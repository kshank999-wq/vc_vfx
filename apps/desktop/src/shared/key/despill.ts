import type { DespillLimit, DespillRestore, ScreenKind } from '@vcvfx/domain';

/**
 * Despill (master spec §7; addendum 09 §3.6), on the premultiplied
 * foreground in linear light.
 *
 * The screen channel is limited to a combination of the other two (green ≤
 * the average, max, min or a weighted mix of red and blue; blue likewise of
 * red and green). The limit is homogeneous, so it works the same on
 * premultiplied values. What was removed is put back as luminance, so the
 * subject is not darkened:
 *  - background: in the colour of the background near that pixel (a blurred
 *    background plate or representative frame) — the spill is replaced by
 *    the destination's light, not by grey;
 *  - neutral: as grey;
 *  - none: not put back.
 * Legitimate foreground colours are protected: listed hues (a green prop)
 * are left alone, and skin — which an aggressive limit would turn grey — is
 * never limited harder than the average.
 */

export interface DespillOptions {
  kind: ScreenKind;
  limit: DespillLimit;
  weight: number;
  strength: number;
  restore: DespillRestore;
  restoreAmount: number;
  protectSkin: boolean;
  protect: readonly { rgb: readonly [number, number, number]; hueTolerance: number }[];
  luma: readonly [number, number, number];
}

/** HSV hue in degrees (0 red, 120 green, 240 blue) and saturation, of a non-negative colour. */
export function hueSat(r: number, g: number, b: number): [number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (!(max > 0) || d <= 0) return [0, 0];
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, d / max];
}

const hueDistance = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/** How much a colour is skin: hue 5…45° (peak ≈ 22°), saturation 0.12…0.75. */
export function skinWeight(r: number, g: number, b: number): number {
  const [h, s] = hueSat(r, g, b);
  if (s < 0.08 || s > 0.85) return 0;
  const hw = Math.max(0, 1 - Math.max(0, hueDistance(h, 22) - 16) / 12);
  const sw = s < 0.12 ? (s - 0.08) / 0.04 : s > 0.75 ? (0.85 - s) / 0.1 : 1;
  return Math.max(0, Math.min(1, hw * sw));
}

/** How much a colour is one of the protected hues: 1 within the tolerance, falling to 0 at 1.5×. */
export function protectWeight(r: number, g: number, b: number, protect: DespillOptions['protect']): number {
  if (!protect.length) return 0;
  const [h, s] = hueSat(r, g, b);
  if (s < 0.06) return 0;
  let w = 0;
  for (const p of protect) {
    const [ph] = hueSat(p.rgb[0], p.rgb[1], p.rgb[2]);
    const d = hueDistance(h, ph);
    const t = p.hueTolerance;
    w = Math.max(w, d <= t ? 1 : d >= 1.5 * t ? 0 : 1 - (d - t) / (0.5 * t));
  }
  return w;
}

/**
 * Despill a premultiplied foreground. `bgNear` is the background's colour near
 * each pixel (interleaved RGB at the same size), or null. Returns the
 * despilled foreground and the amount removed per pixel (for review).
 */
export function despill(fg: Float32Array, alpha: Float32Array, o: DespillOptions, bgNear: Float32Array | null): { out: Float32Array; spill: Float32Array } {
  const n = alpha.length;
  const out = new Float32Array(n * 3);
  const spillOut = new Float32Array(n);
  const s = o.kind === 'green' ? 1 : 2;
  const c = o.kind === 'green' ? 2 : 1;
  const [lr, lg, lb] = o.luma;
  const lumS = s === 1 ? lg : lb;
  for (let i = 0; i < n; i += 1) {
    const a = alpha[i]!;
    const R = fg[3 * i]!;
    const G = fg[3 * i + 1]!;
    const B = fg[3 * i + 2]!;
    if (!(a > 0)) continue;
    const sv = s === 1 ? G : B;
    const other = c === 2 ? B : G;
    const avg = 0.5 * (R + other);
    const limit = o.limit === 'average' ? avg : o.limit === 'max' ? Math.max(R, other) : o.limit === 'min' ? Math.min(R, other) : o.weight * R + (1 - o.weight) * other;
    let spill = Math.max(0, sv - limit);
    if (spill > 0) {
      if (o.protectSkin && o.limit !== 'average') {
        // Judge skin on the colour as a gentle (average) despill would leave it.
        const sAvg = Math.min(sv, avg);
        const w = s === 1 ? skinWeight(R, sAvg, B) : skinWeight(R, G, sAvg);
        spill += w * (Math.max(0, sv - avg) - spill);
      }
      spill *= 1 - protectWeight(R, G, B, o.protect);
      spill *= o.strength;
    }
    let r = R;
    let g = G;
    let b = B;
    if (s === 1) g -= spill;
    else b -= spill;
    if (spill > 0 && o.restore !== 'none' && o.restoreAmount > 0) {
      const lum = lumS * spill * o.restoreAmount;
      let cr = 1;
      let cg = 1;
      let cb = 1;
      if (o.restore === 'background' && bgNear) {
        const br = Math.max(0, bgNear[3 * i]!);
        const bg = Math.max(0, bgNear[3 * i + 1]!);
        const bb = Math.max(0, bgNear[3 * i + 2]!);
        const bl = lr * br + lg * bg + lb * bb;
        if (bl > 1e-5) {
          cr = Math.min(6, br / bl);
          cg = Math.min(6, bg / bl);
          cb = Math.min(6, bb / bl);
        }
      }
      r += lum * cr;
      g += lum * cg;
      b += lum * cb;
    }
    out[3 * i] = r;
    out[3 * i + 1] = g;
    out[3 * i + 2] = b;
    spillOut[i] = spill;
  }
  return { out, spill: spillOut };
}
