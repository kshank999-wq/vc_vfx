import { cross, det3, mul3, mulv3, nearestRotation, norm3, t3 } from './linalg';

/**
 * Camera geometry for the solver and the exporters (addendum 06).
 *
 * Conventions, used everywhere in `shared/camera`:
 *  - Image: pixel index coordinates — the centre of pixel (i, j) is at
 *    (x = i, y = j); x right, y down. The principal point of a centred lens is
 *    ((W − 1)/2, (H − 1)/2).
 *  - Camera ("computer vision"): x right, y down, z forward (OpenCV). A world
 *    point X is seen at Xc = R·X + t; the camera centre is C = −Rᵀt.
 *  - Lens: pinhole with a focal length f in pixels, a pixel aspect a (the
 *    stored pixel's width over its height: 1 square, 2 for a 2× anamorphic
 *    plate kept squeezed; addendum 17), and Brown–Conrady distortion on
 *    normalised coordinates (x, y) = (Xc/Zc, Yc/Zc):
 *      r² = x² + y²,  radial = 1 + k1 r² + k2 r⁴ + k3 r⁶
 *      xd = x·radial + 2 p1 x y + p2 (r² + 2x²)
 *      yd = y·radial + p1 (r² + 2y²) + 2 p2 x y
 *      u = (f / a)·xd + cx,  v = f·yd + cy
 *    — OpenCV's model with fx = f / a, fy = f. f is the vertical focal in
 *    plate pixels, which is the focal in de-squeezed (physical, square)
 *    pixels; the distortion acts on physical coordinates, the 3DEqualizer /
 *    Nuke anamorphic convention. Exports carry it as numbers and as STMaps.
 */

export interface Intrinsics {
  /** Focal length in pixels. */
  f: number;
  cx: number;
  cy: number;
  k1: number;
  k2: number;
  k3: number;
  p1: number;
  p2: number;
  /** Pixel aspect (stored pixel width / height); absent = 1. fx = f / a. */
  a?: number;
}

/** The intrinsics' pixel aspect (1 when not set). */
export const aspectOf = (k: Pick<Intrinsics, 'a'>): number => k.a ?? 1;

export const pinhole = (f: number, width: number, height: number): Intrinsics => ({ f, cx: (width - 1) / 2, cy: (height - 1) / 2, k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 });

export const hasDistortion = (k: Intrinsics): boolean => k.k1 !== 0 || k.k2 !== 0 || k.k3 !== 0 || k.p1 !== 0 || k.p2 !== 0;

/** Distort normalised coordinates. */
export function distort(k: Intrinsics, x: number, y: number): [number, number] {
  const r2 = x * x + y * y;
  const radial = 1 + r2 * (k.k1 + r2 * (k.k2 + r2 * k.k3));
  return [x * radial + 2 * k.p1 * x * y + k.p2 * (r2 + 2 * x * x), y * radial + k.p1 * (r2 + 2 * y * y) + 2 * k.p2 * x * y];
}

/** Undistort normalised coordinates (Newton iterations on the forward model). */
export function undistort(k: Intrinsics, xd: number, yd: number): [number, number] {
  if (!hasDistortion(k)) return [xd, yd];
  let x = xd;
  let y = yd;
  for (let it = 0; it < 20; it += 1) {
    const r2 = x * x + y * y;
    const radial = 1 + r2 * (k.k1 + r2 * (k.k2 + r2 * k.k3));
    const dradial = k.k1 + r2 * (2 * k.k2 + 3 * r2 * k.k3); // d radial / d r²
    const fx = x * radial + 2 * k.p1 * x * y + k.p2 * (r2 + 2 * x * x) - xd;
    const fy = y * radial + k.p1 * (r2 + 2 * y * y) + 2 * k.p2 * x * y - yd;
    // Jacobian of the forward model.
    const j11 = radial + 2 * x * x * dradial + 2 * k.p1 * y + 6 * k.p2 * x;
    const j12 = 2 * x * y * dradial + 2 * k.p1 * x + 2 * k.p2 * y;
    const j21 = 2 * x * y * dradial + 2 * k.p1 * x + 2 * k.p2 * y;
    const j22 = radial + 2 * y * y * dradial + 6 * k.p1 * y + 2 * k.p2 * x;
    const det = j11 * j22 - j12 * j21;
    if (Math.abs(det) < 1e-12) break;
    const dx = (j22 * fx - j12 * fy) / det;
    const dy = (j11 * fy - j21 * fx) / det;
    x -= dx;
    y -= dy;
    if (dx * dx + dy * dy < 1e-24) break;
  }
  return [x, y];
}

/** Pixel → undistorted normalised coordinates. */
export function pixelToRay(k: Intrinsics, u: number, v: number): [number, number] {
  return undistort(k, ((u - k.cx) * aspectOf(k)) / k.f, (v - k.cy) / k.f);
}

/** Undistorted normalised coordinates → pixel. */
export function rayToPixel(k: Intrinsics, x: number, y: number): [number, number] {
  const [xd, yd] = distort(k, x, y);
  return [(k.f * xd) / aspectOf(k) + k.cx, k.f * yd + k.cy];
}

/** Project a world point; null behind the camera. */
export function project(k: Intrinsics, R: ArrayLike<number>, t: ArrayLike<number>, X: ArrayLike<number>): [number, number] | null {
  const xc = R[0]! * X[0]! + R[1]! * X[1]! + R[2]! * X[2]! + t[0]!;
  const yc = R[3]! * X[0]! + R[4]! * X[1]! + R[5]! * X[2]! + t[1]!;
  const zc = R[6]! * X[0]! + R[7]! * X[1]! + R[8]! * X[2]! + t[2]!;
  if (zc <= 1e-9) return null;
  return rayToPixel(k, xc / zc, yc / zc);
}

// ---------------------------------------------------------------------------
// Rotations
// ---------------------------------------------------------------------------

/** Rotation matrix from an axis-angle vector (Rodrigues). */
export function rodrigues(w: ArrayLike<number>): number[] {
  const theta = Math.hypot(w[0]!, w[1]!, w[2]!);
  if (theta < 1e-12) {
    // First order: I + [w]×
    return [1, -w[2]!, w[1]!, w[2]!, 1, -w[0]!, -w[1]!, w[0]!, 1];
  }
  const kx = w[0]! / theta;
  const ky = w[1]! / theta;
  const kz = w[2]! / theta;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const v = 1 - c;
  return [
    c + kx * kx * v, kx * ky * v - kz * s, kx * kz * v + ky * s,
    ky * kx * v + kz * s, c + ky * ky * v, ky * kz * v - kx * s,
    kz * kx * v - ky * s, kz * ky * v + kx * s, c + kz * kz * v,
  ];
}

/** Axis-angle vector of a rotation matrix. */
export function logRotation(R: ArrayLike<number>): [number, number, number] {
  const tr = R[0]! + R[4]! + R[8]!;
  const c = Math.max(-1, Math.min(1, (tr - 1) / 2));
  const theta = Math.acos(c);
  if (theta < 1e-9) return [(R[7]! - R[5]!) / 2, (R[2]! - R[6]!) / 2, (R[3]! - R[1]!) / 2];
  if (Math.PI - theta < 1e-6) {
    // Near π: from the symmetric part.
    const xx = Math.sqrt(Math.max(0, (R[0]! + 1) / 2));
    const yy = Math.sqrt(Math.max(0, (R[4]! + 1) / 2));
    const zz = Math.sqrt(Math.max(0, (R[8]! + 1) / 2));
    let axis: number[];
    if (xx >= yy && xx >= zz) axis = [xx, R[1]! / (2 * xx), R[2]! / (2 * xx)];
    else if (yy >= zz) axis = [R[1]! / (2 * yy), yy, R[5]! / (2 * yy)];
    else axis = [R[2]! / (2 * zz), R[5]! / (2 * zz), zz];
    const n = norm3(axis);
    return [(axis[0]! / n) * theta, (axis[1]! / n) * theta, (axis[2]! / n) * theta];
  }
  const k = theta / (2 * Math.sin(theta));
  return [(R[7]! - R[5]!) * k, (R[2]! - R[6]!) * k, (R[3]! - R[1]!) * k];
}

/** Angle between two rotations, radians. */
export function rotationDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const d = mul3(a, t3(b));
  return Math.acos(Math.max(-1, Math.min(1, (d[0]! + d[4]! + d[8]! - 1) / 2)));
}

export type Quat = [number, number, number, number]; // w, x, y, z

export function quatFromRotation(R: ArrayLike<number>): Quat {
  const tr = R[0]! + R[4]! + R[8]!;
  let q: Quat;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [s / 4, (R[7]! - R[5]!) / s, (R[2]! - R[6]!) / s, (R[3]! - R[1]!) / s];
  } else if (R[0]! > R[4]! && R[0]! > R[8]!) {
    const s = Math.sqrt(1 + R[0]! - R[4]! - R[8]!) * 2;
    q = [(R[7]! - R[5]!) / s, s / 4, (R[1]! + R[3]!) / s, (R[2]! + R[6]!) / s];
  } else if (R[4]! > R[8]!) {
    const s = Math.sqrt(1 + R[4]! - R[0]! - R[8]!) * 2;
    q = [(R[2]! - R[6]!) / s, (R[1]! + R[3]!) / s, s / 4, (R[5]! + R[7]!) / s];
  } else {
    const s = Math.sqrt(1 + R[8]! - R[0]! - R[4]!) * 2;
    q = [(R[3]! - R[1]!) / s, (R[2]! + R[6]!) / s, (R[5]! + R[7]!) / s, s / 4];
  }
  const n = Math.hypot(...q);
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

export function rotationFromQuat(q: Quat): number[] {
  const [w, x, y, z] = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}

/** Spherical interpolation between two rotations. */
export function slerpRotation(a: ArrayLike<number>, b: ArrayLike<number>, t: number): number[] {
  const qa = quatFromRotation(a);
  let qb = quatFromRotation(b);
  let d = qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3];
  if (d < 0) {
    qb = [-qb[0], -qb[1], -qb[2], -qb[3]];
    d = -d;
  }
  if (d > 0.9995) {
    const q: Quat = [qa[0] + t * (qb[0] - qa[0]), qa[1] + t * (qb[1] - qa[1]), qa[2] + t * (qb[2] - qa[2]), qa[3] + t * (qb[3] - qa[3])];
    const n = Math.hypot(...q);
    return rotationFromQuat([q[0] / n, q[1] / n, q[2] / n, q[3] / n]);
  }
  const th = Math.acos(d);
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s;
  const wb = Math.sin(t * th) / s;
  return rotationFromQuat([wa * qa[0] + wb * qb[0], wa * qa[1] + wb * qb[1], wa * qa[2] + wb * qb[2], wa * qa[3] + wb * qb[3]]);
}

export const rotX = (a: number): number[] => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
export const rotY = (a: number): number[] => [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
export const rotZ = (a: number): number[] => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];

/**
 * An Euler order, named by the order the axis rotations are APPLIED to a
 * point (intrinsic-free, column vectors): 'ZXY' means rotate about Z first,
 * then X, then Y, so the matrix is R = Ry · Rx · Rz. This is what Nuke's
 * `rot_order ZXY`, Maya's `rotateOrder` (xyz = X first) and Blender's
 * `rotation_mode` ('XYZ' = X first) mean.
 */
export type EulerOrder = 'XYZ' | 'XZY' | 'YXZ' | 'YZX' | 'ZXY' | 'ZYX';

const AXIS: Record<string, (a: number) => number[]> = { X: rotX, Y: rotY, Z: rotZ };

/** Rotation matrix from Euler angles (radians) given per axis {x, y, z}. */
export function rotationFromEuler(angles: { x: number; y: number; z: number }, order: EulerOrder): number[] {
  const value = (axis: string) => (axis === 'X' ? angles.x : axis === 'Y' ? angles.y : angles.z);
  const [a, b, c] = order.split('') as [string, string, string];
  // Applied a, then b, then c: R = Rc · Rb · Ra.
  return mul3(AXIS[c]!(value(c)), mul3(AXIS[b]!(value(b)), AXIS[a]!(value(a))));
}

/**
 * Euler angles (radians) for a rotation matrix in the given order. Continuous
 * with `previous` when given (unwrapping ±360°), which keeps animation curves
 * from jumping.
 */
export function eulerFromRotation(R: ArrayLike<number>, order: EulerOrder, previous?: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  // R = Rc · Rb · Ra with (a, b, c) a permutation of the axes. Work in the
  // permuted frame where this is the canonical "applied first i, then j, then k" form.
  const idx: Record<string, number> = { X: 0, Y: 1, Z: 2 };
  const [a, b, c] = order.split('').map((s) => idx[s]!) as [number, number, number];
  // Parity: is (a, b, c) an even permutation of (0, 1, 2)?
  const even = (b - a + 3) % 3 === 1;
  const m = (i: number, j: number) => R[i * 3 + j]!;
  let A: number;
  let B: number;
  let C: number;
  // For R = Rc(γ) Rb(β) Ra(α) with even (a,b,c): R[c][a] = −sinβ · (sign)...
  const sb = even ? -m(c, a) : m(c, a);
  B = Math.asin(Math.max(-1, Math.min(1, sb)));
  if (Math.abs(sb) < 0.9999999) {
    if (even) {
      A = Math.atan2(m(c, b), m(c, c));
      C = Math.atan2(m(b, a), m(a, a));
    } else {
      A = Math.atan2(-m(c, b), m(c, c));
      C = Math.atan2(-m(b, a), m(a, a));
    }
  } else {
    // Gimbal lock: put everything in the first angle.
    C = 0;
    A = even ? Math.atan2(-m(b, c), m(b, b)) : Math.atan2(m(b, c), m(b, b));
  }
  const out = { x: 0, y: 0, z: 0 };
  const set = (axis: number, v: number) => (axis === 0 ? (out.x = v) : axis === 1 ? (out.y = v) : (out.z = v));
  set(a, A);
  set(b, B);
  set(c, C);
  if (previous) {
    const unwrap = (v: number, p: number) => v + 2 * Math.PI * Math.round((p - v) / (2 * Math.PI));
    out.x = unwrap(out.x, previous.x);
    out.y = unwrap(out.y, previous.y);
    out.z = unwrap(out.z, previous.z);
  }
  return out;
}

/** Camera pose → its world position and camera-to-world rotation. */
export function poseToCamera(R: ArrayLike<number>, t: ArrayLike<number>): { C: number[]; Rcw: number[] } {
  const Rt = t3(R);
  const C = mulv3(Rt, t).map((v) => -v);
  return { C, Rcw: Rt };
}

export function cameraToPose(C: ArrayLike<number>, Rcw: ArrayLike<number>): { R: number[]; t: number[] } {
  const R = t3(Rcw);
  const t = mulv3(R, C).map((v) => -v);
  return { R, t };
}

/** CV camera axes (y down, z forward) → graphics camera axes (y up, looking down −z). */
export const CV_TO_GL = [1, 0, 0, 0, -1, 0, 0, 0, -1];

export function isRotation(R: ArrayLike<number>, tol = 1e-6): boolean {
  const d = mul3(R, t3(R));
  return Math.abs(det3(R) - 1) < tol && Math.abs(d[0]! - 1) < tol && Math.abs(d[4]! - 1) < tol && Math.abs(d[8]! - 1) < tol && Math.abs(d[1]!) < tol;
}

export { nearestRotation, cross };

/** Horizontal field of view in degrees for a focal length and film back width (same units). */
export function fovDegrees(focal: number, aperture: number): number {
  return (2 * Math.atan(aperture / (2 * focal)) * 180) / Math.PI;
}
