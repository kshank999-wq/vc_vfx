import { workingSpace, type LinearImage, type WorkingSpace } from '../key/linear';
import { srgbEncode } from './image';

/**
 * Textures as the viewer shows them (addendum 12 §1): the working linear RGB
 * through a plain sRGB view (matrix to Rec.709 primaries, the sRGB curve, no
 * tone curve) — what a texture map looks like in a 3D package's viewport and
 * what the 16-bit PNG export holds. For looking and for that PNG only; the EXR
 * keeps the linear values.
 */

export const TEXTURE_SPACE: WorkingSpace = workingSpace('acescg');

const LUT_N = 4096;
const LUT_MAX = 1;
const LUT8 = (() => {
  const t = new Uint8Array(LUT_N + 1);
  for (let i = 0; i <= LUT_N; i += 1) t[i] = Math.round(srgbEncode((i / LUT_N) * LUT_MAX) * 255);
  return t;
})();
const enc8 = (v: number) => (v <= 0 ? 0 : v >= LUT_MAX ? 255 : LUT8[Math.round((v / LUT_MAX) * LUT_N)]!);

/** Linear working RGB → linear Rec.709 primaries, interleaved. */
export function toRec709Linear(img: LinearImage, space: WorkingSpace = TEXTURE_SPACE): Float32Array {
  const m = space.toRec709;
  if (!m) return img.data;
  const out = new Float32Array(img.data.length);
  for (let i = 0; i < out.length; i += 3) {
    const r = img.data[i]!;
    const g = img.data[i + 1]!;
    const b = img.data[i + 2]!;
    out[i] = m[0] * r + m[1] * g + m[2] * b;
    out[i + 1] = m[3] * r + m[4] * g + m[5] * b;
    out[i + 2] = m[6] * r + m[7] * g + m[8] * b;
  }
  return out;
}

/** 8-bit sRGB of a picture, scaled down (area average) to at most `maxWidth`. */
export function srgb8(img: LinearImage, maxWidth: number, space: WorkingSpace = TEXTURE_SPACE): { width: number; height: number; rgb: Uint8ClampedArray } {
  const k = Math.max(1, Math.ceil(img.width / Math.max(16, maxWidth)));
  const w = Math.max(1, Math.floor(img.width / k));
  const h = Math.max(1, Math.floor(img.height / k));
  const lin = toRec709Linear(img, space);
  const out = new Uint8ClampedArray(w * h * 3);
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < k; j += 1)
        for (let i = 0; i < k; i += 1) {
          const s = 3 * ((y * k + j) * img.width + x * k + i);
          r += lin[s]!;
          g += lin[s + 1]!;
          b += lin[s + 2]!;
        }
      const o = 3 * (y * w + x);
      const n = k * k;
      out[o] = enc8(r / n);
      out[o + 1] = enc8(g / n);
      out[o + 2] = enc8(b / n);
    }
  return { width: w, height: h, rgb: out };
}

/** 16-bit sRGB of a picture (the PNG export). */
export function srgb16(img: LinearImage, space: WorkingSpace = TEXTURE_SPACE): Uint16Array {
  const lin = toRec709Linear(img, space);
  const out = new Uint16Array(lin.length);
  for (let i = 0; i < lin.length; i += 1) out[i] = Math.round(srgbEncode(lin[i]!) * 65535);
  return out;
}

/** A mask scaled down the same way (any-pixel average → 0 … 255). */
export function mask8(mask: Uint8Array, width: number, height: number, maxWidth: number): { width: number; height: number; data: Uint8Array } {
  const k = Math.max(1, Math.ceil(width / Math.max(16, maxWidth)));
  const w = Math.max(1, Math.floor(width / k));
  const h = Math.max(1, Math.floor(height / k));
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      let s = 0;
      for (let j = 0; j < k; j += 1) for (let i = 0; i < k; i += 1) s += mask[(y * k + j) * width + x * k + i]!;
      out[y * w + x] = Math.round((s / (k * k)) * 255);
    }
  return { width: w, height: h, data: out };
}

/** The cached display form of one built region (what the review cache keeps). */
export interface CachedRegion {
  regionId: string;
  original: { width: number; height: number; rgb: Uint8ClampedArray };
  delit: { width: number; height: number; rgb: Uint8ClampedArray };
  tiled: { width: number; height: number; rgb: Uint8ClampedArray } | null;
  mask: Uint8Array;
  maskWidth: number;
  maskHeight: number;
}

export function cachedRegion(r: { regionId: string; original: LinearImage; delit: LinearImage; tiled: LinearImage | null; mask: Uint8Array }, maxWidth = 1024): CachedRegion {
  const final = r.tiled ?? r.delit;
  const m = mask8(r.mask, final.width, final.height, maxWidth);
  return {
    regionId: r.regionId,
    original: srgb8(r.original, maxWidth),
    delit: srgb8(r.delit, maxWidth),
    tiled: r.tiled ? srgb8(r.tiled, maxWidth) : null,
    mask: m.data,
    maskWidth: m.width,
    maskHeight: m.height,
  };
}

/** Downscale an 8-bit RGB picture (nearest area) for a smaller request. */
export function shrinkRgb(p: { width: number; height: number; rgb: Uint8ClampedArray }, maxWidth: number): { width: number; height: number; rgb: Uint8ClampedArray } {
  if (p.width <= maxWidth) return p;
  const k = Math.ceil(p.width / maxWidth);
  const w = Math.floor(p.width / k);
  const h = Math.floor(p.height / k);
  const out = new Uint8ClampedArray(w * h * 3);
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1)
      for (let c = 0; c < 3; c += 1) {
        let s = 0;
        for (let j = 0; j < k; j += 1) for (let i = 0; i < k; i += 1) s += p.rgb[3 * ((y * k + j) * p.width + x * k + i) + c]!;
        out[3 * (y * w + x) + c] = s / (k * k);
      }
  return { width: w, height: h, rgb: out };
}
