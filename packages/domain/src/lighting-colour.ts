import { GAMUTS, apply3, invert3, rgbToXyz, type GamutId, type Matrix3 } from './color.js';

/**
 * Colour temperature for the lighting analysis (addendum 14 §3.6): the
 * Planckian locus (Kim et al. 2002, 1667–25 000 K), its inverse by search in
 * mired (so a temperature turned into a colour and back is exact), the light
 * colour of a temperature in a working gamut, and the camera white balance
 * modelled as a per-channel scale in that gamut (von Kries in the working
 * RGB: a light at the white-balance temperature renders neutral).
 */

const clampK = (k: number) => Math.max(1667, Math.min(25000, k));

/** CIE 1931 xy of a blackbody at `kelvin`. */
export function planckianXy(kelvin: number): [number, number] {
  const T = clampK(kelvin);
  const t = 1e3 / T;
  const x = T <= 4000 ? -0.2661239 * t ** 3 - 0.2343589 * t ** 2 + 0.8776956 * t + 0.17991 : -3.0258469 * t ** 3 + 2.1070379 * t ** 2 + 0.2226347 * t + 0.24039;
  const y = T <= 2222 ? -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683 : T <= 4000 ? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867 : 3.081758 * x ** 3 - 5.8733867 * x ** 2 + 3.75112997 * x - 0.37001483;
  return [x, y];
}

const uv = (x: number, y: number): [number, number] => {
  const d = -2 * x + 12 * y + 3;
  return [(4 * x) / d, (6 * y) / d];
};

/** The correlated colour temperature of xy and its distance from the locus (Duv, CIE 1960; positive above it, greener). */
export function cctOfXy(x: number, y: number): { kelvin: number; duv: number } {
  const [u, v] = uv(x, y);
  const dist = (mired: number) => {
    const [px, py] = planckianXy(1e6 / mired);
    const [pu, pv] = uv(px, py);
    return Math.hypot(u - pu, v - pv);
  };
  // Coarse scan in mired (40 … 600, i.e. 25 000 … 1667 K), then golden-section refinement.
  let best = 40;
  let bestD = Infinity;
  for (let m = 40; m <= 600; m += 4) {
    const d = dist(m);
    if (d < bestD) (bestD = d), (best = m);
  }
  let a = Math.max(40, best - 4);
  let b = Math.min(600, best + 4);
  const g = (Math.sqrt(5) - 1) / 2;
  for (let i = 0; i < 40; i += 1) {
    const c = b - g * (b - a);
    const d = a + g * (b - a);
    if (dist(c) < dist(d)) b = d;
    else a = c;
  }
  const mired = (a + b) / 2;
  const [px, py] = planckianXy(1e6 / mired);
  const [pu, pv] = uv(px, py);
  const sign = v - pv >= 0 ? 1 : -1;
  return { kelvin: 1e6 / mired, duv: sign * Math.hypot(u - pu, v - pv) };
}

const xyzToRgbCache = new Map<GamutId, Matrix3>();
function xyzToRgb(gamut: GamutId): Matrix3 {
  let m = xyzToRgbCache.get(gamut);
  if (!m) xyzToRgbCache.set(gamut, (m = invert3(rgbToXyz(GAMUTS[gamut]))));
  return m;
}

const normalise = (c: readonly number[]): [number, number, number] => {
  const k = Math.max(c[0]!, c[1]!, c[2]!, 1e-12);
  return [Math.max(0, c[0]! / k), Math.max(0, c[1]! / k), Math.max(0, c[2]! / k)];
};

/** The linear colour of a blackbody at `kelvin` in a working gamut, largest channel 1. */
export function kelvinRgb(kelvin: number, gamut: GamutId = 'ap1'): [number, number, number] {
  const [x, y] = planckianXy(kelvin);
  return normalise(apply3(xyzToRgb(gamut), [x / y, 1, (1 - x - y) / y]));
}

/** xy of a linear colour in a working gamut. */
export function rgbXy(rgb: readonly [number, number, number], gamut: GamutId = 'ap1'): [number, number] {
  const [X, Y, Z] = apply3(rgbToXyz(GAMUTS[gamut]), [Math.max(0, rgb[0]), Math.max(0, rgb[1]), Math.max(0, rgb[2])]);
  const s = X + Y + Z;
  return s > 1e-12 ? [X / s, Y / s] : [0.3127, 0.329];
}

/**
 * How a light of colour `light` appears in a picture white-balanced for
 * `whiteBalanceK` (null: not balanced — the working space's own white).
 */
export function balancedRgb(light: readonly [number, number, number], whiteBalanceK: number | null, gamut: GamutId = 'ap1'): [number, number, number] {
  if (whiteBalanceK === null) return normalise(light);
  const w = kelvinRgb(whiteBalanceK, gamut);
  return normalise([light[0] / w[0], light[1] / w[1], light[2] / w[2]]);
}

/** The light's own colour from how it appears in a picture balanced for `whiteBalanceK` (the inverse of `balancedRgb`). */
export function unbalancedRgb(seen: readonly [number, number, number], whiteBalanceK: number | null, gamut: GamutId = 'ap1'): [number, number, number] {
  if (whiteBalanceK === null) return normalise(seen);
  const w = kelvinRgb(whiteBalanceK, gamut);
  return normalise([seen[0] * w[0], seen[1] * w[1], seen[2] * w[2]]);
}

/** The colour temperature (and Duv) of a light seen as `seen` in a picture balanced for `whiteBalanceK`. */
export function temperatureOf(seen: readonly [number, number, number], whiteBalanceK: number | null, gamut: GamutId = 'ap1'): { kelvin: number; duv: number; rgb: [number, number, number] } {
  const rgb = unbalancedRgb(seen, whiteBalanceK, gamut);
  const [x, y] = rgbXy(rgb, gamut);
  return { ...cctOfXy(x, y), rgb };
}

/** Kelvin ↔ mired (a perceptually even scale: ranges are symmetric in mired). */
export const mired = (kelvin: number) => 1e6 / kelvin;
export const kelvinOfMired = (m: number) => 1e6 / m;

/** A temperature range ± `miredSpread` around `kelvin`, in kelvin (asymmetric: wider on the blue side). */
export function kelvinRange(kelvin: number, miredSpread: number): { value: number; low: number; high: number } {
  const m = mired(kelvin);
  const low = Math.max(1000, kelvinOfMired(m + miredSpread));
  const high = Math.min(40000, m - miredSpread > 25 ? kelvinOfMired(m - miredSpread) : 40000);
  const value = Math.max(1000, Math.min(40000, kelvin));
  return { value, low: Math.min(low, value), high: Math.max(high, value) };
}
