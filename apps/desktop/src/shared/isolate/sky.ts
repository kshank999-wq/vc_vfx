import { fitColorModel, posterior } from '../roto/color-model';
import { components, gaussianBlur, guidedFilter, type RGBImage } from '../roto/image';
import { GridGraph } from '../roto/maxflow';
import { toDisplay, type LinearImage, type WorkingSpace } from '../key/linear';

/**
 * Finding the sky (master spec §11 bullet 4; addendum 11 §3.1). Pure
 * TypeScript on typed arrays, in linear light, deterministic.
 *
 * Per frame, at a cut size (≤ 480 px wide), each pixel gets a probability of
 * being sky from cues that hold for clear and overcast skies alike:
 *  - brightness: within about a stop of the sky's own (the median of the top
 *    rows) — buildings, trees and people are darker against it;
 *  - colour: close to the sky's chromaticity (blue, or the neutral grey of an
 *    overcast day) — lit windows, skin and brick are not;
 *  - texture: low gradient energy of log luminance (a smooth vertical
 *    gradient, soft clouds) against facades, foliage and fabric;
 *  - position: a mild prior that the sky is above.
 * The colours of the confident sky and the confident foreground then train a
 * pair of colour models (the roto engine's Gaussian mixtures), whose posterior
 * is combined with the cues; the neighbouring frames' cues, aligned by the
 * camera's homography, are a temporal prior; painted corrections are hard
 * constraints. A graph cut (the roto engine's max-flow) with a
 * contrast-sensitive smoothness term labels the frame, and sky that does not
 * reach the top of the frame and is not strongly sky is given back to the
 * foreground. Everything is kept as the probability of *foreground* (1 =
 * in front of the sky), as the matte is.
 */

const clamp01 = (v: number) => (v <= 0 ? 0 : v >= 1 ? 1 : v);
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const logit = (p: number) => Math.log(Math.max(1e-4, Math.min(1 - 1e-4, p)) / (1 - Math.max(1e-4, Math.min(1 - 1e-4, p))));

/** The size the cues and the cut work at: at most `max` wide, the frame's aspect. */
export function cutSize(w: number, h: number, max = 480): { width: number; height: number } {
  const width = Math.min(w, max);
  return { width, height: Math.max(8, Math.round((h * width) / w)) };
}

export interface SkyFeatures {
  width: number;
  height: number;
  /** log2 luminance. */
  logL: Float32Array;
  /** The frame through the viewer's display transform (for the colour models and the smoothness term). */
  display: Uint8ClampedArray;
  /** P(foreground) from the cues alone. */
  cue: Float32Array;
  /** P(foreground) from the cues and the colour models. */
  fg: Float32Array;
  /** How sky-coloured each pixel is (0 … 1), for the occluder test. */
  skyColour: Float32Array;
  /** The sky's reference brightness (linear) and chromaticity. */
  reference: { luminance: number; chroma: [number, number, number] };
}

/** Median of a sample. */
function median(v: number[]): number {
  if (!v.length) return 0;
  const s = v.slice().sort((a, b) => a - b);
  return s[s.length >> 1]!;
}

/**
 * The cues and the colour-model posterior of one frame (already at the cut
 * size). `bias` −1 … 1 calls more of the picture sky where the cues are unsure.
 */
export function skyFeatures(img: LinearImage, space: WorkingSpace, bias = 0): SkyFeatures {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const luma = space.luma;
  const L = new Float32Array(n);
  const logL = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const l = Math.max(1e-5, luma[0] * data[3 * i]! + luma[1] * data[3 * i + 1]! + luma[2] * data[3 * i + 2]!);
    L[i] = l;
    logL[i] = Math.log2(l);
  }
  // The sky's reference: the brighter, smooth half of the top rows (the sky is up there in a sky shot).
  const top = Math.max(2, Math.round(0.12 * h));
  const sample: number[] = [];
  for (let y = 0; y < top; y += 1) for (let x = 0; x < w; x += 2) sample.push(logL[y * w + x]!);
  sample.sort((a, b) => a - b);
  const bright = sample.slice(sample.length >> 1);
  const refLog = median(bright);
  const threshold = sample[sample.length >> 1] ?? refLog;
  const chroma: [number[], number[], number[]] = [[], [], []];
  for (let y = 0; y < top; y += 1)
    for (let x = 0; x < w; x += 2) {
      const i = y * w + x;
      if (logL[i]! < threshold) continue;
      for (let c = 0; c < 3; c += 1) chroma[c as 0 | 1 | 2].push(data[3 * i + c]! / L[i]!);
    }
  const ref: [number, number, number] = [median(chroma[0]), median(chroma[1]), median(chroma[2])];

  // Texture: gradient energy of log luminance, blurred.
  const energy = textureEnergy(logL, w, h);

  const cue = new Float32Array(n);
  const skyColour = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const y = (i - (i % w)) / w;
    // Brightness: within about two thirds of a stop of the sky scores high; a stop and a half darker, low.
    const b = sigmoid((logL[i]! - (refLog - 0.7)) / 0.25);
    // Colour: distance of the chromaticity from the sky's.
    let d = 0;
    for (let c = 0; c < 3; c += 1) d += (data[3 * i + c]! / L[i]! - ref[c]!) ** 2;
    const col = Math.exp(-d / 0.03);
    skyColour[i] = col;
    // Texture: smooth sky (clouds included) against facades and foliage.
    const t = Math.exp(-energy[i]! / 0.04);
    const pos = sigmoid((0.62 * h - y) / (0.12 * h));
    const s = 2.6 * (b - 0.5) * 2 + 1.6 * (col - 0.5) * 2 + 1.4 * (t - 0.5) * 2 + 0.8 * (pos - 0.5) * 2 + 1.5 * bias;
    cue[i] = 1 - sigmoid(s);
  }
  const display = toDisplay(data, n, space);
  const rgb: RGBImage = { width: w, height: h, data: display };
  // Colour models from the confident pixels; their posterior joins the cues.
  const fgSeed = new Uint8Array(n);
  const bgSeed = new Uint8Array(n);
  let fgCount = 0;
  let bgCount = 0;
  for (let i = 0; i < n; i += 1) {
    if (cue[i]! > 0.9) (fgSeed[i] = 1), (fgCount += 1);
    else if (cue[i]! < 0.1) (bgSeed[i] = 1), (bgCount += 1);
  }
  const fg = new Float32Array(n);
  const model = fgCount > 50 && bgCount > 50 ? fitColorModel(rgb, fgSeed, bgSeed, { k: 4 }) : null;
  if (model) {
    const post = posterior(rgb, model);
    for (let i = 0; i < n; i += 1) fg[i] = sigmoid(0.6 * logit(cue[i]!) + 0.4 * logit(0.02 + 0.96 * post[i]!));
  } else fg.set(cue);
  return { width: w, height: h, logL, display, cue, fg, skyColour, reference: { luminance: 2 ** refLog, chroma: ref } };
}

/** Texture: the gradient energy of log luminance (central differences), blurred σ 1.5 px. */
export function textureEnergy(logL: Float32Array, w: number, h: number): Float32Array {
  const grad = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      const gx = logL[y * w + Math.min(w - 1, x + 1)]! - logL[y * w + Math.max(0, x - 1)]!;
      const gy = logL[Math.min(h - 1, y + 1) * w + x]! - logL[Math.max(0, y - 1) * w + x]!;
      grad[y * w + x] = Math.min(4, gx * gx + gy * gy);
    }
  return gaussianBlur(grad, w, h, 1.5);
}

/** Hard constraints of the cut: 0 free, 1 foreground, 2 sky/background. */
export const HARD_FG = 1;
export const HARD_BG = 2;

/** β of the contrast term over the free box: 1 / (2⟨‖ΔI‖²⟩). */
function beta(img: RGBImage, x0: number, y0: number, x1: number, y1: number): number {
  const { width: w, data: d } = img;
  let sum = 0;
  let count = 0;
  for (let y = y0; y <= y1; y += 1)
    for (let x = x0; x <= x1; x += 1) {
      const i = 3 * (y * w + x);
      if (x < x1) (sum += (d[i]! - d[i + 3]!) ** 2 + (d[i + 1]! - d[i + 4]!) ** 2 + (d[i + 2]! - d[i + 5]!) ** 2), (count += 1);
      if (y < y1) {
        const j = i + 3 * w;
        sum += (d[i]! - d[j]!) ** 2 + (d[i + 1]! - d[j + 1]!) ** 2 + (d[i + 2]! - d[j + 2]!) ** 2;
        count += 1;
      }
    }
  return count && sum > 0 ? count / (2 * sum) : 0;
}

/**
 * Binary graph cut: unary −λ·log P from `pf` (P(foreground)), contrast-
 * sensitive smoothness γ·exp(−β‖ΔI‖²) between 4-neighbours, `hard` pixels
 * held. Pixels whose probability is decisive (beyond `decisive` from ½) are
 * held too, so the max-flow only works where the label is open.
 */
export function binaryCut(img: RGBImage, pf: Float32Array, hard: Uint8Array | null, o: { gamma?: number; lambda?: number; decisive?: number } = {}): Uint8Array {
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  const gamma = o.gamma ?? 30;
  const lambda = o.lambda ?? 1;
  const decisive = o.decisive ?? 0.47;
  const held = new Uint8Array(n);
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let i = 0; i < n; i += 1) {
    const hv = hard ? hard[i]! : 0;
    const p = pf[i]!;
    held[i] = hv || (p > 0.5 + decisive ? HARD_FG : p < 0.5 - decisive ? HARD_BG : 0);
    if (!held[i]) {
      const x = i % w;
      const y = (i - x) / w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) out[i] = held[i] === HARD_FG ? 1 : 0;
  if (x1 < 0) return out;
  x0 = Math.max(0, x0 - 1);
  y0 = Math.max(0, y0 - 1);
  x1 = Math.min(w - 1, x1 + 1);
  y1 = Math.min(h - 1, y1 + 1);
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  const g = new GridGraph(bw, bh);
  const b = beta(img, x0, y0, x1, y1);
  const weight = (k: number, j: number) => gamma * Math.exp(-b * ((d[k]! - d[j]!) ** 2 + (d[k + 1]! - d[j + 1]!) ** 2 + (d[k + 2]! - d[j + 2]!) ** 2));
  for (let y = 0; y < bh; y += 1)
    for (let x = 0; x < bw; x += 1) {
      const p = y * bw + x;
      const i = (y + y0) * w + x + x0;
      const hv = held[i]!;
      if (hv === 0) {
        const pv = Math.min(0.999, Math.max(0.001, pf[i]!));
        const costFg = -lambda * Math.log(pv);
        const costBg = -lambda * Math.log(1 - pv);
        const m = Math.min(costFg, costBg);
        g.addTerminal(p, costBg - m, costFg - m);
      }
      const k = 3 * i;
      for (const [dir, ok, j, q] of [
        [0, x < bw - 1, i + 1, p + 1],
        [2, y < bh - 1, i + w, p + bw],
      ] as const) {
        if (!ok) continue;
        const hq = held[j]!;
        if (hv === 0 && hq === 0) g.setEdge(p, dir, weight(k, 3 * j));
        else if (hv === 0) g.addTerminal(p, hq === HARD_FG ? weight(k, 3 * j) : 0, hq === HARD_BG ? weight(k, 3 * j) : 0);
        else if (hq === 0) g.addTerminal(q, hv === HARD_FG ? weight(k, 3 * j) : 0, hv === HARD_BG ? weight(k, 3 * j) : 0);
      }
    }
  g.solve();
  for (let y = 0; y < bh; y += 1)
    for (let x = 0; x < bw; x += 1) {
      const i = (y + y0) * w + x + x0;
      if (!held[i]) out[i] = g.isSource(y * bw + x) ? 1 : 0;
    }
  return out;
}

/**
 * Sky that does not reach the top of the frame is foreground unless it is
 * strongly sky (a pocket seen between branches is; a pale wall is not), and
 * specks of foreground floating in the sky that the cues barely call
 * foreground are sky. Painted pixels are kept as painted.
 */
export function cleanSky(labels: Uint8Array, pf: Float32Array, hard: Uint8Array | null, w: number, h: number): Uint8Array {
  const out = labels.slice();
  const sky = components(out, w, h, 0);
  const touches = new Uint8Array(sky.sizes.length);
  for (let x = 0; x < w; x += 1) touches[sky.labels[x]!] = 1;
  const sum = new Float64Array(sky.sizes.length);
  const painted = new Uint8Array(sky.sizes.length);
  for (let i = 0; i < out.length; i += 1) {
    const l = sky.labels[i]!;
    if (!l) continue;
    sum[l]! += pf[i]!;
    if (hard && hard[i] === HARD_BG) painted[l] = 1;
  }
  for (let i = 0; i < out.length; i += 1) {
    const l = sky.labels[i]!;
    if (!l || touches[l] || painted[l]) continue;
    if (sum[l]! / sky.sizes[l]! > 0.12) out[i] = 1;
  }
  const fg = components(out, w, h, 1);
  const fsum = new Float64Array(fg.sizes.length);
  const fpainted = new Uint8Array(fg.sizes.length);
  for (let i = 0; i < out.length; i += 1) {
    const l = fg.labels[i]!;
    if (!l) continue;
    fsum[l]! += pf[i]!;
    if (hard && hard[i] === HARD_FG) fpainted[l] = 1;
  }
  const tiny = Math.max(2, Math.round(0.00015 * w * h));
  for (let i = 0; i < out.length; i += 1) {
    const l = fg.labels[i]!;
    if (!l || fpainted[l]) continue;
    if (fg.sizes[l]! <= tiny && fsum[l]! / fg.sizes[l]! < 0.7) out[i] = 0;
  }
  return out;
}

/**
 * A soft version of the labels for upsampling: the labels guided-filtered by
 * the picture, kept on their side of ½ (the edge can soften but not flip).
 */
export function softLabels(labels: Uint8Array, display: Uint8ClampedArray, w: number, h: number): Float32Array {
  const n = w * h;
  const gray = new Float32Array(n);
  const src = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    gray[i] = (0.2126 * display[3 * i]! + 0.7152 * display[3 * i + 1]! + 0.0722 * display[3 * i + 2]!) / 255;
    src[i] = labels[i]!;
  }
  const f = guidedFilter(gray, src, w, h, 2, 1e-3);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = labels[i] ? Math.max(0.5, clamp01(f[i]!)) : Math.min(0.499, clamp01(f[i]!));
  return out;
}

/** Combine a probability with a prior (both P(foreground)) by adding their logits, the prior weighted. */
export function withPrior(p: number, prior: number, weight: number): number {
  return sigmoid(logit(p) + weight * logit(prior));
}

/** The separation of a frame's probabilities: mean |2p − 1| (1 = every pixel decided). */
export function separationOf(pf: Float32Array): number {
  let s = 0;
  for (let i = 0; i < pf.length; i += 1) s += Math.abs(2 * pf[i]! - 1);
  return pf.length ? s / pf.length : 0;
}
