import type { LinearImage } from '../key/linear';
import { gaussianBlur } from '../roto/image';

/**
 * Picture operations for texture extraction (addendum 12 §3): high-quality
 * resampling, luminance, masked smoothing and robust statistics, on the
 * key's interleaved linear RGB (`LinearImage`).
 */

/** Keys' cubic (a = −½, Catmull–Rom): sharp without ringing much, and interpolating. */
function cubicWeights(t: number, w: Float64Array): void {
  const a = -0.5;
  const t1 = t + 1;
  const t2 = t;
  const t3 = 1 - t;
  const t4 = 2 - t;
  w[0] = ((a * t1 - 5 * a) * t1 + 8 * a) * t1 - 4 * a;
  w[1] = ((a + 2) * t2 - (a + 3)) * t2 * t2 + 1;
  w[2] = ((a + 2) * t3 - (a + 3)) * t3 * t3 + 1;
  w[3] = 1 - w[0]! - w[1]! - w[2]!;
}

const wx = new Float64Array(4);
const wy = new Float64Array(4);

/**
 * Bicubic sample of an interleaved RGB image at (x, y), pixel centres at
 * integers, edges clamped; written to out[o..o+2]. Returns false (and writes
 * nothing) when (x, y) is more than half a pixel outside the picture.
 */
export function sampleCubic(img: LinearImage, x: number, y: number, out: Float32Array, o: number): boolean {
  const { width: w, height: h, data } = img;
  if (!(x >= -0.5 && y >= -0.5 && x <= w - 0.5 && y <= h - 0.5)) return false;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  cubicWeights(x - ix, wx);
  cubicWeights(y - iy, wy);
  let r = 0;
  let g = 0;
  let b = 0;
  for (let j = 0; j < 4; j += 1) {
    const yy = Math.min(h - 1, Math.max(0, iy - 1 + j));
    const row = yy * w;
    let rr = 0;
    let gg = 0;
    let bb = 0;
    for (let i = 0; i < 4; i += 1) {
      const xx = Math.min(w - 1, Math.max(0, ix - 1 + i));
      const k = 3 * (row + xx);
      const q = wx[i]!;
      rr += data[k]! * q;
      gg += data[k + 1]! * q;
      bb += data[k + 2]! * q;
    }
    const q = wy[j]!;
    r += rr * q;
    g += gg * q;
    b += bb * q;
  }
  // Cubic overshoot is clamped at zero: light is never negative.
  out[o] = r > 0 ? r : 0;
  out[o + 1] = g > 0 ? g : 0;
  out[o + 2] = b > 0 ? b : 0;
  return true;
}

/** Bilinear sample with the same conventions (for previews and matching). */
export function sampleLinear(img: LinearImage, x: number, y: number, out: Float32Array, o: number, wrapX = false): boolean {
  const { width: w, height: h, data } = img;
  if (!wrapX && !(x >= -0.5 && x <= w - 0.5)) return false;
  if (!(y >= -0.5 && y <= h - 0.5)) return false;
  const fy = Math.min(h - 1, Math.max(0, y));
  const y0 = Math.floor(fy);
  const y1 = Math.min(h - 1, y0 + 1);
  const ty = fy - y0;
  let x0: number;
  let x1: number;
  let tx: number;
  if (wrapX) {
    const fx = ((x % w) + w) % w;
    x0 = Math.floor(fx);
    x1 = (x0 + 1) % w;
    tx = fx - x0;
  } else {
    const fx = Math.min(w - 1, Math.max(0, x));
    x0 = Math.floor(fx);
    x1 = Math.min(w - 1, x0 + 1);
    tx = fx - x0;
  }
  for (let c = 0; c < 3; c += 1) {
    const a = data[3 * (y0 * w + x0) + c]!;
    const b = data[3 * (y0 * w + x1) + c]!;
    const d = data[3 * (y1 * w + x0) + c]!;
    const e = data[3 * (y1 * w + x1) + c]!;
    const top = a + (b - a) * tx;
    const bot = d + (e - d) * tx;
    out[o + c] = top + (bot - top) * ty;
  }
  return true;
}

export function luminanceOf(img: LinearImage, luma: readonly [number, number, number]): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  const d = img.data;
  for (let i = 0; i < n; i += 1) out[i] = luma[0] * d[3 * i]! + luma[1] * d[3 * i + 1]! + luma[2] * d[3 * i + 2]!;
  return out;
}

/**
 * Gaussian smoothing that ignores masked-out pixels (normalised
 * convolution): blur(v·m) / blur(m). Large σ is done on a smaller grid and
 * interpolated back, so the cost does not grow with the scale.
 */
export function maskedBlur(src: Float32Array, mask: Uint8Array | null, w: number, h: number, sigma: number): Float32Array {
  const n = w * h;
  const k = sigma > 6 ? Math.min(Math.floor(sigma / 3), Math.floor(Math.min(w, h) / 8)) : 1;
  if (k <= 1) {
    if (!mask) return gaussianBlur(src, w, h, sigma);
    const vm = new Float32Array(n);
    const m = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      if (mask[i]) {
        vm[i] = src[i]!;
        m[i] = 1;
      }
    }
    const a = gaussianBlur(vm, w, h, sigma);
    const b = gaussianBlur(m, w, h, sigma);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i += 1) out[i] = b[i]! > 1e-6 ? a[i]! / b[i]! : 0;
    return out;
  }
  // Average k×k blocks (masked), blur there, sample back bilinearly.
  const sw = Math.ceil(w / k);
  const sh = Math.ceil(h / k);
  const vs = new Float32Array(sw * sh);
  const ms = new Float32Array(sw * sh);
  for (let y = 0; y < h; y += 1) {
    const yy = Math.floor(y / k) * sw;
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (mask && !mask[i]) continue;
      const j = yy + Math.floor(x / k);
      vs[j]! += src[i]!;
      ms[j]! += 1;
    }
  }
  const a = gaussianBlur(vs, sw, sh, sigma / k);
  const b = gaussianBlur(ms, sw, sh, sigma / k);
  const small = new Float32Array(sw * sh);
  for (let i = 0; i < small.length; i += 1) small[i] = b[i]! > 1e-6 ? a[i]! / b[i]! : 0;
  const out = new Float32Array(n);
  for (let y = 0; y < h; y += 1) {
    const sy = Math.min(sh - 1, Math.max(0, (y + 0.5) / k - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const ty = sy - y0;
    for (let x = 0; x < w; x += 1) {
      const sx = Math.min(sw - 1, Math.max(0, (x + 0.5) / k - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const tx = sx - x0;
      const top = small[y0 * sw + x0]! + (small[y0 * sw + x1]! - small[y0 * sw + x0]!) * tx;
      const bot = small[y1 * sw + x0]! + (small[y1 * sw + x1]! - small[y1 * sw + x0]!) * tx;
      out[y * w + x] = top + (bot - top) * ty;
    }
  }
  return out;
}

/** The q-quantile (0 … 1) of the values where the mask is set (all when null). */
export function quantile(values: Float32Array, mask: Uint8Array | null, q: number): number {
  const picked: number[] = [];
  const step = Math.max(1, Math.floor(values.length / 200_000));
  for (let i = 0; i < values.length; i += step) if (!mask || mask[i]) picked.push(values[i]!);
  if (!picked.length) return 0;
  picked.sort((a, b) => a - b);
  return picked[Math.min(picked.length - 1, Math.max(0, Math.round(q * (picked.length - 1))))]!;
}

/** Repeat a picture n × n (the tile preview). */
export function tileImage(img: LinearImage, n: number): LinearImage {
  const W = img.width * n;
  const H = img.height * n;
  const out = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y += 1) {
    const sy = y % img.height;
    for (let x = 0; x < W; x += 1) {
      const s = 3 * (sy * img.width + (x % img.width));
      const d = 3 * (y * W + x);
      out[d] = img.data[s]!;
      out[d + 1] = img.data[s + 1]!;
      out[d + 2] = img.data[s + 2]!;
    }
  }
  return { width: W, height: H, data: out };
}

/** Linear (scene) value → sRGB-encoded 0 … 1. */
export function srgbEncode(v: number): number {
  if (!(v > 0)) return 0;
  if (v >= 1) return 1;
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}
