import { detectCorners } from '../camera/features';
import { alignTemplate } from '../camera/planar';
import { applyH, ransacHomography } from '../camera/two-view';
import { buildPyramid, trackPoints, type PyramidLevel } from '../roto/flow';
import { gaussianBlur, sampleBilinear } from '../roto/image';
import { resizeLinear, type LinearImage } from '../key/linear';
import { inv3, mul3 } from './synthetic';

/**
 * Camera-motion-aware alignment for clean plates (master spec §8 bullet 2;
 * addendum 10 §3.1). Every frame is related to the reference frame by a
 * homography — exact for a camera that only rotates and zooms, and for a
 * background that is far away or flat; the residual says how far that holds.
 *
 * Built from the camera tracker's parts (addendum 06):
 *  1. frame to frame: Shi–Tomasi corners on the background (the subject's
 *     dilated matte excluded on both frames) carried by pyramidal
 *     Lucas–Kanade, forward–backward checked, a homography fitted by RANSAC;
 *     chained out from the reference frame in both directions;
 *  2. refined directly against the reference: the reference's background
 *     pixels warped onto the frame, homography plus gain and bias solved by
 *     Gauss–Newton with Huber weights, coarse to fine (the planar tracker's
 *     `alignTemplate`), the frame's own matte left out — so the chain's drift
 *     does not accumulate wherever the frame still overlaps the reference;
 *  3. measured: the frame warped into the reference's coordinates, corners
 *     tracked between the two — what is left over is the residual (parallax,
 *     lens distortion, rolling shutter), in pixels;
 *  4. exposure: the per-channel gain of the frame against the reference, the
 *     median ratio over background pixels both frames see.
 *
 * Grey frames are worked on at most `maxWidth` wide (downscaled alignment);
 * homographies are returned in the caller's (working) pixels, pixel centres
 * at integer coordinates.
 */

export const IDENTITY: readonly number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export interface FrameAlignment {
  frame: number;
  /** Reference pixel → this frame's pixel (working pixels). */
  H: number[];
  /** Median residual displacement after alignment, working pixels. */
  residual: number;
  /** Largest displacement of the frame's corners against the reference, working pixels. */
  motion: number;
  /** Per-channel exposure of this frame against the reference. */
  gain: [number, number, number];
  /** NCC of the direct alignment against the reference (1 for the reference itself; 0 when it did not run). */
  ncc: number;
}

export interface AlignInput {
  /** Linear RGB at the working size. */
  image: LinearImage;
  /** 1 = the subject (dilated): left out of the alignment. */
  hole: Uint8Array | null;
}

export interface AlignOptions {
  /** Longest edge the alignment works at. */
  maxWidth?: number;
  luma: readonly [number, number, number];
  /** static: identity for every frame; homography: always align; auto: align, and report static when nothing moved. */
  model: 'auto' | 'static' | 'homography';
  /** Motion below this (working pixels) over the whole shot counts as a static camera. */
  staticThreshold?: number;
}

/** The alignment of a whole shot to its reference frame. */
export interface ShotAlignment {
  reference: number;
  model: 'static' | 'homography';
  static: boolean;
  frames: Map<number, FrameAlignment>;
  /** Largest motion over the shot, working pixels. */
  motion: number;
  /** Median residual over the shot, working pixels. */
  residual: number;
  /** Largest exposure change against the reference, stops. */
  exposureStops: number;
}

const luminance = (img: LinearImage, luma: readonly [number, number, number]): Float32Array => {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  const d = img.data;
  // √ for a perceptual spread (as the key's roto guide does): shadows count, highlights do not dominate.
  for (let i = 0; i < n; i += 1) out[i] = Math.sqrt(Math.max(0, Math.min(4, luma[0] * d[3 * i]! + luma[1] * d[3 * i + 1]! + luma[2] * d[3 * i + 2]!)));
  return out;
};

/** Grow a binary mask by r pixels with a square (two running passes; cheap at any size). */
function dilateSquare(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    let last = -1e9;
    for (let x = 0; x < w; x += 1) {
      if (src[row + x]) last = x;
      if (x - last <= r) tmp[row + x] = 1;
    }
    last = 1e9;
    for (let x = w - 1; x >= 0; x -= 1) {
      if (src[row + x]) last = x;
      if (last - x <= r) tmp[row + x] = 1;
    }
  }
  for (let x = 0; x < w; x += 1) {
    let last = -1e9;
    for (let y = 0; y < h; y += 1) {
      if (tmp[y * w + x]) last = y;
      if (y - last <= r) out[y * w + x] = 1;
    }
    last = 1e9;
    for (let y = h - 1; y >= 0; y -= 1) {
      if (tmp[y * w + x]) last = y;
      if (last - y <= r) out[y * w + x] = 1;
    }
  }
  return out;
}

/** Any-pixel downscale of a binary mask (a small-scale pixel is masked when any of its source pixels is). */
function shrinkMask(src: Uint8Array, w: number, h: number, nw: number, nh: number): Uint8Array {
  if (nw === w && nh === h) return src;
  const out = new Uint8Array(nw * nh);
  const sx = w / nw;
  const sy = h / nh;
  for (let y = 0; y < h; y += 1) {
    const yy = Math.min(nh - 1, Math.floor(y / sy));
    for (let x = 0; x < w; x += 1) if (src[y * w + x]) out[yy * nw + Math.min(nw - 1, Math.floor(x / sx))] = 1;
  }
  return out;
}

/** Scale a homography between pixel grids whose pixel centres are at integers: x' = (x + ½)·k − ½. */
export function scaleHomography(H: readonly number[], k: number): number[] {
  if (k === 1) return [...H];
  const S = [k, 0, 0.5 * k - 0.5, 0, k, 0.5 * k - 0.5, 0, 0, 1];
  const Si = [1 / k, 0, (0.5 - 0.5 * k) / k, 0, 1 / k, (0.5 - 0.5 * k) / k, 0, 0, 1];
  const out = mul3(mul3(S, H), Si);
  return out.map((v) => v / out[8]!);
}

/** Largest displacement of the image's corners under H. */
export function cornerMotion(H: readonly number[], w: number, h: number): number {
  let m = 0;
  for (const [x, y] of [
    [0, 0],
    [w - 1, 0],
    [w - 1, h - 1],
    [0, h - 1],
  ] as const) {
    const [u, v] = applyH(H, x, y);
    m = Math.max(m, Math.hypot(u - x, v - y));
  }
  return Number.isFinite(m) ? m : 1e9;
}

interface Small {
  w: number;
  h: number;
  /** Working pixels per small pixel. */
  k: number;
  gray: Float32Array;
  hole: Uint8Array;
  pyr: PyramidLevel[];
  rgb: Float32Array;
}

/** A light Gaussian blur of an RGB image (anti-aliasing before a small downscale). */
function blurRgb(img: LinearImage, sigma: number): LinearImage {
  const n = img.width * img.height;
  const out = new Float32Array(n * 3);
  for (let c = 0; c < 3; c += 1) {
    const plane = new Float32Array(n);
    for (let i = 0; i < n; i += 1) plane[i] = img.data[3 * i + c]!;
    const b = gaussianBlur(plane, img.width, img.height, sigma);
    for (let i = 0; i < n; i += 1) out[3 * i + c] = b[i]!;
  }
  return { width: img.width, height: img.height, data: out };
}

function small(input: AlignInput, o: AlignOptions): Small {
  const { width: W, height: H } = input.image;
  const maxW = o.maxWidth ?? 640;
  const w = Math.min(W, maxW);
  const h = Math.max(8, Math.round((H * w) / W));
  const k = W / w;
  // Pixel centres aligned (x' = (x + ½)·k − ½), as the homographies are scaled: binning at a
  // non-integer factor would shift the grid and show up as alignment error.
  const rgb = w === W ? input.image.data : resizeLinear(k < 2 ? blurRgb(input.image, 0.5 * k) : input.image, w, h).data;
  const gray = gaussianBlur(luminance({ width: w, height: h, data: rgb }, o.luma), w, h, 0.8);
  let hole = input.hole ? shrinkMask(input.hole, W, H, w, h) : new Uint8Array(w * h);
  // A margin round the subject: its shadow and soft edge do not pull the alignment.
  hole = dilateSquare(hole, w, h, 2);
  const levels = Math.max(3, Math.min(5, Math.round(Math.log2(Math.max(w, h) / 40))));
  return { w, h, k, gray, hole, pyr: buildPyramid(gray, w, h, levels), rgb };
}

/** Background corners of a frame: not in the (dilated) matte, away from the border. */
function corners(s: Small, max = 300): Float32Array {
  const mask = new Uint8Array(s.w * s.h);
  for (let i = 0; i < mask.length; i += 1) mask[i] = s.hole[i] ? 0 : 1;
  const cs = detectCorners(s.gray, s.w, s.h, { maxFeatures: max, quality: 0.005, mask, minDistance: Math.max(4, Math.round(Math.min(s.w, s.h) / 40)), buckets: [8, 5] });
  return Float32Array.from(cs.flatMap((c) => [c.x, c.y]));
}

/** a → b homography from tracked background corners, or null when too few agree. */
function pairwise(a: Small, b: Small, seed: number): { H: number[]; inliers: number } | null {
  const pts = corners(a, 220);
  if (pts.length < 16) return null;
  const fwd = trackPoints(a.pyr, b.pyr, pts, { win: 6, iterations: 12 });
  const moved = new Float32Array(pts.length);
  for (let i = 0; i < pts.length / 2; i += 1) {
    moved[2 * i] = pts[2 * i]! + fwd.dx[i]!;
    moved[2 * i + 1] = pts[2 * i + 1]! + fwd.dy[i]!;
  }
  const bwd = trackPoints(b.pyr, a.pyr, moved, { win: 6, iterations: 12 });
  const src: number[] = [];
  const dst: number[] = [];
  for (let i = 0; i < pts.length / 2; i += 1) {
    if (!fwd.ok[i] || !bwd.ok[i]) continue;
    const fb = Math.hypot(moved[2 * i]! + bwd.dx[i]! - pts[2 * i]!, moved[2 * i + 1]! + bwd.dy[i]! - pts[2 * i + 1]!);
    if (fb > 0.5) continue;
    const mx = Math.round(moved[2 * i]!);
    const my = Math.round(moved[2 * i + 1]!);
    if (mx < 0 || my < 0 || mx >= b.w || my >= b.h || b.hole[my * b.w + mx]) continue;
    src.push(pts[2 * i]!, pts[2 * i + 1]!);
    dst.push(moved[2 * i]!, moved[2 * i + 1]!);
  }
  if (src.length < 16) return null;
  const r = ransacHomography(Float64Array.from(src), Float64Array.from(dst), { threshold: 1, maxIterations: 400, seed });
  if (!r || r.count < 8) return null;
  return { H: r.model, inliers: r.count };
}

/** The reference's background as an alignment template (positions and values per pyramid level). */
function template(ref: Small, maxSamples = 4000, levelCount = 2) {
  const levels: { x: Float32Array; y: Float32Array; v: Float32Array; scale: number }[] = [];
  const border = 3;
  for (let l = 0; l < Math.min(levelCount, ref.pyr.length); l += 1) {
    const s = 1 << l;
    const lvl = ref.pyr[l]!;
    const step = Math.max(1, Math.round(Math.sqrt((ref.w * ref.h) / (s * s) / maxSamples)));
    const xs: number[] = [];
    const ys: number[] = [];
    const vs: number[] = [];
    for (let ly = border; ly < lvl.h - border; ly += step)
      for (let lx = border; lx < lvl.w - border; lx += step) {
        const x = (lx + 0.5) * s - 0.5;
        const y = (ly + 0.5) * s - 0.5;
        const xi = Math.min(ref.w - 1, Math.round(x));
        const yi = Math.min(ref.h - 1, Math.round(y));
        if (ref.hole[yi * ref.w + xi]) continue;
        xs.push(x);
        ys.push(y);
        vs.push(lvl.img[ly * lvl.w + lx]!);
      }
    levels.push({ x: Float32Array.from(xs), y: Float32Array.from(ys), v: Float32Array.from(vs), scale: s });
  }
  return { levels };
}

/** The frame warped into the reference's coordinates (grey), and where it has no pixels or the subject (1). */
function warpToRef(ref: Small, f: Small, H: readonly number[]): { gray: Float32Array; invalid: Uint8Array } {
  const gray = new Float32Array(ref.w * ref.h);
  const invalid = new Uint8Array(ref.w * ref.h);
  for (let y = 0; y < ref.h; y += 1)
    for (let x = 0; x < ref.w; x += 1) {
      const i = y * ref.w + x;
      const [u, v] = applyH(H, x, y);
      if (!(u >= 0 && v >= 0 && u <= f.w - 1 && v <= f.h - 1) || f.hole[Math.round(v) * f.w + Math.round(u)]) {
        invalid[i] = 1;
        gray[i] = ref.gray[i]!;
        continue;
      }
      gray[i] = sampleBilinear(f.gray, f.w, f.h, u, v);
    }
  return { gray, invalid };
}

/** Median leftover displacement between the reference and the aligned frame, small pixels. */
function residualOf(ref: Small, f: Small, H: readonly number[], refPts: Float32Array): number {
  if (refPts.length < 8) return 0;
  const warped = warpToRef(ref, f, H);
  const pyr = buildPyramid(warped.gray, ref.w, ref.h, 2);
  const keep: number[] = [];
  for (let i = 0; i < refPts.length / 2; i += 1) {
    const x = Math.round(refPts[2 * i]!);
    const y = Math.round(refPts[2 * i + 1]!);
    let bad = false;
    for (let dy = -4; dy <= 4 && !bad; dy += 2) for (let dx = -4; dx <= 4 && !bad; dx += 2) bad = Boolean(warped.invalid[Math.min(ref.h - 1, Math.max(0, y + dy)) * ref.w + Math.min(ref.w - 1, Math.max(0, x + dx))]);
    if (!bad) keep.push(refPts[2 * i]!, refPts[2 * i + 1]!);
  }
  if (keep.length < 8) return 0;
  const pts = Float32Array.from(keep);
  const t = trackPoints(ref.pyr.slice(0, 2), pyr, pts, { win: 5, iterations: 10 });
  const d: number[] = [];
  for (let i = 0; i < pts.length / 2; i += 1) if (t.ok[i]) d.push(Math.hypot(t.dx[i]!, t.dy[i]!));
  if (!d.length) return 0;
  d.sort((a, b) => a - b);
  return d[d.length >> 1]!;
}

/** Per-channel gain of the frame against the reference over background both see (median ratio). */
function gainOf(ref: Small, f: Small, H: readonly number[], luma: readonly [number, number, number]): [number, number, number] {
  const ratios: [number[], number[], number[]] = [[], [], []];
  const step = Math.max(1, Math.round(Math.sqrt((ref.w * ref.h) / 6000)));
  for (let y = 2; y < ref.h - 2; y += step)
    for (let x = 2; x < ref.w - 2; x += step) {
      const i = y * ref.w + x;
      if (ref.hole[i]) continue;
      const [u, v] = applyH(H, x, y);
      if (!(u >= 1 && v >= 1 && u <= f.w - 2 && v <= f.h - 2) || f.hole[Math.round(v) * f.w + Math.round(u)]) continue;
      const y0 = luma[0] * ref.rgb[3 * i]! + luma[1] * ref.rgb[3 * i + 1]! + luma[2] * ref.rgb[3 * i + 2]!;
      if (y0 < 0.01) continue;
      const xi = Math.round(u);
      const yi = Math.round(v);
      const j = 3 * (yi * f.w + xi);
      for (let c = 0; c < 3; c += 1) {
        const a = ref.rgb[3 * i + c]!;
        if (a > 0.004) ratios[c as 0 | 1 | 2].push(f.rgb[j + c]! / a);
      }
    }
  if (ratios[1].length < 30) return [1, 1, 1];
  return ratios.map((r) => {
    r.sort((a, b) => a - b);
    return Math.max(0.25, Math.min(4, r[r.length >> 1]!));
  }) as [number, number, number];
}

const toWorking = (H: readonly number[], k: number) => scaleHomography(H, k);

/**
 * Align a shot to its reference frame. `read(f)` gives each frame (with its
 * subject matte at the working size); it is called twice per frame, in order
 * — the first pass chains frame to frame, the second refines against the
 * reference — so a reader that reads ahead serves it well.
 */
export async function alignShot(
  frames: readonly number[],
  reference: number,
  read: (f: number) => Promise<AlignInput>,
  o: AlignOptions,
  ctx: { check?: () => void; progress?: (done: number, total: number, frame: number) => void } = {},
): Promise<ShotAlignment> {
  const order = [...frames].sort((a, b) => a - b);
  if (!order.includes(reference)) throw new Error(`The reference frame ${reference} is outside the shot`);
  const total = order.length * 2;
  let done = 0;
  const refIn = await read(reference);
  const W = refIn.image.width;
  const Hh = refIn.image.height;
  const ref = small(refIn, o);
  const k = ref.k;
  const out = new Map<number, FrameAlignment>();

  // 1. Frame to frame, chained out from the reference (in small pixels).
  const chain = new Map<number, number[]>([[reference, [...IDENTITY]]]);
  if (o.model !== 'static') {
    const pair = new Map<number, number[] | null>(); // f → f+1
    let prev: Small | null = null;
    let prevF = -1;
    for (const f of order) {
      ctx.check?.();
      const cur = f === reference ? ref : small(await read(f), o);
      if (prev && f === prevF + 1) pair.set(prevF, pairwise(prev, cur, 17 + f)?.H ?? null);
      prev = cur;
      prevF = f;
      ctx.progress?.(++done, total, f);
    }
    const ri = order.indexOf(reference);
    for (let i = ri + 1; i < order.length; i += 1) {
      const p = pair.get(order[i - 1]!) ?? IDENTITY;
      chain.set(order[i]!, mul3(p as number[], chain.get(order[i - 1]!)!));
    }
    for (let i = ri - 1; i >= 0; i -= 1) {
      const p = pair.get(order[i]!);
      chain.set(order[i]!, mul3(p ? inv3(p) : [...IDENTITY], chain.get(order[i + 1]!)!));
    }
  } else {
    done += order.length;
    for (const f of order) chain.set(f, [...IDENTITY]);
  }

  // 2–4. Refine against the reference; measure the residual and the exposure.
  const tpl = o.model === 'static' ? null : template(ref);
  const refPts = corners(ref, 250);
  // Backwards: the frames the first pass read last are still in the reader's cache.
  for (const f of [...order].reverse()) {
    ctx.check?.();
    let Hs = chain.get(f)!.map((v, _i, a) => v / a[8]!);
    let ncc = f === reference ? 1 : 0;
    const cur = f === reference ? ref : small(await read(f), o);
    if (f !== reference && tpl) {
      const a = alignTemplate(tpl, cur.pyr, Hs, cur.hole, { iterations: 8 });
      // Only take the refinement where enough of the reference is still in view and it fits.
      if (a.visible > 0.2 && a.ncc > 0.6 && a.H.every(Number.isFinite) && cornerMotion(mul3(a.H, inv3(Hs)), cur.w, cur.h) < 0.1 * cur.w) {
        Hs = a.H;
        ncc = a.ncc;
      }
    }
    const residual = f === reference ? 0 : residualOf(ref, cur, Hs, refPts) * k;
    const gain = f === reference ? ([1, 1, 1] as [number, number, number]) : gainOf(ref, cur, Hs, o.luma);
    const H = toWorking(Hs, k);
    out.set(f, { frame: f, H, residual, motion: cornerMotion(H, W, Hh), gain, ncc });
    ctx.progress?.(++done, total, f);
  }

  const motion = Math.max(...[...out.values()].map((a) => a.motion));
  const isStatic = o.model === 'static' || (o.model === 'auto' && motion < (o.staticThreshold ?? 0.5));
  // A static camera borrows pixels as they are: no resampling, so nothing is softened.
  if (isStatic) for (const a of out.values()) out.set(a.frame, { ...a, H: [...IDENTITY] });
  const residuals = [...out.values()].filter((a) => a.frame !== reference).map((a) => a.residual).sort((a, b) => a - b);
  const lumaGain = (g: readonly number[]) => o.luma[0] * g[0]! + o.luma[1] * g[1]! + o.luma[2] * g[2]!;
  const exposureStops = Math.max(0, ...[...out.values()].map((a) => Math.abs(Math.log2(Math.max(1e-3, lumaGain(a.gain))))));
  return {
    reference,
    model: isStatic ? 'static' : 'homography',
    static: isStatic,
    frames: out,
    motion,
    residual: residuals.length ? residuals[residuals.length >> 1]! : 0,
    exposureStops,
  };
}

/** target → source homography from both frames' reference alignments (working pixels). */
export function between(alignment: ShotAlignment, target: number, source: number): number[] {
  const t = alignment.frames.get(target);
  const s = alignment.frames.get(source);
  if (!t || !s) throw new Error(`No alignment for frame ${!t ? target : source}`);
  if (alignment.static) return [...IDENTITY];
  const H = mul3(s.H, inv3(t.H));
  return H.map((v) => v / H[8]!);
}

