import type { ScreenKind } from '@vcvfx/domain';
import { morph } from '../roto/image';
import type { LinearImage } from './linear';

/**
 * The clean plate: a model of the screen alone (addendum 09 §3.2).
 *
 * Real screens are lit unevenly — brighter in the middle, falling off at the
 * corners, a seam, a shadow. Keying every pixel against one colour then
 * leaves the dim corners grey. Instead the keyer keys each pixel against
 * what the screen would be there without the subject: a smooth field over a
 * coarse grid, made from the pixels that are certainly screen in a few frames
 * spread over the shot (the subject moves, so what it hides in one frame is
 * seen in another), with the cells the subject covers in every frame filled
 * in from their neighbours (pull–push inpainting). Built twice: the second
 * pass picks its screen pixels against the first model, so dim screen is
 * found too. Per frame, a global gain follows slow drift (flicker, a cloud).
 */

export interface ScreenModel {
  /** Grid cells across and down; the grid spans the image (cell centres). */
  gw: number;
  gh: number;
  /** Linear RGB per cell, row-major. */
  grid: Float32Array;
  /** Share of cells that had screen pixels (the rest were inpainted). */
  observed: number;
  /**
   * Per cell, how well the screen was seen there (0 … 1, before inpainting).
   * Absent: everywhere (a flat model).
   */
  support?: Float32Array;
}

export interface ScreenRef {
  kind: ScreenKind;
  rgb: readonly [number, number, number];
}

const chromaOf = (r: number, g: number, b: number): [number, number] => {
  const s = r + g + b;
  return s > 1e-6 ? [r / s, b / s] : [1, 1];
};

/**
 * Pixels that are certainly screen: chromaticity within `tol` of the screen's
 * and, when a model is given, within 25 % of its brightness there; eroded so
 * soft edges (hair, motion blur) are left out.
 */
export function screenCandidates(img: LinearImage, screen: ScreenRef, model: Float32Array | null, options: { tol?: number; erode?: number } = {}): Uint8Array {
  const n = img.width * img.height;
  const [sr, sb] = chromaOf(screen.rgb[0], screen.rgb[1], screen.rgb[2]);
  const tol = options.tol ?? 0.045;
  const out = new Uint8Array(n);
  const d = img.data;
  for (let i = 0; i < n; i += 1) {
    const r = d[3 * i]!;
    const g = d[3 * i + 1]!;
    const b = d[3 * i + 2]!;
    const [cr, cb] = chromaOf(r, g, b);
    if ((cr - sr) ** 2 + (cb - sb) ** 2 > tol * tol) continue;
    if (model) {
      const mr = model[3 * i]!;
      const mg = model[3 * i + 1]!;
      const mb = model[3 * i + 2]!;
      const ms = mr + mg + mb;
      if (!(ms > 1e-6) || Math.abs(r + g + b - ms) > 0.25 * ms) continue;
    } else if (r + g + b < 0.08 * (screen.rgb[0] + screen.rgb[1] + screen.rgb[2])) continue;
    out[i] = 1;
  }
  const e = options.erode ?? 2;
  return e > 0 ? morph(out, img.width, img.height, -e) : out;
}

/**
 * Fill the unweighted samples of a grid from the weighted ones (pull–push):
 * average down a pyramid by weight, then fill each level's gaps from the
 * level above. `values` has `ch` channels per sample.
 */
export function pullPush(values: Float32Array, weights: Float32Array, w: number, h: number, ch: number): Float32Array {
  type Level = { w: number; h: number; vw: Float32Array; wt: Float32Array };
  const levels: Level[] = [];
  const base: Level = { w, h, vw: new Float32Array(w * h * ch), wt: Float32Array.from(weights) };
  for (let i = 0; i < w * h; i += 1) for (let c = 0; c < ch; c += 1) base.vw[i * ch + c] = values[i * ch + c]! * weights[i]!;
  levels.push(base);
  while (levels[levels.length - 1]!.w > 1 || levels[levels.length - 1]!.h > 1) {
    const L = levels[levels.length - 1]!;
    const nw = Math.max(1, Math.ceil(L.w / 2));
    const nh = Math.max(1, Math.ceil(L.h / 2));
    const next: Level = { w: nw, h: nh, vw: new Float32Array(nw * nh * ch), wt: new Float32Array(nw * nh) };
    for (let y = 0; y < L.h; y += 1)
      for (let x = 0; x < L.w; x += 1) {
        const i = y * L.w + x;
        const j = (y >> 1) * nw + (x >> 1);
        next.wt[j]! += L.wt[i]!;
        for (let c = 0; c < ch; c += 1) next.vw[j * ch + c]! += L.vw[i * ch + c]!;
      }
    levels.push(next);
  }
  // Push: each level's value is its own where it is well supported, the coarser level's where not.
  let above: Float32Array | null = null;
  let aw = 1;
  let ah = 1;
  for (let l = levels.length - 1; l >= 0; l -= 1) {
    const L = levels[l]!;
    const val = new Float32Array(L.w * L.h * ch);
    for (let y = 0; y < L.h; y += 1)
      for (let x = 0; x < L.w; x += 1) {
        const i = y * L.w + x;
        const wt = L.wt[i]!;
        const a = Math.min(1, wt);
        for (let c = 0; c < ch; c += 1) {
          let coarse = 0;
          if (above) {
            // Bilinear from the level above, at this sample's centre.
            const fx = Math.min(aw - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
            const fy = Math.min(ah - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
            const x0 = Math.floor(fx);
            const y0 = Math.floor(fy);
            const x1 = Math.min(aw - 1, x0 + 1);
            const y1 = Math.min(ah - 1, y0 + 1);
            const tx = fx - x0;
            const ty = fy - y0;
            const at = (xx: number, yy: number) => above![(yy * aw + xx) * ch + c]!;
            coarse = (at(x0, y0) * (1 - tx) + at(x1, y0) * tx) * (1 - ty) + (at(x0, y1) * (1 - tx) + at(x1, y1) * tx) * ty;
          }
          const own = wt > 0 ? L.vw[i * ch + c]! / wt : 0;
          val[i * ch + c] = above ? a * own + (1 - a) * coarse : own;
        }
      }
    above = val;
    aw = L.w;
    ah = L.h;
  }
  return above!;
}

function cellSums(img: LinearImage, mask: Uint8Array, gw: number, gh: number): { sum: Float64Array; count: Float64Array; area: number } {
  const sum = new Float64Array(gw * gh * 3);
  const count = new Float64Array(gw * gh);
  const { width: w, height: h, data } = img;
  for (let y = 0; y < h; y += 1) {
    const cy = Math.min(gh - 1, Math.floor((y * gh) / h));
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (!mask[i]) continue;
      const c = cy * gw + Math.min(gw - 1, Math.floor((x * gw) / w));
      count[c]! += 1;
      sum[3 * c]! += data[3 * i]!;
      sum[3 * c + 1]! += data[3 * i + 1]!;
      sum[3 * c + 2]! += data[3 * i + 2]!;
    }
  }
  return { sum, count, area: (w * h) / (gw * gh) };
}

function median(v: number[]): number {
  const s = v.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function fitGrid(frames: readonly LinearImage[], masks: readonly Uint8Array[], gw: number, gh: number, quantile = 0.5): ScreenModel {
  const perFrame = frames.map((im, k) => cellSums(im, masks[k]!, gw, gh));
  const grid = new Float32Array(gw * gh * 3);
  const weight = new Float32Array(gw * gh);
  let observed = 0;
  for (let c = 0; c < gw * gh; c += 1) {
    const means: [number, number, number][] = [];
    let support = 0;
    for (const s of perFrame) {
      const n = s.count[c]!;
      if (n < Math.max(3, 0.06 * s.area)) continue;
      means.push([s.sum[3 * c]! / n, s.sum[3 * c + 1]! / n, s.sum[3 * c + 2]! / n]);
      support += n / s.area;
    }
    if (!means.length) continue;
    observed += 1;
    // The median over frames: a frame where the subject crept into the cell does not pull it. The first
    // pass takes the brighter frames (a quantile above the median, by brightness): a shadow cast on the
    // screen only ever darkens it, and must not become the clean plate where it lingers (addendum 18).
    if (quantile === 0.5) for (let ch = 0; ch < 3; ch += 1) grid[3 * c + ch] = median(means.map((m) => m[ch]!));
    else {
      const byLum = [...means].sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
      const at = byLum[Math.min(byLum.length - 1, Math.round(quantile * (byLum.length - 1)))]!;
      for (let ch = 0; ch < 3; ch += 1) grid[3 * c + ch] = at[ch]!;
    }
    weight[c] = Math.min(1, support / Math.max(1, frames.length) / 0.3);
  }
  const filled = pullPush(grid, weight, gw, gh, 3);
  return { gw, gh, grid: filled, observed: observed / (gw * gh), support: weight };
}

/** The screen model's colour at every pixel of a w × h image (bilinear between cell centres). */
export function evalScreenModel(model: ScreenModel, w: number, h: number, gain: readonly [number, number, number] = [1, 1, 1]): Float32Array {
  const out = new Float32Array(w * h * 3);
  const { gw, gh, grid } = model;
  for (let y = 0; y < h; y += 1) {
    const fy = Math.min(gh - 1, Math.max(0, ((y + 0.5) * gh) / h - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(gh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x += 1) {
      const fx = Math.min(gw - 1, Math.max(0, ((x + 0.5) * gw) / w - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(gw - 1, x0 + 1);
      const tx = fx - x0;
      const o = 3 * (y * w + x);
      for (let c = 0; c < 3; c += 1) {
        const a = grid[3 * (y0 * gw + x0) + c]!;
        const b = grid[3 * (y0 * gw + x1) + c]!;
        const d = grid[3 * (y1 * gw + x0) + c]!;
        const e = grid[3 * (y1 * gw + x1) + c]!;
        out[o + c] = ((a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty) * gain[c]!;
      }
    }
  }
  return out;
}

/** A model that is one colour everywhere (no clean plate). */
export function flatScreenModel(rgb: readonly [number, number, number]): ScreenModel {
  return { gw: 1, gh: 1, grid: Float32Array.from(rgb), observed: 1 };
}

/** Build the clean-plate model from a few frames (two passes). */
export function buildScreenModel(frames: readonly LinearImage[], screen: ScreenRef, cols: number, excludes?: readonly (Uint8Array | null)[]): ScreenModel {
  if (!frames.length) return flatScreenModel(screen.rgb);
  const { width: w, height: h } = frames[0]!;
  const gw = Math.max(2, Math.min(cols, w));
  const gh = Math.max(2, Math.min(Math.round((cols * h) / w), h));
  // The subject segmentation, when the key has one (addendum 18): a screen-lit costume has the screen's
  // chromaticity and would otherwise darken the clean plate where it stands in most frames.
  const without = (m: Uint8Array, k: number): Uint8Array => {
    const ex = excludes?.[k];
    if (!ex) return m;
    const out = m.slice();
    for (let i = 0; i < out.length; i += 1) if (ex[i]) out[i] = 0;
    return out;
  };
  const first = fitGrid(frames, frames.map((im, k) => without(screenCandidates(im, screen, null), k)), gw, gh, 0.75);
  const masks = frames.map((im, k) => without(screenCandidates(im, screen, evalScreenModel(first, im.width, im.height)), k));
  const second = fitGrid(frames, masks, gw, gh);
  return second.observed > 0 ? second : first.observed > 0 ? first : flatScreenModel(screen.rgb);
}

/**
 * The screen of this one frame, in detail (addendum 16): the model, times a
 * fine per-channel ratio field measured on this frame's own screen pixels and
 * filled across what hides the screen from the screen round it (pull–push) —
 * the way a per-frame clean plate is pulled from an eroded screen. The model
 * is smooth (its grid is coarse, and the camera may move), so on a real
 * screen the folds of the cloth, the fall-off towards the floor and shadows
 * on the screen differ from it locally, and a pixel of screen 30 % darker
 * than the model keys 30 % solid. Screen pixels here are those whose
 * chromaticity is within `tol` of the model's at that pixel and whose
 * brightness is 0.25 … 2 × the model's, eroded so soft edges stay out; cells
 * are `cell` pixels. A pixel the key against the model calls more than
 * `maxKey` solid is not taken (see below), so a light shadow on the screen
 * keys out and a deep one (darker than about half the screen) stays.
 */
export function localScreen(img: LinearImage, model: Float32Array, kind: ScreenKind, options: { cell?: number; tol?: number; erode?: number; maxKey?: number; exclude?: Uint8Array | null } = {}): Float32Array {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const tol = options.tol ?? 0.04;
  const maxKey = options.maxKey ?? 0.5;
  const [sc, ac, cc] = kind === 'green' ? [1, 0, 2] : [2, 0, 1];
  const cand = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    const q = 3 * i;
    const r = data[q]!;
    const g = data[q + 1]!;
    const b = data[q + 2]!;
    const mr = model[q]!;
    const mg = model[q + 1]!;
    const mb = model[q + 2]!;
    const s = r + g + b;
    const ms = mr + mg + mb;
    if (!(ms > 1e-6) || !(s > 0.25 * ms) || s > 2 * ms || r < 0 || g < 0 || b < 0) continue;
    // The subject segmentation, when there is one: never screen (addendum 18).
    if (options.exclude?.[i]) continue;
    // Not what the key against the model already calls mostly subject: a costume the screen's
    // bounce has made screen-coloured is darker than the screen and must not become screen here.
    const dS = model[q + sc]! - 0.5 * (model[q + ac]! + model[q + cc]!);
    const dP = data[q + sc]! - 0.5 * (data[q + ac]! + data[q + cc]!);
    if (!(dS > 1e-6) || 1 - dP / dS > maxKey) continue;
    if ((r / s - mr / ms) ** 2 + (b / s - mb / ms) ** 2 > tol * tol) continue;
    cand[i] = 1;
  }
  const e = options.erode ?? Math.max(1, Math.round(w / 640));
  const mask = e > 0 ? morph(cand, w, h, -e) : cand;
  const cell = Math.max(2, Math.round(options.cell ?? w / 240));
  const gw = Math.max(1, Math.ceil(w / cell));
  const gh = Math.max(1, Math.ceil(h / cell));
  const sum = new Float32Array(gw * gh * 3);
  const wt = new Float32Array(gw * gh);
  for (let y = 0; y < h; y += 1) {
    const cy = Math.floor(y / cell) * gw;
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (!mask[i]) continue;
      const c = cy + Math.floor(x / cell);
      const q = 3 * i;
      for (let k = 0; k < 3; k += 1) sum[3 * c + k]! += Math.max(0.25, Math.min(2, data[q + k]! / Math.max(1e-6, model[q + k]!)));
      wt[c]! += 1;
    }
  }
  const full = cell * cell * 0.25;
  for (let c = 0; c < gw * gh; c += 1) {
    if (!wt[c]) continue;
    for (let k = 0; k < 3; k += 1) sum[3 * c + k]! /= wt[c]!;
    wt[c] = Math.min(1, wt[c]! / full);
  }
  // Nowhere to measure (a frame without screen): the model as it is.
  if (!wt.some((v) => v > 0)) return model.slice();
  const ratio = pullPush(sum, wt, gw, gh, 3);
  const out = new Float32Array(n * 3);
  for (let y = 0; y < h; y += 1) {
    const fy = Math.min(gh - 1, Math.max(0, (y + 0.5) / cell - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(gh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x += 1) {
      const fx = Math.min(gw - 1, Math.max(0, (x + 0.5) / cell - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(gw - 1, x0 + 1);
      const tx = fx - x0;
      const q = 3 * (y * w + x);
      for (let k = 0; k < 3; k += 1) {
        const v = (ratio[3 * (y0 * gw + x0) + k]! * (1 - tx) + ratio[3 * (y0 * gw + x1) + k]! * tx) * (1 - ty) + (ratio[3 * (y1 * gw + x0) + k]! * (1 - tx) + ratio[3 * (y1 * gw + x1) + k]! * tx) * ty;
        out[q + k] = model[q + k]! * v;
      }
    }
  }
  return out;
}

/**
 * Where the model was seen (support ≥ ½ in the pixel's cell), per pixel of a
 * w × h image; null for a model seen everywhere.
 */
export function modelSeen(model: ScreenModel, w: number, h: number): Uint8Array | null {
  if (!model.support) return null;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const cy = Math.min(model.gh - 1, Math.floor((y * model.gh) / h));
    for (let x = 0; x < w; x += 1) out[y * w + x] = model.support[cy * model.gw + Math.min(model.gw - 1, Math.floor((x * model.gw) / w))]! >= 0.5 ? 1 : 0;
  }
  return out;
}

/**
 * The per-channel gain that brings the model to this frame's screen (drift:
 * flicker, clouds): the median ratio over this frame's certain screen pixels,
 * kept within ½ … 2. With `seen`, only where the model was itself measured:
 * elsewhere it is inpainted, and screen-coloured things there (grass and
 * trees round a green card held up outdoors) say nothing about the screen.
 */
export function screenGain(img: LinearImage, model: Float32Array, screen: ScreenRef, seen: Uint8Array | null = null): [number, number, number] {
  // Chromaticity only (a frame whose screen got much darker must still find its screen), on a
  // sparse grid, a sample counting only when its neighbours on the grid are screen too.
  const { width: w, height: h, data } = img;
  const [sr, sb] = chromaOf(screen.rgb[0], screen.rgb[1], screen.rgb[2]);
  const minSum = 0.08 * (screen.rgb[0] + screen.rgb[1] + screen.rgb[2]);
  const step = Math.max(2, Math.round(Math.sqrt((w * h) / 30_000)));
  const isScreen = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    const i = 3 * (y * w + x);
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    if (r + g + b < minSum) return false;
    const [cr, cb] = chromaOf(r, g, b);
    return (cr - sr) ** 2 + (cb - sb) ** 2 <= 0.05 * 0.05;
  };
  const ratios: [number[], number[], number[]] = [[], [], []];
  for (let y = step; y < h - step; y += step)
    for (let x = step; x < w - step; x += step) {
      if (seen && !seen[y * w + x]) continue;
      if (!isScreen(x, y) || !isScreen(x - step, y) || !isScreen(x + step, y) || !isScreen(x, y - step) || !isScreen(x, y + step)) continue;
      const i = 3 * (y * w + x);
      for (let c = 0; c < 3; c += 1) {
        const m = model[i + c]!;
        if (m > 1e-5) ratios[c as 0 | 1 | 2].push(data[i + c]! / m);
      }
    }
  if (ratios[1].length < 50) return [1, 1, 1];
  return ratios.map((r) => Math.max(0.5, Math.min(2, median(r)))) as [number, number, number];
}
