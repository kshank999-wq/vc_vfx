import type { TexturePlane } from '@vcvfx/domain';
import { symEig, Mat } from '../camera/linalg';
import { voxelDownsample, type PointCloud } from '../camera/lidar';
import { rng } from '../roto/image';
import { cross, dot3, fromCanonical, toCanonical, unit, type V3 } from './geometry';

/**
 * The dominant planes of a scan (master spec §12 "assist in mapping those
 * textures back onto the scanned environment"; addendum 12 §3.4): the walls,
 * floor and ceiling a texture goes back onto.
 *
 * Sequential RANSAC on the scan (voxel-downsampled to about 60 000 points):
 * three random points propose a plane, the one with the most points within
 * `threshold` wins, it is refitted to its inliers by least squares (the
 * smallest eigenvector of their covariance) and its inliers are taken away;
 * again until what is left is too small to be a surface. Planes are reported
 * in the scan's own coordinates, their normals facing the middle of the scan
 * (where it was seen from), with in-plane axes (u horizontal where it can be)
 * and the inliers' extent, and named by which way they face.
 */

export interface PlaneFitOptions {
  /** Inlier distance, scan units. */
  threshold: number;
  up: 'y' | 'z';
  maxPlanes?: number;
  /** A plane needs at least this share of the (downsampled) points. */
  minShare?: number;
  iterations?: number;
  seed?: number;
}

export interface FittedPlane extends TexturePlane {
  /** Indices of the inliers in the downsampled cloud (for drawing). */
  members: Uint32Array;
}

function fitLeastSquares(P: Float64Array, idx: ArrayLike<number>): { n: V3; d: number; c: V3 } {
  let cx = 0;
  let cy = 0;
  let cz = 0;
  const m = idx.length;
  for (let i = 0; i < m; i += 1) {
    const k = 3 * idx[i]!;
    cx += P[k]!;
    cy += P[k + 1]!;
    cz += P[k + 2]!;
  }
  cx /= m;
  cy /= m;
  cz /= m;
  const C = new Mat(3, 3);
  for (let i = 0; i < m; i += 1) {
    const k = 3 * idx[i]!;
    const d = [P[k]! - cx, P[k + 1]! - cy, P[k + 2]! - cz];
    for (let a = 0; a < 3; a += 1) for (let b = 0; b < 3; b += 1) C.data[a * 3 + b]! += d[a]! * d[b]!;
  }
  const { values, vectors } = symEig(C);
  let j = 0;
  for (let i = 1; i < 3; i += 1) if (values[i]! < values[j]!) j = i;
  const n = unit([vectors.data[0 * 3 + j]!, vectors.data[1 * 3 + j]!, vectors.data[2 * 3 + j]!]);
  return { n, d: n[0] * cx + n[1] * cy + n[2] * cz, c: [cx, cy, cz] };
}

const AXES = ['X', 'Y', 'Z'] as const;

/** "floor", "ceiling", "wall facing −Y" … from a normal in scan coordinates. */
export function planeLabel(n: ArrayLike<number>, up: 'y' | 'z'): string {
  const c = toCanonical(n, up);
  if (c[1] > 0.8) return 'floor';
  if (c[1] < -0.8) return 'ceiling';
  // The dominant horizontal axis of the scan's own coordinates.
  const upIndex = up === 'z' ? 2 : 1;
  let best = -1;
  for (let i = 0; i < 3; i += 1) if (i !== upIndex && (best < 0 || Math.abs(n[i]!) > Math.abs(n[best]!))) best = i;
  return `wall facing ${n[best]! >= 0 ? '+' : '−'}${AXES[best]}`;
}

export function fitPlanes(cloud: PointCloud, o: PlaneFitOptions): FittedPlane[] {
  const ext = [0, 1, 2].map((k) => cloud.bbox.max[k]! - cloud.bbox.min[k]!);
  const diag = Math.hypot(...ext);
  // About 60 000 points: one per voxel.
  const area = ext[0]! * ext[1]! + ext[1]! * ext[2]! + ext[0]! * ext[2]!;
  const voxel = cloud.count > 60_000 ? Math.sqrt(Math.max(1e-12, area) / 60_000) : 0;
  const c = voxel > 0 ? voxelDownsample(cloud, voxel) : cloud;
  const N = c.count;
  const P = new Float64Array(N * 3);
  for (let i = 0; i < N; i += 1) for (let k = 0; k < 3; k += 1) P[3 * i + k] = c.positions[3 * i + k]! + c.origin[k]!;
  const centre: V3 = [0, 0, 0];
  for (let i = 0; i < N; i += 1) for (let k = 0; k < 3; k += 1) centre[k]! += P[3 * i + k]! / N;
  const t = Math.min(o.threshold, diag * 0.02);
  const minCount = Math.max(60, Math.round((o.minShare ?? 0.03) * N));
  const iterations = o.iterations ?? 400;
  const rand = rng(o.seed ?? 7);
  const alive = new Uint8Array(N).fill(1);
  let remaining = N;
  const planes: FittedPlane[] = [];
  const upC = fromCanonical([0, 1, 0], o.up);
  for (let p = 0; p < (o.maxPlanes ?? 10) && remaining >= minCount; p += 1) {
    const live: number[] = [];
    for (let i = 0; i < N; i += 1) if (alive[i]) live.push(i);
    // Score candidates on a sample of what is left; the winner is counted on all of it.
    const sample = live.length > 6000 ? Array.from({ length: 6000 }, () => live[Math.floor(rand() * live.length)]!) : live;
    let best: { n: V3; d: number; score: number } | null = null;
    for (let it = 0; it < iterations; it += 1) {
      const a = live[Math.floor(rand() * live.length)]!;
      const b = live[Math.floor(rand() * live.length)]!;
      const q = live[Math.floor(rand() * live.length)]!;
      const A: V3 = [P[3 * a]!, P[3 * a + 1]!, P[3 * a + 2]!];
      const n0 = cross([P[3 * b]! - A[0], P[3 * b + 1]! - A[1], P[3 * b + 2]! - A[2]], [P[3 * q]! - A[0], P[3 * q + 1]! - A[1], P[3 * q + 2]! - A[2]]);
      const l = Math.hypot(...n0);
      if (l < 1e-12) continue;
      const n: V3 = [n0[0] / l, n0[1] / l, n0[2] / l];
      const d = dot3(n, A);
      let score = 0;
      for (const i of sample) if (Math.abs(n[0] * P[3 * i]! + n[1] * P[3 * i + 1]! + n[2] * P[3 * i + 2]! - d) < t) score += 1;
      if (!best || score > best.score) best = { n, d, score };
    }
    if (!best) break;
    let inl = live.filter((i) => Math.abs(best!.n[0] * P[3 * i]! + best!.n[1] * P[3 * i + 1]! + best!.n[2] * P[3 * i + 2]! - best!.d) < t);
    if (inl.length < minCount) break;
    // Refit, recount, refit.
    let fit = fitLeastSquares(P, inl);
    for (let r = 0; r < 2; r += 1) {
      inl = live.filter((i) => Math.abs(fit.n[0] * P[3 * i]! + fit.n[1] * P[3 * i + 1]! + fit.n[2] * P[3 * i + 2]! - fit.d) < t);
      fit = fitLeastSquares(P, inl);
    }
    for (const i of inl) alive[i] = 0;
    remaining -= inl.length;
    // Face the middle of the scan.
    let { n, d } = fit;
    if (dot3(n, centre) - d < 0) {
      n = [-n[0], -n[1], -n[2]];
      d = -d;
    }
    // In-plane axes: u horizontal (up × n) for a wall; the scan's X for a floor or ceiling.
    let u = cross(upC, n);
    if (Math.hypot(...u) < 0.3) {
      const x: V3 = [1, 0, 0];
      u = [x[0] - n[0] * n[0], x[1] - n[0] * n[1], x[2] - n[0] * n[2]];
    }
    u = unit(u);
    const v = cross(n, u);
    const us: number[] = [];
    const vs: number[] = [];
    let ss = 0;
    for (const i of inl) {
      const q: V3 = [P[3 * i]! - fit.c[0], P[3 * i + 1]! - fit.c[1], P[3 * i + 2]! - fit.c[2]];
      us.push(dot3(q, u));
      vs.push(dot3(q, v));
      const dist = n[0] * P[3 * i]! + n[1] * P[3 * i + 1]! + n[2] * P[3 * i + 2]! - d;
      ss += dist * dist;
    }
    us.sort((x, y) => x - y);
    vs.sort((x, y) => x - y);
    const at = (a: number[], q: number) => a[Math.min(a.length - 1, Math.max(0, Math.round(q * (a.length - 1))))]!;
    const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
    planes.push({
      id: `p${planes.length + 1}`,
      label: planeLabel(n, o.up),
      normal: n.map(r6) as V3,
      d: r6(d),
      centroid: fit.c.map(r6) as V3,
      axisU: u.map(r6) as V3,
      axisV: v.map(r6) as V3,
      extent: { u0: r6(at(us, 0.01)), u1: r6(at(us, 0.99)), v0: r6(at(vs, 0.01)), v1: r6(at(vs, 0.99)) },
      inliers: inl.length,
      rms: r6(Math.sqrt(ss / inl.length)),
      members: Uint32Array.from(inl),
    });
  }
  // The same label twice gets a number.
  const seen = new Map<string, number>();
  for (const pl of planes) {
    const k = (seen.get(pl.label) ?? 0) + 1;
    seen.set(pl.label, k);
    if (k > 1) pl.label = `${pl.label} (${k})`;
  }
  return planes;
}

/** Where a ray (origin o, direction d, scan coordinates) meets a plane, inside its extent (with a margin); null when it does not. */
export function hitPlane(pl: TexturePlane, o: ArrayLike<number>, d: ArrayLike<number>, margin = 0.1): { t: number; point: V3; inside: boolean } | null {
  const den = dot3(pl.normal, d);
  if (Math.abs(den) < 1e-9) return null;
  const t = (pl.d - dot3(pl.normal, o)) / den;
  if (!(t > 1e-6)) return null;
  const point: V3 = [o[0]! + t * d[0]!, o[1]! + t * d[1]!, o[2]! + t * d[2]!];
  const q = [point[0] - pl.centroid[0], point[1] - pl.centroid[1], point[2] - pl.centroid[2]];
  const u = dot3(q, pl.axisU);
  const v = dot3(q, pl.axisV);
  const mu = margin * (pl.extent.u1 - pl.extent.u0);
  const mv = margin * (pl.extent.v1 - pl.extent.v0);
  const inside = u >= pl.extent.u0 - mu && u <= pl.extent.u1 + mu && v >= pl.extent.v0 - mv && v <= pl.extent.v1 + mv;
  return { t, point, inside };
}

/** The nearest plane a ray meets inside its extent. */
export function firstHit(planes: readonly TexturePlane[], o: ArrayLike<number>, d: ArrayLike<number>): { plane: TexturePlane; t: number; point: V3 } | null {
  let best: { plane: TexturePlane; t: number; point: V3 } | null = null;
  for (const pl of planes) {
    const h = hitPlane(pl, o, d);
    if (h && h.inside && (!best || h.t < best.t)) best = { plane: pl, t: h.t, point: h.point };
  }
  return best;
}
