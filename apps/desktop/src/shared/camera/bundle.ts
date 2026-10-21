import { EnvelopeMatrix } from './linalg';
import { rodrigues, type Intrinsics } from './geometry';

/**
 * Bundle adjustment (addendum 06): Levenberg–Marquardt on the reprojection
 * error of every observation, with the sparse camera/point structure
 * eliminated by the Schur complement.
 *
 *  - Cameras: rotation R (updated multiplicatively, R ← exp([δω]×)·R) and
 *    translation t, 6 parameters each. Any parameter can be held (gauge
 *    fixing, nodal shots hold every translation).
 *  - Points: 3 parameters each; a point can be fixed (a surveyed control
 *    point) or carry a prior (a LiDAR correspondence, σ in world units).
 *  - Intrinsics shared by the shot: f, k1, k2, k3, p1, p2, each optional.
 *  - Robust loss on each observation's squared residual: Huber or Cauchy
 *    (iteratively reweighted).
 *
 * The reduced camera system S = U − W V⁻¹ Wᵀ is stored as an envelope
 * (skyline) matrix: with cameras in shot order a camera shares points only
 * with its neighbours in time, so S is banded, plus dense rows for the
 * intrinsics, which go last. Its Cholesky fills only the envelope. That keeps
 * a 200-frame global solve to a fraction of a second per iteration.
 */

export type RobustLoss = 'none' | 'huber' | 'cauchy';

export const INTRINSIC_KEYS = ['f', 'k1', 'k2', 'k3', 'p1', 'p2'] as const;
export type IntrinsicKey = (typeof INTRINSIC_KEYS)[number];

export interface BAProblem {
  intr: Intrinsics;
  refine: Partial<Record<IntrinsicKey, boolean>>;
  /** Per camera: R (9, row-major) and t (3). Updated in place. */
  R: Float64Array;
  t: Float64Array;
  /** Per camera, 6 flags (ω x y z, t x y z): 1 = held. */
  camFixed: Uint8Array;
  /** Points, 3 per point. Updated in place. */
  X: Float64Array;
  pointFixed: Uint8Array;
  /** Optional priors: point index → prior position (3) and σ. */
  priors?: { point: number; X: [number, number, number]; sigma: number }[];
  /** Observations. */
  obsCam: Int32Array;
  obsPt: Int32Array;
  obsUV: Float64Array;
  /** Optional per-observation weight (multiplies the squared residual). */
  obsWeight?: Float64Array;
}

export interface BAOptions {
  loss?: RobustLoss;
  /** Loss scale, pixels. */
  delta?: number;
  maxIterations?: number;
  /** Stop when the relative cost decrease is below this. */
  tolerance?: number;
  /** Renormalise points to their initial distance after each step (nodal shots). */
  nodal?: boolean;
  signal?: { aborted: boolean };
}

export interface BAResult {
  initialCost: number;
  finalCost: number;
  iterations: number;
  /** RMS reprojection error over all observations (unweighted, pixels). */
  rms: number;
  /** Per observation residual norm after the solve (pixels). */
  residuals: Float64Array;
  ms: number;
  converged: boolean;
}

function lossOf(loss: RobustLoss, delta: number, s: number): { rho: number; w: number } {
  if (loss === 'huber') {
    const d2 = delta * delta;
    if (s <= d2) return { rho: s, w: 1 };
    const r = Math.sqrt(s);
    return { rho: 2 * delta * r - d2, w: delta / r };
  }
  if (loss === 'cauchy') {
    const d2 = delta * delta;
    return { rho: d2 * Math.log1p(s / d2), w: 1 / (1 + s / d2) };
  }
  return { rho: s, w: 1 };
}

interface Projection {
  u: number;
  v: number;
  ok: boolean;
}

/** Project point X with camera c and the intrinsics; optionally fill Jacobians. */
function projectWithJacobians(
  p: BAProblem,
  intr: Intrinsics,
  ic: number,
  X: ArrayLike<number>,
  xo: number,
  jc: Float64Array | null,
  jp: Float64Array | null,
  ji: Float64Array | null,
  iKeys: readonly IntrinsicKey[],
): Projection {
  const R = p.R;
  const t = p.t;
  const r = ic * 9;
  const x0 = X[xo]!;
  const x1 = X[xo + 1]!;
  const x2 = X[xo + 2]!;
  const rx = R[r]! * x0 + R[r + 1]! * x1 + R[r + 2]! * x2;
  const ry = R[r + 3]! * x0 + R[r + 4]! * x1 + R[r + 5]! * x2;
  const rz = R[r + 6]! * x0 + R[r + 7]! * x1 + R[r + 8]! * x2;
  const X0 = rx + t[ic * 3]!;
  const Y0 = ry + t[ic * 3 + 1]!;
  const Z0 = rz + t[ic * 3 + 2]!;
  if (!(Z0 > 1e-9)) return { u: 0, v: 0, ok: false };
  const iz = 1 / Z0;
  const xn = X0 * iz;
  const yn = Y0 * iz;
  const { f, k1, k2, k3, p1, p2 } = intr;
  const r2 = xn * xn + yn * yn;
  const radial = 1 + r2 * (k1 + r2 * (k2 + r2 * k3));
  const xd = xn * radial + 2 * p1 * xn * yn + p2 * (r2 + 2 * xn * xn);
  const yd = yn * radial + p1 * (r2 + 2 * yn * yn) + 2 * p2 * xn * yn;
  const u = f * xd + intr.cx;
  const v = f * yd + intr.cy;
  if (jc || jp || ji) {
    const dr = k1 + r2 * (2 * k2 + 3 * r2 * k3);
    const d11 = radial + 2 * xn * xn * dr + 2 * p1 * yn + 6 * p2 * xn;
    const d12 = 2 * xn * yn * dr + 2 * p1 * xn + 2 * p2 * yn;
    const d21 = d12;
    const d22 = radial + 2 * yn * yn * dr + 6 * p1 * yn + 2 * p2 * xn;
    // d(u,v)/d(Xc): f·D·[[1/Z, 0, −X/Z²], [0, 1/Z, −Y/Z²]]
    const a11 = f * d11 * iz;
    const a12 = f * d12 * iz;
    const a13 = -f * (d11 * xn + d12 * yn) * iz;
    const a21 = f * d21 * iz;
    const a22 = f * d22 * iz;
    const a23 = -f * (d21 * xn + d22 * yn) * iz;
    if (jc) {
      // Rotation (left update): dXc/dω = −[R·X]×, columns: ω_x → (0, −rz, ry), ω_y → (rz, 0, −rx), ω_z → (−ry, rx, 0).
      jc[0] = -a12 * rz + a13 * ry;
      jc[1] = a11 * rz - a13 * rx;
      jc[2] = -a11 * ry + a12 * rx;
      jc[3] = a11;
      jc[4] = a12;
      jc[5] = a13;
      jc[6] = -a22 * rz + a23 * ry;
      jc[7] = a21 * rz - a23 * rx;
      jc[8] = -a21 * ry + a22 * rx;
      jc[9] = a21;
      jc[10] = a22;
      jc[11] = a23;
    }
    if (jp) {
      // dXc/dX = R
      for (let k = 0; k < 3; k += 1) {
        jp[k] = a11 * R[r + k]! + a12 * R[r + 3 + k]! + a13 * R[r + 6 + k]!;
        jp[3 + k] = a21 * R[r + k]! + a22 * R[r + 3 + k]! + a23 * R[r + 6 + k]!;
      }
    }
    if (ji) {
      const n = iKeys.length;
      iKeys.forEach((key, k) => {
        let du = 0;
        let dv = 0;
        switch (key) {
          case 'f':
            du = xd;
            dv = yd;
            break;
          case 'k1':
            du = f * xn * r2;
            dv = f * yn * r2;
            break;
          case 'k2':
            du = f * xn * r2 * r2;
            dv = f * yn * r2 * r2;
            break;
          case 'k3':
            du = f * xn * r2 * r2 * r2;
            dv = f * yn * r2 * r2 * r2;
            break;
          case 'p1':
            du = f * 2 * xn * yn;
            dv = f * (r2 + 2 * yn * yn);
            break;
          case 'p2':
            du = f * (r2 + 2 * xn * xn);
            dv = f * 2 * xn * yn;
            break;
        }
        ji[k] = du;
        ji[n + k] = dv;
      });
    }
  }
  return { u, v, ok: true };
}

/** Total robust cost (and per-observation residual norms) at the current parameters. */
export function evaluate(p: BAProblem, loss: RobustLoss, delta: number, residuals?: Float64Array): number {
  let cost = 0;
  const m = p.obsCam.length;
  for (let o = 0; o < m; o += 1) {
    const pr = projectWithJacobians(p, p.intr, p.obsCam[o]!, p.X, 3 * p.obsPt[o]!, null, null, null, []);
    let s: number;
    if (!pr.ok) s = 1e6;
    else {
      const du = pr.u - p.obsUV[2 * o]!;
      const dv = pr.v - p.obsUV[2 * o + 1]!;
      s = du * du + dv * dv;
    }
    if (residuals) residuals[o] = Math.sqrt(s);
    cost += lossOf(loss, delta, s).rho * (p.obsWeight ? p.obsWeight[o]! : 1);
  }
  for (const pr of p.priors ?? []) {
    const i = pr.point * 3;
    const e = ((p.X[i]! - pr.X[0]) ** 2 + (p.X[i + 1]! - pr.X[1]) ** 2 + (p.X[i + 2]! - pr.X[2]) ** 2) / (pr.sigma * pr.sigma);
    cost += e;
  }
  return cost;
}

/** Bundle adjustment in place. */
export function bundleAdjust(p: BAProblem, options: BAOptions = {}): BAResult {
  const started = Date.now();
  const loss = options.loss ?? 'huber';
  const delta = options.delta ?? 1.5;
  const maxIt = options.maxIterations ?? 30;
  const tol = options.tolerance ?? 1e-7;
  const nc = p.R.length / 9;
  const np = p.X.length / 3;
  const m = p.obsCam.length;
  const iKeys = INTRINSIC_KEYS.filter((k) => p.refine[k]);
  const nI = iKeys.length;
  const nRows = 6 * nc + nI;

  // Points' observations (CSR) and each camera's earliest neighbour (the envelope).
  const ptStart = new Int32Array(np + 1);
  for (let o = 0; o < m; o += 1) ptStart[p.obsPt[o]! + 1]! += 1;
  for (let i = 0; i < np; i += 1) ptStart[i + 1]! += ptStart[i]!;
  const ptObs = new Int32Array(m);
  const fill = ptStart.slice(0, np);
  for (let o = 0; o < m; o += 1) ptObs[fill[p.obsPt[o]!]!++] = o;
  const minCam = new Int32Array(nc);
  for (let c = 0; c < nc; c += 1) minCam[c] = c;
  for (let i = 0; i < np; i += 1) {
    if (p.pointFixed[i]) continue;
    let lo = nc;
    for (let k = ptStart[i]!; k < ptStart[i + 1]!; k += 1) lo = Math.min(lo, p.obsCam[ptObs[k]!]!);
    for (let k = ptStart[i]!; k < ptStart[i + 1]!; k += 1) {
      const c = p.obsCam[ptObs[k]!]!;
      if (lo < minCam[c]!) minCam[c] = lo;
    }
  }
  const first = new Int32Array(nRows);
  for (let c = 0; c < nc; c += 1) for (let k = 0; k < 6; k += 1) first[6 * c + k] = 6 * minCam[c]!;
  for (let k = 0; k < nI; k += 1) first[6 * nc + k] = 0;

  const priorOf = new Map<number, { X: [number, number, number]; sigma: number }>();
  for (const pr of p.priors ?? []) priorOf.set(pr.point, pr);

  const jc = new Float64Array(12);
  const jp = new Float64Array(6);
  const ji = new Float64Array(2 * Math.max(1, nI));
  // Per-iteration accumulators.
  const U = new Float64Array(nc * 36);
  const gc = new Float64Array(nc * 6);
  const V = new Float64Array(np * 9);
  const gp = new Float64Array(np * 3);
  const W = new Float64Array(m * 18);
  const UI = new Float64Array(nI * nI);
  const gI = new Float64Array(nI);
  const AIc = new Float64Array(nc * 6 * nI); // intrinsics × camera cross, nI×6 per camera
  const Z = new Float64Array(np * 3 * nI); // point × intrinsics cross, 3×nI per point
  const fixedCam = p.camFixed;
  // Observations of each point in camera order (the elimination relies on it).
  for (let i = 0; i < np; i += 1) {
    const a = ptStart[i]!;
    const e = ptStart[i + 1]!;
    if (e - a > 1) {
      const sorted = Array.from(ptObs.subarray(a, e)).sort((x, y) => p.obsCam[x]! - p.obsCam[y]!);
      ptObs.set(sorted, a);
    }
  }
  let maxObs = 1;
  for (let i = 0; i < np; i += 1) maxObs = Math.max(maxObs, ptStart[i + 1]! - ptStart[i]!);
  const S = new EnvelopeMatrix(first);
  const rowBase = new Int32Array(nRows);
  for (let r = 0; r < nRows; r += 1) rowBase[r] = S.offset[r]! - first[r]!;
  const bvec = new Float64Array(nRows);
  const Vinv = new Float64Array(np * 9);
  const Wl = new Float64Array(maxObs * 18);
  const YT = new Float64Array(maxObs * 18);
  const camOf = new Int32Array(maxObs);
  const Yi = new Float64Array(3 * Math.max(1, nI));
  const nodalRidge = options.nodal ? 1e-9 : 0;

  let cost = evaluate(p, loss, delta);
  const initialCost = cost;
  let lambda = 1e-4;
  let iterations = 0;
  let converged = false;
  const backupR = new Float64Array(p.R.length);
  const backupT = new Float64Array(p.t.length);
  const backupX = new Float64Array(p.X.length);
  const norms0 = options.nodal ? Float64Array.from({ length: np }, (_, i) => Math.hypot(p.X[3 * i]!, p.X[3 * i + 1]!, p.X[3 * i + 2]!)) : null;

  for (let it = 0; it < maxIt; it += 1) {
    if (options.signal?.aborted) break;
    iterations = it + 1;
    U.fill(0);
    gc.fill(0);
    V.fill(0);
    gp.fill(0);
    UI.fill(0);
    gI.fill(0);
    AIc.fill(0);
    Z.fill(0);
    // --- linearise ---------------------------------------------------------
    for (let o = 0; o < m; o += 1) {
      const c = p.obsCam[o]!;
      const i = p.obsPt[o]!;
      const pr = projectWithJacobians(p, p.intr, c, p.X, 3 * i, jc, jp, nI ? ji : null, iKeys);
      const wo = W.subarray(o * 18, o * 18 + 18);
      if (!pr.ok) {
        wo.fill(0);
        continue;
      }
      const ru = pr.u - p.obsUV[2 * o]!;
      const rv = pr.v - p.obsUV[2 * o + 1]!;
      const s2 = ru * ru + rv * rv;
      const w = (loss === 'huber' ? (s2 <= delta * delta ? 1 : delta / Math.sqrt(s2)) : loss === 'cauchy' ? 1 / (1 + s2 / (delta * delta)) : 1) * (p.obsWeight ? p.obsWeight[o]! : 1);
      // Hold fixed camera parameters by zeroing their columns.
      const cf = c * 6;
      for (let k = 0; k < 6; k += 1)
        if (fixedCam[cf + k]) {
          jc[k] = 0;
          jc[6 + k] = 0;
        }
      const pf = p.pointFixed[i] === 1;
      // U, gc
      const u0 = c * 36;
      for (let a = 0; a < 6; a += 1) {
        const ja0 = jc[a]!;
        const ja1 = jc[6 + a]!;
        gc[cf + a]! += w * (ja0 * ru + ja1 * rv);
        for (let b = 0; b <= a; b += 1) U[u0 + a * 6 + b]! += w * (ja0 * jc[b]! + ja1 * jc[6 + b]!);
      }
      if (!pf) {
        const v0 = i * 9;
        for (let a = 0; a < 3; a += 1) {
          gp[3 * i + a]! += w * (jp[a]! * ru + jp[3 + a]! * rv);
          for (let b = 0; b < 3; b += 1) V[v0 + a * 3 + b]! += w * (jp[a]! * jp[b]! + jp[3 + a]! * jp[3 + b]!);
        }
        for (let a = 0; a < 6; a += 1) for (let b = 0; b < 3; b += 1) wo[a * 3 + b] = w * (jc[a]! * jp[b]! + jc[6 + a]! * jp[3 + b]!);
      } else wo.fill(0);
      if (nI) {
        for (let a = 0; a < nI; a += 1) {
          const ia0 = ji[a]!;
          const ia1 = ji[nI + a]!;
          gI[a]! += w * (ia0 * ru + ia1 * rv);
          for (let b = 0; b <= a; b += 1) UI[a * nI + b]! += w * (ia0 * ji[b]! + ia1 * ji[nI + b]!);
          for (let b = 0; b < 6; b += 1) AIc[(c * nI + a) * 6 + b]! += w * (ia0 * jc[b]! + ia1 * jc[6 + b]!);
          if (!pf) for (let b = 0; b < 3; b += 1) Z[(i * 3 + b) * nI + a]! += w * (jp[b]! * ia0 + jp[3 + b]! * ia1);
        }
      }
    }
    for (const [i, pr] of priorOf) {
      if (p.pointFixed[i]) continue;
      const k = 1 / (pr.sigma * pr.sigma);
      for (let a = 0; a < 3; a += 1) {
        V[i * 9 + a * 4]! += k;
        gp[3 * i + a]! += k * (p.X[3 * i + a]! - pr.X[a]!);
      }
    }

    // --- solve the damped system by the Schur complement -------------------
    let accepted = false;
    for (let attempt = 0; attempt < 12 && !accepted; attempt += 1) {
      S.values.fill(0);
      bvec.fill(0);
      const vals = S.values;
      const b = bvec;
      // Camera blocks (lower triangle) with damping.
      for (let c = 0; c < nc; c += 1) {
        for (let a = 0; a < 6; a += 1) {
          const row = 6 * c + a;
          const base = rowBase[row]!;
          for (let bb = 0; bb <= a; bb += 1) vals[base + 6 * c + bb]! += U[c * 36 + a * 6 + bb]!;
          const d = U[c * 36 + a * 7]!;
          if (fixedCam[6 * c + a]) {
            vals[base + row] = 1;
          } else vals[base + row]! += lambda * Math.min(1e32, Math.max(1e-6, d));
          b[row] = fixedCam[6 * c + a] ? 0 : -gc[6 * c + a]!;
        }
      }
      // Intrinsics block and its cross terms.
      for (let a = 0; a < nI; a += 1) {
        const row = 6 * nc + a;
        const base = rowBase[row]!;
        for (let c = 0; c < nc; c += 1) for (let k = 0; k < 6; k += 1) vals[base + 6 * c + k]! += AIc[(c * nI + a) * 6 + k]!;
        for (let bb = 0; bb <= a; bb += 1) vals[base + 6 * nc + bb]! += UI[a * nI + bb]!;
        vals[base + row]! += lambda * Math.min(1e32, Math.max(1e-6, UI[a * nI + a]!));
        b[row] = -gI[a]!;
      }
      // Eliminate points: S −= W V⁻¹ Wᵀ, b += W V⁻¹ g_p, per point.
      for (let i = 0; i < np; i += 1) {
        if (p.pointFixed[i]) continue;
        const v0 = i * 9;
        const e00 = V[v0]! + lambda * Math.min(1e32, Math.max(1e-6, V[v0]!)) + nodalRidge;
        const e11 = V[v0 + 4]! + lambda * Math.min(1e32, Math.max(1e-6, V[v0 + 4]!)) + nodalRidge;
        const e22 = V[v0 + 8]! + lambda * Math.min(1e32, Math.max(1e-6, V[v0 + 8]!)) + nodalRidge;
        const e01 = V[v0 + 1]!;
        const e02 = V[v0 + 2]!;
        const e12 = V[v0 + 5]!;
        // Symmetric 3×3 inverse.
        const c00 = e11 * e22 - e12 * e12;
        const c01 = e02 * e12 - e01 * e22;
        const c02 = e01 * e12 - e02 * e11;
        const det = e00 * c00 + e01 * c01 + e02 * c02;
        if (!(Math.abs(det) > 1e-300) || !Number.isFinite(det)) {
          Vinv.fill(0, v0, v0 + 9);
          continue;
        }
        const id = 1 / det;
        const i00 = c00 * id;
        const i01 = c01 * id;
        const i02 = c02 * id;
        const i11 = (e00 * e22 - e02 * e02) * id;
        const i12 = (e01 * e02 - e00 * e12) * id;
        const i22 = (e00 * e11 - e01 * e01) * id;
        Vinv[v0] = i00;
        Vinv[v0 + 1] = i01;
        Vinv[v0 + 2] = i02;
        Vinv[v0 + 3] = i01;
        Vinv[v0 + 4] = i11;
        Vinv[v0 + 5] = i12;
        Vinv[v0 + 6] = i02;
        Vinv[v0 + 7] = i12;
        Vinv[v0 + 8] = i22;
        const s0 = ptStart[i]!;
        const mcount = ptStart[i + 1]! - s0;
        const g0 = gp[3 * i]!;
        const g1 = gp[3 * i + 1]!;
        const g2 = gp[3 * i + 2]!;
        const q0 = i00 * g0 + i01 * g1 + i02 * g2;
        const q1 = i01 * g0 + i11 * g1 + i12 * g2;
        const q2 = i02 * g0 + i12 * g1 + i22 * g2;
        // Gather W_a and YT_a = W_a V⁻¹ (6×3 each) for this point's observations, in camera order.
        for (let a = 0; a < mcount; a += 1) {
          const o = ptObs[s0 + a]!;
          const src = o * 18;
          const dst = a * 18;
          camOf[a] = p.obsCam[o]!;
          for (let r = 0; r < 6; r += 1) {
            const w0 = W[src + r * 3]!;
            const w1 = W[src + r * 3 + 1]!;
            const w2 = W[src + r * 3 + 2]!;
            Wl[dst + r * 3] = w0;
            Wl[dst + r * 3 + 1] = w1;
            Wl[dst + r * 3 + 2] = w2;
            YT[dst + r * 3] = w0 * i00 + w1 * i01 + w2 * i02;
            YT[dst + r * 3 + 1] = w0 * i01 + w1 * i11 + w2 * i12;
            YT[dst + r * 3 + 2] = w0 * i02 + w1 * i12 + w2 * i22;
          }
          // rhs: b_ca += W_a q
          const cb6 = 6 * camOf[a]!;
          for (let r = 0; r < 6; r += 1) b[cb6 + r]! += Wl[dst + r * 3]! * q0 + Wl[dst + r * 3 + 1]! * q1 + Wl[dst + r * 3 + 2]! * q2;
        }
        // Intrinsics.
        if (nI) {
          const z = (i * 3) * nI;
          for (let a = 0; a < nI; a += 1) {
            const z0 = Z[z + a]!;
            const z1 = Z[z + nI + a]!;
            const z2 = Z[z + 2 * nI + a]!;
            Yi[a] = i00 * z0 + i01 * z1 + i02 * z2;
            Yi[nI + a] = i01 * z0 + i11 * z1 + i12 * z2;
            Yi[2 * nI + a] = i02 * z0 + i12 * z1 + i22 * z2;
          }
          for (let a = 0; a < nI; a += 1) {
            const row = 6 * nc + a;
            const base = rowBase[row]!;
            const z0 = Z[z + a]!;
            const z1 = Z[z + nI + a]!;
            const z2 = Z[z + 2 * nI + a]!;
            for (let bb = 0; bb <= a; bb += 1) vals[base + 6 * nc + bb]! -= z0 * Yi[bb]! + z1 * Yi[nI + bb]! + z2 * Yi[2 * nI + bb]!;
            b[row]! += z0 * q0 + z1 * q1 + z2 * q2;
            // S_{I, ca} −= Zᵀ V⁻¹ W_aᵀ = (Yi[:, a])ᵀ W_aᵀ
            const y0 = Yi[a]!;
            const y1 = Yi[nI + a]!;
            const y2 = Yi[2 * nI + a]!;
            for (let k = 0; k < mcount; k += 1) {
              const wk = k * 18;
              const col = base + 6 * camOf[k]!;
              for (let r = 0; r < 6; r += 1) vals[col + r]! -= y0 * Wl[wk + r * 3]! + y1 * Wl[wk + r * 3 + 1]! + y2 * Wl[wk + r * 3 + 2]!;
            }
          }
        }
        // camera × camera: S_{ca, cb} −= YT_a W_bᵀ for b ≤ a (observations are in camera order).
        for (let a = 0; a < mcount; a += 1) {
          const ya = a * 18;
          const ca6 = 6 * camOf[a]!;
          for (let r = 0; r < 6; r += 1) {
            const y0 = YT[ya + r * 3]!;
            const y1 = YT[ya + r * 3 + 1]!;
            const y2 = YT[ya + r * 3 + 2]!;
            const rb = rowBase[ca6 + r]!;
            for (let bIdx = 0; bIdx < a; bIdx += 1) {
              const wb = bIdx * 18;
              const base = rb + 6 * camOf[bIdx]!;
              vals[base]! -= y0 * Wl[wb]! + y1 * Wl[wb + 1]! + y2 * Wl[wb + 2]!;
              vals[base + 1]! -= y0 * Wl[wb + 3]! + y1 * Wl[wb + 4]! + y2 * Wl[wb + 5]!;
              vals[base + 2]! -= y0 * Wl[wb + 6]! + y1 * Wl[wb + 7]! + y2 * Wl[wb + 8]!;
              vals[base + 3]! -= y0 * Wl[wb + 9]! + y1 * Wl[wb + 10]! + y2 * Wl[wb + 11]!;
              vals[base + 4]! -= y0 * Wl[wb + 12]! + y1 * Wl[wb + 13]! + y2 * Wl[wb + 14]!;
              vals[base + 5]! -= y0 * Wl[wb + 15]! + y1 * Wl[wb + 16]! + y2 * Wl[wb + 17]!;
            }
            // Diagonal block: lower triangle only.
            const base = rb + ca6;
            for (let k = 0; k <= r; k += 1) vals[base + k]! -= y0 * Wl[ya + k * 3]! + y1 * Wl[ya + k * 3 + 1]! + y2 * Wl[ya + k * 3 + 2]!;
          }
        }
      }
      // Fixed camera parameters: identity rows/cols (their J columns are zero, so only the diagonal remains).
      if (!S.factor()) {
        lambda *= 10;
        continue;
      }
      const dc = S.solve(bvec);
      // Back-substitute points.
      backupR.set(p.R);
      backupT.set(p.t);
      backupX.set(p.X);
      const intrBefore = { ...p.intr };
      for (let i = 0; i < np; i += 1) {
        if (p.pointFixed[i]) continue;
        const v0 = i * 9;
        let r0 = -gp[3 * i]!;
        let r1 = -gp[3 * i + 1]!;
        let r2 = -gp[3 * i + 2]!;
        for (let k = ptStart[i]!; k < ptStart[i + 1]!; k += 1) {
          const o = ptObs[k]!;
          const c = p.obsCam[o]!;
          const wo = o * 18;
          for (let a = 0; a < 6; a += 1) {
            const d = dc[6 * c + a]!;
            r0 -= W[wo + a * 3]! * d;
            r1 -= W[wo + a * 3 + 1]! * d;
            r2 -= W[wo + a * 3 + 2]! * d;
          }
        }
        for (let a = 0; a < nI; a += 1) {
          const d = dc[6 * nc + a]!;
          r0 -= Z[(i * 3) * nI + a]! * d;
          r1 -= Z[(i * 3 + 1) * nI + a]! * d;
          r2 -= Z[(i * 3 + 2) * nI + a]! * d;
        }
        p.X[3 * i]! += Vinv[v0]! * r0 + Vinv[v0 + 1]! * r1 + Vinv[v0 + 2]! * r2;
        p.X[3 * i + 1]! += Vinv[v0 + 3]! * r0 + Vinv[v0 + 4]! * r1 + Vinv[v0 + 5]! * r2;
        p.X[3 * i + 2]! += Vinv[v0 + 6]! * r0 + Vinv[v0 + 7]! * r1 + Vinv[v0 + 8]! * r2;
        if (norms0) {
          const n = Math.hypot(p.X[3 * i]!, p.X[3 * i + 1]!, p.X[3 * i + 2]!) || 1;
          const k = norms0[i]! / n;
          p.X[3 * i]! *= k;
          p.X[3 * i + 1]! *= k;
          p.X[3 * i + 2]! *= k;
        }
      }
      for (let c = 0; c < nc; c += 1) {
        const w = [dc[6 * c]!, dc[6 * c + 1]!, dc[6 * c + 2]!];
        if (w[0] !== 0 || w[1] !== 0 || w[2] !== 0) {
          const dR = rodrigues(w);
          const R0 = p.R.subarray(9 * c, 9 * c + 9);
          const nR = new Float64Array(9);
          for (let r = 0; r < 3; r += 1)
            for (let k = 0; k < 3; k += 1) nR[r * 3 + k] = dR[r * 3]! * R0[k]! + dR[r * 3 + 1]! * R0[3 + k]! + dR[r * 3 + 2]! * R0[6 + k]!;
          p.R.set(nR, 9 * c);
        }
        for (let k = 0; k < 3; k += 1) p.t[3 * c + k]! += dc[6 * c + 3 + k]!;
      }
      iKeys.forEach((key, a) => {
        (p.intr as unknown as Record<string, number>)[key] = (p.intr as unknown as Record<string, number>)[key]! + dc[6 * nc + a]!;
      });
      const next = evaluate(p, loss, delta);
      if (Number.isFinite(next) && next < cost) {
        const rel = (cost - next) / Math.max(cost, 1e-300);
        cost = next;
        lambda = Math.max(1e-12, lambda / 3);
        accepted = true;
        if (rel < tol) converged = true;
      } else {
        p.R.set(backupR);
        p.t.set(backupT);
        p.X.set(backupX);
        Object.assign(p.intr, intrBefore);
        lambda *= 4;
        if (lambda > 1e12) break;
      }
    }
    if (!accepted || converged) {
      converged = converged || !accepted;
      break;
    }
  }
  const residuals = new Float64Array(m);
  evaluate(p, 'none', 1, residuals);
  let s = 0;
  for (let o = 0; o < m; o += 1) s += residuals[o]! * residuals[o]!;
  return { initialCost, finalCost: cost, iterations, rms: m ? Math.sqrt(s / m) : 0, residuals, ms: Date.now() - started, converged };
}
