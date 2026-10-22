import type { LinearImage } from '../key/linear';
import { gaussianBlur } from '../roto/image';

/**
 * The compositor's pictures (addendum 13 §3): four floats per pixel —
 * r, g, b, a interleaved — in scene-linear light, premultiplied by alpha, as
 * Nuke holds them. Pure TypeScript on typed arrays, so the same code runs in
 * the desktop (main process and worker) and in the browser preview.
 *
 * Coordinates are continuous pixels with pixel (x, y)'s centre at
 * (x + 0.5, y + 0.5), y down; the Nuke writer flips to Nuke's y-up.
 */

export interface RGBA {
  width: number;
  height: number;
  data: Float32Array;
}

export const blank = (width: number, height: number): RGBA => ({ width, height, data: new Float32Array(width * height * 4) });

/** An opaque picture (a plate): alpha 1. */
export function fromLinear(img: LinearImage): RGBA {
  const n = img.width * img.height;
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i += 1) {
    out[4 * i] = img.data[3 * i]!;
    out[4 * i + 1] = img.data[3 * i + 1]!;
    out[4 * i + 2] = img.data[3 * i + 2]!;
    out[4 * i + 3] = 1;
  }
  return { width: img.width, height: img.height, data: out };
}

/** A matte: alpha = m, colour = m (premultiplied white), as a Read of a matte shuffled to alpha. */
export function fromMatte(m: Float32Array, width: number, height: number): RGBA {
  const out = new Float32Array(width * height * 4);
  for (let i = 0; i < m.length; i += 1) {
    const v = m[i]!;
    out[4 * i] = v;
    out[4 * i + 1] = v;
    out[4 * i + 2] = v;
    out[4 * i + 3] = v;
  }
  return { width, height, data: out };
}

/** A premultiplied foreground from interleaved RGB (already premultiplied) and its alpha. */
export function fromPremult(rgb: Float32Array, alpha: Float32Array, width: number, height: number): RGBA {
  const out = new Float32Array(width * height * 4);
  for (let i = 0; i < alpha.length; i += 1) {
    out[4 * i] = rgb[3 * i]!;
    out[4 * i + 1] = rgb[3 * i + 1]!;
    out[4 * i + 2] = rgb[3 * i + 2]!;
    out[4 * i + 3] = alpha[i]!;
  }
  return { width, height, data: out };
}

export function rgbOf(img: RGBA): LinearImage {
  const n = img.width * img.height;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    out[3 * i] = img.data[4 * i]!;
    out[3 * i + 1] = img.data[4 * i + 1]!;
    out[3 * i + 2] = img.data[4 * i + 2]!;
  }
  return { width: img.width, height: img.height, data: out };
}

export function alphaOf(img: RGBA): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = img.data[4 * i + 3]!;
  return out;
}

/** Resample to another size: area average when shrinking 2× or more, bilinear otherwise (pixel centres aligned). */
export function resizeRGBA(img: RGBA, width: number, height: number): RGBA {
  if (img.width === width && img.height === height) return img;
  const out = new Float32Array(width * height * 4);
  const sx = img.width / width;
  const sy = img.height / height;
  const W = img.width;
  const H = img.height;
  const src = img.data;
  if (sx >= 2 && sy >= 2) {
    for (let y = 0; y < height; y += 1) {
      const y0 = Math.floor(y * sy);
      const y1 = Math.min(H, Math.max(y0 + 1, Math.floor((y + 1) * sy)));
      for (let x = 0; x < width; x += 1) {
        const x0 = Math.floor(x * sx);
        const x1 = Math.min(W, Math.max(x0 + 1, Math.floor((x + 1) * sx)));
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let yy = y0; yy < y1; yy += 1)
          for (let xx = x0; xx < x1; xx += 1) {
            const k = 4 * (yy * W + xx);
            r += src[k]!;
            g += src[k + 1]!;
            b += src[k + 2]!;
            a += src[k + 3]!;
          }
        const inv = 1 / ((y1 - y0) * (x1 - x0));
        const o = 4 * (y * width + x);
        out[o] = r * inv;
        out[o + 1] = g * inv;
        out[o + 2] = b * inv;
        out[o + 3] = a * inv;
      }
    }
    return { width, height, data: out };
  }
  for (let y = 0; y < height; y += 1) {
    const fy = Math.max(0, Math.min(H - 1, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(H - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < width; x += 1) {
      const fx = Math.max(0, Math.min(W - 1, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(W - 1, x0 + 1);
      const tx = fx - x0;
      const o = 4 * (y * width + x);
      for (let c = 0; c < 4; c += 1) {
        const a = src[4 * (y0 * W + x0) + c]! * (1 - tx) + src[4 * (y0 * W + x1) + c]! * tx;
        const b = src[4 * (y1 * W + x0) + c]! * (1 - tx) + src[4 * (y1 * W + x1) + c]! * tx;
        out[o + c] = a * (1 - ty) + b * ty;
      }
    }
  }
  return { width, height, data: out };
}

export type Filter = 'impulse' | 'bilinear' | 'cubic';

/** Catmull–Rom weights (Keys, a = −½). */
function cubicW(t: number, w: Float64Array): void {
  const t2 = t * t;
  const t3 = t2 * t;
  w[0] = -0.5 * t3 + t2 - 0.5 * t;
  w[1] = 1.5 * t3 - 2.5 * t2 + 1;
  w[2] = -1.5 * t3 + 2 * t2 + 0.5 * t;
  w[3] = 0.5 * t3 - 0.5 * t2;
}

/**
 * The output pixel at (x, y) is the input at `map(x + ½, y + ½)` (continuous
 * coordinates). Outside the input: transparent black, as Nuke's black outside.
 */
export function warp(img: RGBA, map: (x: number, y: number, out: Float64Array) => void, filter: Filter): RGBA {
  const { width: W, height: H, data: src } = img;
  const out = new Float32Array(W * H * 4);
  const p = new Float64Array(2);
  const wx = new Float64Array(4);
  const wy = new Float64Array(4);
  const px = (xx: number, yy: number, c: number) => (xx < 0 || yy < 0 || xx >= W || yy >= H ? 0 : src[4 * (yy * W + xx) + c]!);
  for (let y = 0; y < H; y += 1)
    for (let x = 0; x < W; x += 1) {
      map(x + 0.5, y + 0.5, p);
      const sx = p[0]! - 0.5;
      const sy = p[1]! - 0.5;
      if (!(sx > -2 && sy > -2 && sx < W + 1 && sy < H + 1)) continue;
      const o = 4 * (y * W + x);
      if (filter === 'impulse') {
        const xx = Math.round(sx);
        const yy = Math.round(sy);
        for (let c = 0; c < 4; c += 1) out[o + c] = px(xx, yy, c);
        continue;
      }
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const tx = sx - x0;
      const ty = sy - y0;
      if (filter === 'bilinear') {
        for (let c = 0; c < 4; c += 1) out[o + c] = (px(x0, y0, c) * (1 - tx) + px(x0 + 1, y0, c) * tx) * (1 - ty) + (px(x0, y0 + 1, c) * (1 - tx) + px(x0 + 1, y0 + 1, c) * tx) * ty;
        continue;
      }
      cubicW(tx, wx);
      cubicW(ty, wy);
      for (let c = 0; c < 4; c += 1) {
        let v = 0;
        for (let j = 0; j < 4; j += 1) {
          let row = 0;
          for (let i = 0; i < 4; i += 1) row += wx[i]! * px(x0 - 1 + i, y0 - 1 + j, c);
          v += wy[j]! * row;
        }
        out[o + c] = v;
      }
    }
  return { width: W, height: H, data: out };
}

/** Gaussian blur of the chosen channels (σ in pixels; three box passes). */
export function blurRGBA(img: RGBA, sigma: number, alphaOnly: boolean): RGBA {
  if (sigma <= 0.25) return img;
  const n = img.width * img.height;
  const out = img.data.slice();
  const plane = new Float32Array(n);
  for (let c = alphaOnly ? 3 : 0; c < 4; c += 1) {
    for (let i = 0; i < n; i += 1) plane[i] = img.data[4 * i + c]!;
    const b = gaussianBlur(plane, img.width, img.height, sigma);
    for (let i = 0; i < n; i += 1) out[4 * i + c] = b[i]!;
  }
  return { ...img, data: out };
}

/** Separable min (erode) or max (dilate) over a square of radius r (integer pixels). */
function minMax(plane: Float32Array, w: number, h: number, r: number, max: boolean): Float32Array {
  if (r <= 0) return plane.slice();
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const pick = max ? Math.max : Math.min;
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      let v = plane[y * w + x]!;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k += 1) v = pick(v, plane[y * w + k]!);
      tmp[y * w + x] = v;
    }
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      let v = tmp[y * w + x]!;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k += 1) v = pick(v, tmp[k * w + x]!);
      out[y * w + x] = v;
    }
  return out;
}

/** Erode (size > 0) or dilate (size < 0) the chosen channels; a fractional size blends the two nearest radii. */
export function erodeRGBA(img: RGBA, size: number, alphaOnly: boolean): RGBA {
  if (Math.abs(size) < 1e-3) return img;
  const n = img.width * img.height;
  const out = img.data.slice();
  const max = size < 0;
  const s = Math.abs(size);
  const r0 = Math.floor(s);
  const t = s - r0;
  const plane = new Float32Array(n);
  for (let c = alphaOnly ? 3 : 0; c < 4; c += 1) {
    for (let i = 0; i < n; i += 1) plane[i] = img.data[4 * i + c]!;
    const a = minMax(plane, img.width, img.height, r0, max);
    const b = t > 1e-3 ? minMax(plane, img.width, img.height, r0 + 1, max) : a;
    for (let i = 0; i < n; i += 1) out[4 * i + c] = a[i]! * (1 - t) + b[i]! * t;
  }
  return { ...img, data: out };
}
