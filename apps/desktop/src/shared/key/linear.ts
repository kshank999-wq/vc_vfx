import { ENCODINGS, GAMUTS, TRANSFERS, apply3, gamutMatrix, isIdentity3, rgbToXyz, viewDisplayCurve, type ColorEncodingId, type GamutId, type Matrix3 } from '@vcvfx/domain';

/**
 * Linear light for the keyer (addendum 09 §2). Pure TypeScript on typed
 * arrays, so the same code runs in the desktop's worker thread and in the
 * browser preview.
 *
 * Keying is done in scene-linear RGB, where a pixel on a soft edge really is
 * α·foreground + (1 − α)·screen: the colour difference, the screen
 * subtraction and the despill are then exact operations rather than
 * approximations on display-encoded values. Frames arrive as float code
 * values (ffmpeg's gbrpf32le) and are decoded here with the colour module's
 * published curves and matrices:
 *  - a linear plate (EXR ACEScg / ACES2065-1 / linear Rec.709) is used as is;
 *  - a camera log or display (Rec.709/sRGB) encoding is decoded to linear and
 *    converted to ACEScg;
 *  - an unknown encoding is keyed on its code values, and says so.
 */

export interface LinearImage {
  width: number;
  height: number;
  /** r, g, b per pixel, interleaved. */
  data: Float32Array;
}

export interface WorkingSpace {
  /** The encoding of the decoded pixels (what the foreground is written in). */
  encoding: ColorEncodingId | null;
  label: string;
  /** False only when the source encoding is unknown and code values were keyed. */
  linear: boolean;
  /** Luminance weights of the working gamut (Y row of its RGB → XYZ). */
  luma: [number, number, number];
  /** Linear working RGB → linear Rec.709, for the viewer's display transform. */
  toRec709: Matrix3 | null;
}

const GAMUT_OF = (e: ColorEncodingId): GamutId => ENCODINGS[e].gamut;

export function lumaWeights(gamut: GamutId): [number, number, number] {
  const m = rgbToXyz(GAMUTS[gamut]);
  return [m[3], m[4], m[5]];
}

/** Where pixels of a source in `encoding` are keyed. */
export function workingSpace(encoding: ColorEncodingId | null): WorkingSpace {
  if (!encoding) return { encoding: null, label: 'code values (source encoding unknown)', linear: false, luma: lumaWeights('rec709'), toRec709: null };
  const e = ENCODINGS[encoding];
  const target: ColorEncodingId = e.kind === 'linear' ? encoding : 'acescg';
  const m = gamutMatrix(GAMUT_OF(target), 'rec709');
  return { encoding: target, label: ENCODINGS[target].label, linear: true, luma: lumaWeights(GAMUT_OF(target)), toRec709: isIdentity3(m, 1e-7) ? null : m };
}

/** A per-channel decode table: 4096 steps over code values 0…1, the curve itself outside. */
function decodeTable(encoding: ColorEncodingId): (v: number) => number {
  const t = TRANSFERS[ENCODINGS[encoding].transfer];
  if (ENCODINGS[encoding].transfer === 'linear') return (v) => v;
  const n = 4096;
  const table = new Float32Array(n + 1);
  for (let i = 0; i <= n; i += 1) table[i] = t.toLinear(i / n);
  return (v) => {
    if (!(v >= 0 && v <= 1)) return t.toLinear(v);
    const f = v * n;
    const i = Math.min(n - 1, Math.floor(f));
    return table[i]! + (table[i + 1]! - table[i]!) * (f - i);
  };
}

/**
 * Planar float code values (ffmpeg gbrpf32le: the G plane, then B, then R) →
 * interleaved linear RGB in the working space of `encoding`.
 */
export function decodePlanar(planes: Float32Array, width: number, height: number, encoding: ColorEncodingId | null): LinearImage {
  const n = width * height;
  const out = new Float32Array(n * 3);
  const g = planes.subarray(0, n);
  const b = planes.subarray(n, 2 * n);
  const r = planes.subarray(2 * n, 3 * n);
  if (!encoding || ENCODINGS[encoding].kind === 'linear') {
    for (let i = 0; i < n; i += 1) {
      out[3 * i] = r[i]!;
      out[3 * i + 1] = g[i]!;
      out[3 * i + 2] = b[i]!;
    }
    return { width, height, data: out };
  }
  const dec = decodeTable(encoding);
  const m = gamutMatrix(GAMUT_OF(encoding), 'ap1', ENCODINGS[encoding].adaptation);
  for (let i = 0; i < n; i += 1) {
    const lr = dec(r[i]!);
    const lg = dec(g[i]!);
    const lb = dec(b[i]!);
    out[3 * i] = m[0] * lr + m[1] * lg + m[2] * lb;
    out[3 * i + 1] = m[3] * lr + m[4] * lg + m[5] * lb;
    out[3 * i + 2] = m[6] * lr + m[7] * lg + m[8] * lb;
  }
  return { width, height, data: out };
}

/** Interleaved code values (any encoding) → working linear, as decodePlanar. */
export function decodeInterleaved(rgb: Float32Array, width: number, height: number, encoding: ColorEncodingId | null): LinearImage {
  const n = width * height;
  const planes = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    planes[i] = rgb[3 * i + 1]!;
    planes[n + i] = rgb[3 * i + 2]!;
    planes[2 * n + i] = rgb[3 * i]!;
  }
  return decodePlanar(planes, width, height, encoding);
}

/** Working linear → a linear image in another linear encoding (e.g. ACEScg → linear Rec.709). */
export function convertLinear(img: LinearImage, from: ColorEncodingId, to: ColorEncodingId): LinearImage {
  const m = gamutMatrix(GAMUT_OF(from), GAMUT_OF(to));
  if (isIdentity3(m, 1e-9)) return img;
  const out = new Float32Array(img.data.length);
  for (let i = 0; i < out.length; i += 3) {
    const v = apply3(m, [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!]);
    out[i] = v[0];
    out[i + 1] = v[1];
    out[i + 2] = v[2];
  }
  return { ...img, data: out };
}

// ---------------------------------------------------------------------------
// Display, for the viewer only (never written to an output)
// ---------------------------------------------------------------------------

const TONE_MAX = 16;
const TONE_N = 4096;
const TONE = (() => {
  const t = new Uint8Array(TONE_N + 1);
  for (let i = 0; i <= TONE_N; i += 1) t[i] = Math.round(viewDisplayCurve((i / TONE_N) * TONE_MAX) * 255);
  return t;
})();
const tone8 = (x: number) => (x <= 0 ? TONE[0]! : x >= TONE_MAX ? TONE[TONE_N]! : TONE[Math.round((x / TONE_MAX) * TONE_N)]!);

/**
 * Linear working RGB → 8-bit display RGB through the viewer's Rec.709
 * (approx.) view: matrix to Rec.709, filmic tone, 2.4 display gamma (the same
 * curve as `viewTransform`). Code values (unknown encoding) are shown as they are.
 */
export function toDisplay(data: Float32Array, n: number, space: WorkingSpace, out = new Uint8ClampedArray(n * 3)): Uint8ClampedArray {
  const m = space.toRec709;
  for (let i = 0; i < n; i += 1) {
    let r = data[3 * i]!;
    let g = data[3 * i + 1]!;
    let b = data[3 * i + 2]!;
    if (!space.linear) {
      out[3 * i] = r * 255;
      out[3 * i + 1] = g * 255;
      out[3 * i + 2] = b * 255;
      continue;
    }
    if (m) {
      const rr = m[0] * r + m[1] * g + m[2] * b;
      const gg = m[3] * r + m[4] * g + m[5] * b;
      const bb = m[6] * r + m[7] * g + m[8] * b;
      r = rr;
      g = gg;
      b = bb;
    }
    out[3 * i] = tone8(r);
    out[3 * i + 1] = tone8(g);
    out[3 * i + 2] = tone8(b);
  }
  return out;
}

/** Bilinear resample of an interleaved RGB float image (pixel centres aligned); area-averaged when shrinking 2× or more. */
export function resizeLinear(img: LinearImage, width: number, height: number): LinearImage {
  if (img.width === width && img.height === height) return img;
  const out = new Float32Array(width * height * 3);
  const sx = img.width / width;
  const sy = img.height / height;
  const src = img.data;
  const W = img.width;
  if (sx >= 2 && sy >= 2) {
    for (let y = 0; y < height; y += 1) {
      const y0 = Math.floor(y * sy);
      const y1 = Math.min(img.height, Math.max(y0 + 1, Math.floor((y + 1) * sy)));
      for (let x = 0; x < width; x += 1) {
        const x0 = Math.floor(x * sx);
        const x1 = Math.min(W, Math.max(x0 + 1, Math.floor((x + 1) * sx)));
        let r = 0;
        let g = 0;
        let b = 0;
        for (let yy = y0; yy < y1; yy += 1) {
          let k = (yy * W + x0) * 3;
          for (let xx = x0; xx < x1; xx += 1, k += 3) {
            r += src[k]!;
            g += src[k + 1]!;
            b += src[k + 2]!;
          }
        }
        const c = (y1 - y0) * (x1 - x0);
        const o = (y * width + x) * 3;
        out[o] = r / c;
        out[o + 1] = g / c;
        out[o + 2] = b / c;
      }
    }
    return { width, height, data: out };
  }
  for (let y = 0; y < height; y += 1) {
    const fy = Math.min(img.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(img.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < width; x += 1) {
      const fx = Math.min(W - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(W - 1, x0 + 1);
      const wx = fx - x0;
      const a = (y0 * W + x0) * 3;
      const b = (y0 * W + x1) * 3;
      const c = (y1 * W + x0) * 3;
      const d = (y1 * W + x1) * 3;
      const o = (y * width + x) * 3;
      for (let ch = 0; ch < 3; ch += 1) {
        const top = src[a + ch]! + (src[b + ch]! - src[a + ch]!) * wx;
        const bottom = src[c + ch]! + (src[d + ch]! - src[c + ch]!) * wx;
        out[o + ch] = top + (bottom - top) * wy;
      }
    }
  }
  return { width, height, data: out };
}

/** One channel of an interleaved image as a plane. */
export function channel(img: LinearImage, c: 0 | 1 | 2): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = img.data[3 * i + c]!;
  return out;
}

/** Luminance plane of a linear image. */
export function luminance(img: LinearImage, luma: readonly [number, number, number]): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = luma[0] * img.data[3 * i]! + luma[1] * img.data[3 * i + 1]! + luma[2] * img.data[3 * i + 2]!;
  return out;
}
