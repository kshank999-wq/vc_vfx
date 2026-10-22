import type { LinearImage } from '../key/linear';
import { percentile, rng } from './geometry';

/**
 * The lens from the picture (addendum 14 §3.7), when the metadata and the
 * camera track do not give it.
 *
 * Straight lines: edge pixels (Sobel on log luminance, thinned along the
 * gradient) grown into line-support regions of one orientation (as LSD
 * does), each fitted with a line. Vanishing points: RANSAC over pairs of
 * lines, the hypothesis scored by the length of lines pointing at it; then a
 * second one among the rest. Two vanishing points of perpendicular scene
 * directions give the focal length, f² = −(v₁ − c)·(v₂ − c) with c the
 * picture's centre; its range comes from a bootstrap over the lines. Line
 * curvature (the plumb-line method): the division-model k₁ that makes the
 * long edges straightest. Depth of field: how much wider the background's
 * edges are than the subject's, through the thin-lens blur — a hint, clearly
 * labelled.
 */

export interface LineSegment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  length: number;
  /** The edge pixels it was fitted to (for the curvature). */
  points: Float32Array;
}

function gradients(img: LinearImage, luma: readonly [number, number, number]) {
  const { width: w, height: h, data } = img;
  const L = new Float32Array(w * h);
  for (let i = 0; i < w * h; i += 1) L[i] = Math.log2(Math.max(1e-4, luma[0] * data[3 * i]! + luma[1] * data[3 * i + 1]! + luma[2] * data[3 * i + 2]!));
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  const mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y += 1)
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      const a = L[i - w - 1]!;
      const b = L[i - w]!;
      const c = L[i - w + 1]!;
      const d = L[i - 1]!;
      const f = L[i + 1]!;
      const g = L[i + w - 1]!;
      const hh = L[i + w]!;
      const k = L[i + w + 1]!;
      gx[i] = (c + 2 * f + k - a - 2 * d - g) / 8;
      gy[i] = (g + 2 * hh + k - a - 2 * b - c) / 8;
      mag[i] = Math.hypot(gx[i]!, gy[i]!);
    }
  return { L, gx, gy, mag };
}

/** Line segments in the picture (longest first). */
export function detectLines(img: LinearImage, luma: readonly [number, number, number], o: { minLength?: number; exclude?: Uint8Array | null; max?: number } = {}): LineSegment[] {
  const { width: w, height: h } = img;
  const { gx, gy, mag } = gradients(img, luma);
  const thr = Math.max(0.12, percentile(mag, 0.9) * 0.6);
  // Thin along the gradient (non-maximum suppression).
  const edge = new Uint8Array(w * h);
  for (let y = 2; y < h - 2; y += 1)
    for (let x = 2; x < w - 2; x += 1) {
      const i = y * w + x;
      if (mag[i]! < thr || o.exclude?.[i]) continue;
      const ux = gx[i]! / mag[i]!;
      const uy = gy[i]! / mag[i]!;
      const a = mag[Math.round(y + uy) * w + Math.round(x + ux)]!;
      const b = mag[Math.round(y - uy) * w + Math.round(x - ux)]!;
      if (mag[i]! >= a && mag[i]! >= b) edge[i] = 1;
    }
  const minLength = o.minLength ?? Math.max(20, 0.05 * Math.max(w, h));
  const used = new Uint8Array(w * h);
  const out: LineSegment[] = [];
  const tol = (22.5 * Math.PI) / 180;
  for (let i = 0; i < w * h; i += 1) {
    if (!edge[i] || used[i]) continue;
    // Grow a region of edge pixels whose gradient orientation stays within the tolerance of the region's.
    const angle0 = Math.atan2(gy[i]!, gx[i]!);
    let sc = Math.cos(2 * angle0);
    let ss = Math.sin(2 * angle0);
    const region = [i];
    used[i] = 1;
    for (let q = 0; q < region.length; q += 1) {
      const j = region[q]!;
      const x = j % w;
      const y = (j - x) / w;
      const ra = Math.atan2(ss, sc) / 2;
      for (let dy = -1; dy <= 1; dy += 1)
        for (let dx = -1; dx <= 1; dx += 1) {
          const k = (y + dy) * w + x + dx;
          if ((!dx && !dy) || k < 0 || k >= w * h || !edge[k] || used[k]) continue;
          const a = Math.atan2(gy[k]!, gx[k]!);
          let d = Math.abs(((a - ra) % Math.PI) + Math.PI) % Math.PI;
          d = Math.min(d, Math.PI - d);
          if (d > tol) continue;
          used[k] = 1;
          region.push(k);
          sc += Math.cos(2 * a);
          ss += Math.sin(2 * a);
        }
    }
    if (region.length < minLength * 0.7) continue;
    // Principal axis.
    let mx = 0;
    let my = 0;
    for (const j of region) {
      mx += (j % w) + 0.5;
      my += (j - (j % w)) / w + 0.5;
    }
    mx /= region.length;
    my /= region.length;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (const j of region) {
      const dx = (j % w) + 0.5 - mx;
      const dy = (j - (j % w)) / w + 0.5 - my;
      sxx += dx * dx;
      syy += dy * dy;
      sxy += dx * dy;
    }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const ux = Math.cos(th);
    const uy = Math.sin(th);
    let tmin = Infinity;
    let tmax = -Infinity;
    let wid = 0;
    const pts = new Float32Array(region.length * 2);
    region.forEach((j, q) => {
      const dx = (j % w) + 0.5 - mx;
      const dy = (j - (j % w)) / w + 0.5 - my;
      const t = dx * ux + dy * uy;
      tmin = Math.min(tmin, t);
      tmax = Math.max(tmax, t);
      wid += (dx * -uy + dy * ux) ** 2;
      pts[2 * q] = (j % w) + 0.5;
      pts[2 * q + 1] = (j - (j % w)) / w + 0.5;
    });
    const length = tmax - tmin;
    if (length < minLength || Math.sqrt(wid / region.length) > 2.5) continue;
    out.push({ x0: mx + ux * tmin, y0: my + uy * tmin, x1: mx + ux * tmax, y1: my + uy * tmax, length, points: pts });
  }
  out.sort((a, b) => b.length - a.length);
  return out.slice(0, o.max ?? 200);
}

type H3 = [number, number, number];
const lineOf = (s: LineSegment): H3 => {
  const a: H3 = [s.x0, s.y0, 1];
  const b: H3 = [s.x1, s.y1, 1];
  const l: H3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const n = Math.hypot(l[0], l[1]) || 1;
  return [l[0] / n, l[1] / n, l[2] / n];
};
const cross = (a: H3, b: H3): H3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Angle (degrees) between a segment and the direction from its middle to a vanishing point (homogeneous). */
function vpAngle(s: LineSegment, v: H3): number {
  const mx = (s.x0 + s.x1) / 2;
  const my = (s.y0 + s.y1) / 2;
  const dx = s.x1 - s.x0;
  const dy = s.y1 - s.y0;
  // Direction to the VP (works for points at infinity: v[2] = 0).
  const tx = v[0] - mx * v[2];
  const ty = v[1] - my * v[2];
  const c = Math.abs(dx * tx + dy * ty) / (Math.hypot(dx, dy) * Math.hypot(tx, ty) || 1);
  return (Math.acos(Math.min(1, c)) * 180) / Math.PI;
}

export interface VanishingPoint {
  v: H3;
  /** Lines pointing at it. */
  inliers: number[];
  support: number;
}

/** The least-squares vanishing point of a set of lines (the null vector of Σ wᵢ lᵢ lᵢᵀ). */
function vpOf(lines: H3[], weights: number[]): H3 {
  const M = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  lines.forEach((l, i) => {
    const w = weights[i]!;
    for (let r = 0; r < 3; r += 1) for (let c = 0; c < 3; c += 1) M[3 * r + c]! += w * l[r]! * l[c]!;
  });
  // Smallest eigenvector by inverse power iteration on M + εI.
  let v: H3 = [0, 0, 1];
  const eps = 1e-9 * (M[0]! + M[4]! + M[8]!);
  const A = M.map((x, i) => x + (i % 4 === 0 ? eps : 0));
  const det = A[0]! * (A[4]! * A[8]! - A[5]! * A[7]!) - A[1]! * (A[3]! * A[8]! - A[5]! * A[6]!) + A[2]! * (A[3]! * A[7]! - A[4]! * A[6]!);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-30) return v;
  const inv = [
    (A[4]! * A[8]! - A[5]! * A[7]!) / det,
    (A[2]! * A[7]! - A[1]! * A[8]!) / det,
    (A[1]! * A[5]! - A[2]! * A[4]!) / det,
    (A[5]! * A[6]! - A[3]! * A[8]!) / det,
    (A[0]! * A[8]! - A[2]! * A[6]!) / det,
    (A[2]! * A[3]! - A[0]! * A[5]!) / det,
    (A[3]! * A[7]! - A[4]! * A[6]!) / det,
    (A[1]! * A[6]! - A[0]! * A[7]!) / det,
    (A[0]! * A[4]! - A[1]! * A[3]!) / det,
  ];
  for (let it = 0; it < 30; it += 1) {
    const n: H3 = [inv[0]! * v[0] + inv[1]! * v[1] + inv[2]! * v[2], inv[3]! * v[0] + inv[4]! * v[1] + inv[5]! * v[2], inv[6]! * v[0] + inv[7]! * v[1] + inv[8]! * v[2]];
    const l = Math.hypot(...n) || 1;
    v = [n[0] / l, n[1] / l, n[2] / l];
  }
  return v;
}

function bestVp(segs: LineSegment[], lines: H3[], candidates: number[], random: () => number, accept: (v: H3) => boolean): VanishingPoint | null {
  if (candidates.length < 3) return null;
  let best: VanishingPoint | null = null;
  for (let it = 0; it < 600; it += 1) {
    const a = candidates[Math.floor(random() * candidates.length)]!;
    const b = candidates[Math.floor(random() * candidates.length)]!;
    if (a === b) continue;
    const v = cross(lines[a]!, lines[b]!);
    if (Math.hypot(...v) < 1e-12) continue;
    if (!accept(v)) continue;
    const inliers = candidates.filter((i) => vpAngle(segs[i]!, v) < 1.5);
    const support = inliers.reduce((s, i) => s + segs[i]!.length, 0);
    if (inliers.length >= 3 && (!best || support > best.support)) best = { v, inliers, support };
  }
  if (!best) return null;
  const v = vpOf(
    best.inliers.map((i) => lines[i]!),
    best.inliers.map((i) => segs[i]!.length),
  );
  return { ...best, v };
}

export interface FocalFromLines {
  /** Focal length in pixels and its range (10th–90th percentile of the bootstrap, widened), or null. */
  focalPx: number | null;
  low: number;
  high: number;
  vps: VanishingPoint[];
  lines: number;
}

/** The focal length from two vanishing points of perpendicular directions (principal point at the centre). */
export function focalFromLines(segs: LineSegment[], width: number, height: number, o: { seed?: number } = {}): FocalFromLines {
  const random = rng(o.seed ?? 5);
  const lines = segs.map(lineOf);
  const cx = width / 2;
  const cy = height / 2;
  const all = segs.map((_, i) => i);
  const finite = (v: H3) => Math.abs(v[2]) > 1e-9;
  const f2Of = (a: H3, b: H3) => {
    if (!finite(a) || !finite(b)) return NaN;
    return -((a[0] / a[2] - cx) * (b[0] / b[2] - cx) + (a[1] / a[2] - cy) * (b[1] / b[2] - cy));
  };
  const plausible = (f2: number) => f2 > (0.25 * width) ** 2 && f2 < (8 * width) ** 2;
  const vp1 = bestVp(segs, lines, all, random, () => true);
  if (!vp1) return { focalPx: null, low: 0, high: 0, vps: [], lines: segs.length };
  const rest = all.filter((i) => !vp1.inliers.includes(i));
  const vp2 = bestVp(segs, lines, rest, random, (v) => plausible(f2Of(vp1.v, v)));
  if (!vp2) return { focalPx: null, low: 0, high: 0, vps: [vp1], lines: segs.length };
  const vps = [vp1, vp2];
  const rest2 = rest.filter((i) => !vp2.inliers.includes(i));
  const vp3 = bestVp(segs, lines, rest2, random, (v) => plausible(f2Of(vp1.v, v)) && plausible(f2Of(vp2.v, v)));
  if (vp3) vps.push(vp3);
  const estimate = (pick: (ids: number[]) => number[]) => {
    const vs = vps.map((vp) => {
      const ids = pick(vp.inliers);
      return vpOf(
        ids.map((i) => lines[i]!),
        ids.map((i) => segs[i]!.length),
      );
    });
    const fs: number[] = [];
    for (let a = 0; a < vs.length; a += 1) for (let b = a + 1; b < vs.length; b += 1) {
      const f2 = f2Of(vs[a]!, vs[b]!);
      if (plausible(f2)) fs.push(Math.sqrt(f2));
    }
    return fs.length ? fs.reduce((x, y) => x + y, 0) / fs.length : NaN;
  };
  const f0 = estimate((ids) => ids);
  if (!Number.isFinite(f0)) return { focalPx: null, low: 0, high: 0, vps, lines: segs.length };
  const boots: number[] = [];
  for (let b = 0; b < 40; b += 1) {
    const f = estimate((ids) => ids.map(() => ids[Math.floor(random() * ids.length)]!));
    if (Number.isFinite(f)) boots.push(f);
  }
  const p10 = percentile(boots, 0.1);
  const p90 = percentile(boots, 0.9);
  // Widened: the principal point is assumed at the centre, the lines may not be exactly perpendicular in the scene.
  const half = Math.max(0.06 * f0, 1.4 * Math.max(f0 - p10, p90 - f0));
  return { focalPx: f0, low: Math.max(1, f0 - half), high: f0 + half, vps, lines: segs.length };
}

/**
 * The plumb-line method: the division-model k₁ (radius normalised by the
 * half-diagonal; negative = barrel) that makes the long edges straightest.
 */
export function curvatureK1(segs: LineSegment[], width: number, height: number): { k1: number; straightRms: number; bentRms: number } | null {
  const long = segs.filter((s) => s.length > 0.07 * Math.max(width, height)).slice(0, 60);
  if (long.length < 4) return null;
  const cx = width / 2;
  const cy = height / 2;
  const half = Math.hypot(cx, cy);
  const cost = (k1: number) => {
    let sse = 0;
    let n = 0;
    for (const s of long) {
      const m = s.points.length / 2;
      const xs = new Float64Array(m);
      const ys = new Float64Array(m);
      let mx = 0;
      let my = 0;
      for (let i = 0; i < m; i += 1) {
        const dx = s.points[2 * i]! - cx;
        const dy = s.points[2 * i + 1]! - cy;
        const f = 1 / (1 + k1 * ((dx * dx + dy * dy) / (half * half)));
        xs[i] = dx * f;
        ys[i] = dy * f;
        mx += xs[i]!;
        my += ys[i]!;
      }
      mx /= m;
      my /= m;
      let sxx = 0;
      let syy = 0;
      let sxy = 0;
      for (let i = 0; i < m; i += 1) {
        sxx += (xs[i]! - mx) ** 2;
        syy += (ys[i]! - my) ** 2;
        sxy += (xs[i]! - mx) * (ys[i]! - my);
      }
      // The scatter's eigenvalues: the smaller is the squared distance from the best line, the larger its length —
      // their ratio is scale-free (undistorting also shrinks or grows the picture).
      const tr = sxx + syy;
      const det = sxx * syy - sxy * sxy;
      const root = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
      const small = tr / 2 - root;
      const large = tr / 2 + root;
      sse += (small / Math.max(1e-12, large)) * m;
      n += m;
    }
    // In pixels for a line as long as a tenth of the picture's diagonal.
    return Math.sqrt(sse / n) * 0.1 * 2 * half;
  };
  let best = 0;
  let bestCost = cost(0);
  for (let k = -0.4; k <= 0.4 + 1e-9; k += 0.01) {
    const c = cost(k);
    if (c < bestCost) (bestCost = c), (best = k);
  }
  for (let step = 0.005; step > 0.0002; step /= 2)
    for (const k of [best - step, best + step]) {
      const c = cost(k);
      if (c < bestCost) (bestCost = c), (best = k);
    }
  const bentRms = cost(0);
  // Only a clear improvement counts: otherwise the lines are straight within what can be measured.
  if (bentRms - bestCost < 0.12 * bentRms) return { k1: 0, straightRms: bentRms, bentRms };
  return { k1: best, straightRms: bestCost, bentRms };
}

/** Take the division-model k₁ out of segments: each one's points undistorted and its line refitted. */
export function undistortSegments(segs: LineSegment[], k1: number, width: number, height: number): LineSegment[] {
  if (Math.abs(k1) < 1e-6) return segs;
  const cx = width / 2;
  const cy = height / 2;
  const half2 = cx * cx + cy * cy;
  return segs.map((s) => {
    const m = s.points.length / 2;
    const pts = new Float32Array(s.points.length);
    let mx = 0;
    let my = 0;
    for (let i = 0; i < m; i += 1) {
      const dx = s.points[2 * i]! - cx;
      const dy = s.points[2 * i + 1]! - cy;
      const f = 1 / (1 + (k1 * (dx * dx + dy * dy)) / half2);
      pts[2 * i] = cx + dx * f;
      pts[2 * i + 1] = cy + dy * f;
      mx += pts[2 * i]!;
      my += pts[2 * i + 1]!;
    }
    mx /= m;
    my /= m;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (let i = 0; i < m; i += 1) {
      sxx += (pts[2 * i]! - mx) ** 2;
      syy += (pts[2 * i + 1]! - my) ** 2;
      sxy += (pts[2 * i]! - mx) * (pts[2 * i + 1]! - my);
    }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const ux = Math.cos(th);
    const uy = Math.sin(th);
    let tmin = Infinity;
    let tmax = -Infinity;
    for (let i = 0; i < m; i += 1) {
      const t = (pts[2 * i]! - mx) * ux + (pts[2 * i + 1]! - my) * uy;
      tmin = Math.min(tmin, t);
      tmax = Math.max(tmax, t);
    }
    return { x0: mx + ux * tmin, y0: my + uy * tmin, x1: mx + ux * tmax, y1: my + uy * tmax, length: tmax - tmin, points: pts };
  });
}

/**
 * Edge width (10–90 %, pixels) across strong edges inside a region: the
 * picture's blur there. Null without enough edges.
 */
export function edgeWidth(img: LinearImage, luma: readonly [number, number, number], region: Uint8Array): number | null {
  const { width: w, height: h } = img;
  const { L, gx, gy, mag } = gradients(img, luma);
  const ids: number[] = [];
  const thr = percentile(
    Array.from(mag).filter((_, i) => region[i]),
    0.9,
  );
  if (!(thr > 0.05)) return null;
  for (let y = 8; y < h - 8; y += 1)
    for (let x = 8; x < w - 8; x += 1) {
      const i = y * w + x;
      if (!region[i] || mag[i]! < thr) continue;
      const ux = gx[i]! / mag[i]!;
      const uy = gy[i]! / mag[i]!;
      if (mag[i]! < mag[Math.round(y + uy) * w + Math.round(x + ux)]! || mag[i]! < mag[Math.round(y - uy) * w + Math.round(x - ux)]!) continue;
      ids.push(i);
    }
  if (ids.length < 20) return null;
  const widths: number[] = [];
  const random = rng(17);
  for (let q = 0; q < Math.min(400, ids.length); q += 1) {
    const i = ids[Math.floor(random() * ids.length)]!;
    const x = i % w;
    const y = (i - x) / w;
    const ux = gx[i]! / mag[i]!;
    const uy = gy[i]! / mag[i]!;
    const prof: number[] = [];
    for (let t = -6; t <= 6; t += 0.5) {
      const xx = Math.round(x + ux * t);
      const yy = Math.round(y + uy * t);
      prof.push(L[Math.max(0, Math.min(h - 1, yy)) * w + Math.max(0, Math.min(w - 1, xx))]!);
    }
    const lo = Math.min(...prof.slice(0, 5));
    const hi = Math.max(...prof.slice(-5));
    if (hi - lo < 0.3) continue;
    const at = (f: number) => {
      const target = lo + f * (hi - lo);
      for (let k = 1; k < prof.length; k += 1) if (prof[k - 1]! < target && prof[k]! >= target) return (k - 1 + (target - prof[k - 1]!) / (prof[k]! - prof[k - 1]!)) * 0.5;
      return NaN;
    };
    const wd = at(0.9) - at(0.1);
    if (Number.isFinite(wd) && wd > 0) widths.push(wd);
  }
  return widths.length >= 10 ? percentile(widths, 0.5) : null;
}

/**
 * A depth-of-field hint: the f-number that blurs the background by
 * `blurPx` more than the subject, focused on the subject at `subjectM`, for a
 * background somewhere between twice as far and infinitely far (thin lens):
 * c = f² (B − D) / (N · B · (D − f)).
 */
export function apertureFromBlur(blurPx: number, focalMm: number, filmBackWidthMm: number, widthPx: number, subjectM: number): { value: number; low: number; high: number } | null {
  if (!(blurPx > 0.3) || !(focalMm > 0)) return null;
  // The blur's diameter on the sensor, mm (a 10–90 % edge width of a disk blur ≈ 0.8 × its diameter).
  const c = (blurPx / 0.8) * (filmBackWidthMm / widthPx);
  const D = subjectM * 1000;
  const nAt = (bOverD: number) => (focalMm * focalMm * (1 - 1 / bOverD)) / (c * (D - focalMm));
  const near = nAt(2);
  const far = nAt(1e6);
  const clamp = (v: number) => Math.max(0.7, Math.min(32, v));
  const value = clamp(Math.sqrt(near * far));
  return { value, low: Math.min(value, clamp(near / 1.5)), high: Math.max(value, clamp(far * 1.5)) };
}
