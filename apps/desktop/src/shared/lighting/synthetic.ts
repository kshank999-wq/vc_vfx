import { balancedRgb, kelvinRgb } from '@vcvfx/domain';
import type { LinearImage } from '../key/linear';
import { DEG, add, dirOf, dot, levelRotation, mulv, norm, pinhole, rayOf, rng, scale, sub, type Ground, type PinholeCamera, type V3 } from './geometry';

/**
 * Synthetic lit shots with known lights (addendum 14 §8): the ground truth
 * the tests measure the estimates against, and the browser preview's sample.
 *
 * A level-frame world (x right, y up, z towards the camera; the camera at the
 * origin, pitched and rolled): a grey subject (a sphere, or an ellipsoid —
 * whose silhouette normals are only approximately a sphere's) standing on a
 * ground plane, a background wall, area lights (disks facing the subject,
 * sampled, with real soft shadows from the subject on the ground and the
 * wall), point practicals that are also seen glowing in frame, and an even
 * dome. Values are linear, scaled so that a grey of albedo ρ under the key
 * alone, facing it, reads ρ (the key's illuminance is 1); every light's
 * colour is its blackbody colour as the camera's white balance renders it.
 *
 * Also a chrome ball and a grey ball as photographed at the subject, and the
 * equirectangular HDRI one would shoot there.
 */

export interface SyntheticLight {
  id: string;
  role: 'key' | 'fill' | 'rim' | 'back' | 'sun';
  /** Level-frame direction from the subject's centre, degrees (the domain's convention). */
  az: number;
  el: number;
  /** From the subject's centre, metres. */
  distanceM: number;
  /** The disk's radius, metres (its angular diameter is 2·atan(r / d)). */
  radiusM: number;
  /** Illuminance at the subject relative to the key, stops. */
  stops: number;
  kelvin: number;
}

export interface SyntheticPractical {
  id: string;
  /** Level-frame position, metres. */
  position: V3;
  radiusM: number;
  /** Illuminance it gives the subject's centre (facing it), relative to the key, stops. */
  stops: number;
  kelvin: number;
}

export interface SyntheticScene {
  width: number;
  height: number;
  focalMm: number;
  filmBackMm: number;
  cameraHeightM: number;
  pitchDeg: number;
  rollDeg: number;
  subject: { kind: 'sphere' | 'ellipsoid'; radiusM: number; depthM: number; offsetXM: number; axes: V3; albedo: V3 };
  groundAlbedo: number;
  wall: { depthM: number; albedo: number } | null;
  lights: SyntheticLight[];
  practicals: SyntheticPractical[];
  ambient: { stops: number; kelvin: number };
  whiteBalanceK: number | null;
  /** Samples per area light per shading point (soft shadows). */
  samples: number;
  /** Supersampling per axis. */
  supersample: number;
  noise: number;
  seed: number;
}

/** A small studio: a warm soft key from frame right and above, a cool fill from the left, a rim from behind left, a tungsten practical on the wall. */
export const STUDIO_SCENE: SyntheticScene = {
  width: 480,
  height: 270,
  focalMm: 35,
  filmBackMm: 36,
  cameraHeightM: 1.4,
  pitchDeg: -6,
  rollDeg: 0,
  subject: { kind: 'sphere', radiusM: 0.45, depthM: 4, offsetXM: -0.2, axes: [1, 1, 1], albedo: [0.55, 0.55, 0.55] },
  groundAlbedo: 0.32,
  wall: { depthM: 7.5, albedo: 0.42 },
  lights: [
    { id: 'key', role: 'key', az: 48, el: 32, distanceM: 3.2, radiusM: 0.35, stops: 0, kelvin: 4300 },
    { id: 'fill', role: 'fill', az: -42, el: 12, distanceM: 3.5, radiusM: 1.0, stops: -2.2, kelvin: 6500 },
    { id: 'rim', role: 'rim', az: -150, el: 28, distanceM: 3, radiusM: 0.2, stops: -0.6, kelvin: 5600 },
  ],
  practicals: [{ id: 'lamp', position: [1.9, 0.35, -7.3], radiusM: 0.07, stops: -5, kelvin: 2700 }],
  ambient: { stops: -4.5, kelvin: 7000 },
  whiteBalanceK: 5600,
  samples: 20,
  supersample: 2,
  noise: 0.003,
  seed: 7,
};

export interface SyntheticTruth {
  lights: { id: string; role: string; az: number; el: number; sizeDeg: number; stops: number; kelvin: number }[];
  practicals: { id: string; x: number; y: number; stops: number; kelvin: number }[];
  ambientStops: number;
  focalPx: number;
  /** Fill / key illuminance ratio. */
  fillRatio: number | null;
}

export interface SyntheticShot {
  image: LinearImage;
  /** Subject coverage 0 … 1. */
  matte: Float32Array;
  camera: PinholeCamera;
  ground: Ground;
  truth: SyntheticTruth;
}

interface Hit {
  t: number;
  p: V3;
  n: V3;
  kind: 'subject' | 'ground' | 'wall' | 'practical';
  practical?: SyntheticPractical;
}

const focalPxOf = (s: Pick<SyntheticScene, 'focalMm' | 'filmBackMm' | 'width'>) => (s.focalMm / s.filmBackMm) * s.width;

/** Light colour as the camera records it. */
const seenRgb = (kelvin: number, wb: number | null) => balancedRgb(kelvinRgb(kelvin), wb);

function subjectCentre(s: SyntheticScene): V3 {
  return [s.subject.offsetXM, -s.cameraHeightM + s.subject.radiusM * s.subject.axes[1], -s.subject.depthM];
}

/** Ray / ellipsoid (axis-aligned, semi-axes radius·axes) intersection: the nearest t > eps, or null. */
function hitSubject(s: SyntheticScene, o: V3, d: V3, eps = 1e-5): { t: number; n: V3 } | null {
  const c = subjectCentre(s);
  const a = s.subject.axes.map((k) => k * s.subject.radiusM) as V3;
  const oc = [(o[0] - c[0]) / a[0], (o[1] - c[1]) / a[1], (o[2] - c[2]) / a[2]];
  const dd = [d[0] / a[0], d[1] / a[1], d[2] / a[2]];
  const A = dot(dd, dd);
  const B = 2 * dot(oc, dd);
  const C = dot(oc, oc) - 1;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  let t = (-B - sq) / (2 * A);
  if (t <= eps) t = (-B + sq) / (2 * A);
  if (t <= eps) return null;
  const p = add(o, scale(d, t));
  const n = norm([(p[0] - c[0]) / (a[0] * a[0]), (p[1] - c[1]) / (a[1] * a[1]), (p[2] - c[2]) / (a[2] * a[2])]);
  return { t, n };
}

/** Does the subject block the segment p → to? (Scalar maths: this is the renderer's inner loop.) */
function blocked(s: SyntheticScene, p: V3, to: V3): boolean {
  const c = subjectCentre(s);
  const ax = s.subject.axes[0] * s.subject.radiusM;
  const ay = s.subject.axes[1] * s.subject.radiusM;
  const az = s.subject.axes[2] * s.subject.radiusM;
  const dx = to[0] - p[0];
  const dy = to[1] - p[1];
  const dz = to[2] - p[2];
  const ox = (p[0] - c[0]) / ax;
  const oy = (p[1] - c[1]) / ay;
  const oz = (p[2] - c[2]) / az;
  const ex = dx / ax;
  const ey = dy / ay;
  const ez = dz / az;
  const A = ex * ex + ey * ey + ez * ez;
  const B = 2 * (ox * ex + oy * ey + oz * ez);
  const C = ox * ox + oy * oy + oz * oz - 1;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return false;
  const sq = Math.sqrt(disc);
  const t0 = (-B - sq) / (2 * A);
  const t1 = (-B + sq) / (2 * A);
  // The segment runs t = 0 … 1; a hit strictly inside it (not at the start point) blocks.
  return (t0 > 1e-4 && t0 < 1 - 1e-6) || (t1 > 1e-4 && t1 < 1 - 1e-6 && t0 < 1e-4 && C > 1e-6);
}

function trace(s: SyntheticScene, d: V3): Hit | null {
  const o: V3 = [0, 0, 0];
  let best: Hit | null = null;
  const subj = hitSubject(s, o, d);
  if (subj) best = { t: subj.t, p: scale(d, subj.t), n: subj.n, kind: 'subject' };
  for (const pr of s.practicals) {
    const oc = sub(o, pr.position);
    const b = dot(oc, d);
    const c = dot(oc, oc) - pr.radiusM * pr.radiusM;
    const disc = b * b - c;
    if (disc >= 0) {
      const t = -b - Math.sqrt(disc);
      if (t > 0 && (!best || t < best.t)) best = { t, p: scale(d, t), n: norm(sub(scale(d, t), pr.position)), kind: 'practical', practical: pr };
    }
  }
  if (d[1] < -1e-9) {
    const t = s.cameraHeightM / -d[1];
    if (!best || t < best.t) best = { t, p: scale(d, t), n: [0, 1, 0], kind: 'ground' };
  }
  if (s.wall && d[2] < -1e-9) {
    const t = s.wall.depthM / -d[2];
    if ((!best || t < best.t) && t * d[1] > -s.cameraHeightM) best = { t, p: scale(d, t), n: [0, 0, 1], kind: 'wall' };
  }
  return best;
}

/** Vogel-spiral points on the unit disk: even, deterministic. */
function diskPattern(n: number): [number, number][] {
  const g = Math.PI * (3 - Math.sqrt(5));
  return Array.from({ length: n }, (_, i) => {
    const r = Math.sqrt((i + 0.5) / n);
    return [r * Math.cos(i * g), r * Math.sin(i * g)] as [number, number];
  });
}

/** An orthonormal frame around a direction. */
function frameOf(w: V3): { u: V3; v: V3 } {
  const a: V3 = Math.abs(w[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm([a[1] * w[2] - a[2] * w[1], a[2] * w[0] - a[0] * w[2], a[0] * w[1] - a[1] * w[0]]);
  const v: V3 = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]];
  return { u, v };
}

interface PreparedLight {
  light: SyntheticLight;
  centre: V3;
  normal: V3;
  points: V3[];
  /** Radiance (value units) of the disk. */
  radiance: number;
  rgb: V3;
}

function prepare(s: SyntheticScene): { lights: PreparedLight[]; practicals: { pr: SyntheticPractical; intensity: number; rgb: V3 }[]; ambientRgb: V3; ambient: number } {
  const c = subjectCentre(s);
  const pattern = diskPattern(s.samples);
  const lights = s.lights.map((l) => {
    const dir = dirOf(l.az, l.el);
    const centre = add(c, scale(dir, l.distanceM));
    const { u, v } = frameOf(dir);
    const points = pattern.map(([a, b]) => add(centre, add(scale(u, a * l.radiusM), scale(v, b * l.radiusM))));
    // A disk of radiance L seen face on from distance d gives E = π L r² / (r² + d²) (value units: ρE).
    const E = 2 ** l.stops;
    const radiance = E / ((l.radiusM * l.radiusM) / (l.radiusM * l.radiusM + l.distanceM * l.distanceM));
    return { light: l, centre, normal: scale(dir, -1), points, radiance, rgb: seenRgb(l.kelvin, s.whiteBalanceK) as V3 };
  });
  const practicals = s.practicals.map((pr) => {
    const d = Math.hypot(...sub(pr.position, c));
    return { pr, intensity: 2 ** pr.stops * d * d, rgb: seenRgb(pr.kelvin, s.whiteBalanceK) as V3 };
  });
  return { lights, practicals, ambientRgb: seenRgb(s.ambient.kelvin, s.whiteBalanceK) as V3, ambient: 2 ** s.ambient.stops };
}

/** Irradiance (per channel, relative to the key) at a point with a normal. */
function irradiance(s: SyntheticScene, prep: ReturnType<typeof prepare>, p: V3, n: V3, shadows = true): V3 {
  const out: V3 = [prep.ambient * prep.ambientRgb[0], prep.ambient * prep.ambientRgb[1], prep.ambient * prep.ambientRgb[2]];
  // A point on the convex subject cannot be shadowed by it.
  const onSubject = shadows && Math.abs((p[0] - subjectCentre(s)[0]) ** 2 / (s.subject.axes[0] * s.subject.radiusM) ** 2 + (p[1] - subjectCentre(s)[1]) ** 2 / (s.subject.axes[1] * s.subject.radiusM) ** 2 + (p[2] - subjectCentre(s)[2]) ** 2 / (s.subject.axes[2] * s.subject.radiusM) ** 2 - 1) < 1e-3;
  const test = shadows && !onSubject;
  for (const L of prep.lights) {
    const area = (Math.PI * L.light.radiusM * L.light.radiusM) / L.points.length;
    let e = 0;
    for (const q of L.points) {
      const wx = q[0] - p[0];
      const wy = q[1] - p[1];
      const wz = q[2] - p[2];
      const d2 = wx * wx + wy * wy + wz * wz;
      const inv = 1 / Math.sqrt(d2);
      const cosS = (n[0] * wx + n[1] * wy + n[2] * wz) * inv;
      if (cosS <= 0) continue;
      const cosL = -(L.normal[0] * wx + L.normal[1] * wy + L.normal[2] * wz) * inv;
      if (cosL <= 0) continue;
      if (test && blocked(s, p, q)) continue;
      e += (cosS * cosL * area) / d2;
    }
    // The disk's radiance is scaled so a face-on point at the subject's centre gets 2^stops (value units fold in 1/π).
    e *= L.radiance / Math.PI;
    out[0] += e * L.rgb[0];
    out[1] += e * L.rgb[1];
    out[2] += e * L.rgb[2];
  }
  for (const P of prep.practicals) {
    const w = sub(P.pr.position, p);
    const d2 = dot(w, w);
    const cosS = dot(n, w) / Math.sqrt(d2);
    if (cosS <= 0) continue;
    if (test && blocked(s, p, P.pr.position)) continue;
    const e = (P.intensity * cosS) / d2;
    for (let k = 0; k < 3; k += 1) out[k] += e * P.rgb[k]!;
  }
  return out;
}

/** Render the shot: the frame (linear), the subject's matte, the camera and ground, and the truth. */
export function renderScene(s: SyntheticScene): SyntheticShot {
  const W = s.width;
  const H = s.height;
  const cam = pinhole(W, H, focalPxOf(s), s.pitchDeg, s.rollDeg);
  const R = levelRotation(cam);
  const prep = prepare(s);
  const data = new Float32Array(W * H * 3);
  const matte = new Float32Array(W * H);
  const ss = Math.max(1, s.supersample);
  const random = rng(s.seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  for (let y = 0; y < H; y += 1)
    for (let x = 0; x < W; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let cover = 0;
      for (let sy = 0; sy < ss; sy += 1)
        for (let sx = 0; sx < ss; sx += 1) {
          const d = mulv(R, rayOf(cam, x + (sx + 0.5) / ss, y + (sy + 0.5) / ss));
          const hit = trace(s, d);
          if (!hit) continue;
          if (hit.kind === 'practical') {
            const P = prep.practicals.find((q) => q.pr === hit.practical)!;
            const L = P.intensity / (P.pr.radiusM * P.pr.radiusM);
            r += L * P.rgb[0];
            g += L * P.rgb[1];
            b += L * P.rgb[2];
            continue;
          }
          const albedo: V3 = hit.kind === 'subject' ? s.subject.albedo : hit.kind === 'ground' ? [s.groundAlbedo, s.groundAlbedo, s.groundAlbedo] : [s.wall!.albedo, s.wall!.albedo, s.wall!.albedo];
          if (hit.kind === 'subject') cover += 1;
          const e = irradiance(s, prep, hit.p, hit.n);
          r += albedo[0] * e[0];
          g += albedo[1] * e[1];
          b += albedo[2] * e[2];
        }
      const k = 1 / (ss * ss);
      const i = y * W + x;
      const nz = s.noise ? 1 + s.noise * gauss() : 1;
      data[3 * i] = r * k * nz;
      data[3 * i + 1] = g * k * nz;
      data[3 * i + 2] = b * k * nz;
      matte[i] = cover * k;
    }
  const c = subjectCentre(s);
  const fill = s.lights.find((l) => l.role === 'fill');
  return {
    image: { width: W, height: H, data },
    matte,
    camera: cam,
    ground: { heightM: s.cameraHeightM },
    truth: {
      lights: s.lights.map((l) => ({ id: l.id, role: l.role, az: l.az, el: l.el, sizeDeg: (2 * Math.atan(l.radiusM / l.distanceM)) / DEG, stops: l.stops, kelvin: l.kelvin })),
      practicals: s.practicals.map((pr) => {
        const at = projectWorld(cam, pr.position);
        return { id: pr.id, x: at?.x ?? NaN, y: at?.y ?? NaN, stops: pr.stops, kelvin: pr.kelvin };
      }),
      ambientStops: s.ambient.stops,
      focalPx: cam.focalPx,
      fillRatio: fill ? 2 ** fill.stops : null,
    },
  };
}

function projectWorld(cam: PinholeCamera, p: V3): { x: number; y: number } | null {
  const R = levelRotation(cam);
  const Rt = [R[0]!, R[3]!, R[6]!, R[1]!, R[4]!, R[7]!, R[2]!, R[5]!, R[8]!];
  const q = mulv(Rt, p);
  if (q[2] >= 0) return null;
  return { x: cam.cx + (cam.focalPx * q[0]) / -q[2], y: cam.cy - (cam.focalPx * q[1]) / -q[2] };
}

/** Radiance (value units) the environment sends from a level-frame direction, seen from the subject. */
function environment(s: SyntheticScene, prep: ReturnType<typeof prepare>, d: V3): V3 {
  const c = subjectCentre(s);
  for (const L of prep.lights) {
    const w = norm(sub(L.centre, c));
    const half = Math.atan(L.light.radiusM / L.light.distanceM);
    if (Math.acos(Math.max(-1, Math.min(1, dot(w, d)))) <= half) return scale(L.rgb, L.radiance) as V3;
  }
  for (const P of prep.practicals) {
    const w = sub(P.pr.position, c);
    const dist = Math.hypot(...w);
    const half = Math.atan(P.pr.radiusM / dist);
    if (Math.acos(Math.max(-1, Math.min(1, dot(scale(w, 1 / dist), d)))) <= half) return scale(P.rgb, P.intensity / (P.pr.radiusM * P.pr.radiusM)) as V3;
  }
  if (d[1] >= 0) return scale(prep.ambientRgb, prep.ambient) as V3;
  // The ground below, lit by the key and the dome (no shadows: it is far).
  const e = irradiance(s, prep, [c[0] + d[0] * 3, -s.cameraHeightM, c[2] + d[2] * 3], [0, 1, 0], false);
  return scale(e, s.groundAlbedo) as V3;
}

export interface BallShot {
  image: LinearImage;
  circle: { cx: number; cy: number; r: number };
}

/** A chrome ball (mirror, reflectance 0.8) photographed at the subject, orthographically, centred in a size × size frame. */
export function renderChromeBall(s: SyntheticScene, size = 160): BallShot {
  const prep = prepare(s);
  const cam = pinhole(size, size, 1, s.pitchDeg, s.rollDeg);
  const R = levelRotation(cam);
  const data = new Float32Array(size * size * 3);
  const r = size * 0.42;
  const cx = size / 2;
  const cy = size / 2;
  const ss = 3;
  for (let y = 0; y < size; y += 1)
    for (let x = 0; x < size; x += 1) {
      const acc: V3 = [0, 0, 0];
      for (let sy = 0; sy < ss; sy += 1)
        for (let sx = 0; sx < ss; sx += 1) {
          const nx = (x + (sx + 0.5) / ss - cx) / r;
          const ny = -(y + (sy + 0.5) / ss - cy) / r;
          const q = nx * nx + ny * ny;
          let v: V3;
          if (q > 1) v = [0.08, 0.08, 0.08];
          else {
            const n: V3 = [nx, ny, Math.sqrt(1 - q)];
            const refl: V3 = [2 * n[2] * n[0], 2 * n[2] * n[1], 2 * n[2] * n[2] - 1];
            v = scale(environment(s, prep, mulv(R, refl)), 0.8) as V3;
          }
          acc[0] += v[0];
          acc[1] += v[1];
          acc[2] += v[2];
        }
      const i = y * size + x;
      for (let k = 0; k < 3; k += 1) data[3 * i + k] = acc[k]! / (ss * ss);
    }
  return { image: { width: size, height: size, data }, circle: { cx, cy, r } };
}

/** A grey ball (albedo 0.18) photographed at the subject, orthographically, unshadowed. */
export function renderGreyBall(s: SyntheticScene, size = 160): BallShot {
  const prep = prepare(s);
  const cam = pinhole(size, size, 1, s.pitchDeg, s.rollDeg);
  const R = levelRotation(cam);
  const data = new Float32Array(size * size * 3);
  const r = size * 0.42;
  const c = subjectCentre(s);
  for (let y = 0; y < size; y += 1)
    for (let x = 0; x < size; x += 1) {
      const nx = (x + 0.5 - size / 2) / r;
      const ny = -(y + 0.5 - size / 2) / r;
      const q = nx * nx + ny * ny;
      const i = y * size + x;
      if (q > 1) {
        data.set([0.08, 0.08, 0.08], 3 * i);
        continue;
      }
      const n = mulv(R, [nx, ny, Math.sqrt(1 - q)]);
      const e = irradiance(s, prep, add(c, scale(n, 1.001 * s.subject.radiusM)), n, false);
      data.set([0.18 * e[0], 0.18 * e[1], 0.18 * e[2]], 3 * i);
    }
  return { image: { width: size, height: size, data }, circle: { cx: size / 2, cy: size / 2, r } };
}

/**
 * The equirectangular HDRI from the subject: column u → yaw (u/W − ½)·360°
 * (positive to the right of the centre column), row v → pitch (½ − v/H)·180°.
 * `headingDeg` is the panorama yaw the camera looked along.
 */
export function renderEquirect(s: SyntheticScene, width = 512, headingDeg = 0): LinearImage {
  const prep = prepare(s);
  const H = width / 2;
  const data = new Float32Array(width * H * 3);
  const ss = 2;
  for (let v = 0; v < H; v += 1)
    for (let u = 0; u < width; u += 1) {
      const acc: V3 = [0, 0, 0];
      for (let sy = 0; sy < ss; sy += 1)
        for (let sx = 0; sx < ss; sx += 1) {
          const yaw = (((u + (sx + 0.5) / ss) / width - 0.5) * 360 - headingDeg) * DEG;
          const pitch = (0.5 - (v + (sy + 0.5) / ss) / H) * 180 * DEG;
          const d: V3 = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
          const e = environment(s, prep, d);
          acc[0] += e[0];
          acc[1] += e[1];
          acc[2] += e[2];
        }
      const i = v * width + u;
      for (let k = 0; k < 3; k += 1) data[3 * i + k] = acc[k]! / (ss * ss);
    }
  return { width, height: H, data };
}

/**
 * A room of tiled walls and floor seen through a lens (addendum 14 §3.7):
 * straight lines towards known vanishing points, for the focal-length and
 * line-curvature tests. `k1` bends them (the division model, normalised by
 * the half-diagonal): negative is barrel.
 */
export function renderLineRoom(o: { width: number; height: number; focalPx: number; yawDeg: number; pitchDeg: number; k1?: number; supersample?: number; spacing?: number }): LinearImage {
  const { width: W, height: H } = o;
  const data = new Float32Array(W * H * 3);
  const ss = o.supersample ?? 2;
  const yaw = o.yawDeg * DEG;
  const pitch = o.pitchDeg * DEG;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const half = Math.hypot(W / 2, H / 2);
  const k1 = o.k1 ?? 0;
  for (let y = 0; y < H; y += 1)
    for (let x = 0; x < W; x += 1) {
      let acc = 0;
      for (let a = 0; a < ss; a += 1)
        for (let b = 0; b < ss; b += 1) {
          // Distorted pixel → undistorted (division model): p_u = c + (p_d − c) / (1 + k1 r_d²).
          let px = x + (a + 0.5) / ss - W / 2;
          let py = y + (b + 0.5) / ss - H / 2;
          const r2 = (px * px + py * py) / (half * half);
          const f = 1 / (1 + k1 * r2);
          px *= f;
          py *= f;
          let d: V3 = norm([px / o.focalPx, -py / o.focalPx, -1]);
          // Camera → room: pitch about x, then yaw about y.
          d = [d[0], cp * d[1] - sp * d[2], sp * d[1] + cp * d[2]];
          d = [cy * d[0] + sy * d[2], d[1], -sy * d[0] + cy * d[2]];
          // A box room: floor y = −1.5, ceiling y = 1.5, walls x = ±3, z = −6, z = 4.
          let t = Infinity;
          let uv: [number, number] = [0, 0];
          const tryPlane = (axis: 0 | 1 | 2, at: number, u: 0 | 1 | 2, v: 0 | 1 | 2) => {
            if (Math.abs(d[axis]) < 1e-9) return;
            const tt = at / d[axis];
            if (tt > 0 && tt < t) {
              t = tt;
              uv = [d[u] * tt, d[v] * tt];
            }
          };
          tryPlane(1, -1.5, 0, 2);
          tryPlane(1, 1.5, 0, 2);
          tryPlane(0, -3, 1, 2);
          tryPlane(0, 3, 1, 2);
          tryPlane(2, -6, 0, 1);
          tryPlane(2, 4, 0, 1);
          const grid = o.spacing ?? 0.5;
          const gu = Math.abs(uv[0] / grid - Math.round(uv[0] / grid)) * grid;
          const gv = Math.abs(uv[1] / grid - Math.round(uv[1] / grid)) * grid;
          acc += Math.min(gu, gv) < 0.02 ? 0.05 : 0.6;
        }
      const i = y * W + x;
      const v = acc / (ss * ss);
      data[3 * i] = v;
      data[3 * i + 1] = v;
      data[3 * i + 2] = v;
    }
  return { width: W, height: H, data };
}

/** The subject's true normals per pixel (camera frame; NaN off the subject), for checking the silhouette normals. */
export function trueNormals(s: SyntheticScene): Float32Array {
  const cam = pinhole(s.width, s.height, focalPxOf(s), s.pitchDeg, s.rollDeg);
  const R = levelRotation(cam);
  const Rt = [R[0]!, R[3]!, R[6]!, R[1]!, R[4]!, R[7]!, R[2]!, R[5]!, R[8]!];
  const out = new Float32Array(s.width * s.height * 3).fill(NaN);
  for (let y = 0; y < s.height; y += 1)
    for (let x = 0; x < s.width; x += 1) {
      const d = mulv(R, rayOf(cam, x + 0.5, y + 0.5));
      const h = hitSubject(s, [0, 0, 0], d);
      if (!h) continue;
      out.set(mulv(Rt, h.n), 3 * (y * s.width + x));
    }
  return out;
}
