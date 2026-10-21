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

function fitGrid(frames: readonly LinearImage[], masks: readonly Uint8Array[], gw: number, gh: number): ScreenModel {
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
    // The median over frames: a frame where the subject crept into the cell does not pull it.
    for (let ch = 0; ch < 3; ch += 1) grid[3 * c + ch] = median(means.map((m) => m[ch]!));
    weight[c] = Math.min(1, support / Math.max(1, frames.length) / 0.3);
  }
  const filled = pullPush(grid, weight, gw, gh, 3);
  return { gw, gh, grid: filled, observed: observed / (gw * gh) };
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
export function buildScreenModel(frames: readonly LinearImage[], screen: ScreenRef, cols: number): ScreenModel {
  if (!frames.length) return flatScreenModel(screen.rgb);
  const { width: w, height: h } = frames[0]!;
  const gw = Math.max(2, Math.min(cols, w));
  const gh = Math.max(2, Math.min(Math.round((cols * h) / w), h));
  const first = fitGrid(frames, frames.map((im) => screenCandidates(im, screen, null)), gw, gh);
  const masks = frames.map((im) => screenCandidates(im, screen, evalScreenModel(first, im.width, im.height)));
  const second = fitGrid(frames, masks, gw, gh);
  return second.observed > 0 ? second : first.observed > 0 ? first : flatScreenModel(screen.rgb);
}

/**
 * The per-channel gain that brings the model to this frame's screen (drift:
 * flicker, clouds): the median ratio over this frame's certain screen pixels,
 * kept within ½ … 2.
 */
export function screenGain(img: LinearImage, model: Float32Array, screen: ScreenRef): [number, number, number] {
  // Chromaticity only: a frame whose screen got much darker must still find its screen.
  const mask = screenCandidates(img, screen, null, { erode: 1, tol: 0.05 });
  const n = img.width * img.height;
  const step = Math.max(1, Math.floor(n / 40_000));
  const ratios: [number[], number[], number[]] = [[], [], []];
  for (let i = 0; i < n; i += step) {
    if (!mask[i]) continue;
    for (let c = 0; c < 3; c += 1) {
      const m = model[3 * i + c]!;
      if (m > 1e-5) ratios[c as 0 | 1 | 2].push(img.data[3 * i + c]! / m);
    }
  }
  if (ratios[1].length < 50) return [1, 1, 1];
  const g = ratios.map((r) => Math.max(0.5, Math.min(2, median(r)))) as [number, number, number];
  return g;
}
