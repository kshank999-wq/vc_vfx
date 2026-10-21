import { Mat, cross, det3, mul3, mulv3, normalize3, svd, symEig, t3 } from './linalg';

/**
 * Rigid and similarity alignment (addendum 06): Umeyama's closed form for the
 * similarity between two corresponding point sets, the same with weights,
 * applying a similarity to a solve, and point-to-plane ICP with normals
 * estimated from k nearest neighbours for refining a solve against a LiDAR
 * cloud.
 */

export interface Similarity {
  /** Scale. */
  s: number;
  /** Rotation, row-major 3×3. */
  R: number[];
  /** Translation. */
  t: number[];
}

export const IDENTITY_SIM: Similarity = { s: 1, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

export function applySim(T: Similarity, X: ArrayLike<number>): number[] {
  const r = mulv3(T.R, X);
  return [T.s * r[0]! + T.t[0]!, T.s * r[1]! + T.t[1]!, T.s * r[2]! + T.t[2]!];
}

export function composeSim(a: Similarity, b: Similarity): Similarity {
  // a ∘ b: X ↦ a(b(X)) = sa Ra (sb Rb X + tb) + ta
  return { s: a.s * b.s, R: mul3(a.R, b.R), t: applySim(a, b.t) };
}

export function invertSim(a: Similarity): Similarity {
  const Rt = t3(a.R);
  const t = mulv3(Rt, a.t).map((v) => -v / a.s);
  return { s: 1 / a.s, R: Rt, t };
}

/**
 * Umeyama (1991): the similarity (s, R, t) minimising Σ w‖dst − (s R src + t)‖².
 * `allowScale` false gives the rigid (Kabsch) fit. Points are flat [x, y, z, …].
 */
export function umeyama(src: ArrayLike<number>, dst: ArrayLike<number>, options: { weights?: ArrayLike<number>; allowScale?: boolean } = {}): Similarity & { rms: number } {
  const n = src.length / 3;
  if (n < 3) throw new Error('Umeyama needs at least 3 points');
  const w = options.weights;
  let ws = 0;
  const ms = [0, 0, 0];
  const md = [0, 0, 0];
  for (let i = 0; i < n; i += 1) {
    const wi = w ? w[i]! : 1;
    ws += wi;
    for (let k = 0; k < 3; k += 1) {
      ms[k]! += wi * src[3 * i + k]!;
      md[k]! += wi * dst[3 * i + k]!;
    }
  }
  for (let k = 0; k < 3; k += 1) {
    ms[k]! /= ws;
    md[k]! /= ws;
  }
  const C = new Array<number>(9).fill(0);
  let varS = 0;
  for (let i = 0; i < n; i += 1) {
    const wi = w ? w[i]! : 1;
    const a = [src[3 * i]! - ms[0]!, src[3 * i + 1]! - ms[1]!, src[3 * i + 2]! - ms[2]!];
    const b = [dst[3 * i]! - md[0]!, dst[3 * i + 1]! - md[1]!, dst[3 * i + 2]! - md[2]!];
    varS += wi * (a[0]! ** 2 + a[1]! ** 2 + a[2]! ** 2);
    for (let r = 0; r < 3; r += 1) for (let c = 0; c < 3; c += 1) C[r * 3 + c]! += wi * b[r]! * a[c]!;
  }
  for (let k = 0; k < 9; k += 1) C[k]! /= ws;
  varS /= ws;
  const d = svd(new Mat(3, 3, C));
  const U = Array.from(d.u.data);
  const V = Array.from(d.v.data);
  const S = [1, 1, det3(U) * det3(V) < 0 ? -1 : 1];
  const R = mul3(mul3(U, [S[0]!, 0, 0, 0, S[1]!, 0, 0, 0, S[2]!]), t3(V));
  const trace = d.s[0]! * S[0]! + d.s[1]! * S[1]! + d.s[2]! * S[2]!;
  const s = options.allowScale === false || varS <= 0 ? 1 : trace / varS;
  const Rm = mulv3(R, ms);
  const t = [md[0]! - s * Rm[0]!, md[1]! - s * Rm[1]!, md[2]! - s * Rm[2]!];
  let e = 0;
  for (let i = 0; i < n; i += 1) {
    const p = applySim({ s, R, t }, [src[3 * i]!, src[3 * i + 1]!, src[3 * i + 2]!]);
    e += (p[0]! - dst[3 * i]!) ** 2 + (p[1]! - dst[3 * i + 1]!) ** 2 + (p[2]! - dst[3 * i + 2]!) ** 2;
  }
  return { s, R, t, rms: Math.sqrt(e / n) };
}

// ---------------------------------------------------------------------------
// Nearest neighbours: a uniform grid (clouds are roughly uniform after voxel
// downsampling, which is what ICP runs on).
// ---------------------------------------------------------------------------

export class PointGrid {
  readonly cell: number;
  private readonly map = new Map<number, number[]>();

  constructor(
    readonly points: Float32Array | Float64Array,
    cell?: number,
  ) {
    const n = points.length / 3;
    let lo = [Infinity, Infinity, Infinity];
    let hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i += 1)
      for (let k = 0; k < 3; k += 1) {
        lo[k] = Math.min(lo[k]!, points[3 * i + k]!);
        hi[k] = Math.max(hi[k]!, points[3 * i + k]!);
      }
    const vol = Math.max(1e-12, (hi[0]! - lo[0]!) * (hi[1]! - lo[1]!) * (hi[2]! - lo[2]!));
    // ≈ 8 points per cell on average.
    this.cell = cell ?? Math.max(1e-6, Math.cbrt((vol / Math.max(1, n)) * 8));
    for (let i = 0; i < n; i += 1) {
      const key = this.keyOf(points[3 * i]!, points[3 * i + 1]!, points[3 * i + 2]!);
      const list = this.map.get(key);
      if (list) list.push(i);
      else this.map.set(key, [i]);
    }
    lo = hi = [];
  }

  private keyOf(x: number, y: number, z: number): number {
    return PointGrid.key(Math.floor(x / this.cell), Math.floor(y / this.cell), Math.floor(z / this.cell));
  }

  /** Exact integer key for cell indices within ±10⁵ (beyond that, cells are merged, which only costs time). */
  private static key(ix: number, iy: number, iz: number): number {
    const c = (v: number) => Math.min(199999, Math.max(0, v + 100000));
    return c(ix) + c(iy) * 200000 + c(iz) * 40000000000;
  }

  /** The k nearest points to (x, y, z) within `maxRadius`: indices, nearest first. */
  nearest(x: number, y: number, z: number, k: number, maxRadius = Infinity): { index: number; d2: number }[] {
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    const cz = Math.floor(z / this.cell);
    const found: { index: number; d2: number }[] = [];
    const maxRing = Math.min(64, Number.isFinite(maxRadius) ? Math.ceil(maxRadius / this.cell) + 1 : 64);
    for (let ring = 0; ring <= maxRing; ring += 1) {
      for (let dx = -ring; dx <= ring; dx += 1)
        for (let dy = -ring; dy <= ring; dy += 1)
          for (let dz = -ring; dz <= ring; dz += 1) {
            if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== ring) continue;
            const list = this.map.get(PointGrid.key(cx + dx, cy + dy, cz + dz));
            if (!list) continue;
            for (const i of list) {
              const d2 = (this.points[3 * i]! - x) ** 2 + (this.points[3 * i + 1]! - y) ** 2 + (this.points[3 * i + 2]! - z) ** 2;
              if (d2 <= maxRadius * maxRadius) found.push({ index: i, d2 });
            }
          }
      // Everything within ring·cell is final once we have k of them that close.
      if (found.length >= k) {
        found.sort((a, b) => a.d2 - b.d2);
        if (found[k - 1]!.d2 <= (ring * this.cell) ** 2) return found.slice(0, k);
      }
    }
    found.sort((a, b) => a.d2 - b.d2);
    return found.slice(0, k);
  }
}

/** Unit normals by PCA of each point's k nearest neighbours (smallest eigenvector). */
export function estimateNormals(points: Float32Array | Float64Array, k = 12, grid = new PointGrid(points)): Float32Array {
  const n = points.length / 3;
  const normals = new Float32Array(points.length);
  for (let i = 0; i < n; i += 1) {
    const nb = grid.nearest(points[3 * i]!, points[3 * i + 1]!, points[3 * i + 2]!, k);
    if (nb.length < 3) continue;
    const m = [0, 0, 0];
    for (const { index } of nb) for (let c = 0; c < 3; c += 1) m[c]! += points[3 * index + c]! / nb.length;
    const C = new Mat(3, 3);
    for (const { index } of nb) {
      const d = [points[3 * index]! - m[0]!, points[3 * index + 1]! - m[1]!, points[3 * index + 2]! - m[2]!];
      for (let r = 0; r < 3; r += 1) for (let c = 0; c < 3; c += 1) C.data[r * 3 + c]! += d[r]! * d[c]!;
    }
    const { vectors } = symEig(C);
    const nv = normalize3([vectors.get(0, 0), vectors.get(1, 0), vectors.get(2, 0)]);
    normals.set(nv, 3 * i);
  }
  return normals;
}

export interface IcpResult {
  transform: Similarity;
  iterations: number;
  /** RMS point-to-plane distance of the kept pairs, cloud units. */
  rms: number;
  /** Pairs kept in the last iteration. */
  pairs: number;
}

/**
 * Point-to-plane ICP: refine `initial` (src → cloud) so the transformed `src`
 * points lie on the cloud's surface. Each iteration pairs every source point
 * with its nearest cloud point (rejecting pairs beyond `maxDistance`), then
 * solves the linearised point-to-plane problem for a small rotation,
 * translation and (optionally) scale change.
 */
export function icpPointToPlane(
  src: ArrayLike<number>,
  cloud: Float32Array | Float64Array,
  normals: Float32Array,
  initial: Similarity,
  options: { maxDistance: number; iterations?: number; allowScale?: boolean; grid?: PointGrid } = { maxDistance: 1 },
): IcpResult {
  const grid = options.grid ?? new PointGrid(cloud);
  let T: Similarity = { s: initial.s, R: [...initial.R], t: [...initial.t] };
  const n = src.length / 3;
  let rms = Infinity;
  let pairs = 0;
  let it = 0;
  const maxD = options.maxDistance;
  for (it = 0; it < (options.iterations ?? 30); it += 1) {
    // Unknowns: ω (3), δt (3), δs (1 if scale) — on points transformed by T.
    const nu = options.allowScale ? 7 : 6;
    const A = new Mat(nu, nu);
    const b = new Float64Array(nu);
    let e2 = 0;
    pairs = 0;
    for (let i = 0; i < n; i += 1) {
      const p = applySim(T, [src[3 * i]!, src[3 * i + 1]!, src[3 * i + 2]!]);
      const nb = grid.nearest(p[0]!, p[1]!, p[2]!, 1, maxD);
      if (!nb.length) continue;
      const q = nb[0]!.index;
      const nq = [normals[3 * q]!, normals[3 * q + 1]!, normals[3 * q + 2]!];
      if (nq[0] === 0 && nq[1] === 0 && nq[2] === 0) continue;
      const d = (p[0]! - cloud[3 * q]!) * nq[0]! + (p[1]! - cloud[3 * q + 1]!) * nq[1]! + (p[2]! - cloud[3 * q + 2]!) * nq[2]!;
      // The update turns and scales about the current translation:
      // r(ω, δt, δs) ≈ d + (ω × (p − t))·n + δt·n + δs (p − t)·n
      const rel = [p[0]! - T.t[0]!, p[1]! - T.t[1]!, p[2]! - T.t[2]!];
      const pxn = cross(rel, nq);
      const J = [pxn[0]!, pxn[1]!, pxn[2]!, nq[0]!, nq[1]!, nq[2]!, rel[0]! * nq[0]! + rel[1]! * nq[1]! + rel[2]! * nq[2]!];
      // Robust (Huber at maxD / 3).
      const hd = maxD / 3;
      const w = Math.abs(d) <= hd ? 1 : hd / Math.abs(d);
      for (let r = 0; r < nu; r += 1) {
        b[r]! -= w * J[r]! * d;
        for (let c = 0; c < nu; c += 1) A.data[r * nu + c]! += w * J[r]! * J[c]!;
      }
      e2 += d * d;
      pairs += 1;
    }
    if (pairs < nu) break;
    for (let r = 0; r < nu; r += 1) A.data[r * nu + r]! += 1e-9;
    const x = (() => {
      try {
        // Small symmetric system.
        const l = symEig(A);
        // Solve via eigen decomposition, dropping near-null directions.
        const out = new Float64Array(nu);
        const maxEv = l.values[nu - 1]!;
        for (let k = 0; k < nu; k += 1) {
          const ev = l.values[k]!;
          if (ev < maxEv * 1e-10) continue;
          let proj = 0;
          for (let r = 0; r < nu; r += 1) proj += l.vectors.get(r, k) * b[r]!;
          for (let r = 0; r < nu; r += 1) out[r]! += (proj / ev) * l.vectors.get(r, k);
        }
        return out;
      } catch {
        return null;
      }
    })();
    if (!x) break;
    const w = [x[0]!, x[1]!, x[2]!];
    const theta = Math.hypot(...w);
    const dR = theta > 1e-12 ? axisAngle(w) : [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const ds = options.allowScale ? 1 + x[6]! : 1;
    // New T: X ↦ ds·dR·(T(X) − T.t) + T.t + δt  (scale and rotate about the current translation)
    const R = mul3(dR, T.R);
    const s = T.s * ds;
    const t = [T.t[0]! + x[3]!, T.t[1]! + x[4]!, T.t[2]! + x[5]!];
    T = { s, R, t };
    const prev = rms;
    rms = Math.sqrt(e2 / pairs);
    if (Math.abs(prev - rms) < 1e-9 * Math.max(1, rms) && theta < 1e-9) break;
  }
  return { transform: T, iterations: it, rms, pairs };
}

function axisAngle(w: number[]): number[] {
  const th = Math.hypot(w[0]!, w[1]!, w[2]!);
  const k = [w[0]! / th, w[1]! / th, w[2]! / th];
  const c = Math.cos(th);
  const s = Math.sin(th);
  const v = 1 - c;
  return [
    c + k[0]! * k[0]! * v, k[0]! * k[1]! * v - k[2]! * s, k[0]! * k[2]! * v + k[1]! * s,
    k[1]! * k[0]! * v + k[2]! * s, c + k[1]! * k[1]! * v, k[1]! * k[2]! * v - k[0]! * s,
    k[2]! * k[0]! * v - k[1]! * s, k[2]! * k[1]! * v + k[0]! * s, c + k[2]! * k[2]! * v,
  ];
}
