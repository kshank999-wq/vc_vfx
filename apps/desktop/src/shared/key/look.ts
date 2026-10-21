import { gaussianBlur, signedDistance } from '../roto/image';
import type { LinearImage } from './linear';

/**
 * The background's influence on the foreground (master spec §7 bullets 3–5;
 * addendum 09 §3.7): its colour near each pixel (for the despill), a light
 * wrap, and a suggested colour match. All of it is preview or a separate
 * layer or metadata — never baked into the prep foreground.
 */

/** Blur each channel of an interleaved RGB image. */
export function blurRgb(data: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const n = w * h;
  const out = new Float32Array(n * 3);
  for (let c = 0; c < 3; c += 1) {
    const p = new Float32Array(n);
    for (let i = 0; i < n; i += 1) p[i] = data[3 * i + c]!;
    const b = gaussianBlur(p, w, h, sigma);
    for (let i = 0; i < n; i += 1) out[3 * i + c] = b[i]!;
  }
  return out;
}

/** The background's colour near each pixel: the background blurred by `sigma` pixels. */
export function backgroundNear(bg: LinearImage, sigma: number): Float32Array {
  return sigma >= 0.5 ? blurRgb(bg.data, bg.width, bg.height, sigma) : bg.data.slice();
}

export interface LightWrapOptions {
  /** Pixels the background reaches into the subject. */
  width: number;
  intensity: number;
  /** 0: colour as is; 1: weighted by luminance (relative to 18 % grey, at most 2×). */
  lumaWeight: number;
  luma: readonly [number, number, number];
}

/**
 * The light-wrap layer (to be added over a composite): the background's
 * colour just outside the subject (the background where it is visible,
 * blurred and normalised by how much of it is visible), times a mask that is
 * non-zero only inside the subject near its edge — α·(1 − blur(α)). Zero
 * outside the subject and deep inside it; at most intensity·(1 + lumaWeight)
 * times the brightest background.
 */
export function lightWrap(alpha: Float32Array, bg: LinearImage, o: LightWrapOptions): Float32Array {
  const { width: w, height: h } = bg;
  const n = w * h;
  const sigma = Math.max(0.5, o.width / 2);
  const inv = new Float32Array(n);
  const bgInv = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    const v = 1 - alpha[i]!;
    inv[i] = v;
    bgInv[3 * i] = bg.data[3 * i]! * v;
    bgInv[3 * i + 1] = bg.data[3 * i + 1]! * v;
    bgInv[3 * i + 2] = bg.data[3 * i + 2]! * v;
  }
  const invBlur = gaussianBlur(inv, w, h, sigma);
  const bgBlur = blurRgb(bgInv, w, h, sigma);
  const out = new Float32Array(n * 3);
  const [lr, lg, lb] = o.luma;
  for (let i = 0; i < n; i += 1) {
    const a = alpha[i]!;
    const vis = invBlur[i]!;
    if (!(a > 0) || vis <= 1e-4) continue;
    const mask = a * Math.min(1, vis);
    const r = bgBlur[3 * i]! / vis;
    const g = bgBlur[3 * i + 1]! / vis;
    const b = bgBlur[3 * i + 2]! / vis;
    const lum = Math.max(0, lr * r + lg * g + lb * b);
    const f = o.intensity * mask * (1 - o.lumaWeight + o.lumaWeight * Math.min(2, lum / 0.18));
    out[3 * i] = Math.max(0, r * f);
    out[3 * i + 1] = Math.max(0, g * f);
    out[3 * i + 2] = Math.max(0, b * f);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Suggested match (§7 bullet 3)
// ---------------------------------------------------------------------------

export interface MatchEstimate {
  gain: [number, number, number];
  offset: [number, number, number];
  exposureStops: number;
  confidence: number;
  samples: { foreground: number; background: number };
}

function medianOf(v: Float64Array | number[]): number {
  const s = Array.from(v).sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * A robust per-channel gain and offset that maps the foreground's colour
 * statistics onto the background's: gain = MAD(bg) / MAD(fg), offset =
 * median(bg) − gain · median(fg), with medians and median absolute deviations
 * so a few bright highlights or dark pixels do not decide it. Exactly
 * recovers g·x + o when the background samples are that transform of the
 * foreground's.
 */
export function estimateMatch(fg: readonly number[], bg: readonly number[], luma: readonly [number, number, number]): MatchEstimate {
  const nf = Math.floor(fg.length / 3);
  const nb = Math.floor(bg.length / 3);
  const gain: [number, number, number] = [1, 1, 1];
  const offset: [number, number, number] = [0, 0, 0];
  const mf: number[] = [0, 0, 0];
  const mb: number[] = [0, 0, 0];
  let spread = 1;
  if (nf >= 8 && nb >= 8) {
    for (let c = 0; c < 3; c += 1) {
      const f = new Float64Array(nf);
      const b = new Float64Array(nb);
      for (let i = 0; i < nf; i += 1) f[i] = fg[3 * i + c]!;
      for (let i = 0; i < nb; i += 1) b[i] = bg[3 * i + c]!;
      const medF = medianOf(f);
      const medB = medianOf(b);
      const madF = medianOf(f.map((v) => Math.abs(v - medF)));
      const madB = medianOf(b.map((v) => Math.abs(v - medB)));
      const g = madF > 1e-6 ? Math.max(0.25, Math.min(4, madB / madF)) : 1;
      if (madF <= 1e-6) spread = 0.5;
      gain[c] = g;
      offset[c] = medB - g * medF;
      mf[c] = medF;
      mb[c] = medB;
    }
  }
  const lf = luma[0] * mf[0]! + luma[1] * mf[1]! + luma[2] * mf[2]!;
  const lb = luma[0] * mb[0]! + luma[1] * mb[1]! + luma[2] * mb[2]!;
  const exposureStops = lf > 1e-6 && lb > 1e-6 ? Math.log2(lb / lf) : 0;
  const confidence = Math.min(1, nf / 400) * Math.min(1, nb / 400) * spread;
  return { gain, offset, exposureStops, confidence: Math.round(confidence * 1000) / 1000, samples: { foreground: nf, background: nb } };
}

/**
 * The samples a match is estimated from: the despilled foreground (not
 * premultiplied) just inside the subject's edge, and the background just
 * outside it, within `band` pixels.
 */
export function matchSamples(fg: Float32Array, alpha: Float32Array, bg: LinearImage, band: number, maxSamples = 20_000): { fg: number[]; bg: number[] } {
  const { width: w, height: h } = bg;
  const n = w * h;
  const bin = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) bin[i] = alpha[i]! >= 0.5 ? 1 : 0;
  const sd = signedDistance(bin, w, h, band + 2);
  const inside: number[] = [];
  const outside: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const d = sd[i]!;
    const a = alpha[i]!;
    if (d < 0 && d >= -band && a >= 0.98) inside.push(i);
    else if (d > 0 && d <= band && a <= 0.02) outside.push(i);
  }
  const pick = (idx: number[], fn: (i: number) => [number, number, number]) => {
    const step = Math.max(1, Math.floor(idx.length / maxSamples));
    const out: number[] = [];
    for (let k = 0; k < idx.length; k += step) out.push(...fn(idx[k]!));
    return out;
  };
  return {
    fg: pick(inside, (i) => {
      const a = Math.max(1e-6, alpha[i]!);
      return [fg[3 * i]! / a, fg[3 * i + 1]! / a, fg[3 * i + 2]! / a];
    }),
    bg: pick(outside, (i) => [bg.data[3 * i]!, bg.data[3 * i + 1]!, bg.data[3 * i + 2]!]),
  };
}

/** A premultiplied foreground with a match applied at `strength` (0 none, 1 full) — for preview only. */
export function applyMatch(fg: Float32Array, alpha: Float32Array, m: Pick<MatchEstimate, 'gain' | 'offset'>, strength: number): Float32Array {
  const out = new Float32Array(fg.length);
  const g = m.gain.map((v) => 1 + strength * (v - 1));
  const o = m.offset.map((v) => strength * v);
  for (let i = 0; i < alpha.length; i += 1) {
    const a = alpha[i]!;
    if (!(a > 0)) continue;
    for (let c = 0; c < 3; c += 1) out[3 * i + c] = Math.max(0, g[c]! * fg[3 * i + c]! + a * o[c]!);
  }
  return out;
}

/** Premultiplied foreground over a background, plus an optional additive layer: fg + (1 − α)·bg + add. */
export function over(fg: Float32Array, alpha: Float32Array, bg: Float32Array, add: Float32Array | null = null): Float32Array {
  const out = new Float32Array(fg.length);
  for (let i = 0; i < alpha.length; i += 1) {
    const k = 1 - alpha[i]!;
    for (let c = 0; c < 3; c += 1) out[3 * i + c] = fg[3 * i + c]! + k * bg[3 * i + c]! + (add ? add[3 * i + c]! : 0);
  }
  return out;
}

/** A neutral checkerboard (linear 0.18 / 0.36, `cell` pixels) to judge a premultiplied foreground over. */
export function checker(w: number, h: number, cell = 16): Float32Array {
  const out = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      const v = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 ? 0.36 : 0.18;
      out.fill(v, 3 * (y * w + x), 3 * (y * w + x) + 3);
    }
  return out;
}
