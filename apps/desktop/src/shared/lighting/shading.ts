import type { LinearImage } from '../key/linear';
import { DEG, cameraToLevel, dot, norm, percentile, rng, stddev, type PinholeCamera, type V3 } from './geometry';

/**
 * Shading-based light directions (addendum 14 §3.1).
 *
 * The subject's matte gives its silhouette. On the occluding contour the
 * surface normal is exactly the outward 2-D normal of the silhouette (its
 * z is 0); inside, the normal is inflated from the silhouette as a sphere's
 * would be: its in-image direction is towards the nearest silhouette point
 * (an exact Euclidean feature transform), its tilt 1 − d/R from the distance
 * d to the silhouette and the subject's largest inscribed radius R. On a
 * sphere these are exact; on other shapes approximate, which the ranges
 * allow for.
 *
 * The plate's luminance on those normals is fitted with a low-order lighting
 * model: an even ambient term plus a key — a source of angular radius α whose
 * irradiance is the clamped cosine with a soft terminator,
 *
 *   s(x) = x                      for x ≥ sin α
 *        = (x + sin α)² / 4 sin α for |x| < sin α      (x = n·L)
 *        = 0                      for x ≤ −sin α
 *
 * — searched over the whole sphere of directions and every softness, then a
 * fill (a second such source) fitted on what is left, and the key refined
 * again with the fill held. The ranges come from a bootstrap over the
 * samples, floored by how far the shading model can be trusted (its
 * residual, and how sphere-like the silhouette is). Bright, unexplained light
 * along the silhouette is a rim or back light. With the geometry held, each
 * light's colour is fitted per channel.
 */

export interface NormalField {
  width: number;
  height: number;
  /** Unit normals in camera coordinates (x right, y up, z to the camera); NaN outside the subject. */
  normals: Float32Array;
  /** 1 inside the subject. */
  mask: Uint8Array;
  /** Distance to the silhouette, pixels. */
  dist: Float32Array;
  /** The subject's largest inscribed radius, pixels. */
  radius: number;
  /** How sphere-like the silhouette is: 1 for a disk. */
  roundness: number;
  /** The matte's coverage (pixels part-covered at the silhouette mix in the background and are not sampled). */
  cover: Float32Array;
  /** The subject's pixel count and its bounding box. */
  count: number;
  box: { x0: number; y0: number; x1: number; y1: number };
}

const INF = 1e20;

/** 1-D squared distance transform with the index of the nearest zero (Felzenszwalb & Huttenlocher). */
function edt1d(f: Float64Array, n: number, d: Float64Array, idx: Int32Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q += 1) {
    let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) {
      k -= 1;
      s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    }
    k += 1;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q += 1) {
    while (z[k + 1]! < q) k += 1;
    d[q] = (q - v[k]!) ** 2 + f[v[k]!]!;
    idx[q] = v[k]!;
  }
}

/** Exact Euclidean distance to the nearest outside pixel, and which pixel it is. */
export function featureTransform(inside: Uint8Array, w: number, h: number): { dist: Float32Array; nearest: Int32Array } {
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const idx = new Int32Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const colD = new Float64Array(w * h);
  const colY = new Int32Array(w * h);
  for (let x = 0; x < w; x += 1) {
    for (let y = 0; y < h; y += 1) f[y] = inside[y * w + x] ? INF : 0;
    edt1d(f, h, d, idx, v, z);
    for (let y = 0; y < h; y += 1) {
      colD[y * w + x] = d[y]!;
      colY[y * w + x] = idx[y]!;
    }
  }
  const dist = new Float32Array(w * h);
  const nearest = new Int32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) f[x] = colD[y * w + x]!;
    edt1d(f, w, d, idx, v, z);
    for (let x = 0; x < w; x += 1) {
      const nx = idx[x]!;
      dist[y * w + x] = Math.sqrt(d[x]!);
      nearest[y * w + x] = colY[y * w + nx]! * w + nx;
    }
  }
  return { dist, nearest };
}

/** Separable gaussian blur of a single channel (edges clamped). */
export function gaussianBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(3 * sigma));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i += 1) sum += k[i + r] = Math.exp((-i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i += 1) k[i] = k[i]! / sum;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      let v = 0;
      for (let i = -r; i <= r; i += 1) v += k[i + r]! * src[y * w + Math.max(0, Math.min(w - 1, x + i))]!;
      tmp[y * w + x] = v;
    }
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      let v = 0;
      for (let i = -r; i <= r; i += 1) v += k[i + r]! * tmp[Math.max(0, Math.min(h - 1, y + i)) * w + x]!;
      out[y * w + x] = v;
    }
  return out;
}

/** The largest 4-connected component of a mask. */
export function largestComponent(mask: Uint8Array, w: number, h: number): Uint8Array {
  const label = new Int32Array(w * h).fill(-1);
  let best = -1;
  let bestSize = 0;
  const stack: number[] = [];
  let next = 0;
  for (let i = 0; i < w * h; i += 1) {
    if (!mask[i] || label[i]! >= 0) continue;
    let size = 0;
    stack.push(i);
    label[i] = next;
    while (stack.length) {
      const j = stack.pop()!;
      size += 1;
      const x = j % w;
      const y = (j - x) / w;
      const nb = [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, y > 0 ? j - w : -1, y < h - 1 ? j + w : -1];
      for (const k of nb) if (k >= 0 && mask[k] && label[k]! < 0) (label[k] = next), stack.push(k);
    }
    if (size > bestSize) (bestSize = size), (best = next);
    next += 1;
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i += 1) if (label[i] === best) out[i] = 1;
  return out;
}

/** Normals inflated from the subject's silhouette (null when the subject is too small to read). */
export function silhouetteNormals(matte: Float32Array, w: number, h: number, threshold = 0.5, cam: Pick<PinholeCamera, 'focalPx' | 'cx' | 'cy'> | null = null): NormalField | null {
  const raw = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i += 1) raw[i] = matte[i]! >= threshold ? 1 : 0;
  const mask = largestComponent(raw, w, h);
  let count = 0;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let i = 0; i < w * h; i += 1)
    if (mask[i]) {
      count += 1;
      const x = i % w;
      const y = (i - x) / w;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  if (count < 200) return null;
  // A signed distance to the silhouette (positive inside), sub-pixel from the matte's coverage at the edge, smoothed:
  // its gradient is the outward normal's in-image direction, its depth the inflation.
  const { dist } = featureTransform(mask, w, h);
  const outside = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i += 1) outside[i] = mask[i] ? 0 : 1;
  const { dist: distOut } = featureTransform(outside, w, h);
  const phi = new Float32Array(w * h);
  for (let i = 0; i < w * h; i += 1) {
    const c = matte[i]!;
    let v = mask[i] ? dist[i]! - 0.5 : -(distOut[i]! - 0.5);
    if (c > 0.01 && c < 0.99 && Math.abs(v) < 1.01) v = c - 0.5;
    phi[i] = v;
  }
  let R0 = 0;
  for (let i = 0; i < w * h; i += 1) if (mask[i] && phi[i]! > R0) R0 = phi[i]!;
  const sm = gaussianBlur(phi, w, h, Math.max(0.8, Math.min(3, R0 / 30)));
  let R = 0;
  for (let i = 0; i < w * h; i += 1) if (mask[i] && sm[i]! > R) R = sm[i]!;
  const Reff = Math.max(1, R);
  // Under perspective the silhouette's normals are square to the ray through the subject, not to the lens axis:
  // inflate in the subject's own view frame, then turn that frame's z onto the direction back to the camera.
  let rot: number[] | null = null;
  if (cam) {
    let mx = 0;
    let my = 0;
    for (let i = 0; i < w * h; i += 1)
      if (mask[i]) {
        mx += (i % w) + 0.5;
        my += (i - (i % w)) / w + 0.5;
      }
    mx /= count;
    my /= count;
    const back = norm([-(mx - cam.cx) / cam.focalPx, (my - cam.cy) / cam.focalPx, 1]);
    // Rotation taking (0,0,1) to `back` (Rodrigues).
    const v: V3 = [-back[1], back[0], 0];
    const c = back[2];
    const k = 1 / (1 + c);
    rot = [v[0] * v[0] * k + c, v[0] * v[1] * k - v[2], v[0] * v[2] * k + v[1], v[1] * v[0] * k + v[2], v[1] * v[1] * k + c, v[1] * v[2] * k - v[0], v[2] * v[0] * k - v[1], v[2] * v[1] * k + v[0], v[2] * v[2] * k + c];
  }
  // Under perspective a sphere shows less than a hemisphere: its silhouette's normals face the camera by
  // sin β (β its angular radius). A point at a fraction ρ of the silhouette's radius has the normal tilted by α
  // from the view axis with ρ = sin α · √(1 − k²) / (1 − k cos α), k = sin β: inverted by a table.
  const kk = cam ? Math.sin(Math.atan(Reff / cam.focalPx)) : 0;
  const alphaMax = Math.acos(kk);
  const table = new Float32Array(257);
  {
    const rhoOf = (a: number) => (Math.sin(a) * Math.sqrt(1 - kk * kk)) / (1 - kk * Math.cos(a));
    let a = 0;
    for (let i = 0; i <= 256; i += 1) {
      const target = i / 256;
      while (a < alphaMax && rhoOf(a) < target) a += alphaMax / 4096;
      table[i] = Math.min(a, alphaMax);
    }
  }
  const alphaOf = (rho: number) => {
    const f = Math.max(0, Math.min(1, rho)) * 256;
    const i = Math.min(255, Math.floor(f));
    return table[i]! + (table[i + 1]! - table[i]!) * (f - i);
  };
  const normals = new Float32Array(w * h * 3).fill(NaN);
  for (let i = 0; i < w * h; i += 1) {
    if (!mask[i]) continue;
    const x = i % w;
    const y = (i - x) / w;
    const gx = (sm[y * w + Math.min(w - 1, x + 1)]! - sm[y * w + Math.max(0, x - 1)]!) / 2;
    const gy = (sm[Math.min(h - 1, y + 1) * w + x]! - sm[Math.max(0, y - 1) * w + x]!) / 2;
    const l = Math.hypot(gx, gy) || 1;
    const dx = -gx / l;
    const dy = -gy / l;
    const alpha = alphaOf(1 - Math.max(0, sm[i]!) / Reff);
    const m = Math.sin(alpha);
    let n: V3 = [m * dx, -m * dy, Math.cos(alpha)];
    if (rot) n = [rot[0]! * n[0] + rot[1]! * n[1] + rot[2]! * n[2], rot[3]! * n[0] + rot[4]! * n[1] + rot[5]! * n[2], rot[6]! * n[0] + rot[7]! * n[1] + rot[8]! * n[2]];
    normals[3 * i] = n[0];
    normals[3 * i + 1] = n[1];
    normals[3 * i + 2] = n[2];
  }
  // Roundness: the subject's area against the disk of its inscribed radius' bounding box … simply: area / (π (box/2)²) for the box's mean side.
  const side = (x1 - x0 + 1 + (y1 - y0 + 1)) / 2;
  const roundness = Math.max(0, Math.min(1, count / (Math.PI * (side / 2) ** 2)));
  const aspect = Math.min(x1 - x0 + 1, y1 - y0 + 1) / Math.max(x1 - x0 + 1, y1 - y0 + 1);
  return { width: w, height: h, normals, mask, dist: sm, radius: R, roundness: Math.min(roundness, 1) * aspect, count, box: { x0, y0, x1, y1 }, cover: matte };
}

/** The soft-terminator clamped cosine of a source of angular radius α (sin α given). */
export function softShade(x: number, sinA: number): number {
  if (sinA < 1e-4) return x > 0 ? x : 0;
  if (x >= sinA) return x;
  if (x <= -sinA) return 0;
  return ((x + sinA) * (x + sinA)) / (4 * sinA);
}

interface Samples {
  n: Float32Array; // 3 per sample, level frame
  I: Float32Array; // luminance
  rgb: Float32Array; // 3 per sample
  idx: Int32Array; // pixel index
  count: number;
}

function fibonacciSphere(n: number): V3[] {
  const out: V3[] = [];
  const g = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i += 1) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - y * y);
    out.push([r * Math.cos(i * g), y, r * Math.sin(i * g)]);
  }
  return out;
}


export interface LightTerm {
  L: V3;
  sinA: number;
  /** 1 / the light's distance from the subject's centre in subject radii (0: distant). */
  inv?: number;
}

/** A term's irradiance at a point of the subject with normal n (taken to be at n on the unit sphere). */
export function termShade(nx: number, ny: number, nz: number, t: LightTerm): number {
  const inv = t.inv ?? 0;
  if (inv <= 1e-6) return softShade(nx * t.L[0] + ny * t.L[1] + nz * t.L[2], t.sinA);
  // The light at δ·L (δ = 1/inv radii); the point at n: direction and inverse-square falloff relative to the centre.
  const vx = t.L[0] - nx * inv;
  const vy = t.L[1] - ny * inv;
  const vz = t.L[2] - nz * inv;
  const d2 = vx * vx + vy * vy + vz * vz;
  const d = Math.sqrt(d2);
  return softShade((nx * vx + ny * vy + nz * vz) / d, t.sinA) / d2;
}

/** Least squares of I ≈ a + Σ e_j s_j over the samples (subset `use`); a ≥ 0 and e ≥ 0 enforced by dropping. */
function fitAmplitudes(s: Samples, terms: LightTerm[], use: Int32Array | null, values?: Float32Array): { a: number; e: number[]; sse: number; sst: number } {
  const k = terms.length + 1;
  const AtA = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const Atb = new Array<number>(k).fill(0);
  const m = use ? use.length : s.count;
  const shade = new Float64Array(terms.length);
  const I = values ?? s.I;
  let sum = 0;
  let sum2 = 0;
  for (let q = 0; q < m; q += 1) {
    const i = use ? use[q]! : q;
    const nx = s.n[3 * i]!;
    const ny = s.n[3 * i + 1]!;
    const nz = s.n[3 * i + 2]!;
    for (let j = 0; j < terms.length; j += 1) shade[j] = termShade(nx, ny, nz, terms[j]!);
    const row = [1, ...shade];
    const b = I[i]!;
    sum += b;
    sum2 += b * b;
    for (let r = 0; r < k; r += 1) {
      Atb[r]! += row[r]! * b;
      for (let c = r; c < k; c += 1) AtA[r]![c]! += row[r]! * row[c]!;
    }
  }
  for (let r = 0; r < k; r += 1) for (let c = 0; c < r; c += 1) AtA[r]![c] = AtA[c]![r]!;
  const sst = sum2 - (sum * sum) / Math.max(1, m);
  let x = solveSym(AtA, Atb);
  if (!x || x.some((v, i) => (i === 0 ? v < 0 : v < 0))) {
    // Drop negative terms (non-negative least squares, by elimination: few terms).
    const keep = [true, ...terms.map(() => true)];
    for (let iter = 0; iter < k && x; iter += 1) {
      const neg = x.findIndex((v, i) => keep[i] && v < 0);
      if (neg < 0) break;
      keep[neg] = false;
      const ids = keep.map((kk, i) => (kk ? i : -1)).filter((i) => i >= 0);
      const sub = solveSym(
        ids.map((r) => ids.map((c) => AtA[r]![c]!)),
        ids.map((r) => Atb[r]!),
      );
      x = new Array<number>(k).fill(0);
      if (sub) ids.forEach((id, j) => (x![id] = sub[j]!));
    }
  }
  x = x ?? new Array<number>(k).fill(0);
  // SSE = bᵀb − 2xᵀAᵀb + xᵀAᵀAx.
  let sse = sum2;
  for (let r = 0; r < k; r += 1) {
    sse -= 2 * x[r]! * Atb[r]!;
    for (let c = 0; c < k; c += 1) sse += x[r]! * AtA[r]![c]! * x[c]!;
  }
  return { a: x[0]!, e: x.slice(1), sse: Math.max(0, sse), sst: Math.max(1e-12, sst) };
}

function solveSym(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]!]);
  for (let c = 0; c < n; c += 1) {
    let p = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    if (Math.abs(M[p]![c]!) < 1e-12) return null;
    const tmp = M[c]!;
    M[c] = M[p]!;
    M[p] = tmp;
    for (let r = 0; r < n; r += 1) {
      if (r === c) continue;
      const f = M[r]![c]! / M[c]![c]!;
      if (f === 0) continue;
      for (let q = c; q <= n; q += 1) M[r]![q] = M[r]![q]! - f * M[c]![q]!;
    }
  }
  return M.map((r, i) => r[n]! / r[i]!);
}

const azel = (L: V3) => ({ az: Math.atan2(L[0], L[2]) / DEG, el: Math.asin(Math.max(-1, Math.min(1, L[1]))) / DEG });
const fromAzel = (az: number, el: number): V3 => [Math.sin(az * DEG) * Math.cos(el * DEG), Math.sin(el * DEG), Math.cos(az * DEG) * Math.cos(el * DEG)];

/** Pattern search of one term's direction (and softness) keeping the others. */
function refine(s: Samples, terms: LightTerm[], j: number, use: Int32Array | null, o: { start?: number; softness?: boolean } = {}): { terms: LightTerm[]; fit: ReturnType<typeof fitAmplitudes> } {
  let best = terms.map((t) => ({ ...t, L: [...t.L] as V3 }));
  let fit = fitAmplitudes(s, best, use);
  let step = o.start ?? 4;
  while (step >= 0.2) {
    let improved = false;
    const { az, el } = azel(best[j]!.L);
    const candidates: { az: number; el: number; sinA: number }[] = [];
    for (const [da, de] of [
      [step, 0],
      [-step, 0],
      [0, step],
      [0, -step],
      [step, step],
      [-step, -step],
      [step, -step],
      [-step, step],
    ] as const) {
      const e = Math.max(-89.9, Math.min(89.9, el + de));
      candidates.push({ az: az + da / Math.max(0.2, Math.cos(e * DEG)), el: e, sinA: best[j]!.sinA });
    }
    const inv0 = best[j]!.inv ?? 0;
    const cands: { az: number; el: number; sinA: number; inv: number }[] = candidates.map((c) => ({ ...c, inv: inv0 }));
    if (o.softness) for (const ds of [-0.04, 0.04]) cands.push({ az, el, sinA: Math.max(0, Math.min(0.7, best[j]!.sinA + ds)), inv: inv0 });
    if (o.softness) for (const di of [-0.025, 0.025]) cands.push({ az, el, sinA: best[j]!.sinA, inv: Math.max(0, Math.min(0.45, inv0 + di)) });
    for (const c of cands) {
      const trial = best.map((t, i) => (i === j ? { L: fromAzel(c.az, c.el), sinA: c.sinA, inv: c.inv } : t));
      const f = fitAmplitudes(s, trial, use);
      if (f.sse < fit.sse - 1e-12 && f.e[j]! > 0) {
        best = trial;
        fit = f;
        improved = true;
      }
    }
    if (!improved) step /= 2;
  }
  return { terms: best, fit };
}

/**
 * Non-negative least squares of the samples on a dictionary of soft sources
 * over the sphere (plus an even ambient), by coordinate descent on the normal
 * equations; the weights are then gathered into clusters of nearby
 * directions, strongest first: each cluster is a light (its weighted mean
 * direction, its total weight, its angular spread).
 */
function nnlsClusters(s: Samples, seed: number): { L: V3; weight: number; spread: number }[] {
  const m = Math.min(s.count, 1200);
  const random = rng(seed + 101);
  const use = Int32Array.from({ length: m }, (_, i) => (s.count <= 1200 ? i : Math.floor(random() * s.count)));
  const dirs = fibonacciSphere(420).filter((d) => {
    for (let q = 0; q < m; q += 1) {
      const i = use[q]!;
      if (s.n[3 * i]! * d[0] + s.n[3 * i + 1]! * d[1] + s.n[3 * i + 2]! * d[2] > 0.1) return true;
    }
    return false;
  });
  const k = dirs.length + 1;
  const A = new Float32Array(k * m);
  for (let q = 0; q < m; q += 1) {
    const i = use[q]!;
    A[q] = 1;
    for (let j = 0; j < dirs.length; j += 1) A[(j + 1) * m + q] = softShade(s.n[3 * i]! * dirs[j]![0] + s.n[3 * i + 1]! * dirs[j]![1] + s.n[3 * i + 2]! * dirs[j]![2], 0.12);
  }
  const G = new Float64Array(k * k);
  const b = new Float64Array(k);
  for (let a = 0; a < k; a += 1) {
    let sb = 0;
    for (let q = 0; q < m; q += 1) sb += A[a * m + q]! * s.I[use[q]!]!;
    b[a] = sb;
    for (let c = a; c < k; c += 1) {
      let v = 0;
      for (let q = 0; q < m; q += 1) v += A[a * m + q]! * A[c * m + q]!;
      G[a * k + c] = v;
      G[c * k + a] = v;
    }
  }
  const x = new Float64Array(k);
  const r = new Float64Array(k);
  for (let j = 0; j < k; j += 1) r[j] = -b[j]!;
  for (let sweep = 0; sweep < 400; sweep += 1) {
    let moved = 0;
    for (let j = 0; j < k; j += 1) {
      const g = G[j * k + j]!;
      if (g <= 1e-12) continue;
      const nx = Math.max(0, x[j]! - r[j]! / g);
      const d = nx - x[j]!;
      if (d === 0) continue;
      x[j] = nx;
      moved += Math.abs(d);
      for (let i = 0; i < k; i += 1) r[i] = r[i]! + d * G[i * k + j]!;
    }
    if (moved < 1e-9) break;
  }
  const w = Array.from(x.subarray(1));
  const out: { L: V3; weight: number; spread: number }[] = [];
  const taken = new Uint8Array(dirs.length);
  const total = w.reduce((a, v) => a + v, 0);
  if (!(total > 0)) return out;
  for (let c = 0; c < 4; c += 1) {
    let top = -1;
    for (let j = 0; j < dirs.length; j += 1) if (!taken[j] && w[j]! > 0 && (top < 0 || w[j]! > w[top]!)) top = j;
    if (top < 0) break;
    let sum = 0;
    const acc: V3 = [0, 0, 0];
    const members: number[] = [];
    for (let j = 0; j < dirs.length; j += 1) {
      if (taken[j] || dot(dirs[j]!, dirs[top]!) < Math.cos(32 * DEG)) continue;
      taken[j] = 1;
      sum += w[j]!;
      members.push(j);
      for (let q = 0; q < 3; q += 1) acc[q]! += w[j]! * dirs[j]![q]!;
    }
    if (sum < 0.04 * total && out.length) continue;
    const L = norm(acc);
    const spread = Math.sqrt(members.reduce((a, j) => a + w[j]! * (Math.acos(Math.max(-1, Math.min(1, dot(dirs[j]!, L)))) / DEG) ** 2, 0) / sum);
    out.push({ L, weight: sum, spread: Math.max(4, spread) });
  }
  return out.sort((a, b) => b.weight - a.weight);
}

export interface ShadingFit {
  key: { L: V3; sinA: number; inv: number; E: number; azRange: number; elRange: number; sizeRange: number; ratioSigma: number; invRange: number } | null;
  fill: { L: V3; sinA: number; F: number; ratio: number; ratioSigma: number; dirSigma: number } | null;
  ambient: { a: number; ratio: number; /** The darkest shading (5th percentile, relative to the key): the ambient cannot exceed it. */ floorRatio: number };
  rim: { L: V3; Lnear: V3; Lfar: V3; E: number; ratio: number; ratioSigma: number; phiDeg: number; pixels: number; dirSigma: number; fitted: boolean } | null;
  colours: { key: [number, number, number]; fill: [number, number, number] | null; ambient: [number, number, number]; rim: [number, number, number] | null };
  /** R² of the model over the samples. */
  r2: number;
  /** The global stage's clusters (direction, weight, spread), for inspection. */
  clusters: { L: V3; weight: number; spread: number }[];
  /** The fitted sources (key first) and their amplitudes. */
  terms: (LightTerm & { e: number })[];
  /** Residual RMS relative to the key's amplitude. */
  relRms: number;
  samples: number;
  roundness: number;
  /** The fitted irradiance, per pixel and channel (relative to the key), for the albedo and the relight. */
  shadeOf(n: readonly number[]): number;
}

/** Collect the subject's samples: level-frame normals, luminance, colour. */
function collect(img: LinearImage, field: NormalField, luma: readonly [number, number, number], cam: Pick<PinholeCamera, 'pitchDeg' | 'rollDeg'>, o: { minNz: number; maxNz?: number; max: number; seed: number; exclude?: Uint8Array | null }): Samples {
  const ids: number[] = [];
  for (let i = 0; i < field.width * field.height; i += 1) {
    if (!field.mask[i] || o.exclude?.[i] || field.cover[i]! < 0.98) continue;
    const nz = field.normals[3 * i + 2]!;
    if (nz < o.minNz || (o.maxNz !== undefined && nz > o.maxNz)) continue;
    ids.push(i);
  }
  const random = rng(o.seed);
  while (ids.length > o.max) ids.splice(Math.floor(random() * ids.length), 1);
  const count = ids.length;
  const s: Samples = { n: new Float32Array(count * 3), I: new Float32Array(count), rgb: new Float32Array(count * 3), idx: Int32Array.from(ids), count };
  ids.forEach((i, q) => {
    const nl = cameraToLevel(cam, [field.normals[3 * i]!, field.normals[3 * i + 1]!, field.normals[3 * i + 2]!]);
    s.n.set(nl, 3 * q);
    const r = img.data[3 * i]!;
    const g = img.data[3 * i + 1]!;
    const b = img.data[3 * i + 2]!;
    s.rgb.set([r, g, b], 3 * q);
    s.I[q] = luma[0] * r + luma[1] * g + luma[2] * b;
  });
  return s;
}

/**
 * Fit the lighting model to the subject's shading. `cam` gives the camera's
 * tilt, so the directions come out in the level frame.
 */
export function fitShading(img: LinearImage, field: NormalField, luma: readonly [number, number, number], cam: Pick<PinholeCamera, 'pitchDeg' | 'rollDeg'>, o: { seed?: number; bootstrap?: number; maxSamples?: number; exclude?: Uint8Array | null } = {}): ShadingFit | null {
  const seed = o.seed ?? 1;
  const s = collect(img, field, luma, cam, { minNz: 0.12, max: o.maxSamples ?? 2400, seed, exclude: o.exclude ?? null });
  if (s.count < 150) return null;
  // 1. Global: a non-negative mixture of many soft sources over the whole sphere (convex, no local minima), clustered into lights.
  const clusters = nnlsClusters(s, seed);
  if (!clusters.length) return null;
  // 2. Local: each source's direction, softness and distance refined with the others held, in rounds — from several
  // starts (the strongest two, three and four clusters), keeping the best fit (a little penalty per source).
  const localFit = (init: LightTerm[]) => {
    let r = refine(s, init, 0, null, { start: 4, softness: true });
    for (let round = 0; round < 3; round += 1) for (let j = 0; j < init.length; j += 1) r = refine(s, r.terms, j, null, { start: round ? 1 : 3, softness: true });
    let t = r.terms;
    let f = r.fit;
    // Drop sources too weak to matter, and any crowding a stronger one (within 35°: that is the stronger one's softness), then refine again.
    for (let pass = 0; pass < 3; pass += 1) {
      const top = f.e.indexOf(Math.max(...f.e));
      const keep = t.map((_, j) => j).filter((j) => j === top || (f.e[j]! > 0.04 * f.e[top]! && !t.some((u, k) => k !== j && f.e[k]! > f.e[j]! && dot(u.L, t[j]!.L) > Math.cos(35 * DEG))));
      if (keep.length === t.length) break;
      t = keep.map((j) => t[j]!);
      let q = refine(s, t, 0, null, { start: 2, softness: true });
      for (let j = 1; j < t.length; j += 1) q = refine(s, q.terms, j, null, { start: 2, softness: true });
      t = q.terms;
      f = q.fit;
    }
    return { terms: t, fit: f, score: f.sse * (1 + 0.015 * t.length) };
  };
  const toTerms = (cs: typeof clusters) => cs.map((c) => ({ L: c.L, sinA: Math.min(0.6, Math.max(0.05, Math.sin(c.spread * DEG))) }));
  const starts = [clusters.slice(0, 4), clusters.slice(0, 3), clusters.slice(0, 2)].filter((cs, i, all) => cs.length && all.findIndex((x) => x.length === cs.length) === i);
  const inits = starts.map(toTerms);
  // A photographer's start too: the key, a fill on the other side of the camera, and whatever came from behind.
  const front = clusters.find((c) => c.L[2] > -0.25);
  if (front) {
    const k = azel(front.L);
    inits.push([{ L: front.L, sinA: 0.15 }, { L: fromAzel(-0.8 * k.az, 12), sinA: 0.3 }, ...clusters.filter((c) => c.L[2] < -0.25).slice(0, 1).map((c) => ({ L: c.L, sinA: 0.1 }))]);
  }
  let bestLocal: ReturnType<typeof localFit> | null = null;
  for (const init of inits) {
    const r = localFit(init);
    if (!bestLocal || r.score < bestLocal.score) bestLocal = r;
  }
  let terms = bestLocal!.terms;
  let fit = bestLocal!.fit;
  // The key gives the subject the most light; the others are a fill (in front) or a rim (behind the subject).
  {
    const share = terms.map((t, j) => {
      let v = 0;
      for (let i = 0; i < s.count; i += 1) v += termShade(s.n[3 * i]!, s.n[3 * i + 1]!, s.n[3 * i + 2]!, t);
      return (fit.e[j]! * v) / s.count;
    });
    const order = terms.map((_, j) => j).sort((a, b) => share[b]! - share[a]!);
    terms = order.map((j) => terms[j]!);
    fit = { ...fit, e: order.map((j) => fit.e[j]!) };
  }
  const behind = (L: V3) => L[2] < -0.25;
  const fillIdx = terms.findIndex((q, j) => j > 0 && !behind(q.L));
  const rimIdx = terms.findIndex((q, j) => j > 0 && behind(q.L));
  const fillFound = fillIdx > 0;
  const E = fit.e[0]!;
  if (!(E > 0)) return null;
  // 3. The bootstrap.
  const B = o.bootstrap ?? 20;
  const random = rng(seed * 7919 + 3);
  const az0 = azel(terms[0]!.L);
  const azs: number[] = [];
  const els: number[] = [];
  const sizes: number[] = [];
  const invs: number[] = [];
  const ratios: number[] = [];
  const fillAz: number[] = [];
  const fillRatios: number[] = [];
  const rimAng: number[] = [];
  const rimRatios: number[] = [];
  const m = Math.min(s.count, 900);
  for (let b = 0; b < B; b += 1) {
    const use = Int32Array.from({ length: m }, () => Math.floor(random() * s.count));
    let r = refine(s, terms, 0, use, { start: 2, softness: true });
    for (let j = 1; j < terms.length; j += 1) r = refine(s, r.terms, j, use, { start: 2, softness: true });
    const ae = azel(r.terms[0]!.L);
    azs.push(az0.az + (((ae.az - az0.az + 540) % 360) - 180));
    els.push(ae.el);
    sizes.push((2 * Math.asin(r.terms[0]!.sinA)) / DEG);
    invs.push(r.terms[0]!.inv ?? 0);
    ratios.push(Math.log2(Math.max(1e-6, r.fit.a) / Math.max(1e-6, r.fit.e[0]!)));
    if (fillFound) {
      fillAz.push(Math.acos(Math.max(-1, Math.min(1, dot(r.terms[fillIdx]!.L, terms[fillIdx]!.L)))) / DEG);
      fillRatios.push(Math.log2(Math.max(1e-6, r.fit.e[fillIdx]!) / Math.max(1e-6, r.fit.e[0]!)));
    }
    if (rimIdx > 0) {
      rimAng.push(Math.acos(Math.max(-1, Math.min(1, dot(r.terms[rimIdx]!.L, terms[rimIdx]!.L)))) / DEG);
      rimRatios.push(Math.log2(Math.max(1e-6, r.fit.e[rimIdx]!) / Math.max(1e-6, r.fit.e[0]!)));
    }
  }
  const relRms = Math.sqrt(fit.sse / s.count) / E;
  const r2 = Math.max(0, 1 - fit.sse / fit.sst);
  // 4. Colours with the geometry held.
  const channel = (c: number) => {
    const values = new Float32Array(s.count);
    for (let i = 0; i < s.count; i += 1) values[i] = s.rgb[3 * i + c]!;
    return fitAmplitudes(s, terms, null, values);
  };
  const ch = [channel(0), channel(1), channel(2)];
  const nrm = (v: number[]): [number, number, number] => {
    const k = Math.max(v[0]!, v[1]!, v[2]!, 1e-9);
    return [Math.max(0, v[0]! / k), Math.max(0, v[1]! / k), Math.max(0, v[2]! / k)];
  };
  const keyRgb = nrm(ch.map((c) => c.e[0]!));
  const fillRgb = fillFound ? nrm(ch.map((c) => c.e[fillIdx]!)) : null;
  const ambRgb = nrm(ch.map((c) => c.a));
  // 5. A rim: a fitted source behind the subject, else bright, unexplained light along the silhouette.
  const rim =
    rimIdx > 0
      ? (() => {
          const L = terms[rimIdx]!.L;
          const spread = Math.max(12, 2.5 * Math.sqrt(rimAng.reduce((a, v) => a + v * v, 0) / Math.max(1, rimAng.length)));
          const tilt = (k: number): V3 => norm([L[0] * Math.cos(k * DEG), L[1], L[2] + Math.sign(L[2] || -1) * Math.sin(k * DEG) * 0.5]);
          const phi = Math.atan2(L[1], L[0]) / DEG;
          return { L, Lnear: tilt(-spread), Lfar: tilt(spread), E: fit.e[rimIdx]!, ratio: fit.e[rimIdx]! / E, ratioSigma: stddev(rimRatios), phiDeg: phi, pixels: s.count, dirSigma: spread / 2.5, rgb: nrm(ch.map((c) => c.e[rimIdx]!)), fitted: true };
        })()
      : findRim(img, field, luma, cam, terms, fit, E, seed);
  const model = (n: readonly number[]) => {
    let v = fit.a;
    terms.forEach((t, j) => (v += fit.e[j]! * termShade(n[0]!, n[1]!, n[2]!, t)));
    if (rim && !rim.fitted) v += rim.E * softShade(n[0]! * rim.L[0] + n[1]! * rim.L[1] + n[2]! * rim.L[2], 0.1);
    return v / E;
  };
  const sdAz = stddev(azs);
  const sdEl = stddev(els);
  return {
    key: { L: terms[0]!.L, sinA: terms[0]!.sinA, inv: terms[0]!.inv ?? 0, E, azRange: sdAz, elRange: sdEl, sizeRange: stddev(sizes), ratioSigma: stddev(ratios), invRange: stddev(invs) },
    fill: fillFound ? { L: terms[fillIdx]!.L, sinA: terms[fillIdx]!.sinA, F: fit.e[fillIdx]!, ratio: fit.e[fillIdx]! / E, ratioSigma: stddev(fillRatios), dirSigma: fillAz.length ? Math.sqrt(fillAz.reduce((a, v) => a + v * v, 0) / fillAz.length) : 30 } : null,
    ambient: { a: fit.a, ratio: fit.a / E, floorRatio: Math.max(1e-4, percentile(Array.from(s.I), 0.05) / E) },
    rim,
    colours: { key: keyRgb, fill: fillRgb, ambient: ambRgb, rim: rim?.rgb ?? null },
    r2,
    clusters,
    terms: terms.map((t, j) => ({ ...t, e: fit.e[j]! })),
    relRms,
    samples: s.count,
    roundness: field.roundness,
    shadeOf: model,
  };
}

function findRim(img: LinearImage, field: NormalField, luma: readonly [number, number, number], cam: Pick<PinholeCamera, 'pitchDeg' | 'rollDeg'>, terms: LightTerm[], fit: { a: number; e: number[] }, E: number, seed: number) {
  // The silhouette band: the outer pixels, whose normals face sideways.
  const band = collect(img, field, luma, cam, { minNz: 0, maxNz: 0.6, max: 4000, seed: seed + 11 });
  if (band.count < 40) return null;
  const bins = 36;
  const sum = new Float64Array(bins);
  const cnt = new Float64Array(bins);
  const rgb = new Float64Array(bins * 3);
  const resid = new Float32Array(band.count);
  for (let i = 0; i < band.count; i += 1) {
    const n = [band.n[3 * i]!, band.n[3 * i + 1]!, band.n[3 * i + 2]!];
    let model = fit.a;
    terms.forEach((t, j) => (model += fit.e[j]! * termShade(n[0]!, n[1]!, n[2]!, t)));
    const r = band.I[i]! - model;
    resid[i] = r;
    // The in-image direction of the normal, from the camera-frame normal.
    const p = band.idx[i]!;
    const phi = Math.atan2(field.normals[3 * p + 1]!, field.normals[3 * p]!) / DEG;
    const bi = Math.floor((((phi % 360) + 360) % 360) / (360 / bins)) % bins;
    sum[bi] = sum[bi]! + r;
    cnt[bi] = cnt[bi]! + 1;
    for (let c = 0; c < 3; c += 1) rgb[3 * bi + c] = rgb[3 * bi + c]! + Math.max(0, band.rgb[3 * i + c]! - (model / Math.max(1e-9, band.I[i]!)) * band.rgb[3 * i + c]!);
  }
  const mean = Array.from(sum, (v, i) => (cnt[i]! > 3 ? v / cnt[i]! : 0));
  // Smooth over neighbouring bins.
  const sm = mean.map((_, i) => (mean[(i + bins - 1) % bins]! + 2 * mean[i]! + mean[(i + 1) % bins]!) / 4);
  let peak = 0;
  let at = -1;
  sm.forEach((v, i) => {
    if (v > peak) (peak = v), (at = i);
  });
  const noise = Math.sqrt(resid.reduce((a, v) => a + v * v, 0) / band.count);
  if (at < 0 || peak < 0.1 * E || peak < 1.5 * noise * 0.5) return null;
  let s = 0;
  let c = 0;
  let wsum = 0;
  let px = 0;
  const col = [0, 0, 0];
  sm.forEach((v, i) => {
    if (v < 0.5 * peak) return;
    const ang = ((i + 0.5) * 360) / bins;
    const d = Math.abs(((ang - (at + 0.5) * 10 + 540) % 360) - 180);
    if (d > 70) return;
    s += v * Math.sin(ang * DEG);
    c += v * Math.cos(ang * DEG);
    wsum += v;
    px += cnt[i]!;
    for (let k = 0; k < 3; k += 1) col[k]! += rgb[3 * i + k]!;
  });
  if (!wsum) return null;
  const phi = Math.atan2(s, c) / DEG;
  // Behind the silhouette by γ: 45° (between 15° and 75°).
  const dirAt = (gamma: number): V3 => cameraToLevel(cam, norm([Math.cos(phi * DEG) * Math.cos(gamma * DEG), Math.sin(phi * DEG) * Math.cos(gamma * DEG), -Math.sin(gamma * DEG)]));
  const L = dirAt(45);
  const k = Math.max(col[0]!, col[1]!, col[2]!, 1e-9);
  // The band's peak residual is at normals ~90° from the view; the rim gives E_rim · cos γ there.
  const Erim = (peak * 1.6) / Math.cos(45 * DEG);
  return { L, Lnear: dirAt(15), Lfar: dirAt(75), E: Erim, ratio: Erim / E, ratioSigma: 0.7, phiDeg: phi, pixels: px, dirSigma: 15, rgb: [col[0]! / k, col[1]! / k, col[2]! / k] as [number, number, number], fitted: false };
}

/** The irradiance-explained shading of a fit, per pixel (for the match score and the albedo). */
export function shadingMap(field: NormalField, fit: ShadingFit, cam: Pick<PinholeCamera, 'pitchDeg' | 'rollDeg'>): Float32Array {
  const out = new Float32Array(field.width * field.height);
  for (let i = 0; i < out.length; i += 1) {
    if (!field.mask[i]) continue;
    out[i] = fit.shadeOf(cameraToLevel(cam, [field.normals[3 * i]!, field.normals[3 * i + 1]!, field.normals[3 * i + 2]!]));
  }
  return out;
}
