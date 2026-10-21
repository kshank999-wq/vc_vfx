import { buildPyramid, trackPoints, type PyramidLevel } from '../roto/flow';
import { gaussianBlur, sampleBilinear } from '../roto/image';
import { detectCorners } from './features';
import { Mat, solveSPD } from './linalg';
import { applyH, dltHomography, ransacHomography } from './two-view';
import type { GrayFrame } from './klt';

/**
 * 2D tracking for surface replacement (master spec §9; addendum 06 §7).
 *
 * Planar: the operator gives four corners on a key frame. Each step, corners
 * found in the key frame inside the surface are carried to the new frame by
 * pyramidal Lucas–Kanade (forward–backward checked) and a homography from the
 * key frame is fitted by RANSAC — key → frame directly, so errors do not
 * accumulate. It is then refined by direct alignment: the key frame's pixels
 * inside the surface are warped onto the frame and the homography (plus a
 * gain and bias for lighting) is solved by Gauss–Newton with Huber weights,
 * coarse to fine. Pixels under an occluder's matte (a roto part) are left
 * out. Confidence is the normalised correlation of the aligned surface.
 *
 * Point: a pattern around the point on the key frame is found in a search
 * window by normalised cross-correlation, then refined to a fraction of a
 * pixel by Lucas–Kanade (translation, gain, bias).
 *
 * Coordinates here are working pixels; callers convert to plate pixels.
 */

export const PLANAR_VERSION = '1.0.0';
export type Quad = [[number, number], [number, number], [number, number], [number, number]];

export interface PlanarIO {
  frame(f: number): Promise<GrayFrame>;
  /** 1 where the surface is hidden on frame f (working size); null when nothing hides it. */
  occlusion?(f: number): Promise<Uint8Array | null>;
}

export interface PlanarStep {
  frame: number;
  corners: Quad;
  confidence: number;
  status: 'tracked' | 'lost';
}

/** Homography mapping the unit square's corners (0,0)(1,0)(1,1)(0,1) — or any 4 points — onto a quad. */
export function homographyFromQuads(from: readonly (readonly [number, number])[], to: readonly (readonly [number, number])[]): number[] | null {
  const a = new Float64Array(from.flatMap((p) => [p[0], p[1]]));
  const b = new Float64Array(to.flatMap((p) => [p[0], p[1]]));
  return dltHomography(a, b);
}

export function pointInQuad(q: readonly (readonly [number, number])[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const [xi, yi] = q[i]!;
    const [xj, yj] = q[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function quadArea(q: readonly (readonly [number, number])[]): number {
  let s = 0;
  for (let i = 0; i < q.length; i += 1) {
    const [x0, y0] = q[i]!;
    const [x1, y1] = q[(i + 1) % q.length]!;
    s += x0 * y1 - x1 * y0;
  }
  return s / 2;
}

function convex(q: Quad): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i += 1) {
    const a = q[i]!;
    const b = q[(i + 1) % 4]!;
    const c = q[(i + 2) % 4]!;
    const z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(z) < 1e-9) return false;
    const s = Math.sign(z);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

interface Template {
  /** Template sample positions (key frame pixels) and values, per pyramid level. */
  levels: { x: Float32Array; y: Float32Array; v: Float32Array; scale: number }[];
}

/** Sample the key frame inside the quad (shrunk a little) on a grid, per level. */
export function buildTemplate(key: PyramidLevel[], quad: Quad, maxSamples = 6000): Template {
  const levels: Template['levels'] = [];
  const area = Math.abs(quadArea(quad));
  const cx = quad.reduce((s, p) => s + p[0], 0) / 4;
  const cy = quad.reduce((s, p) => s + p[1], 0) / 4;
  const shrink = quad.map(([x, y]) => [cx + 0.94 * (x - cx), cy + 0.94 * (y - cy)] as [number, number]);
  for (let l = 0; l < Math.min(3, key.length); l += 1) {
    const s = 1 << l;
    const lvl = key[l]!;
    // Integer steps on the level's pixel grid: template values are pixels, not interpolations.
    const step = Math.max(1, Math.round(Math.sqrt(area / (s * s) / maxSamples)));
    const xs: number[] = [];
    const ys: number[] = [];
    const vs: number[] = [];
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [x, y] of shrink) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    for (let ly = Math.max(0, Math.ceil((y0 + 0.5) / s - 0.5)); ly <= Math.min(lvl.h - 1, Math.floor((y1 + 0.5) / s - 0.5)); ly += step) {
      for (let lx = Math.max(0, Math.ceil((x0 + 0.5) / s - 0.5)); lx <= Math.min(lvl.w - 1, Math.floor((x1 + 0.5) / s - 0.5)); lx += step) {
        const x = (lx + 0.5) * s - 0.5;
        const y = (ly + 0.5) * s - 0.5;
        if (!pointInQuad(shrink, x, y)) continue;
        xs.push(x);
        ys.push(y);
        vs.push(lvl.img[ly * lvl.w + lx]!);
      }
    }
    levels.push({ x: Float32Array.from(xs), y: Float32Array.from(ys), v: Float32Array.from(vs), scale: s });
  }
  return { levels };
}

/**
 * Refine H (key → frame, level-0 pixels) by direct alignment of the template.
 * Returns the refined H, the NCC of the aligned surface and how much of it was visible.
 */
export function alignTemplate(tpl: Template, frame: PyramidLevel[], H0: number[], occlusion: Uint8Array | null, options: { iterations?: number } = {}): { H: number[]; ncc: number; visible: number } {
  // Normalise template coordinates for conditioning: x' = (x − c)/s.
  const L0 = tpl.levels[0]!;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < L0.x.length; i += 1) {
    mx += L0.x[i]!;
    my += L0.y[i]!;
  }
  mx /= Math.max(1, L0.x.length);
  my /= Math.max(1, L0.x.length);
  let sc = 0;
  for (let i = 0; i < L0.x.length; i += 1) sc += Math.hypot(L0.x[i]! - mx, L0.y[i]! - my);
  sc = sc / Math.max(1, L0.x.length) || 1;
  // H in normalised template coordinates (output still in frame pixels): Hn = H · N⁻¹, N⁻¹ = [sc 0 mx; 0 sc my; 0 0 1].
  const Ninv = [sc, 0, mx, 0, sc, my, 0, 0, 1];
  const mul = (a: number[], b: number[]) => {
    const o = new Array<number>(9).fill(0);
    for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) for (let k = 0; k < 3; k += 1) o[i * 3 + j]! += a[i * 3 + k]! * b[k * 3 + j]!;
    return o;
  };
  let Hn = mul(H0, Ninv);
  const n8 = Hn[8]!;
  Hn = Hn.map((v) => v / n8);
  let gain = 1;
  let bias = 0;
  const W0 = frame[0]!.w;
  const H0h = frame[0]!.h;
  for (let li = tpl.levels.length - 1; li >= 0; li -= 1) {
    const T = tpl.levels[li]!;
    const lvl = frame[li];
    if (!lvl) continue;
    const s = T.scale;
    const iters = options.iterations ?? 20;
    for (let it = 0; it < iters; it += 1) {
      const A = new Mat(10, 10);
      const g = new Float64Array(10);
      let used = 0;
      const res: number[] = [];
      // First pass for the robust scale.
      const pts: { r: number; J: number[] }[] = [];
      for (let i = 0; i < T.x.length; i += 1) {
        const u = (T.x[i]! - mx) / sc;
        const v = (T.y[i]! - my) / sc;
        const d = Hn[6]! * u + Hn[7]! * v + 1;
        const wx = (Hn[0]! * u + Hn[1]! * v + Hn[2]!) / d;
        const wy = (Hn[3]! * u + Hn[4]! * v + Hn[5]!) / d;
        if (wx < 1 || wy < 1 || wx > W0 - 2 || wy > H0h - 2) continue;
        if (occlusion && occlusion[Math.round(wy) * W0 + Math.round(wx)]) continue;
        const lx = (wx + 0.5) / s - 0.5;
        const ly = (wy + 0.5) / s - 0.5;
        const I = sampleBilinear(lvl.img, lvl.w, lvl.h, lx, ly);
        const gx = sampleBilinear(lvl.gx, lvl.w, lvl.h, lx, ly) / s;
        const gy = sampleBilinear(lvl.gy, lvl.w, lvl.h, lx, ly) / s;
        const r = gain * I + bias - T.v[i]!;
        const ggx = gain * gx;
        const ggy = gain * gy;
        // d(w)/d(h): h0..h7
        const J = [(ggx * u) / d, (ggx * v) / d, ggx / d, (ggy * u) / d, (ggy * v) / d, ggy / d, (-(ggx * wx + ggy * wy) * u) / d, (-(ggx * wx + ggy * wy) * v) / d, I, 1];
        pts.push({ r, J });
        res.push(Math.abs(r));
      }
      if (pts.length < 20) break;
      res.sort((a, b) => a - b);
      const sigma = Math.max(1e-3, 1.4826 * res[res.length >> 1]!);
      const delta = 1.5 * sigma;
      for (const { r, J } of pts) {
        const w = Math.abs(r) <= delta ? 1 : delta / Math.abs(r);
        for (let a = 0; a < 10; a += 1) {
          g[a]! += w * J[a]! * r;
          for (let b = a; b < 10; b += 1) A.data[a * 10 + b]! += w * J[a]! * J[b]!;
        }
        used += 1;
      }
      for (let a = 0; a < 10; a += 1) for (let b = 0; b < a; b += 1) A.data[a * 10 + b] = A.data[b * 10 + a]!;
      for (let a = 0; a < 10; a += 1) A.data[a * 11]! += 1e-9 + 1e-6 * A.data[a * 11]!;
      const dx = solveSPD(A, Array.from(g, (x) => -x));
      if (!dx || used < 20) break;
      for (let k = 0; k < 8; k += 1) Hn[k] = Hn[k]! + dx[k]!;
      gain += dx[8]!;
      bias += dx[9]!;
      // Converged when the corners of the template move < 0.005 px.
      const move = Math.hypot(dx[2]!, dx[5]!) + Math.hypot(dx[0]!, dx[3]!) + Math.hypot(dx[1]!, dx[4]!);
      if (move < 0.002 / s) break;
    }
  }
  // Back to template pixels: H = Hn · N.
  const N = [1 / sc, 0, -mx / sc, 0, 1 / sc, -my / sc, 0, 0, 1];
  let H = mul(Hn, N);
  const h8 = H[8]!;
  H = H.map((v) => v / h8);
  // NCC of the aligned surface at full resolution.
  const T = tpl.levels[0]!;
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  let n = 0;
  for (let i = 0; i < T.x.length; i += 1) {
    const [wx, wy] = applyH(H, T.x[i]!, T.y[i]!);
    if (wx < 0 || wy < 0 || wx > W0 - 1 || wy > H0h - 1) continue;
    if (occlusion && occlusion[Math.round(wy) * W0 + Math.round(wx)]) continue;
    const a = T.v[i]!;
    const b = sampleBilinear(frame[0]!.img, W0, H0h, wx, wy);
    sa += a;
    sb += b;
    saa += a * a;
    sbb += b * b;
    sab += a * b;
    n += 1;
  }
  const ca = saa - (sa * sa) / Math.max(1, n);
  const cb = sbb - (sb * sb) / Math.max(1, n);
  const ncc = n > 10 && ca > 1e-9 && cb > 1e-9 ? (sab - (sa * sb) / n) / Math.sqrt(ca * cb) : 0;
  return { H, ncc, visible: T.x.length ? n / T.x.length : 0 };
}

/**
 * Track a planar surface from a key frame through `frames` (in order, each
 * adjacent to the previous; the key frame first). Returns one step per frame
 * after the key.
 */
export async function trackPlanar(io: PlanarIO, key: { frame: number; corners: Quad }, frames: number[], ctx: { signal?: { aborted: boolean }; progress?: (done: number, total: number) => void; yieldNow?: () => Promise<void> } = {}): Promise<PlanarStep[]> {
  const g0 = await io.frame(key.frame);
  const W = g0.width;
  const H = g0.height;
  const levels = Math.max(3, Math.min(5, Math.round(Math.log2(Math.max(W, H) / 40))));
  // Direct alignment compares interpolated pixels of two images; a light blur keeps sharp edges
  // from biasing it (interpolation error is position-dependent on unblurred edges).
  const smooth = (d: Float32Array) => gaussianBlur(d, W, H, 1);
  const keyPyr = buildPyramid(smooth(g0.data), W, H, levels);
  const tpl = buildTemplate(keyPyr, key.corners);
  // Features in the surface on the key frame.
  const mask = new Uint8Array(W * H);
  const xs = key.corners.map((p) => p[0]);
  const ys = key.corners.map((p) => p[1]);
  const keyOcc = io.occlusion ? await io.occlusion(key.frame) : null;
  for (let y = Math.max(0, Math.floor(Math.min(...ys))); y <= Math.min(H - 1, Math.ceil(Math.max(...ys))); y += 1)
    for (let x = Math.max(0, Math.floor(Math.min(...xs))); x <= Math.min(W - 1, Math.ceil(Math.max(...xs))); x += 1) if (pointInQuad(key.corners, x, y) && !(keyOcc && keyOcc[y * W + x])) mask[y * W + x] = 1;
  const corners = detectCorners(g0.data, W, H, { maxFeatures: 250, minDistance: Math.max(4, Math.round(Math.sqrt(Math.abs(quadArea(key.corners))) / 25)), quality: 0.005, mask, buckets: [4, 4] });
  const kp = new Float64Array(corners.flatMap((c) => [c.x, c.y]));
  const unit: Quad = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  const keyToUnit = homographyFromQuads(key.corners, unit);
  if (!keyToUnit) throw new Error('The four corners do not make a usable quadrilateral');
  let Hcur = [1, 0, 0, 0, 1, 0, 0, 0, 1]; // key → current frame
  let prevPyr = keyPyr;
  const out: PlanarStep[] = [];
  let lost = false;
  for (let k = 0; k < frames.length; k += 1) {
    if (ctx.signal?.aborted) throw new Error('Cancelled');
    const f = frames[k]!;
    const g = await io.frame(f);
    const pyr = buildPyramid(smooth(g.data), W, H, levels);
    const occ = io.occlusion ? await io.occlusion(f) : null;
    let Hinit = Hcur;
    // Carry the key's features from the previous frame with LK, fit key → frame by RANSAC.
    if (kp.length >= 16 && !lost) {
      const prevPts = new Float32Array(kp.length);
      for (let i = 0; i < kp.length / 2; i += 1) {
        const [x, y] = applyH(Hcur, kp[2 * i]!, kp[2 * i + 1]!);
        prevPts[2 * i] = x;
        prevPts[2 * i + 1] = y;
      }
      const fwd = trackPoints(prevPyr, pyr, prevPts, { win: 7, iterations: 12 });
      const moved = new Float32Array(prevPts.length);
      for (let i = 0; i < prevPts.length / 2; i += 1) {
        moved[2 * i] = prevPts[2 * i]! + fwd.dx[i]!;
        moved[2 * i + 1] = prevPts[2 * i + 1]! + fwd.dy[i]!;
      }
      const bwd = trackPoints(pyr, prevPyr, moved, { win: 7, iterations: 12 });
      const src: number[] = [];
      const dst: number[] = [];
      for (let i = 0; i < prevPts.length / 2; i += 1) {
        const fb = Math.hypot(moved[2 * i]! + bwd.dx[i]! - prevPts[2 * i]!, moved[2 * i + 1]! + bwd.dy[i]! - prevPts[2 * i + 1]!);
        if (!fwd.ok[i] || !bwd.ok[i] || fb > 1) continue;
        if (occ && occ[Math.round(moved[2 * i + 1]!) * W + Math.round(moved[2 * i]!)]) continue;
        src.push(kp[2 * i]!, kp[2 * i + 1]!);
        dst.push(moved[2 * i]!, moved[2 * i + 1]!);
      }
      if (src.length >= 16) {
        const r = ransacHomography(Float64Array.from(src), Float64Array.from(dst), { threshold: 2, maxIterations: 300, seed: 31 + k });
        if (r && r.count >= 8) Hinit = r.model;
      }
    }
    const a = alignTemplate(tpl, pyr, Hinit, occ);
    const q = key.corners.map(([x, y]) => applyH(a.H, x, y)) as Quad;
    const areaRatio = Math.abs(quadArea(q) / quadArea(key.corners));
    const ok = a.ncc > 0.5 && a.visible > 0.15 && convex(q) && areaRatio > 0.05 && areaRatio < 20 && q.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
    const confidence = Math.max(0, Math.min(1, ((a.ncc - 0.5) / 0.45) * Math.min(1, a.visible / 0.5)));
    if (ok) {
      Hcur = a.H;
      lost = false;
      out.push({ frame: f, corners: q, confidence, status: 'tracked' });
    } else {
      lost = true;
      out.push({ frame: f, corners: key.corners.map(([x, y]) => applyH(Hcur, x, y)) as Quad, confidence: 0, status: 'lost' });
    }
    prevPyr = pyr;
    ctx.progress?.(k + 1, frames.length);
    if (k % 3 === 2) await ctx.yieldNow?.();
  }
  void keyToUnit;
  return out;
}

export interface PointStep {
  frame: number;
  point: [number, number];
  confidence: number;
  status: 'tracked' | 'lost';
}

function ncc(a: Float32Array, b: Float32Array, w: number, h: number, ax: number, ay: number, bx: number, by: number, r: number, A: readonly number[] = [1, 0, 0, 1]): number {
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  let n = 0;
  for (let j = -r; j <= r; j += 1)
    for (let i = -r; i <= r; i += 1) {
      const va = sampleBilinear(a, w, h, ax + i, ay + j);
      const vb = sampleBilinear(b, w, h, bx + A[0]! * i + A[1]! * j, by + A[2]! * i + A[3]! * j);
      sa += va;
      sb += vb;
      saa += va * va;
      sbb += vb * vb;
      sab += va * vb;
      n += 1;
    }
  const ca = saa - (sa * sa) / n;
  const cb = sbb - (sb * sb) / n;
  return ca > 1e-9 && cb > 1e-9 ? (sab - (sa * sb) / n) / Math.sqrt(ca * cb) : 0;
}

/** Track one point (pattern radius r, search radius s, working pixels) from a key frame. */
export async function trackPoint(io: PlanarIO, key: { frame: number; point: [number, number] }, frames: number[], opts: { pattern: number; search: number }, ctx: { signal?: { aborted: boolean }; progress?: (done: number, total: number) => void; yieldNow?: () => Promise<void> } = {}): Promise<PointStep[]> {
  const raw = await io.frame(key.frame);
  const W = raw.width;
  const H = raw.height;
  // The same light blur as the planar tracker: sub-pixel matching is not biased by sharp edges.
  const kf = { ...raw, data: gaussianBlur(raw.data, W, H, 1) };
  const r = Math.max(3, Math.round(opts.pattern));
  const S = Math.max(4, Math.round(opts.search));
  const [kx, ky] = key.point;
  let p: [number, number] = [kx, ky];
  let vel: [number, number] = [0, 0];
  let affine = [1, 0, 0, 1];
  const out: PointStep[] = [];
  for (let k = 0; k < frames.length; k += 1) {
    if (ctx.signal?.aborted) throw new Error('Cancelled');
    const f = frames[k]!;
    const g0 = await io.frame(f);
    const g = { ...g0, data: gaussianBlur(g0.data, W, H, 1) };
    const pred: [number, number] = [p[0] + vel[0], p[1] + vel[1]];
    // Coarse NCC search on a 2-pixel grid, then ±2 at 1 px.
    let best = -2;
    let bx = pred[0];
    let by = pred[1];
    // The whole pattern even when coarse (small patterns repeat on busy texture), with a slight
    // preference for staying near the prediction.
    for (let dy = -S; dy <= S; dy += 2)
      for (let dx = -S; dx <= S; dx += 2) {
        const c = ncc(kf.data, g.data, W, H, kx, ky, pred[0] + dx, pred[1] + dy, r, affine) - 0.002 * Math.hypot(dx, dy);
        if (c > best) {
          best = c;
          bx = pred[0] + dx;
          by = pred[1] + dy;
        }
      }
    const cx0 = bx;
    const cy0 = by;
    best = -2; // the refinement compares full-size patterns, not the coarse ones
    for (let dy = -2; dy <= 2; dy += 1)
      for (let dx = -2; dx <= 2; dx += 1) {
        const c = ncc(kf.data, g.data, W, H, kx, ky, cx0 + dx, cy0 + dy, r, affine);
        if (c > best) {
          best = c;
          bx = cx0 + dx;
          by = cy0 + dy;
        }
      }
    // Sub-pixel: affine Lucas–Kanade (the pattern may scale, turn and shear) with gain and bias,
    // against the key pattern: x' = p + A·(x − k), A carried from the previous frame.
    let x = bx;
    let y = by;
    let A = [...affine];
    let gain = 1;
    let bias = 0;
    const gpyr = buildPyramid(g.data, W, H, 1)[0]!;
    for (let it = 0; it < 30; it += 1) {
      const M = new Mat(8, 8);
      const gr = new Float64Array(8);
      for (let j = -r; j <= r; j += 1)
        for (let i = -r; i <= r; i += 1) {
          const wx = x + A[0]! * i + A[1]! * j;
          const wy = y + A[2]! * i + A[3]! * j;
          const I = sampleBilinear(gpyr.img, W, H, wx, wy);
          const gx = gain * sampleBilinear(gpyr.gx, W, H, wx, wy);
          const gy = gain * sampleBilinear(gpyr.gy, W, H, wx, wy);
          const T = sampleBilinear(kf.data, W, H, kx + i, ky + j);
          const res = gain * I + bias - T;
          const J = [gx, gy, gx * i, gx * j, gy * i, gy * j, I, 1];
          for (let a = 0; a < 8; a += 1) {
            gr[a]! += J[a]! * res;
            for (let b = a; b < 8; b += 1) M.data[a * 8 + b]! += J[a]! * J[b]!;
          }
        }
      for (let a = 0; a < 8; a += 1) for (let b = 0; b < a; b += 1) M.data[a * 8 + b] = M.data[b * 8 + a]!;
      for (let a = 0; a < 8; a += 1) M.data[a * 9]! += 1e-9 + 1e-6 * M.data[a * 9]!;
      const d = solveSPD(M, Array.from(gr, (v) => -v));
      if (!d) break;
      x += d[0]!;
      y += d[1]!;
      A = [A[0]! + d[2]!, A[1]! + d[3]!, A[2]! + d[4]!, A[3]! + d[5]!];
      gain += d[6]!;
      bias += d[7]!;
      if (Math.hypot(d[0]!, d[1]!) < 1e-3) break;
    }
    const det = A[0]! * A[3]! - A[1]! * A[2]!;
    if (Math.hypot(x - bx, y - by) > 2.5 || !(det > 0.2 && det < 5)) {
      x = bx;
      y = by;
      A = [...affine];
    }
    // Score with the same affine.
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, nn = 0;
    for (let j = -r; j <= r; j += 1)
      for (let i = -r; i <= r; i += 1) {
        const va = sampleBilinear(kf.data, W, H, kx + i, ky + j);
        const vb = sampleBilinear(g.data, W, H, x + A[0]! * i + A[1]! * j, y + A[2]! * i + A[3]! * j);
        sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb; nn += 1;
      }
    const ca = saa - (sa * sa) / nn;
    const cb = sbb - (sb * sb) / nn;
    const c = ca > 1e-9 && cb > 1e-9 ? (sab - (sa * sb) / nn) / Math.sqrt(ca * cb) : 0;
    const ok = c > 0.6 && x >= 0 && y >= 0 && x <= W - 1 && y <= H - 1;
    if (ok) {
      vel = [x - p[0], y - p[1]];
      p = [x, y];
      affine = A;
    }
    out.push({ frame: f, point: ok ? [x, y] : p, confidence: ok ? Math.max(0, Math.min(1, (c - 0.6) / 0.35)) : 0, status: ok ? 'tracked' : 'lost' });
    ctx.progress?.(k + 1, frames.length);
    if (k % 5 === 4) await ctx.yieldNow?.();
  }
  return out;
}

/** Linear blend of two runs' points over the frames between two keys (weight to the later key grows with the frame). */
export function blendRuns<T extends { frame: number; points: [number, number][]; confidence: number; status: 'tracked' | 'lost' }>(fromEarlier: T[], fromLater: T[], a: number, b: number): T[] {
  const later = new Map(fromLater.map((s) => [s.frame, s]));
  return fromEarlier.map((s) => {
    const o = later.get(s.frame);
    if (!o || o.status === 'lost') return s;
    if (s.status === 'lost') return o;
    const w = (s.frame - a) / Math.max(1, b - a);
    return { ...s, points: s.points.map((p, i) => [p[0] * (1 - w) + o.points[i]![0] * w, p[1] * (1 - w) + o.points[i]![1] * w] as [number, number]), confidence: Math.min(s.confidence, o.confidence) };
  });
}
