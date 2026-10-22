import type { MergeOperation, Track2d } from '@vcvfx/domain';
import { homographyFromQuads } from '../camera/planar';
import { despill as despillRgb, type DespillOptions } from '../key/despill';
import { backgroundNear, lightWrap as lightWrapLayer } from '../key/look';
import { blank, rgbOf, warp, type Filter, type RGBA } from './image';

/**
 * The maths of each node (addendum 13 §3), on premultiplied linear RGBA.
 * Formulas are Nuke's where Nuke has the node (Merge2, Grade, ColorCorrect,
 * Saturation, Transform, CornerPin2D, Shuffle, Copy, Premult, Unpremult, Crop,
 * Constant); the despill and the light wrap are the Key tab's own.
 */

/** Rec.709 luminance, as Nuke's Saturation and ColorCorrect use it. */
export const REC709_LUMA = [0.2126, 0.7152, 0.0722] as const;

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/** One channel of a Merge: A and B are the channel's values, a and b the two alphas. */
export function mergeChannel(op: MergeOperation, A: number, B: number, a: number, b: number): number {
  switch (op) {
    case 'over':
      return A + B * (1 - a);
    case 'under':
      return A * (1 - b) + B;
    case 'plus':
      return A + B;
    case 'minus':
      return A - B;
    case 'multiply':
      return A * B;
    case 'screen':
      // Nuke: A + B − AB while both are 0…1, else the larger.
      return A >= 0 && A <= 1 && B >= 0 && B <= 1 ? A + B - A * B : Math.max(A, B);
    case 'stencil':
      return B * (1 - a);
    case 'mask':
      return B * a;
    case 'in':
      return A * b;
    case 'out':
      return A * (1 - b);
    case 'atop':
      return A * b + B * (1 - a);
    case 'difference':
      return Math.abs(A - B);
    case 'max':
      return Math.max(A, B);
    case 'min':
      return Math.min(A, B);
    case 'average':
      return (A + B) / 2;
    case 'copy':
      return A;
  }
}

/**
 * A Merge: every channel (r, g, b and a) by the operation, then blended back
 * towards B by mix × the mask's alpha. A missing A or B is transparent black.
 */
export function merge(op: MergeOperation, A: RGBA | null, B: RGBA | null, mask: RGBA | null, mix: number, width: number, height: number): RGBA {
  const n = width * height;
  const out = new Float32Array(n * 4);
  const a = A?.data;
  const b = B?.data;
  const m = mask?.data;
  for (let i = 0; i < n; i += 1) {
    const aa = a ? a[4 * i + 3]! : 0;
    const ba = b ? b[4 * i + 3]! : 0;
    const k = mix * (m ? m[4 * i + 3]! : 1);
    for (let c = 0; c < 4; c += 1) {
      const Bv = b ? b[4 * i + c]! : 0;
      const v = mergeChannel(op, a ? a[4 * i + c]! : 0, Bv, aa, ba);
      out[4 * i + c] = k >= 1 ? v : Bv + (v - Bv) * k;
    }
  }
  return { width, height, data: out };
}

/** Blend `out` back towards `src` where the mask's alpha is below 1 (the mask input of colour and filter nodes). */
export function masked(out: RGBA, src: RGBA, mask: RGBA | null): RGBA {
  if (!mask) return out;
  const d = out.data;
  const s = src.data;
  const m = mask.data;
  for (let i = 0; i < d.length; i += 4) {
    const k = m[i + 3]!;
    if (k >= 1) continue;
    for (let c = 0; c < 4; c += 1) d[i + c] = s[i + c]! + (d[i + c]! - s[i + c]!) * k;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

export interface GradeParams {
  blackpoint: number;
  whitepoint: number;
  lift: number;
  gain: number;
  multiply: number;
  offset: number;
  gamma: number;
  /** Stops: the multiply is scaled by 2^exposure (Nuke: multiply × 2^exposure, exactly). */
  exposure: number;
  blackClamp: boolean;
  whiteClamp: boolean;
  unpremult: boolean;
}

/** Nuke's Grade on one value: A·x + B with A = multiply·(gain − lift)/(whitepoint − blackpoint), B = offset + lift − A·blackpoint, then ^(1/gamma). */
export function gradeValue(x: number, g: GradeParams): number {
  const mult = g.multiply * 2 ** g.exposure;
  const A = (mult * (g.gain - g.lift)) / (g.whitepoint - g.blackpoint || 1e-9);
  const B = g.offset + g.lift - A * g.blackpoint;
  let v = A * x + B;
  if (g.gamma !== 1 && v > 0) v = v ** (1 / g.gamma);
  if (g.blackClamp && v < 0) v = 0;
  if (g.whiteClamp && v > 1) v = 1;
  return v;
}

function perPixelRgb(img: RGBA, unpremult: boolean, fn: (rgb: Float64Array) => void): RGBA {
  const out = img.data.slice();
  const v = new Float64Array(3);
  for (let i = 0; i < out.length; i += 4) {
    const a = out[i + 3]!;
    const k = unpremult && a !== 0 ? 1 / a : 1;
    v[0] = out[i]! * k;
    v[1] = out[i + 1]! * k;
    v[2] = out[i + 2]! * k;
    fn(v);
    const back = unpremult && a !== 0 ? a : 1;
    out[i] = v[0]! * back;
    out[i + 1] = v[1]! * back;
    out[i + 2] = v[2]! * back;
  }
  return { ...img, data: out };
}

export function grade(img: RGBA, g: GradeParams): RGBA {
  return perPixelRgb(img, g.unpremult, (v) => {
    v[0] = gradeValue(v[0]!, g);
    v[1] = gradeValue(v[1]!, g);
    v[2] = gradeValue(v[2]!, g);
  });
}

const luma709 = (v: Float64Array) => REC709_LUMA[0] * v[0]! + REC709_LUMA[1] * v[1]! + REC709_LUMA[2] * v[2]!;

export function saturate(v: Float64Array, s: number): void {
  if (s === 1) return;
  const L = luma709(v);
  for (let c = 0; c < 3; c += 1) v[c] = L + s * (v[c]! - L);
}

export function saturation(img: RGBA, s: number): RGBA {
  return perPixelRgb(img, false, (v) => saturate(v, s));
}

export interface ColorCorrectParams {
  saturation: number;
  contrast: number;
  gamma: number;
  gain: number;
  offset: number;
  unpremult: boolean;
}

/** Nuke's ColorCorrect master, in its order: saturation, contrast (about 0.18), gamma, gain, offset. */
export function colorCorrectValue(x: number, p: ColorCorrectParams): number {
  let v = x;
  if (p.contrast !== 1 && v > 0) v = (v / 0.18) ** p.contrast * 0.18;
  if (p.gamma !== 1 && v > 0) v = v ** (1 / p.gamma);
  return v * p.gain + p.offset;
}

export function colorCorrect(img: RGBA, p: ColorCorrectParams): RGBA {
  return perPixelRgb(img, p.unpremult, (v) => {
    saturate(v, p.saturation);
    for (let c = 0; c < 3; c += 1) v[c] = colorCorrectValue(v[c]!, p);
  });
}

export function premult(img: RGBA): RGBA {
  const out = img.data.slice();
  for (let i = 0; i < out.length; i += 4) {
    const a = out[i + 3]!;
    out[i] = out[i]! * a;
    out[i + 1] = out[i + 1]! * a;
    out[i + 2] = out[i + 2]! * a;
  }
  return { ...img, data: out };
}

/** Divide colour by alpha where alpha is not 0 (Nuke leaves a = 0 pixels as they are). */
export function unpremult(img: RGBA): RGBA {
  const out = img.data.slice();
  for (let i = 0; i < out.length; i += 4) {
    const a = out[i + 3]!;
    if (a === 0) continue;
    out[i] = out[i]! / a;
    out[i + 1] = out[i + 1]! / a;
    out[i + 2] = out[i + 2]! / a;
  }
  return { ...img, data: out };
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

const CH: Record<string, number> = { r: 0, g: 1, b: 2, a: 3 };

export function shuffle(img: RGBA, map: { r: string; g: string; b: string; a: string }): RGBA {
  const out = new Float32Array(img.data.length);
  const src = img.data;
  const pick = [map.r, map.g, map.b, map.a];
  for (let i = 0; i < out.length; i += 4)
    for (let c = 0; c < 4; c += 1) {
      const s = pick[c]!;
      out[i + c] = s === '0' ? 0 : s === '1' ? 1 : src[i + CH[s]!]!;
    }
  return { ...img, data: out };
}

/** B with one channel replaced by one of A's (Nuke's Copy). */
export function copyChannel(B: RGBA, A: RGBA | null, from: string, to: string): RGBA {
  const out = B.data.slice();
  const f = CH[from]!;
  const t = CH[to]!;
  for (let i = 0; i < out.length; i += 4) out[i + t] = A ? A.data[i + f]! : 0;
  return { ...B, data: out };
}

export function constant(width: number, height: number, color: readonly number[]): RGBA {
  const out = new Float32Array(width * height * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = color[0]!;
    out[i + 1] = color[1]!;
    out[i + 2] = color[2]!;
    out[i + 3] = color[3]!;
  }
  return { width, height, data: out };
}

/** Black outside a box (pixels, y down), feathered inwards by `softness` pixels; the frame size is kept. */
export function crop(img: RGBA, box: { x0: number; y0: number; x1: number; y1: number }, softness: number): RGBA {
  const { width: W, height: H } = img;
  const out = img.data.slice();
  const s = Math.max(1e-6, softness);
  const ramp = (d: number) => (softness <= 0 ? (d >= 0 ? 1 : 0) : Math.max(0, Math.min(1, d / s)));
  for (let y = 0; y < H; y += 1) {
    const cy = y + 0.5;
    const ky = softness <= 0 ? (cy >= box.y0 && cy <= box.y1 ? 1 : 0) : ramp(cy - box.y0) * ramp(box.y1 - cy);
    for (let x = 0; x < W; x += 1) {
      const cx = x + 0.5;
      const kx = softness <= 0 ? (cx >= box.x0 && cx <= box.x1 ? 1 : 0) : ramp(cx - box.x0) * ramp(box.x1 - cx);
      const k = kx * ky;
      if (k >= 1) continue;
      const o = 4 * (y * W + x);
      for (let c = 0; c < 4; c += 1) out[o + c] = out[o + c]! * k;
    }
  }
  return { ...img, data: out };
}

// ---------------------------------------------------------------------------
// Transform, corner pin, track
// ---------------------------------------------------------------------------

export type Mat3 = [number, number, number, number, number, number, number, number, number];

export function mul3(a: readonly number[], b: readonly number[]): Mat3 {
  const o = new Array(9).fill(0) as Mat3;
  for (let r = 0; r < 3; r += 1) for (let c = 0; c < 3; c += 1) o[3 * r + c] = a[3 * r]! * b[c]! + a[3 * r + 1]! * b[3 + c]! + a[3 * r + 2]! * b[6 + c]!;
  return o;
}

export function inv3(m: readonly number[]): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m as Mat3;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const k = 1 / det;
  return [A * k, -(b * i - c * h) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, -(a * f - c * d) * k, C * k, -(a * h - b * g) * k, (a * e - b * d) * k];
}

export function apply3(m: readonly number[], x: number, y: number): [number, number] {
  const w = m[6]! * x + m[7]! * y + m[8]!;
  return [(m[0]! * x + m[1]! * y + m[2]!) / w, (m[3]! * x + m[4]! * y + m[5]!) / w];
}

export interface TransformParams {
  translate: readonly [number, number];
  /** Degrees, counter-clockwise on screen (as Nuke's). */
  rotate: number;
  scale: readonly [number, number];
  /** Pixels (y down). */
  center: readonly [number, number];
  invert: boolean;
}

/**
 * The forward matrix, image pixels y down: about the centre, scale then
 * rotate, then translate. Nuke's rotate is counter-clockwise in its y-up
 * frame, which is −angle in y-down maths.
 */
export function transformMatrix(t: TransformParams): Mat3 {
  const th = (-t.rotate * Math.PI) / 180;
  const c = Math.cos(th);
  const s = Math.sin(th);
  const [cx, cy] = t.center;
  const [sx, sy] = t.scale;
  const [tx, ty] = t.translate;
  // T(c + t) · R · S · T(−c)
  const m: Mat3 = [c * sx, -s * sy, 0, s * sx, c * sy, 0, 0, 0, 1];
  const ox = cx + tx - (m[0] * cx + m[1] * cy);
  const oy = cy + ty - (m[3] * cx + m[4] * cy);
  m[2] = ox;
  m[5] = oy;
  return m;
}

/** Warp by a forward matrix: out(p) = in(M⁻¹ p). */
export function warpMatrix(img: RGBA, forward: readonly number[], filter: Filter): RGBA {
  const inv = inv3(forward);
  if (!inv) return blank(img.width, img.height);
  return warp(
    img,
    (x, y, out) => {
      const w = inv[6] * x + inv[7] * y + inv[8];
      out[0] = (inv[0] * x + inv[1] * y + inv[2]) / w;
      out[1] = (inv[3] * x + inv[4] * y + inv[5]) / w;
    },
    filter,
  );
}

/** The homography taking the four `from` corners onto the four `to` corners (pixels). */
export function cornerPinMatrix(from: readonly (readonly [number, number])[], to: readonly (readonly [number, number])[]): Mat3 | null {
  const h = homographyFromQuads(from, to);
  if (!h) return null;
  const k = h[8] && Math.abs(h[8]) > 1e-12 ? 1 / h[8] : 1;
  return h.map((v) => v * k) as Mat3;
}

/** A tracked frame's points, interpolated between tracked frames, held at the ends; null with nothing usable. */
export function trackPointsAt(t: Track2d, frame: number): [number, number][] | null {
  const fr = t.frames.filter((f) => f.status !== 'lost').sort((a, b) => a.frame - b.frame);
  if (!fr.length) {
    const keys = [...t.keys].sort((a, b) => a.frame - b.frame);
    return keys.length ? keys[0]!.points.map((p) => [p[0], p[1]] as [number, number]) : null;
  }
  const exact = fr.find((f) => f.frame === frame);
  if (exact) return exact.points.map((p) => [p[0], p[1]]);
  if (frame <= fr[0]!.frame) return fr[0]!.points.map((p) => [p[0], p[1]]);
  if (frame >= fr.at(-1)!.frame) return fr.at(-1)!.points.map((p) => [p[0], p[1]]);
  const after = fr.findIndex((f) => f.frame > frame);
  const a = fr[after - 1]!;
  const b = fr[after]!;
  const k = (frame - a.frame) / (b.frame - a.frame);
  return a.points.map((p, i) => [p[0] + (b.points[i]![0] - p[0]) * k, p[1] + (b.points[i]![1] - p[1]) * k]);
}

/** The reference frame of a track node: the given one, else the track's first key (else its first tracked frame). */
export function trackReference(t: Track2d, reference: number): number {
  if (reference > 0) return reference;
  const keys = t.keys.map((k) => k.frame).sort((a, b) => a - b);
  return keys[0] ?? t.frames[0]?.frame ?? 0;
}

/** Tracked points are pixel indices (centre at the integer); the compositor's continuous coordinates put it at +½. */
const centre = (p: readonly number[], scale: number): [number, number] => [(p[0]! + 0.5) * scale, (p[1]! + 0.5) * scale];

/** The corner pin of a planar track on a frame: match-move maps the reference corners to the frame's; stabilise the other way. */
export function trackCornerPin(t: Track2d, frame: number, reference: number, mode: 'matchmove' | 'stabilise', scale: number): Mat3 | null {
  const ref = trackPointsAt(t, trackReference(t, reference));
  const cur = trackPointsAt(t, frame);
  if (!ref || !cur || ref.length < 4 || cur.length < 4) return null;
  const a = ref.map((p) => centre(p, scale));
  const b = cur.map((p) => centre(p, scale));
  return mode === 'matchmove' ? cornerPinMatrix(a, b) : cornerPinMatrix(b, a);
}

/** The translation of a track (a point track's point, a planar track's centre) from the reference frame to `frame`. */
export function trackOffset(t: Track2d, frame: number, reference: number, mode: 'matchmove' | 'stabilise', scale: number): [number, number] | null {
  const ref = trackPointsAt(t, trackReference(t, reference));
  const cur = trackPointsAt(t, frame);
  if (!ref || !cur) return null;
  const mean = (ps: [number, number][]) => [ps.reduce((s, p) => s + p[0], 0) / ps.length, ps.reduce((s, p) => s + p[1], 0) / ps.length];
  const r = mean(t.kind === 'point' ? ref.slice(0, 1) : ref);
  const c = mean(t.kind === 'point' ? cur.slice(0, 1) : cur);
  const d: [number, number] = [(c[0]! - r[0]!) * scale, (c[1]! - r[1]!) * scale];
  return mode === 'matchmove' ? d : [-d[0], -d[1]];
}

// ---------------------------------------------------------------------------
// The Key tab's despill and light wrap, on the comp's pictures
// ---------------------------------------------------------------------------

export function despill(img: RGBA, o: Omit<DespillOptions, 'protect'>, bg: RGBA | null, bgBlurPx: number): RGBA {
  const n = img.width * img.height;
  const rgb = rgbOf(img).data;
  const alpha = new Float32Array(n);
  for (let i = 0; i < n; i += 1) alpha[i] = img.data[4 * i + 3]!;
  const restore = o.restore === 'background' && !bg ? 'neutral' : o.restore;
  const near = restore === 'background' && bg ? backgroundNear(rgbOf(bg), bgBlurPx / 2) : null;
  const { out } = despillRgb(rgb, alpha, { ...o, restore, protect: [] }, near);
  const data = img.data.slice();
  for (let i = 0; i < n; i += 1) {
    if (!(alpha[i]! > 0)) continue; // left as it was (the despill skips them)
    data[4 * i] = out[3 * i]!;
    data[4 * i + 1] = out[3 * i + 1]!;
    data[4 * i + 2] = out[3 * i + 2]!;
  }
  return { ...img, data };
}

/** The foreground plus the light-wrap layer (the background's light just inside its edge); alpha unchanged. */
export function lightWrap(fg: RGBA, bg: RGBA, o: { width: number; intensity: number; lumaWeight: number; luma: readonly [number, number, number] }): RGBA {
  const n = fg.width * fg.height;
  const alpha = new Float32Array(n);
  for (let i = 0; i < n; i += 1) alpha[i] = fg.data[4 * i + 3]!;
  const layer = lightWrapLayer(alpha, rgbOf(bg), o);
  const data = fg.data.slice();
  for (let i = 0; i < n; i += 1) {
    data[4 * i] = data[4 * i]! + layer[3 * i]!;
    data[4 * i + 1] = data[4 * i + 1]! + layer[3 * i + 1]!;
    data[4 * i + 2] = data[4 * i + 2]! + layer[3 * i + 2]!;
  }
  return { ...fg, data };
}
