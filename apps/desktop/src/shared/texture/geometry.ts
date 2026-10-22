import type { TextureCamera } from '@vcvfx/domain';
import { distort, undistort, type Intrinsics } from '../camera/geometry';

/**
 * Directions, frames and lenses for texture extraction (addendum 12 §3).
 *
 * Frames:
 *  - **Canonical**: Y up, right-handed, the scan's units. A Z-up scan is
 *    brought here by (x, y, z) → (x, z, −y); a Y-up scan is used as it is.
 *  - **Panorama**: an equirectangular picture, its centre column the
 *    direction of yaw 0. Yaw turns to the right as the picture's column
 *    increases (as a panorama is seen from inside), pitch is above the
 *    horizon: `dir(yaw, pitch) = (−sin yaw · cos pitch, sin pitch, cos yaw · cos pitch)`.
 *    The panorama's *heading* is the yaw of its centre column in the
 *    canonical frame, so a panorama direction (yaw, pitch) is the canonical
 *    direction (yaw + heading, pitch).
 *  - **Camera** (CV, as the camera tracker): x right, y down, z forward;
 *    R maps canonical → camera.
 */

export type V3 = [number, number, number];

const D2R = Math.PI / 180;
export const deg = (r: number) => r / D2R;
export const rad = (d: number) => d * D2R;

export const dot3 = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
export const sub = (a: ArrayLike<number>, b: ArrayLike<number>): V3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
export const add = (a: ArrayLike<number>, b: ArrayLike<number>): V3 => [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
export const scale = (a: ArrayLike<number>, k: number): V3 => [a[0]! * k, a[1]! * k, a[2]! * k];
export const cross = (a: ArrayLike<number>, b: ArrayLike<number>): V3 => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
export const len = (a: ArrayLike<number>) => Math.hypot(a[0]!, a[1]!, a[2]!);
export const unit = (a: ArrayLike<number>): V3 => {
  const l = len(a) || 1;
  return [a[0]! / l, a[1]! / l, a[2]! / l];
};

/** The direction of (yaw, pitch), degrees, in the frame they are measured in. */
export function dirOf(yawDeg: number, pitchDeg: number): V3 {
  const y = rad(yawDeg);
  const p = rad(pitchDeg);
  return [-Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)];
}

/** Yaw and pitch, degrees, of a direction. */
export function yawPitchOf(d: ArrayLike<number>): { yaw: number; pitch: number } {
  const u = unit(d);
  return { yaw: deg(Math.atan2(-u[0], u[2])), pitch: deg(Math.asin(Math.max(-1, Math.min(1, u[1])))) };
}

export const wrapDeg = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;
/** The angle between two directions, degrees. */
export const angleBetween = (a: ArrayLike<number>, b: ArrayLike<number>) => deg(Math.acos(Math.max(-1, Math.min(1, dot3(unit(a), unit(b))))));

/**
 * A camera looking along (yaw, pitch) with a roll, in the frame they are
 * measured in: the rotation R (row-major, frame → camera: rows right, down,
 * forward).
 */
export function cameraRotation(yawDeg: number, pitchDeg: number, rollDeg = 0): number[] {
  const f = dirOf(yawDeg, pitchDeg);
  const r0 = dirOf(yawDeg + 90, 0);
  const up0 = cross(r0, f);
  const c = Math.cos(rad(rollDeg));
  const s = Math.sin(rad(rollDeg));
  // Roll turns the picture clockwise as seen by the camera: right goes down.
  const right: V3 = [r0[0] * c - up0[0] * s, r0[1] * c - up0[1] * s, r0[2] * c - up0[2] * s];
  const up: V3 = [up0[0] * c + r0[0] * s, up0[1] * c + r0[1] * s, up0[2] * c + r0[2] * s];
  return [...right, -up[0], -up[1], -up[2], ...f];
}

/** Yaw, pitch and roll of a camera rotation (frame → camera), degrees. */
export function anglesOf(R: ArrayLike<number>): { yaw: number; pitch: number; roll: number } {
  const f = [R[6]!, R[7]!, R[8]!];
  const { yaw, pitch } = yawPitchOf(f);
  const r0 = dirOf(yaw + 90, 0);
  const up0 = cross(r0, unit(f));
  const right = [R[0]!, R[1]!, R[2]!];
  return { yaw, pitch, roll: deg(Math.atan2(-dot3(right, up0), dot3(right, r0))) };
}

/** Rotate a vector by a row-major 3×3 (or its transpose). */
export const rot = (R: ArrayLike<number>, v: ArrayLike<number>): V3 => [R[0]! * v[0]! + R[1]! * v[1]! + R[2]! * v[2]!, R[3]! * v[0]! + R[4]! * v[1]! + R[5]! * v[2]!, R[6]! * v[0]! + R[7]! * v[1]! + R[8]! * v[2]!];
export const rotT = (R: ArrayLike<number>, v: ArrayLike<number>): V3 => [R[0]! * v[0]! + R[3]! * v[1]! + R[6]! * v[2]!, R[1]! * v[0]! + R[4]! * v[1]! + R[7]! * v[2]!, R[2]! * v[0]! + R[5]! * v[1]! + R[8]! * v[2]!];

/** Scan coordinates → canonical (Y up), and back. */
export function toCanonical(p: ArrayLike<number>, up: 'y' | 'z'): V3 {
  return up === 'z' ? [p[0]!, p[2]!, -p[1]!] : [p[0]!, p[1]!, p[2]!];
}
export function fromCanonical(p: ArrayLike<number>, up: 'y' | 'z'): V3 {
  return up === 'z' ? [p[0]!, -p[2]!, p[1]!] : [p[0]!, p[1]!, p[2]!];
}

// ---------------------------------------------------------------------------
// Equirectangular panoramas
// ---------------------------------------------------------------------------

/** Panorama pixel (centres at integers) of a panorama-frame direction. */
export function equirectPixel(d: ArrayLike<number>, width: number, height: number): [number, number] {
  const { yaw, pitch } = yawPitchOf(d);
  return [((yaw / 360 + 0.5) * width) - 0.5, ((0.5 - pitch / 180) * height) - 0.5];
}

/** Panorama-frame direction of a panorama pixel. */
export function equirectDir(u: number, v: number, width: number, height: number): V3 {
  return dirOf(((u + 0.5) / width - 0.5) * 360, (0.5 - (v + 0.5) / height) * 180);
}

// ---------------------------------------------------------------------------
// Lenses
// ---------------------------------------------------------------------------

/**
 * The intrinsics of a photograph from its camera record, at a given picture
 * width: the focal length in pixels from millimetres and the film back (null
 * when either is unknown), the principal point at the centre, the distortion
 * when known. Resolution independent (normalised coordinates), so a photo
 * read smaller keeps its lens.
 */
export function photoIntrinsics(camera: TextureCamera | null | undefined, width: number, height: number, fallbackFovDeg: number | null = null): Intrinsics | null {
  let f: number | null = null;
  if (camera?.focalMm && camera.filmBackWidthMm) f = (camera.focalMm / camera.filmBackWidthMm) * width;
  else if (fallbackFovDeg) f = width / 2 / Math.tan(rad(fallbackFovDeg) / 2);
  if (!f) return null;
  const k = camera?.distortion ?? { k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 };
  return { f, cx: (width - 1) / 2, cy: (height - 1) / 2, k1: k.k1, k2: k.k2, k3: k.k3, p1: k.p1, p2: k.p2 };
}

/** Horizontal field of view of intrinsics, degrees. */
export const fovOf = (k: Intrinsics, width: number) => deg(2 * Math.atan(width / 2 / k.f));

/** A distorted photo pixel → the undistorted (ideal pinhole) pixel of the same intrinsics. */
export function undistortPixel(k: Intrinsics, u: number, v: number): [number, number] {
  const [x, y] = undistort(k, (u - k.cx) / k.f, (v - k.cy) / k.f);
  return [k.f * x + k.cx, k.f * y + k.cy];
}

/** An undistorted pixel → where it is in the distorted photo. */
export function distortPixel(k: Intrinsics, u: number, v: number): [number, number] {
  const [x, y] = distort(k, (u - k.cx) / k.f, (v - k.cy) / k.f);
  return [k.f * x + k.cx, k.f * y + k.cy];
}

/** The undistorted camera ray (z = 1) through a photo pixel. */
export function pixelRay(k: Intrinsics, u: number, v: number): V3 {
  const [x, y] = undistort(k, (u - k.cx) / k.f, (v - k.cy) / k.f);
  return [x, y, 1];
}
