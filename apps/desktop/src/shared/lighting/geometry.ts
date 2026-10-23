import type { Range } from '@vcvfx/domain';

/**
 * Directions, cameras and ranges for the lighting analysis (addendum 14 §2).
 *
 * Camera coordinates are the graphics convention the camera track exports
 * use: x right, y up, z towards the camera (the camera looks down −z). A
 * light's direction is the unit vector from the subject towards the light;
 * its azimuth is measured from +z (the camera's side) towards +x (frame
 * right), its elevation up from the camera's horizontal plane:
 *
 *   L = (sin az · cos el, sin el, cos az · cos el)
 *
 * Image pixels: x right, y down, pixel centres at +½.
 */

export type V3 = [number, number, number];

export const DEG = Math.PI / 180;
export const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
export const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
export const add = (a: readonly number[], b: readonly number[]): V3 => [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
export const scale = (a: readonly number[], k: number): V3 => [a[0]! * k, a[1]! * k, a[2]! * k];
export const len = (a: readonly number[]) => Math.hypot(a[0]!, a[1]!, a[2]!);
export const norm = (a: readonly number[]): V3 => {
  const l = len(a) || 1;
  return [a[0]! / l, a[1]! / l, a[2]! / l];
};
export const cross = (a: readonly number[], b: readonly number[]): V3 => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];

/** Unit direction towards a light from azimuth and elevation (degrees). */
export function dirOf(azDeg: number, elDeg: number): V3 {
  const a = azDeg * DEG;
  const e = elDeg * DEG;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
}

/** Azimuth and elevation (degrees) of a direction. */
export function azElOf(d: readonly number[]): { az: number; el: number } {
  const n = norm(d);
  return { az: Math.atan2(n[0], n[2]) / DEG, el: Math.asin(Math.max(-1, Math.min(1, n[1]))) / DEG };
}

/** Angle between two directions, degrees. */
export function angleBetween(a: readonly number[], b: readonly number[]): number {
  return Math.acos(Math.max(-1, Math.min(1, dot(norm(a), norm(b))))) / DEG;
}

/** Signed difference of two azimuths, −180 … 180. */
export function azDiff(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

export const wrap180 = (a: number) => azDiff(a, 0);

/** A range around a value with half-width `half` (clamped). */
export function rangeOf(value: number, half: number, min = -Infinity, max = Infinity): Range {
  const v = Math.max(min, Math.min(max, value));
  return { value: v, low: Math.max(min, v - half), high: Math.min(max, v + half) };
}

/** An azimuth range (it may cross ±180: low and high are then outside −180 … 180, value inside). */
export function azRange(value: number, half: number): Range {
  const v = wrap180(value);
  const h = Math.min(180, Math.max(0, half));
  return { value: v, low: v - h, high: v + h };
}

/** Is an azimuth inside an azimuth range (wrap-aware)? */
export function inAzRange(r: Range, az: number): boolean {
  const d = azDiff(az, r.value);
  return d >= r.low - r.value - 1e-9 && d <= r.high - r.value + 1e-9;
}

export function inRange(r: Range, v: number): boolean {
  return v >= r.low - 1e-9 && v <= r.high + 1e-9;
}

/** The smallest range holding all values (azimuths with `wrap`). */
export function hullRange(values: number[], centre: number, wrap = false): Range {
  if (!wrap) return { value: centre, low: Math.min(centre, ...values), high: Math.max(centre, ...values) };
  const ds = values.map((v) => azDiff(v, centre));
  return { value: wrap180(centre), low: wrap180(centre) + Math.min(0, ...ds), high: wrap180(centre) + Math.max(0, ...ds) };
}

/** Weighted circular mean of azimuths (degrees). */
export function circularMean(values: readonly number[], weights?: readonly number[]): number {
  let s = 0;
  let c = 0;
  values.forEach((v, i) => {
    const w = weights?.[i] ?? 1;
    s += w * Math.sin(v * DEG);
    c += w * Math.cos(v * DEG);
  });
  return Math.atan2(s, c) / DEG;
}

export function percentile(values: ArrayLike<number>, p: number): number {
  const a = Array.from(values).filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const i = Math.max(0, Math.min(a.length - 1, (a.length - 1) * p));
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return a[lo]! + (a[hi]! - a[lo]!) * (i - lo);
}

export const median = (values: ArrayLike<number>) => percentile(values, 0.5);

export function stddev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1));
}

/** A small deterministic random generator (mulberry32), so analyses are reproducible from source + settings (§19). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The pinhole camera of the analysed frame, at the analysis size: focal
 * length in pixels, principal point, and its tilt: pitch (up positive) and
 * roll about the view axis, degrees, relative to the world's horizontal.
 */
export interface PinholeCamera {
  width: number;
  height: number;
  focalPx: number;
  cx: number;
  cy: number;
  pitchDeg: number;
  rollDeg: number;
}

export function pinhole(width: number, height: number, focalPx: number, pitchDeg = 0, rollDeg = 0): PinholeCamera {
  return { width, height, focalPx, cx: width / 2, cy: height / 2, pitchDeg, rollDeg };
}

/** Camera → level frame (the camera's yaw kept, its pitch and roll taken out): v_level = R · v_camera. */
export function levelRotation(cam: Pick<PinholeCamera, 'pitchDeg' | 'rollDeg'>): number[] {
  const p = cam.pitchDeg * DEG;
  const r = cam.rollDeg * DEG;
  // Roll about z, then pitch about x.
  const Rz = [Math.cos(r), -Math.sin(r), 0, Math.sin(r), Math.cos(r), 0, 0, 0, 1];
  const Rx = [1, 0, 0, 0, Math.cos(p), -Math.sin(p), 0, Math.sin(p), Math.cos(p)];
  return mul3(Rx, Rz);
}

export function mul3(a: readonly number[], b: readonly number[]): number[] {
  const o = new Array<number>(9);
  for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) o[3 * i + j] = a[3 * i]! * b[j]! + a[3 * i + 1]! * b[3 + j]! + a[3 * i + 2]! * b[6 + j]!;
  return o;
}
export function mulv(m: readonly number[], v: readonly number[]): V3 {
  return [m[0]! * v[0]! + m[1]! * v[1]! + m[2]! * v[2]!, m[3]! * v[0]! + m[4]! * v[1]! + m[5]! * v[2]!, m[6]! * v[0]! + m[7]! * v[1]! + m[8]! * v[2]!];
}
export function transpose3(m: readonly number[]): number[] {
  return [m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!];
}

/** The ray through a pixel, in camera coordinates (unit). */
export function rayOf(cam: PinholeCamera, x: number, y: number): V3 {
  return norm([(x - cam.cx) / cam.focalPx, -(y - cam.cy) / cam.focalPx, -1]);
}

/** Where a camera-space point lands in the image. */
export function project(cam: PinholeCamera, p: readonly number[]): { x: number; y: number } | null {
  if (p[2]! >= -1e-9) return null;
  return { x: cam.cx + (cam.focalPx * p[0]!) / -p[2]!, y: cam.cy - (cam.focalPx * p[1]!) / -p[2]! };
}

/**
 * The ground: a horizontal plane `heightM` below the camera. A pixel's ray
 * meets it at a point in the level frame (x right, y up, z back), or null
 * above the horizon.
 */
export interface Ground {
  heightM: number;
}

export function groundPoint(cam: PinholeCamera, ground: Ground, x: number, y: number): V3 | null {
  const d = mulv(levelRotation(cam), rayOf(cam, x, y));
  if (d[1] >= -1e-6) return null;
  const t = ground.heightM / -d[1];
  return [d[0] * t, -ground.heightM, d[2] * t];
}

/** A level-frame point → image. */
export function projectLevel(cam: PinholeCamera, p: readonly number[]): { x: number; y: number } | null {
  return project(cam, mulv(transpose3(levelRotation(cam)), p));
}

/** A direction in the level frame → the camera frame. */
export const levelToCamera = (cam: Pick<PinholeCamera, 'pitchDeg' | 'rollDeg'>, d: readonly number[]) => mulv(transpose3(levelRotation(cam)), d);
export const cameraToLevel = (cam: Pick<PinholeCamera, 'pitchDeg' | 'rollDeg'>, d: readonly number[]) => mulv(levelRotation(cam), d);

/** Bilinear sample of a single-channel image (clamped at the edges); pixel centres at +½. */
export function sample1(data: ArrayLike<number>, w: number, h: number, x: number, y: number): number {
  const fx = Math.max(0, Math.min(w - 1, x - 0.5));
  const fy = Math.max(0, Math.min(h - 1, y - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const a = data[y0 * w + x0]! * (1 - tx) + data[y0 * w + x1]! * tx;
  const b = data[y1 * w + x0]! * (1 - tx) + data[y1 * w + x1]! * tx;
  return a * (1 - ty) + b * ty;
}

/** Solve a small symmetric linear system (Gaussian elimination with partial pivoting); null when singular. */
export function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c += 1) {
    let p = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    if (Math.abs(M[p]![c]!) < 1e-12) return null;
    [M[c], M[p]] = [M[p]!, M[c]!];
    for (let r = 0; r < n; r += 1) {
      if (r === c) continue;
      const f = M[r]![c]! / M[c]![c]!;
      for (let k = c; k <= n; k += 1) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  return M.map((row, i) => row[n]! / row[i]!);
}

/**
 * A ball's circle marked on the plate (stored pixels; r measured vertically)
 * → the analysis frame, which is the plate de-squeezed to `size` (addendum
 * 17): x and y scale apart, and the ball is round there.
 */
export function plateCircleToAnalysis(circle: { cx: number; cy: number; r: number }, plate: { width: number; height: number }, size: { width: number; height: number }): { cx: number; cy: number; r: number } {
  const kx = size.width / plate.width;
  const ky = size.height / plate.height;
  return { cx: circle.cx * kx, cy: circle.cy * ky, r: circle.r * ky };
}
