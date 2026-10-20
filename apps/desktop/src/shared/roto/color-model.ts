import { rng, type RGBImage } from './image';

/**
 * Colour models for segmentation (addendum 04): a Gaussian mixture with full
 * covariance in CIE Lab, fitted by k-means++ then EM, as GrabCut does. For
 * speed the negative log-likelihood is tabulated once per model over RGB
 * quantised to 5 bits a channel (32 768 bins), so labelling a pixel is one
 * lookup.
 */

const SRGB_TO_LINEAR = new Float64Array(256);
for (let i = 0; i < 256; i += 1) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

const labF = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);

/** CIE Lab (D65) of an 8-bit sRGB colour; L 0…100. */
export function rgbToLab(r: number, g: number, b: number, out: Float64Array | number[] = [0, 0, 0], at = 0): Float64Array | number[] {
  const R = SRGB_TO_LINEAR[r]!;
  const G = SRGB_TO_LINEAR[g]!;
  const B = SRGB_TO_LINEAR[b]!;
  const x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const fx = labF(x);
  const fy = labF(y);
  const fz = labF(z);
  out[at] = 116 * fy - 16;
  out[at + 1] = 500 * (fx - fy);
  out[at + 2] = 200 * (fy - fz);
  return out;
}

export const BINS = 32;
export const binOf = (r: number, g: number, b: number) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

/** Lab of each bin's centre. */
const BIN_LAB = (() => {
  const out = new Float64Array(BINS * BINS * BINS * 3);
  for (let r = 0; r < BINS; r += 1) for (let g = 0; g < BINS; g += 1) for (let b = 0; b < BINS; b += 1) rgbToLab(r * 8 + 4, g * 8 + 4, b * 8 + 4, out, ((r << 10) | (g << 5) | b) * 3);
  return out;
})();

export interface Gmm {
  k: number;
  weights: Float64Array;
  means: Float64Array;
  /** Inverse covariances, 3×3 row-major per component. */
  inv: Float64Array;
  /** log(weight) − ½ log det Σ − 3/2 log 2π per component. */
  logNorm: Float64Array;
}

function invert3(m: Float64Array | number[], o: number, out: Float64Array, at: number): number {
  const a = m[o]!;
  const b = m[o + 1]!;
  const c = m[o + 2]!;
  const d = m[o + 3]!;
  const e = m[o + 4]!;
  const f = m[o + 5]!;
  const g = m[o + 6]!;
  const h = m[o + 7]!;
  const i = m[o + 8]!;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const s = 1 / det;
  out[at] = A * s;
  out[at + 1] = -(b * i - c * h) * s;
  out[at + 2] = (b * f - c * e) * s;
  out[at + 3] = B * s;
  out[at + 4] = (a * i - c * g) * s;
  out[at + 5] = -(a * f - c * d) * s;
  out[at + 6] = C * s;
  out[at + 7] = -(a * h - b * g) * s;
  out[at + 8] = (a * e - b * d) * s;
  return det;
}

function componentLog(model: Gmm, c: number, x0: number, x1: number, x2: number): number {
  const m = c * 3;
  const d0 = x0 - model.means[m]!;
  const d1 = x1 - model.means[m + 1]!;
  const d2 = x2 - model.means[m + 2]!;
  const q = c * 9;
  const inv = model.inv;
  const maha =
    d0 * (inv[q]! * d0 + inv[q + 1]! * d1 + inv[q + 2]! * d2) + d1 * (inv[q + 3]! * d0 + inv[q + 4]! * d1 + inv[q + 5]! * d2) + d2 * (inv[q + 6]! * d0 + inv[q + 7]! * d1 + inv[q + 8]! * d2);
  return model.logNorm[c]! - 0.5 * maha;
}

/** log p(x) under the mixture. */
export function gmmLog(model: Gmm, x0: number, x1: number, x2: number): number {
  let best = -Infinity;
  const logs = new Array<number>(model.k);
  for (let c = 0; c < model.k; c += 1) {
    logs[c] = componentLog(model, c, x0, x1, x2);
    if (logs[c]! > best) best = logs[c]!;
  }
  let s = 0;
  for (let c = 0; c < model.k; c += 1) s += Math.exp(logs[c]! - best);
  return best + Math.log(s);
}

/**
 * Fit a k-component mixture to Lab samples (x0, x1, x2 triples). Deterministic
 * for a given seed. Covariances are regularised so a flat colour still gives a
 * proper Gaussian.
 */
export function fitGmm(samples: Float64Array, k: number, options: { iterations?: number; seed?: number; regularise?: number } = {}): Gmm {
  const n = samples.length / 3;
  const kk = Math.max(1, Math.min(k, n));
  const iterations = options.iterations ?? 6;
  const reg = options.regularise ?? 4;
  const rand = rng(options.seed ?? 7);
  // k-means++ seeding.
  const means = new Float64Array(kk * 3);
  const d2 = new Float64Array(n).fill(Infinity);
  let pick = Math.floor(rand() * n);
  for (let c = 0; c < kk; c += 1) {
    means[3 * c] = samples[3 * pick]!;
    means[3 * c + 1] = samples[3 * pick + 1]!;
    means[3 * c + 2] = samples[3 * pick + 2]!;
    let total = 0;
    for (let i = 0; i < n; i += 1) {
      const a = samples[3 * i]! - means[3 * c]!;
      const b = samples[3 * i + 1]! - means[3 * c + 1]!;
      const e = samples[3 * i + 2]! - means[3 * c + 2]!;
      const d = a * a + b * b + e * e;
      if (d < d2[i]!) d2[i] = d;
      total += d2[i]!;
    }
    let target = rand() * total;
    pick = n - 1;
    for (let i = 0; i < n; i += 1) {
      target -= d2[i]!;
      if (target <= 0) {
        pick = i;
        break;
      }
    }
  }
  const model: Gmm = { k: kk, weights: new Float64Array(kk).fill(1 / kk), means, inv: new Float64Array(kk * 9), logNorm: new Float64Array(kk) };
  // Start from spherical components.
  for (let c = 0; c < kk; c += 1) {
    model.inv[9 * c] = model.inv[9 * c + 4] = model.inv[9 * c + 8] = 1 / 100;
    model.logNorm[c] = Math.log(1 / kk) - 0.5 * Math.log(1e6) - 1.5 * Math.log(2 * Math.PI);
  }
  const resp = new Float64Array(n * kk);
  const cov = new Float64Array(9);
  for (let it = 0; it < iterations; it += 1) {
    // E step.
    for (let i = 0; i < n; i += 1) {
      let best = -Infinity;
      for (let c = 0; c < kk; c += 1) {
        const l = componentLog(model, c, samples[3 * i]!, samples[3 * i + 1]!, samples[3 * i + 2]!);
        resp[i * kk + c] = l;
        if (l > best) best = l;
      }
      let s = 0;
      for (let c = 0; c < kk; c += 1) {
        const e = Math.exp(resp[i * kk + c]! - best);
        resp[i * kk + c] = e;
        s += e;
      }
      for (let c = 0; c < kk; c += 1) resp[i * kk + c]! /= s;
    }
    // M step.
    for (let c = 0; c < kk; c += 1) {
      let wsum = 0;
      let m0 = 0;
      let m1 = 0;
      let m2 = 0;
      for (let i = 0; i < n; i += 1) {
        const r = resp[i * kk + c]!;
        wsum += r;
        m0 += r * samples[3 * i]!;
        m1 += r * samples[3 * i + 1]!;
        m2 += r * samples[3 * i + 2]!;
      }
      if (wsum < 1e-6) {
        model.weights[c] = 1e-6;
        continue;
      }
      m0 /= wsum;
      m1 /= wsum;
      m2 /= wsum;
      cov.fill(0);
      for (let i = 0; i < n; i += 1) {
        const r = resp[i * kk + c]!;
        const a = samples[3 * i]! - m0;
        const b = samples[3 * i + 1]! - m1;
        const e = samples[3 * i + 2]! - m2;
        cov[0]! += r * a * a;
        cov[1]! += r * a * b;
        cov[2]! += r * a * e;
        cov[4]! += r * b * b;
        cov[5]! += r * b * e;
        cov[8]! += r * e * e;
      }
      for (const j of [0, 1, 2, 4, 5, 8]) cov[j]! /= wsum;
      cov[3] = cov[1]!;
      cov[6] = cov[2]!;
      cov[7] = cov[5]!;
      cov[0]! += reg;
      cov[4]! += reg;
      cov[8]! += reg;
      model.weights[c] = wsum / n;
      model.means[3 * c] = m0;
      model.means[3 * c + 1] = m1;
      model.means[3 * c + 2] = m2;
      const det = invert3(cov, 0, model.inv, 9 * c);
      model.logNorm[c] = Math.log(model.weights[c]!) - 0.5 * Math.log(Math.max(det, 1e-12)) - 1.5 * Math.log(2 * Math.PI);
    }
  }
  return model;
}

/** −log p for every RGB bin, as a 32 768-entry table. */
export function costTable(model: Gmm): Float32Array {
  const out = new Float32Array(BINS * BINS * BINS);
  for (let i = 0; i < out.length; i += 1) out[i] = -gmmLog(model, BIN_LAB[3 * i]!, BIN_LAB[3 * i + 1]!, BIN_LAB[3 * i + 2]!);
  return out;
}

/** Lab samples of the pixels where `select` is set, at most `max` of them (evenly strided). */
export function sampleLab(img: RGBImage, select: Uint8Array, max = 6000): Float64Array {
  let count = 0;
  for (let i = 0; i < select.length; i += 1) if (select[i]) count += 1;
  const stride = Math.max(1, Math.floor(count / max));
  const out = new Float64Array(Math.ceil(count / stride) * 3);
  let seen = 0;
  let at = 0;
  const d = img.data;
  for (let i = 0; i < select.length; i += 1) {
    if (!select[i]) continue;
    if (seen++ % stride !== 0) continue;
    if (at + 3 > out.length) break;
    rgbToLab(d[3 * i]!, d[3 * i + 1]!, d[3 * i + 2]!, out, at);
    at += 3;
  }
  return out.subarray(0, at);
}

/** A foreground/background pair of cost tables. */
export interface ColorModel {
  fg: Float32Array;
  bg: Float32Array;
}

export function fitColorModel(img: RGBImage, fg: Uint8Array, bg: Uint8Array, options: { k?: number; seed?: number } = {}): ColorModel | null {
  const fs = sampleLab(img, fg);
  const bs = sampleLab(img, bg);
  if (fs.length < 3 * 8 || bs.length < 3 * 8) return null;
  const k = options.k ?? 5;
  return { fg: costTable(fitGmm(fs, k, { seed: options.seed ?? 11 })), bg: costTable(fitGmm(bs, k, { seed: (options.seed ?? 11) + 1 })) };
}

/** P(foreground | colour) per pixel from the two models, 0…1. */
export function posterior(img: RGBImage, model: ColorModel, out = new Float32Array(img.width * img.height)): Float32Array {
  const d = img.data;
  for (let i = 0; i < out.length; i += 1) {
    const bin = binOf(d[3 * i]!, d[3 * i + 1]!, d[3 * i + 2]!);
    const df = model.fg[bin]!;
    const db = model.bg[bin]!;
    // p_f / (p_f + p_b) with p = exp(−cost).
    out[i] = 1 / (1 + Math.exp(Math.max(-50, Math.min(50, df - db))));
  }
  return out;
}
