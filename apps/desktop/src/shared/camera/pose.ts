import { Mat, mul3, mulv3, nearestRotation, nullVector, solveSPD, det3 } from './linalg';
import { pixelToRay, rodrigues, type Intrinsics } from './geometry';
import { sampler, triangulateLinear, rayAngle } from './two-view';

/**
 * Pose and point estimation for incremental reconstruction (addendum 06):
 * camera resection (PnP) by normalised DLT in RANSAC and a robust
 * Levenberg–Marquardt refinement of a single camera against known points,
 * and multi-view triangulation (linear, then Gauss–Newton on the
 * reprojection error in pixels, distortion included).
 */

export interface Pose {
  R: number[];
  t: number[];
}

/** Project with full distortion; null behind. */
function proj(k: Intrinsics, R: ArrayLike<number>, t: ArrayLike<number>, X: ArrayLike<number>, xo = 0): [number, number, number, number, number] | null {
  const x0 = X[xo]!;
  const x1 = X[xo + 1]!;
  const x2 = X[xo + 2]!;
  const Xc = R[0]! * x0 + R[1]! * x1 + R[2]! * x2 + t[0]!;
  const Yc = R[3]! * x0 + R[4]! * x1 + R[5]! * x2 + t[1]!;
  const Zc = R[6]! * x0 + R[7]! * x1 + R[8]! * x2 + t[2]!;
  if (!(Zc > 1e-9)) return null;
  const xn = Xc / Zc;
  const yn = Yc / Zc;
  const r2 = xn * xn + yn * yn;
  const radial = 1 + r2 * (k.k1 + r2 * (k.k2 + r2 * k.k3));
  const xd = xn * radial + 2 * k.p1 * xn * yn + k.p2 * (r2 + 2 * xn * xn);
  const yd = yn * radial + k.p1 * (r2 + 2 * yn * yn) + 2 * k.p2 * xn * yn;
  return [k.f * xd + k.cx, k.f * yd + k.cy, Xc, Yc, Zc];
}

/** d(u, v)/d(Xc) (2×3, row-major) at camera point (X, Y, Z). */
function dProj(k: Intrinsics, X: number, Y: number, Z: number): number[] {
  const iz = 1 / Z;
  const xn = X * iz;
  const yn = Y * iz;
  const r2 = xn * xn + yn * yn;
  const radial = 1 + r2 * (k.k1 + r2 * (k.k2 + r2 * k.k3));
  const dr = k.k1 + r2 * (2 * k.k2 + 3 * r2 * k.k3);
  const d11 = radial + 2 * xn * xn * dr + 2 * k.p1 * yn + 6 * k.p2 * xn;
  const d12 = 2 * xn * yn * dr + 2 * k.p1 * xn + 2 * k.p2 * yn;
  const d22 = radial + 2 * yn * yn * dr + 6 * k.p1 * yn + 2 * k.p2 * xn;
  const f = k.f;
  return [f * d11 * iz, f * d12 * iz, -f * (d11 * xn + d12 * yn) * iz, f * d12 * iz, f * d22 * iz, -f * (d12 * xn + d22 * yn) * iz];
}

export interface RefinePoseResult extends Pose {
  /** Residual per correspondence, pixels (Infinity behind the camera). */
  residuals: Float64Array;
  inliers: number;
  rms: number;
}

/**
 * Refine one camera against fixed 3D points (Huber-robust LM). `X` is
 * [x, y, z, …], `uv` the observations [u, v, …].
 */
export function refinePose(k: Intrinsics, init: Pose, X: ArrayLike<number>, uv: ArrayLike<number>, options: { delta?: number; iterations?: number; fixTranslation?: boolean; inlierPx?: number } = {}): RefinePoseResult {
  const n = uv.length / 2;
  const delta = options.delta ?? 2;
  let R = [...init.R];
  let t = [...init.t];
  const nu = options.fixTranslation ? 3 : 6;
  const cost = (Rr: number[], tt: number[]) => {
    let c = 0;
    for (let i = 0; i < n; i += 1) {
      const p = proj(k, Rr, tt, X, 3 * i);
      const s = p ? (p[0] - uv[2 * i]!) ** 2 + (p[1] - uv[2 * i + 1]!) ** 2 : 1e6;
      c += s <= delta * delta ? s : 2 * delta * Math.sqrt(s) - delta * delta;
    }
    return c;
  };
  let c0 = cost(R, t);
  let lambda = 1e-3;
  for (let it = 0; it < (options.iterations ?? 20); it += 1) {
    const A = new Mat(nu, nu);
    const g = new Float64Array(nu);
    for (let i = 0; i < n; i += 1) {
      const p = proj(k, R, t, X, 3 * i);
      if (!p) continue;
      const ru = p[0] - uv[2 * i]!;
      const rv = p[1] - uv[2 * i + 1]!;
      const s = ru * ru + rv * rv;
      const w = s <= delta * delta ? 1 : delta / Math.sqrt(s);
      const D = dProj(k, p[2], p[3], p[4]);
      const rx = p[2] - t[0]!;
      const ry = p[3] - t[1]!;
      const rz = p[4] - t[2]!;
      // Rotation columns (left update, dXc/dω = −[R·X]×): ω_x → (0, −rz, ry), ω_y → (rz, 0, −rx), ω_z → (−ry, rx, 0)
      const J = [
        -D[1]! * rz + D[2]! * ry, D[0]! * rz - D[2]! * rx, -D[0]! * ry + D[1]! * rx, D[0]!, D[1]!, D[2]!,
        -D[4]! * rz + D[5]! * ry, D[3]! * rz - D[5]! * rx, -D[3]! * ry + D[4]! * rx, D[3]!, D[4]!, D[5]!,
      ];
      for (let a = 0; a < nu; a += 1) {
        g[a]! += w * (J[a]! * ru + J[6 + a]! * rv);
        for (let b = 0; b < nu; b += 1) A.data[a * nu + b]! += w * (J[a]! * J[b]! + J[6 + a]! * J[6 + b]!);
      }
    }
    let improved = false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const Ad = A.clone();
      for (let a = 0; a < nu; a += 1) Ad.data[a * nu + a]! += lambda * Math.max(1e-9, A.data[a * nu + a]!);
      const dx = solveSPD(Ad, Array.from(g, (v) => -v));
      if (!dx) {
        lambda *= 10;
        continue;
      }
      const R2 = mul3(rodrigues([dx[0]!, dx[1]!, dx[2]!]), R);
      const t2 = nu === 6 ? [t[0]! + dx[3]!, t[1]! + dx[4]!, t[2]! + dx[5]!] : t;
      const c1 = cost(R2, t2);
      if (c1 < c0) {
        R = R2;
        t = t2;
        const rel = (c0 - c1) / Math.max(1e-300, c0);
        c0 = c1;
        lambda = Math.max(1e-12, lambda / 3);
        improved = rel > 1e-9;
        break;
      }
      lambda *= 4;
    }
    if (!improved) break;
  }
  R = nearestRotation(R);
  const residuals = new Float64Array(n);
  let inliers = 0;
  let s2 = 0;
  const th = options.inlierPx ?? 3;
  for (let i = 0; i < n; i += 1) {
    const p = proj(k, R, t, X, 3 * i);
    residuals[i] = p ? Math.hypot(p[0] - uv[2 * i]!, p[1] - uv[2 * i + 1]!) : Infinity;
    if (residuals[i]! < th) {
      inliers += 1;
      s2 += residuals[i]! ** 2;
    }
  }
  return { R, t, residuals, inliers, rms: inliers ? Math.sqrt(s2 / inliers) : Infinity };
}

/** Camera from ≥ 6 point correspondences on normalised (undistorted) rays, by DLT. */
export function dltPnP(X: ArrayLike<number>, rays: ArrayLike<number>, indices?: ArrayLike<number>): Pose | null {
  const n = indices ? indices.length : rays.length / 2;
  if (n < 6) return null;
  const at = (i: number) => (indices ? indices[i]! : i);
  // Normalise the 3D points (centroid, scale).
  let c = [0, 0, 0];
  for (let i = 0; i < n; i += 1) for (let k = 0; k < 3; k += 1) c[k]! += X[3 * at(i) + k]! / n;
  let d = 0;
  for (let i = 0; i < n; i += 1) d += Math.hypot(X[3 * at(i)]! - c[0]!, X[3 * at(i) + 1]! - c[1]!, X[3 * at(i) + 2]! - c[2]!) / n;
  const s = d > 0 ? Math.sqrt(3) / d : 1;
  const A = new Mat(Math.max(2 * n, 12), 12);
  for (let i = 0; i < n; i += 1) {
    const j = at(i);
    const P = [(X[3 * j]! - c[0]!) * s, (X[3 * j + 1]! - c[1]!) * s, (X[3 * j + 2]! - c[2]!) * s, 1];
    const x = rays[2 * j]!;
    const y = rays[2 * j + 1]!;
    for (let k = 0; k < 4; k += 1) {
      A.data[2 * i * 12 + k] = P[k]!;
      A.data[2 * i * 12 + 8 + k] = -x * P[k]!;
      A.data[(2 * i + 1) * 12 + 4 + k] = P[k]!;
      A.data[(2 * i + 1) * 12 + 8 + k] = -y * P[k]!;
    }
  }
  const p = nullVector(A);
  // P' acts on normalised points: P = P' · T with T = [sI | −s c].
  const M = [p[0]!, p[1]!, p[2]!, p[4]!, p[5]!, p[6]!, p[8]!, p[9]!, p[10]!].map((v) => v * s);
  const p4 = [p[3]! - s * (p[0]! * c[0]! + p[1]! * c[1]! + p[2]! * c[2]!), p[7]! - s * (p[4]! * c[0]! + p[5]! * c[1]! + p[6]! * c[2]!), p[11]! - s * (p[8]! * c[0]! + p[9]! * c[1]! + p[10]! * c[2]!)];
  let sign = det3(M) < 0 ? -1 : 1;
  const Ms = M.map((v) => v * sign);
  const scale = Math.cbrt(Math.abs(det3(Ms)));
  if (!(scale > 0)) return null;
  const R = nearestRotation(Ms.map((v) => v / scale));
  let t = p4.map((v) => (v * sign) / scale);
  // Points must be in front.
  let front = 0;
  for (let i = 0; i < n; i += 1) {
    const j = at(i);
    const z = R[6]! * X[3 * j]! + R[7]! * X[3 * j + 1]! + R[8]! * X[3 * j + 2]! + t[2]!;
    if (z > 0) front += 1;
  }
  if (front < n / 2) {
    sign = -sign;
    t = t.map((v) => -v);
    // A flipped sign means the rotation was mirrored: refit.
    return null;
  }
  return { R, t };
}

/** RANSAC PnP (DLT minimal sets of 6) then robust refinement. */
export function ransacPnP(k: Intrinsics, X: ArrayLike<number>, uv: ArrayLike<number>, options: { thresholdPx?: number; iterations?: number; seed?: number } = {}): RefinePoseResult | null {
  const n = uv.length / 2;
  if (n < 6) return null;
  const rays = new Float64Array(2 * n);
  for (let i = 0; i < n; i += 1) {
    const r = pixelToRay(k, uv[2 * i]!, uv[2 * i + 1]!);
    rays[2 * i] = r[0];
    rays[2 * i + 1] = r[1];
  }
  const th = options.thresholdPx ?? 3;
  const pick = sampler(options.seed ?? 5);
  let best: Pose | null = null;
  let bestCount = 0;
  for (let it = 0; it < (options.iterations ?? 300); it += 1) {
    const s = pick(n, 6);
    const P = dltPnP(X, rays, s);
    if (!P) continue;
    let c = 0;
    for (let i = 0; i < n; i += 1) {
      const p = proj(k, P.R, P.t, X, 3 * i);
      if (p && Math.hypot(p[0] - uv[2 * i]!, p[1] - uv[2 * i + 1]!) < th) c += 1;
    }
    if (c > bestCount) {
      bestCount = c;
      best = P;
      if (c > 0.9 * n) break;
    }
  }
  if (!best) return null;
  return refinePose(k, best, X, uv, { delta: th / 2, inlierPx: th });
}

export interface TriangulatedPoint {
  X: number[];
  /** RMS reprojection error over the views, pixels. */
  rms: number;
  /** Largest angle between any two rays, radians. */
  angle: number;
}

/**
 * Triangulate one track from several solved views (linear, then Gauss–Newton
 * on the pixel reprojection error). Null when behind a camera.
 */
export function triangulate(k: Intrinsics, views: readonly { R: ArrayLike<number>; t: ArrayLike<number>; C: ArrayLike<number>; u: number; v: number }[], options: { iterations?: number } = {}): TriangulatedPoint | null {
  if (views.length < 2) return null;
  const rays = views.map((v) => {
    const r = pixelToRay(k, v.u, v.v);
    return { R: v.R, t: v.t, x: r[0], y: r[1] };
  });
  let X = triangulateLinear(rays);
  if (!X) return null;
  for (let it = 0; it < (options.iterations ?? 6); it += 1) {
    const A = new Mat(3, 3);
    const g = [0, 0, 0];
    let ok = true;
    for (const v of views) {
      const p = proj(k, v.R, v.t, X);
      if (!p) {
        ok = false;
        break;
      }
      const ru = p[0] - v.u;
      const rv = p[1] - v.v;
      const D = dProj(k, p[2], p[3], p[4]);
      const J = [0, 0, 0, 0, 0, 0];
      for (let c = 0; c < 3; c += 1) {
        J[c] = D[0]! * v.R[c]! + D[1]! * v.R[3 + c]! + D[2]! * v.R[6 + c]!;
        J[3 + c] = D[3]! * v.R[c]! + D[4]! * v.R[3 + c]! + D[5]! * v.R[6 + c]!;
      }
      for (let a = 0; a < 3; a += 1) {
        g[a]! += J[a]! * ru + J[3 + a]! * rv;
        for (let b = 0; b < 3; b += 1) A.data[a * 3 + b]! += J[a]! * J[b]! + J[3 + a]! * J[3 + b]!;
      }
    }
    if (!ok) break;
    for (let a = 0; a < 3; a += 1) A.data[a * 4]! += 1e-12 + 1e-9 * A.data[a * 4]!;
    const dx = solveSPD(A, g.map((v) => -v));
    if (!dx) break;
    X = [X[0]! + dx[0]!, X[1]! + dx[1]!, X[2]! + dx[2]!];
    if (Math.hypot(dx[0]!, dx[1]!, dx[2]!) < 1e-10 * (1 + Math.hypot(...X))) break;
  }
  let s2 = 0;
  for (const v of views) {
    const p = proj(k, v.R, v.t, X);
    if (!p) return null;
    s2 += (p[0] - v.u) ** 2 + (p[1] - v.v) ** 2;
  }
  let angle = 0;
  const step = Math.max(1, Math.floor(views.length / 8));
  for (let a = 0; a < views.length; a += step) for (let b = a + 1; b < views.length; b += step) angle = Math.max(angle, rayAngle(views[a]!.C, views[b]!.C, X));
  // Always compare the extremes too.
  angle = Math.max(angle, rayAngle(views[0]!.C, views[views.length - 1]!.C, X));
  return { X, rms: Math.sqrt(s2 / views.length), angle };
}

/** Reprojection residual (pixels) of a point in one view, Infinity behind. */
export function reprojection(k: Intrinsics, R: ArrayLike<number>, t: ArrayLike<number>, X: ArrayLike<number>, u: number, v: number, xo = 0): number {
  const p = proj(k, R, t, X, xo);
  return p ? Math.hypot(p[0] - u, p[1] - v) : Infinity;
}

export function centreOf(R: ArrayLike<number>, t: ArrayLike<number>): number[] {
  return mulv3([R[0]!, R[3]!, R[6]!, R[1]!, R[4]!, R[7]!, R[2]!, R[5]!, R[8]!], t).map((v) => -v);
}
