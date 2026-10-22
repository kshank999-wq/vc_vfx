import type { LinearImage } from '../key/linear';
import { gaussianBlur } from '../roto/image';
import { luminanceOf, maskedBlur, quantile } from './image';

/**
 * Lighting flattening — "delighting" (master spec §12 "correct … lighting
 * variation as needed for texture extraction"; addendum 12 §3.2).
 *
 * A photographed surface is albedo × irradiance. Irradiance from a set's
 * lights changes slowly across a surface (falloff, the angle to the light,
 * ambient occlusion near corners); albedo carries the detail. So the shading
 * is estimated as the large-scale geometric mean of the luminance — a
 * Gaussian of log luminance at `radius` × the texture's short side, ignoring
 * texels outside the photo — normalised to its median, and divided out with
 * `strength` (1: all of it). Division keeps colour and leaves every detail
 * finer than the radius as it was; what is lost is albedo variation at the
 * scale of the radius and above (a surface that really does get darker
 * across it), which is why the radius and the strength are the artist's.
 *
 * Measured: the large-scale variation left (stops, the 5–95 % spread of the
 * log₂ luminance smoothed at a fifth of the short side) before and after, and the fine detail kept
 * (high-pass energy after / before).
 */

export interface DelightResult {
  image: LinearImage;
  /** The shading that was divided out (median 1), per texel. */
  shading: Float32Array;
  residualBefore: number;
  residualAfter: number;
  detailKept: number;
}

const EPS = 1e-5;
/** The residual is measured at one fixed scale (a fifth of the short side), whatever radius was delit with. */
export const RESIDUAL_SCALE = 0.2;

/** Stops of large-scale light variation: the 5–95 % spread of log₂ luminance smoothed at σ. */
export function residualStops(img: LinearImage, mask: Uint8Array | null, luma: readonly [number, number, number], sigma: number): number {
  const { width: w, height: h } = img;
  const L = luminanceOf(img, luma);
  for (let i = 0; i < L.length; i += 1) L[i] = Math.log2(Math.max(EPS, L[i]!));
  const s = maskedBlur(L, mask, w, h, sigma);
  // Away from the border, where the smoothing sees half a window.
  const inner = new Uint8Array(w * h);
  const bx = Math.round(Math.min(w * 0.12, sigma * 0.6));
  const by = Math.round(Math.min(h * 0.12, sigma * 0.6));
  for (let y = by; y < h - by; y += 1) for (let x = bx; x < w - bx; x += 1) if (!mask || mask[y * w + x]) inner[y * w + x] = 1;
  return Math.max(0, quantile(s, inner, 0.95) - quantile(s, inner, 0.05));
}

function highPassEnergy(img: LinearImage, mask: Uint8Array | null, luma: readonly [number, number, number]): number {
  const { width: w, height: h } = img;
  const L = luminanceOf(img, luma);
  for (let i = 0; i < L.length; i += 1) L[i] = Math.log2(Math.max(EPS, L[i]!));
  const b = gaussianBlur(L, w, h, 2);
  let e = 0;
  let n = 0;
  for (let i = 0; i < L.length; i += 1) {
    if (mask && !mask[i]) continue;
    const d = L[i]! - b[i]!;
    e += d * d;
    n += 1;
  }
  return n ? e / n : 0;
}

export function delight(img: LinearImage, mask: Uint8Array | null, luma: readonly [number, number, number], o: { strength: number; radius: number }): DelightResult {
  const { width: w, height: h } = img;
  const n = w * h;
  const sigma = Math.max(2, o.radius * Math.min(w, h));
  const L = luminanceOf(img, luma);
  const logL = new Float32Array(n);
  for (let i = 0; i < n; i += 1) logL[i] = Math.log(Math.max(EPS, L[i]!));
  const smooth = maskedBlur(logL, mask, w, h, sigma);
  const med = quantile(smooth, mask, 0.5);
  const shading = new Float32Array(n);
  const out = new Float32Array(n * 3);
  const s = Math.max(0, Math.min(1, o.strength));
  for (let i = 0; i < n; i += 1) {
    const sh = Math.exp(smooth[i]! - med);
    shading[i] = sh;
    const k = s > 0 ? Math.pow(sh, -s) : 1;
    out[3 * i] = img.data[3 * i]! * k;
    out[3 * i + 1] = img.data[3 * i + 1]! * k;
    out[3 * i + 2] = img.data[3 * i + 2]! * k;
  }
  const image = { width: w, height: h, data: out };
  const before = highPassEnergy(img, mask, luma);
  const after = highPassEnergy(image, mask, luma);
  return {
    image,
    shading,
    residualBefore: residualStops(img, mask, luma, RESIDUAL_SCALE * Math.min(w, h)),
    residualAfter: residualStops(image, mask, luma, RESIDUAL_SCALE * Math.min(w, h)),
    detailKept: before > 1e-12 ? Math.sqrt(after / before) : 1,
  };
}

/** Scale a picture's values (an exposure gain). */
export function applyGain(img: LinearImage, gain: number): LinearImage {
  if (gain === 1) return img;
  const out = new Float32Array(img.data.length);
  for (let i = 0; i < out.length; i += 1) out[i] = img.data[i]! * gain;
  return { ...img, data: out };
}

/** The median luminance of a picture where the mask is set. */
export function medianLuminance(img: LinearImage, mask: Uint8Array | null, luma: readonly [number, number, number]): number {
  return quantile(luminanceOf(img, luma), mask, 0.5);
}
