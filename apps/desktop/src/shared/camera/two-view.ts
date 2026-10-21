import { Mat, cross, det3, mul3, mulv3, nullVector, svd3, t3 } from './linalg';

/**
 * Two-view geometry (addendum 06): the fundamental matrix by Hartley's
 * normalised 8-point algorithm inside RANSAC (Sampson distance), the
 * essential matrix on normalised (calibrated) coordinates projected onto the
 * essential manifold, its four (R, t) decompositions disambiguated by
 * cheirality, homographies by normalised DLT, and Torr's GRIC to tell a
 * general (parallax) pair from a homography (rotation-only or planar) one.
 *
 * Points are flat arrays [x0, y0, x1, y1, …].
 */

export type Pts = Float64Array;

export interface Normalised {
  pts: Pts;
  /** The similarity T with p' = T·p (row-major 3×3). */
  T: number[];
}

/** Hartley normalisation: centroid to the origin, mean distance √2. */
export function normalisePoints(pts: Pts, indices?: ArrayLike<number>): Normalised {
  const n = indices ? indices.length : pts.length / 2;
  const at = (i: number) => (indices ? indices[i]! : i);
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i += 1) {
    mx += pts[2 * at(i)]!;
    my += pts[2 * at(i) + 1]!;
  }
  mx /= n;
  my /= n;
  let d = 0;
  for (let i = 0; i < n; i += 1) d += Math.hypot(pts[2 * at(i)]! - mx, pts[2 * at(i) + 1]! - my);
  d /= n;
  const s = d > 0 ? Math.SQRT2 / d : 1;
  const out = new Float64Array(2 * n);
  for (let i = 0; i < n; i += 1) {
    out[2 * i] = (pts[2 * at(i)]! - mx) * s;
    out[2 * i + 1] = (pts[2 * at(i) + 1]! - my) * s;
  }
  return { pts: out, T: [s, 0, -s * mx, 0, s, -s * my, 0, 0, 1] };
}

/** Rank-2 fundamental matrix x2ᵀ F x1 = 0 from ≥ 8 correspondences (normalised 8-point). */
export function eightPoint(x1: Pts, x2: Pts, indices?: ArrayLike<number>): number[] | null {
  const a = normalisePoints(x1, indices);
  const b = normalisePoints(x2, indices);
  const n = a.pts.length / 2;
  if (n < 8) return null;
  const A = new Mat(Math.max(n, 9), 9);
  for (let i = 0; i < n; i += 1) {
    const u1 = a.pts[2 * i]!;
    const v1 = a.pts[2 * i + 1]!;
    const u2 = b.pts[2 * i]!;
    const v2 = b.pts[2 * i + 1]!;
    A.data.set([u2 * u1, u2 * v1, u2, v2 * u1, v2 * v1, v2, u1, v1, 1], i * 9);
  }
  const f = Array.from(nullVector(A));
  // Enforce rank 2.
  const { u, s, v } = svd3(f);
  const F = mul3(mul3(u, [s[0]!, 0, 0, 0, s[1]!, 0, 0, 0, 0]), t3(v));
  // Denormalise: F = T2ᵀ F' T1.
  const out = mul3(mul3(t3(b.T), F), a.T);
  const nrm = Math.hypot(...out);
  return nrm > 0 ? out.map((x) => x / nrm) : null;
}

/** First-order geometric (Sampson) error of a correspondence under F, squared, in the units of the points. */
export function sampson(F: ArrayLike<number>, x1: number, y1: number, x2: number, y2: number): number {
  const fx1 = [F[0]! * x1 + F[1]! * y1 + F[2]!, F[3]! * x1 + F[4]! * y1 + F[5]!, F[6]! * x1 + F[7]! * y1 + F[8]!];
  const ftx2 = [F[0]! * x2 + F[3]! * y2 + F[6]!, F[1]! * x2 + F[4]! * y2 + F[7]!, F[2]! * x2 + F[5]! * y2 + F[8]!];
  const e = x2 * fx1[0]! + y2 * fx1[1]! + fx1[2]!;
  const d = fx1[0]! ** 2 + fx1[1]! ** 2 + ftx2[0]! ** 2 + ftx2[1]! ** 2;
  return d > 0 ? (e * e) / d : Infinity;
}

/** Deterministic sampling for RANSAC. */
export function sampler(seed: number): (n: number, k: number) => number[] {
  let a = seed >>> 0 || 1;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return (n, k) => {
    const out: number[] = [];
    while (out.length < k) {
      const i = Math.floor(rand() * n);
      if (!out.includes(i)) out.push(i);
    }
    return out;
  };
}

export interface RansacResult {
  model: number[];
  inliers: Uint8Array;
  count: number;
  /** Per-correspondence squared error under the final model. */
  errors: Float64Array;
}

/** Adaptive iteration count for a sample of size s at inlier ratio w and confidence p. */
function iterationsFor(w: number, s: number, p = 0.999): number {
  const ws = w ** s;
  if (ws <= 0) return Infinity;
  if (ws >= 1) return 1;
  return Math.ceil(Math.log(1 - p) / Math.log(1 - ws));
}

/** RANSAC for F (threshold in pixels on the Sampson distance), refit on inliers. */
export function ransacFundamental(x1: Pts, x2: Pts, options: { threshold?: number; maxIterations?: number; seed?: number } = {}): RansacResult | null {
  const n = x1.length / 2;
  if (n < 8) return null;
  const th2 = (options.threshold ?? 1) ** 2;
  const maxIt = options.maxIterations ?? 500;
  const pick = sampler(options.seed ?? 7);
  let best: number[] | null = null;
  let bestCount = -1;
  let needed = maxIt;
  const score = (F: number[]) => {
    let c = 0;
    for (let i = 0; i < n; i += 1) if (sampson(F, x1[2 * i]!, x1[2 * i + 1]!, x2[2 * i]!, x2[2 * i + 1]!) < th2) c += 1;
    return c;
  };
  for (let it = 0; it < Math.min(maxIt, needed); it += 1) {
    const s = pick(n, 8);
    const F = eightPoint(x1, x2, s);
    if (!F) continue;
    const c = score(F);
    if (c > bestCount) {
      bestCount = c;
      best = F;
      needed = iterationsFor(c / n, 8);
    }
  }
  if (!best) return null;
  // Refit on inliers, twice.
  for (let r = 0; r < 2; r += 1) {
    const idx: number[] = [];
    for (let i = 0; i < n; i += 1) if (sampson(best, x1[2 * i]!, x1[2 * i + 1]!, x2[2 * i]!, x2[2 * i + 1]!) < th2) idx.push(i);
    if (idx.length < 8) break;
    const F = eightPoint(x1, x2, idx);
    if (F && score(F) >= idx.length * 0.98) best = F;
  }
  const errors = new Float64Array(n);
  const inliers = new Uint8Array(n);
  let count = 0;
  for (let i = 0; i < n; i += 1) {
    errors[i] = sampson(best, x1[2 * i]!, x1[2 * i + 1]!, x2[2 * i]!, x2[2 * i + 1]!);
    if (errors[i]! < th2) {
      inliers[i] = 1;
      count += 1;
    }
  }
  return { model: best, inliers, count, errors };
}

/** Homography x2 ~ H x1 from ≥ 4 correspondences (normalised DLT). */
export function dltHomography(x1: Pts, x2: Pts, indices?: ArrayLike<number>): number[] | null {
  const a = normalisePoints(x1, indices);
  const b = normalisePoints(x2, indices);
  const n = a.pts.length / 2;
  if (n < 4) return null;
  const A = new Mat(Math.max(2 * n, 9), 9);
  for (let i = 0; i < n; i += 1) {
    const x = a.pts[2 * i]!;
    const y = a.pts[2 * i + 1]!;
    const u = b.pts[2 * i]!;
    const v = b.pts[2 * i + 1]!;
    A.data.set([-x, -y, -1, 0, 0, 0, u * x, u * y, u], 2 * i * 9);
    A.data.set([0, 0, 0, -x, -y, -1, v * x, v * y, v], (2 * i + 1) * 9);
  }
  const h = Array.from(nullVector(A));
  const Tb = b.T;
  const TbInv = [1 / Tb[0]!, 0, -Tb[2]! / Tb[0]!, 0, 1 / Tb[4]!, -Tb[5]! / Tb[4]!, 0, 0, 1];
  const H = mul3(mul3(TbInv, h), a.T);
  const s = H[8]! !== 0 ? H[8]! : Math.hypot(...H);
  if (!Number.isFinite(s) || s === 0) return null;
  return H.map((x) => x / s);
}

export function applyH(H: ArrayLike<number>, x: number, y: number): [number, number] {
  const w = H[6]! * x + H[7]! * y + H[8]!;
  return [(H[0]! * x + H[1]! * y + H[2]!) / w, (H[3]! * x + H[4]! * y + H[5]!) / w];
}

/** Forward transfer error², pixels². */
export function transferError(H: ArrayLike<number>, x1: number, y1: number, x2: number, y2: number): number {
  const [u, v] = applyH(H, x1, y1);
  const e = (u - x2) ** 2 + (v - y2) ** 2;
  return Number.isFinite(e) ? e : Infinity;
}

export function ransacHomography(x1: Pts, x2: Pts, options: { threshold?: number; maxIterations?: number; seed?: number } = {}): RansacResult | null {
  const n = x1.length / 2;
  if (n < 4) return null;
  const th2 = (options.threshold ?? 1.5) ** 2;
  const maxIt = options.maxIterations ?? 500;
  const pick = sampler(options.seed ?? 11);
  let best: number[] | null = null;
  let bestCount = -1;
  let needed = maxIt;
  for (let it = 0; it < Math.min(maxIt, needed); it += 1) {
    const s = pick(n, 4);
    const H = dltHomography(x1, x2, s);
    if (!H) continue;
    let c = 0;
    for (let i = 0; i < n; i += 1) if (transferError(H, x1[2 * i]!, x1[2 * i + 1]!, x2[2 * i]!, x2[2 * i + 1]!) < th2) c += 1;
    if (c > bestCount) {
      bestCount = c;
      best = H;
      needed = iterationsFor(c / n, 4);
    }
  }
  if (!best) return null;
  for (let r = 0; r < 2; r += 1) {
    const idx: number[] = [];
    for (let i = 0; i < n; i += 1) if (transferError(best, x1[2 * i]!, x1[2 * i + 1]!, x2[2 * i]!, x2[2 * i + 1]!) < th2) idx.push(i);
    if (idx.length < 4) break;
    const H = dltHomography(x1, x2, idx);
    if (H) best = H;
  }
  const errors = new Float64Array(n);
  const inliers = new Uint8Array(n);
  let count = 0;
  for (let i = 0; i < n; i += 1) {
    errors[i] = transferError(best, x1[2 * i]!, x1[2 * i + 1]!, x2[2 * i]!, x2[2 * i + 1]!);
    if (errors[i]! < th2) {
      inliers[i] = 1;
      count += 1;
    }
  }
  return { model: best, inliers, count, errors };
}

/**
 * Torr's Geometric Robust Information Criterion. Lower is better.
 * d: manifold dimension (F: 3, H: 2), k: model parameters (F: 7, H: 8),
 * r: data dimension (4 for two views), sigma: noise in pixels.
 */
export function gric(errors2: ArrayLike<number>, sigma: number, d: number, k: number): number {
  const n = errors2.length;
  const r = 4;
  const l1 = Math.log(r);
  const l2 = Math.log(r * n);
  const l3 = 2;
  let s = 0;
  const cap = l3 * (r - d);
  for (let i = 0; i < n; i += 1) s += Math.min(errors2[i]! / (sigma * sigma), cap);
  return s + l1 * d * n + l2 * k;
}

/** Project a 3×3 onto the essential manifold (singular values 1, 1, 0). */
export function toEssential(E: ArrayLike<number>): number[] {
  const { u, v } = svd3(E);
  return mul3(mul3(u, [1, 0, 0, 0, 1, 0, 0, 0, 0]), t3(v));
}

/** Essential matrix from normalised (calibrated) coordinates via the normalised 8-point algorithm. */
export function essentialFromNormalised(x1: Pts, x2: Pts, indices?: ArrayLike<number>): number[] | null {
  const F = eightPoint(x1, x2, indices);
  return F ? toEssential(F) : null;
}

/** RANSAC for E on normalised coordinates; threshold in pixels (given focal f in pixels). */
export function ransacEssential(x1: Pts, x2: Pts, f: number, options: { threshold?: number; maxIterations?: number; seed?: number } = {}): RansacResult | null {
  const r = ransacFundamental(x1, x2, { threshold: (options.threshold ?? 1) / f, maxIterations: options.maxIterations ?? 500, seed: options.seed ?? 13 });
  if (!r) return null;
  return { ...r, model: toEssential(r.model) };
}

/** The four (R, t) a calibrated pair's E allows; t has unit length. */
export function decomposeEssential(E: ArrayLike<number>): { R: number[]; t: number[] }[] {
  let { u, v } = svd3(E);
  if (det3(u) < 0) u = u.map((x, i) => (i % 3 === 2 ? -x : x));
  if (det3(v) < 0) v = v.map((x, i) => (i % 3 === 2 ? -x : x));
  const W = [0, -1, 0, 1, 0, 0, 0, 0, 1];
  const R1 = mul3(mul3(u, W), t3(v));
  const R2 = mul3(mul3(u, t3(W)), t3(v));
  const t = [u[2]!, u[5]!, u[8]!];
  const neg = t.map((x) => -x);
  return [
    { R: R1, t },
    { R: R1, t: neg },
    { R: R2, t },
    { R: R2, t: neg },
  ];
}

/**
 * Linear triangulation (DLT) of one point from normalised rays in several
 * views with poses (R, t). Returns the inhomogeneous point or null.
 */
export function triangulateLinear(views: readonly { R: ArrayLike<number>; t: ArrayLike<number>; x: number; y: number }[]): number[] | null {
  const m = views.length;
  if (m < 2) return null;
  // Rows: x·P3 − P1, y·P3 − P2 with P = [R | t]. Solve the 4-column system via its 4×4 normal matrix.
  const A = new Mat(2 * m, 4);
  views.forEach((v, i) => {
    const R = v.R;
    const t = v.t;
    const P1 = [R[0]!, R[1]!, R[2]!, t[0]!];
    const P2 = [R[3]!, R[4]!, R[5]!, t[1]!];
    const P3 = [R[6]!, R[7]!, R[8]!, t[2]!];
    for (let k = 0; k < 4; k += 1) {
      A.data[2 * i * 4 + k] = v.x * P3[k]! - P1[k]!;
      A.data[(2 * i + 1) * 4 + k] = v.y * P3[k]! - P2[k]!;
    }
  });
  const X = nullVector(A);
  if (Math.abs(X[3]!) < 1e-12) return null;
  return [X[0]! / X[3]!, X[1]! / X[3]!, X[2]! / X[3]!];
}

/** Two-ray triangulation by midpoint-free DLT for the common two-view case. */
export function triangulateTwo(R1: ArrayLike<number>, t1: ArrayLike<number>, a: [number, number], R2: ArrayLike<number>, t2: ArrayLike<number>, b: [number, number]): number[] | null {
  return triangulateLinear([
    { R: R1, t: t1, x: a[0], y: a[1] },
    { R: R2, t: t2, x: b[0], y: b[1] },
  ]);
}

/** Angle (radians) between the rays from two camera centres to X. */
export function rayAngle(C1: ArrayLike<number>, C2: ArrayLike<number>, X: ArrayLike<number>): number {
  const a = [X[0]! - C1[0]!, X[1]! - C1[1]!, X[2]! - C1[2]!];
  const b = [X[0]! - C2[0]!, X[1]! - C2[1]!, X[2]! - C2[2]!];
  const c = (a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!) / (Math.hypot(...a) * Math.hypot(...b));
  return Math.acos(Math.max(-1, Math.min(1, c)));
}

export function depthIn(R: ArrayLike<number>, t: ArrayLike<number>, X: ArrayLike<number>): number {
  return R[6]! * X[0]! + R[7]! * X[1]! + R[8]! * X[2]! + t[2]!;
}

/**
 * Pick the (R, t) of E for which the most correspondences triangulate in
 * front of both cameras. Camera 1 is [I | 0].
 */
export function poseFromEssential(E: ArrayLike<number>, x1: Pts, x2: Pts, inliers?: Uint8Array): { R: number[]; t: number[]; front: number; tested: number } {
  const n = x1.length / 2;
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const z = [0, 0, 0];
  let best = { R: I, t: [0, 0, 1], front: -1, tested: 0 };
  for (const cand of decomposeEssential(E)) {
    let front = 0;
    let tested = 0;
    for (let i = 0; i < n; i += 1) {
      if (inliers && !inliers[i]) continue;
      tested += 1;
      const X = triangulateTwo(I, z, [x1[2 * i]!, x1[2 * i + 1]!], cand.R, cand.t, [x2[2 * i]!, x2[2 * i + 1]!]);
      if (X && X[2]! > 0 && depthIn(cand.R, cand.t, X) > 0) front += 1;
    }
    if (front > best.front) best = { ...cand, front, tested };
  }
  return best;
}

/** E = [t]× R. */
export function essentialFromPose(R: ArrayLike<number>, t: ArrayLike<number>): number[] {
  const tx = [0, -t[2]!, t[1]!, t[2]!, 0, -t[0]!, -t[1]!, t[0]!, 0];
  return mul3(tx, R);
}

/**
 * Self-calibration cost of a focal length for a fundamental matrix (Mendonça
 * & Cipolla): with K = diag(f, f, 1) about the principal point, E = KᵀFK has
 * two equal singular values exactly when f is right.
 */
export function essentialCost(F: ArrayLike<number>, f: number): number {
  // F is in principal-point-centred pixel coordinates.
  const K = [f, 0, 0, 0, f, 0, 0, 0, 1];
  const E = mul3(mul3(K, F), K);
  const { s } = svd3(E);
  return s[1]! > 0 ? (s[0]! - s[1]!) / (s[0]! + s[1]!) : 1;
}

/** Translate F from pixel coordinates to coordinates centred on the principal point. */
export function centreFundamental(F: ArrayLike<number>, cx: number, cy: number): number[] {
  const T = [1, 0, cx, 0, 1, cy, 0, 0, 1];
  return mul3(mul3(t3(T), F), T);
}

/** Rotation-only self-calibration cost: K⁻¹HK should be a (scaled) rotation. H in centred pixel coordinates. */
export function rotationHomographyCost(H: ArrayLike<number>, f: number): number {
  const K = [f, 0, 0, 0, f, 0, 0, 0, 1];
  const Ki = [1 / f, 0, 0, 0, 1 / f, 0, 0, 0, 1];
  const R = mul3(mul3(Ki, H), K);
  const d = det3(R);
  if (!(Math.abs(d) > 1e-12)) return 10;
  const s = Math.cbrt(d);
  const Rn = R.map((x) => x / s);
  const RRt = mul3(Rn, t3(Rn));
  return Math.hypot(RRt[0]! - 1, RRt[1]!, RRt[2]!, RRt[3]!, RRt[4]! - 1, RRt[5]!, RRt[6]!, RRt[7]!, RRt[8]! - 1);
}

export { cross, mulv3 };
