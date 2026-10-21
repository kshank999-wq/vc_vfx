import type { IsolateSpill } from '@vcvfx/domain';
import { estimateForeground } from '../key/keyer';
import { blurRgb } from '../key/look';
import type { LinearImage } from '../key/linear';
import { gaussianBlur, morph, sampleBilinear, signedDistance } from '../roto/image';

/**
 * The matte at the size it is delivered (addendum 11 §3.3): the cut's labels
 * (upsampled, soft) give where the edge is; the edge itself is unmixed in
 * linear light. A pixel on the edge is P = α·F + (1 − α)·B, with B the sky
 * (or background) colour and F the foreground's, both estimated from nearby
 * pixels that are clearly one or the other (normalised convolution, the
 * key's `estimateForeground`); α is P's projection on the line from B to F:
 *
 *     α = ((P − B)·(F − B)) / ‖F − B‖²
 *
 * so a branch a third of a pixel wide, a power line, hair or a soft building
 * edge gets the fractional alpha its coverage gives it. For the sky, pixels
 * the cut called sky that are not sky-coloured (a wire too thin for the cut)
 * join the edge. Where F and B are too alike for the unmixing to be trusted,
 * the cut's soft edge is kept and the pixel's confidence drops. The edge is
 * then softened (edge softness), and smoothed in time against the previous
 * frame warped by the camera's homography, only where the picture agrees
 * (static edges; nothing that moved is dragged).
 *
 * The isolated foreground is premultiplied and unmixed: P − (1 − α)·B, which
 * removes the sky's (background's) spill from the edge exactly when the model
 * holds; the spill colour may be the measured one (auto), a colour the artist
 * gives, or none.
 */

const clamp01 = (v: number) => (v <= 0 ? 0 : v >= 1 ? 1 : v);

export interface RefineOptions {
  target: 'sky' | 'background';
  luma: readonly [number, number, number];
  /** At this size: pixels of edge softness (Gaussian) and growth of the foreground. */
  softness: number;
  grow: number;
  /** 0 … 1: unmixing against the cut's soft edge. */
  detail: number;
  /** Pixels of this size per pixel of the probability's own size (how blocky its edge is). */
  k: number;
  spill: Pick<IsolateSpill, 'mode' | 'rgb' | 'amount'>;
  /** Sensor noise σ (linear), for the noise floor. */
  noise?: number;
}

export interface RefineResult {
  width: number;
  height: number;
  /** Foreground alpha, 0 … 1. */
  alpha: Float32Array;
  /** The sky/background colour estimated near each band pixel (linear RGB; 0 elsewhere). */
  B: Float32Array;
  /** The foreground colour estimated near each band pixel (linear RGB; 0 elsewhere). */
  F: Float32Array;
  /** Per-pixel confidence of the matte, 0 … 1. */
  confidence: Float32Array;
  /** 1 on the edge band that was unmixed. */
  band: Uint8Array;
  /** Median relative contrast between foreground and sky/background across the edge (0 … 1). */
  contrast: number;
}

/** A normalised convolution: the weighted mean of nearby samples (σ px), and how much weight was near. */
function localMean(P: Float32Array, wt: Float32Array, w: number, h: number, sigma: number): { mean: Float32Array; weight: Float32Array } {
  const n = w * h;
  const pw = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    const v = wt[i]!;
    if (!v) continue;
    pw[3 * i] = P[3 * i]! * v;
    pw[3 * i + 1] = P[3 * i + 1]! * v;
    pw[3 * i + 2] = P[3 * i + 2]! * v;
  }
  const num = blurRgb(pw, w, h, sigma);
  const den = gaussianBlur(wt, w, h, sigma);
  const mean = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    const d = den[i]!;
    if (d > 1e-6) for (let c = 0; c < 3; c += 1) mean[3 * i + c] = num[3 * i + c]! / d;
  }
  return { mean, weight: den };
}

/**
 * `known`: the sky/background behind the edge when it is known (the
 * background plate, rebuilt from the frames that saw it); estimated from the
 * neighbouring pixels otherwise.
 */
export function refineMatte(img: LinearImage, prob: Float32Array, o: RefineOptions, known: Float32Array | null = null): RefineResult {
  const { width: w, height: h, data: P } = img;
  const n = w * h;
  const luma = o.luma;
  const lum = (a: Float32Array | readonly number[], i: number) => luma[0] * a[3 * i]! + luma[1] * a[3 * i + 1]! + luma[2] * a[3 * i + 2]!;
  let hard: Uint8Array = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) hard[i] = prob[i]! >= 0.5 ? 1 : 0;
  if (Math.abs(o.grow) >= 0.5) hard = morph(hard, w, h, o.grow);
  const r = Math.max(2, Math.ceil(1.5 * o.k)) + 1;
  const sd = signedDistance(hard, w, h, r + 3);
  const band = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) if (Math.abs(sd[i]!) <= r) band[i] = 1;
  const noise = o.noise ?? 0.002;

  // Sky/background samples: clearly outside the foreground. For the sky, pixels the cut called sky that are not
  // sky-coloured (a wire, a twig) are found against a first estimate and left out of the samples, and join the band.
  const bgW = new Float32Array(n);
  for (let i = 0; i < n; i += 1) if (sd[i]! >= 1.5) bgW[i] = 1;
  let skyNear: { mean: Float32Array; weight: Float32Array } | null = null;
  if (o.target === 'sky') {
    const B0 = localMean(P, bgW, w, h, 1.2);
    skyNear = localMean(P, bgW, w, h, 4);
    const deviant = new Uint8Array(n);
    let any = false;
    for (let i = 0; i < n; i += 1) {
      if (hard[i] || B0.weight[i]! < 0.05) continue;
      const lb = Math.max(0.02, lum(B0.mean, i));
      let d2 = 0;
      for (let c = 0; c < 3; c += 1) d2 += (P[3 * i + c]! - B0.mean[3 * i + c]!) ** 2;
      if (Math.sqrt(d2) > Math.max(6 * noise, 0.08 * lb)) {
        deviant[i] = 1;
        any = true;
      }
    }
    if (any) {
      const grown = morph(deviant, w, h, 1.5);
      for (let i = 0; i < n; i += 1)
        if (grown[i]) {
          bgW[i] = 0;
          if (!hard[i]) band[i] = 1;
        }
    }
  }
  const fgW = new Float32Array(n);
  for (let i = 0; i < n; i += 1) if (sd[i]! <= -1.5) fgW[i] = 1;
  if (skyNear) {
    // The foreground's own colour: inside a branch two pixels wide there is still sky. Samples count by how far their
    // colour is from the sky beside them, so the trunk speaks for the twigs and a part-sky pixel hardly at all.
    for (let i = 0; i < n; i += 1) {
      if (!fgW[i] || skyNear.weight[i]! < 0.02) continue;
      const q = 3 * i;
      const b = skyNear.mean;
      const d = Math.sqrt((P[q]! - b[q]!) ** 2 + (P[q + 1]! - b[q + 1]!) ** 2 + (P[q + 2]! - b[q + 2]!) ** 2);
      const ref = Math.max(0.02, Math.sqrt(b[q]! ** 2 + b[q + 1]! ** 2 + b[q + 2]! ** 2));
      fgW[i] = Math.max(0.001, clamp01((d / ref - 0.4) / 0.4));
    }
  }
  const keyed = band;
  const B = known ?? estimateForeground(P, bgW, band, keyed, w, h);
  const F = estimateForeground(P, fgW, band, keyed, w, h);

  const alpha = new Float32Array(n);
  const confidence = new Float32Array(n).fill(1);
  const contrasts: number[] = [];
  for (let i = 0; i < n; i += 1) {
    if (!band[i]) {
      alpha[i] = hard[i]!;
      continue;
    }
    const soft = hard[i] ? Math.max(0.5, prob[i]!) : Math.min(0.5, prob[i]!);
    const q = 3 * i;
    const d0 = F[q]! - B[q]!;
    const d1 = F[q + 1]! - B[q + 1]!;
    const d2 = F[q + 2]! - B[q + 2]!;
    const dd = d0 * d0 + d1 * d1 + d2 * d2;
    const scale = Math.max(0.02, Math.sqrt(F[q]! ** 2 + F[q + 1]! ** 2 + F[q + 2]! ** 2), Math.sqrt(B[q]! ** 2 + B[q + 1]! ** 2 + B[q + 2]! ** 2));
    const contrast = Math.sqrt(dd) / scale;
    if (Math.abs(sd[i]!) <= 1) contrasts.push(Math.min(1, contrast));
    const p0 = P[q]! - B[q]!;
    const p1 = P[q + 1]! - B[q + 1]!;
    const p2 = P[q + 2]! - B[q + 2]!;
    let au = dd > 1e-10 ? clamp01((p0 * d0 + p1 * d1 + p2 * d2) / dd) : soft;
    // The noise floor: a sky pixel within the noise of the sky is sky.
    if (!hard[i] && Math.sqrt(p0 * p0 + p1 * p1 + p2 * p2) < 4 * noise) au = 0;
    // How well the pixel lies on the line from B to F (a wrong F or B shows here).
    const r0 = p0 - au * d0;
    const r1 = p1 - au * d1;
    const r2 = p2 - au * d2;
    const fit = dd > 1e-10 ? Math.sqrt((r0 * r0 + r1 * r1 + r2 * r2) / dd) : 1;
    const trust = clamp01((contrast - 0.03) / 0.12);
    // On the sky side of the cut, only what lies on the line to the foreground is foreground: a cloud's
    // texture is off that line (lighter, or another hue) and stays sky.
    if (!hard[i]) au = au * clamp01(1 - (fit - 0.15) / 0.35);
    // … and only when what it adds to the sky is more than texture: 6 % of the sky's level (a cloud's edge is not a twig).
    if (!hard[i] && (au < 0.04 || au * Math.sqrt(dd) < 0.06 * Math.sqrt(B[q]! ** 2 + B[q + 1]! ** 2 + B[q + 2]! ** 2))) au = 0;
    // Where the pixel is far off the line (F or B guessed wrong: texture, a third colour), the cut's edge is kept.
    const fits = clamp01(1 - (fit - 0.25) / 0.5);
    alpha[i] = soft + o.detail * trust * fits * (au - soft);
    confidence[i] = clamp01(trust * (1 - clamp01(fit / 0.6)) * 0.9 + 0.1 * Math.abs(2 * alpha[i]! - 1));
  }
  if (o.softness >= 0.5) {
    const soft = gaussianBlur(alpha, w, h, o.softness / 2);
    for (let i = 0; i < n; i += 1) if (band[i]) alpha[i] = soft[i]!;
  }

  contrasts.sort((a, b) => a - b);
  return { width: w, height: h, alpha, B, F, confidence, band, contrast: contrasts.length ? contrasts[contrasts.length >> 1]! : 1 };
}

/**
 * Smooth the matte in time against the previous frame's, warped by `H`
 * (this frame's pixel → the previous frame's pixel: the camera's motion), on
 * the edge band only and only where the picture agrees there (static edges;
 * what moved keeps its own matte). Returns the mean |Δα| against the warped
 * previous matte over the agreeing edge, after smoothing: the flicker.
 */
export function smoothTemporal(
  cur: { alpha: Float32Array; band: Uint8Array; image: LinearImage },
  prev: { alpha: Float32Array; image: LinearImage },
  H: readonly number[],
  strength: number,
  luma: readonly [number, number, number],
): number {
  const { width: w, height: h } = cur.image;
  const pw = prev.image.width;
  const ph = prev.image.height;
  const P = cur.image.data;
  const Q = prev.image.data;
  const prevL = new Float32Array(pw * ph);
  for (let i = 0; i < prevL.length; i += 1) prevL[i] = luma[0] * Q[3 * i]! + luma[1] * Q[3 * i + 1]! + luma[2] * Q[3 * i + 2]!;
  let sum = 0;
  let count = 0;
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (!cur.band[i]) continue;
      const d = H[6]! * x + H[7]! * y + H[8]!;
      const u = (H[0]! * x + H[1]! * y + H[2]!) / d;
      const v = (H[3]! * x + H[4]! * y + H[5]!) / d;
      if (!(u >= 0 && v >= 0 && u <= pw - 1 && v <= ph - 1)) continue;
      const L = luma[0] * P[3 * i]! + luma[1] * P[3 * i + 1]! + luma[2] * P[3 * i + 2]!;
      const Lp = sampleBilinear(prevL, pw, ph, u, v);
      const rel = Math.abs(L - Lp) / Math.max(0.02, Math.max(L, Lp));
      const g = Math.exp(-((rel / 0.05) ** 2));
      const ap = sampleBilinear(prev.alpha, pw, ph, u, v);
      const a = cur.alpha[i]! + strength * g * (ap - cur.alpha[i]!);
      cur.alpha[i] = a;
      if (g > 0.5) {
        sum += Math.abs(a - ap);
        count += 1;
      }
    }
  return count ? sum / count : 0;
}

/**
 * The premultiplied foreground: P − (1 − α)·B on the edge (the sky or
 * background unmixed out of it: its spill), α·P elsewhere (0 or the pixel).
 * `spill` picks B: the measured colour near the edge (auto), a colour given
 * (colour), or none (off: the edge keeps its spill); `amount` blends.
 */
export function foregroundOf(img: LinearImage, alpha: Float32Array, band: Uint8Array, B: Float32Array, spill: Pick<IsolateSpill, 'mode' | 'rgb' | 'amount'>, F: Float32Array | null = null): Float32Array {
  const P = img.data;
  const n = img.width * img.height;
  const fg = new Float32Array(n * 3);
  const colour = spill.mode === 'colour' && spill.rgb ? spill.rgb : null;
  for (let i = 0; i < n; i += 1) {
    const a = alpha[i]!;
    if (!(a > 0)) continue;
    const q = 3 * i;
    for (let c = 0; c < 3; c += 1) {
      const raw = a * P[q + c]!;
      if (!band[i] || spill.mode === 'off' || a >= 1) {
        fg[q + c] = raw;
        continue;
      }
      const b = colour ? colour[c]! : B[q + c]!;
      let unmixed = Math.min(P[q + c]!, Math.max(0, P[q + c]! - (1 - a) * b));
      // Where the sky/background leads this channel, what is left above the foreground's own colour is spill
      // (a matte a little too solid on a twig leaves some sky in it): limited to the foreground's colour.
      if (F && b > F[q + c]!) unmixed = Math.min(unmixed, a * (1.25 * F[q + c]! + 0.005));
      fg[q + c] = raw + spill.amount * (unmixed - raw);
    }
  }
  return fg;
}

/** Share of the frame on the uncertain edge (0.05 < α < 0.95). */
export function edgeShare(alpha: Float32Array): number {
  let e = 0;
  for (let i = 0; i < alpha.length; i += 1) if (alpha[i]! > 0.05 && alpha[i]! < 0.95) e += 1;
  return alpha.length ? e / alpha.length : 0;
}
