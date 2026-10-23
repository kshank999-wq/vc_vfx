import type { TextureRegion } from '@vcvfx/domain';
import type { Intrinsics } from '../camera/geometry';
import { distort, undistort } from '../camera/geometry';
import type { PointCloud } from '../camera/lidar';
import type { LinearImage } from '../key/linear';
import { gaussianBlur, rng } from '../roto/image';
import { cross, dirOf, dot3, fromCanonical, sub, unit, type V3 } from './geometry';
import { srgbEncode } from './image';

/**
 * A synthetic storeroom with known ground truth, for the tests and the
 * browser preview (addendum 12 §8): a box room 6 × 5 m and 2.8 m high whose
 * walls and floor carry procedural albedo with fine detail — brick, plaster,
 * timber planks, floor tiles — lit by two lamps (so every surface has a
 * smooth light falloff across it) and seen by:
 *  - photographs from inside the room, any position, direction, field of view
 *    and Brown–Conrady distortion, rendered by ray casting with supersampling,
 *    exposed and clipped like a display-referred still;
 *  - an equirectangular panorama from a point in the room, with a heading;
 *  - a coloured point cloud sampled on the surfaces (a LiDAR scan), Y- or Z-up.
 * The albedo and the light at any point of a surface are known exactly, so a
 * rectified texture can be compared with the truth.
 *
 * Coordinates: canonical (Y up, metres). A surface is its top-left corner and
 * its right (u) and down (v) edges as seen from inside the room.
 */

export type SurfaceKind = 'bricks' | 'tiles' | 'plaster' | 'planks' | 'plain';

export interface SynthSurface {
  id: string;
  name: string;
  kind: SurfaceKind;
  origin: V3;
  u: V3;
  v: V3;
  /** Facing into the room. */
  normal: V3;
  width: number;
  height: number;
}

export interface SynthCamera {
  eye: V3;
  target: V3;
  /** Horizontal field of view (of the de-squeezed picture), degrees. */
  fov: number;
  /** Stored pixels. */
  width: number;
  height: number;
  /** Stored pixel width / height (an anamorphic or DV frame); 1 when absent. */
  pixelAspect?: number;
  k1?: number;
  k2?: number;
  roll?: number;
  /** Exposure multiplier. */
  exposure?: number;
  /** Gaussian blur (pixels) after rendering: focus or motion. */
  blur?: number;
  supersample?: number;
}

const surf = (id: string, name: string, kind: SurfaceKind, origin: V3, u: V3, v: V3): SynthSurface => {
  const n = unit(cross(v, u));
  return { id, name, kind, origin, u, v, normal: n, width: Math.hypot(...u), height: Math.hypot(...v) };
};

/** The room. */
export const ROOM: SynthSurface[] = [
  surf('back', 'back wall (brick)', 'bricks', [3, 2.8, 2.5], [-6, 0, 0], [0, -2.8, 0]),
  surf('west', 'west wall (plaster)', 'plaster', [-3, 2.8, 2.5], [0, 0, -5], [0, -2.8, 0]),
  surf('east', 'east wall (planks)', 'planks', [3, 2.8, -2.5], [0, 0, 5], [0, -2.8, 0]),
  surf('front', 'front wall', 'plain', [-3, 2.8, -2.5], [6, 0, 0], [0, -2.8, 0]),
  surf('floor', 'floor (tiles)', 'tiles', [3, 0, 2.5], [-6, 0, 0], [0, 0, -5]),
  surf('ceiling', 'ceiling', 'plain', [3, 2.8, -2.5], [-6, 0, 0], [0, 0, 5]),
];

export const LIGHTS: { p: V3; intensity: number }[] = [
  { p: [1.6, 2.6, 1.2], intensity: 3.2 },
  { p: [-2.0, 2.4, -1.2], intensity: 1.6 },
];
const AMBIENT = 0.1;

function hash2(x: number, y: number, seed: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise, about −1 … 1, at lattice spacing 1. */
function noise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return 2 * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy) - 1;
}

/** Albedo (linear RGB) of a surface at (sx, sy) metres from its top-left corner. */
export function albedoAt(kind: SurfaceKind, sx: number, sy: number): V3 {
  switch (kind) {
    case 'bricks': {
      const course = Math.floor(sy / 0.075);
      const off = (course % 2) * 0.1125;
      const xb = sx + off;
      const bx = Math.floor(xb / 0.225);
      const fx = xb - bx * 0.225;
      const fy = sy - course * 0.075;
      const fine = 1 + 0.14 * noise(sx / 0.004, sy / 0.004, 3) + 0.08 * noise(sx / 0.02, sy / 0.02, 4);
      if (fx < 0.01 || fy < 0.01) return [0.46 * fine, 0.44 * fine, 0.4 * fine];
      const t = 0.72 + 0.5 * hash2(bx, course, 11);
      const hue = hash2(bx, course, 12) - 0.5;
      return [0.34 * t * fine, (0.13 + 0.04 * hue) * t * fine, (0.075 + 0.02 * hue) * t * fine];
    }
    case 'tiles': {
      const ix = Math.floor(sx / 0.3);
      const iy = Math.floor(sy / 0.3);
      const fx = sx - ix * 0.3;
      const fy = sy - iy * 0.3;
      const speck = 1 + 0.16 * noise(sx / 0.003, sy / 0.003, 5) + 0.06 * noise(sx / 0.03, sy / 0.03, 6);
      if (fx < 0.006 || fy < 0.006) return [0.22 * speck, 0.21 * speck, 0.2 * speck];
      const t = 0.82 + 0.32 * hash2(ix, iy, 21);
      return [0.56 * t * speck, 0.5 * t * speck, 0.4 * t * speck];
    }
    case 'plaster': {
      const k = 1 + 0.08 * noise(sx / 0.06, sy / 0.06, 7) + 0.07 * noise(sx / 0.012, sy / 0.012, 8) + 0.06 * noise(sx / 0.003, sy / 0.003, 9);
      return [0.62 * k, 0.6 * k, 0.55 * k];
    }
    case 'planks': {
      const ix = Math.floor(sx / 0.14);
      const fx = sx - ix * 0.14;
      const grain = 1 + 0.18 * noise(sx / 0.0025, sy / 0.06, 10 + ix) + 0.06 * noise(sx / 0.01, sy / 0.01, 13);
      if (fx < 0.004) return [0.08, 0.06, 0.04];
      const t = 0.8 + 0.4 * hash2(ix, 0, 31);
      return [0.4 * t * grain, 0.25 * t * grain, 0.13 * t * grain];
    }
    default: {
      const k = 1 + 0.05 * noise(sx / 0.01, sy / 0.01, 14);
      return [0.5 * k, 0.5 * k, 0.48 * k];
    }
  }
}

/** The light falling on a point of a surface (relative irradiance). */
export function irradianceAt(p: ArrayLike<number>, n: ArrayLike<number>): number {
  let e = AMBIENT;
  for (const l of LIGHTS) {
    const d = sub(l.p, p);
    const r = Math.hypot(...d);
    const c = dot3(n, d) / r;
    if (c > 0) e += (l.intensity * c) / (r * r);
  }
  return e;
}

const surfacePoint = (s: SynthSurface, sx: number, sy: number): V3 => [
  s.origin[0] + (s.u[0] * sx) / s.width + (s.v[0] * sy) / s.height,
  s.origin[1] + (s.u[1] * sx) / s.width + (s.v[1] * sy) / s.height,
  s.origin[2] + (s.u[2] * sx) / s.width + (s.v[2] * sy) / s.height,
];

/** The radiance seen at (sx, sy) of a surface: albedo × light. */
export function radianceAt(s: SynthSurface, sx: number, sy: number): V3 {
  const a = albedoAt(s.kind, sx, sy);
  const e = irradianceAt(surfacePoint(s, sx, sy), s.normal);
  return [a[0] * e, a[1] * e, a[2] * e];
}

/** The nearest surface a ray from inside the room meets, and where (surface metres). */
export function trace(o: ArrayLike<number>, d: ArrayLike<number>): { s: SynthSurface; sx: number; sy: number; t: number } | null {
  let best: { s: SynthSurface; sx: number; sy: number; t: number } | null = null;
  for (const s of ROOM) {
    const den = dot3(s.normal, d);
    if (den >= -1e-9) continue;
    const t = dot3(s.normal, sub(s.origin, o)) / den;
    if (!(t > 1e-6) || (best && t >= best.t)) continue;
    const q = [o[0]! + t * d[0]! - s.origin[0], o[1]! + t * d[1]! - s.origin[1], o[2]! + t * d[2]! - s.origin[2]];
    const sx = dot3(q, s.u) / s.width;
    const sy = dot3(q, s.v) / s.height;
    if (sx < -1e-6 || sy < -1e-6 || sx > s.width + 1e-6 || sy > s.height + 1e-6) continue;
    best = { s, sx, sy, t };
  }
  return best;
}

/** The camera of a synthetic photo: R (canonical → camera, CV), t and the lens at its size. */
export function cameraOf(c: SynthCamera): { R: number[]; t: V3; intr: Intrinsics; C: V3 } {
  const f = unit(sub(c.target, c.eye));
  let right = unit(cross(f, [0, 1, 0]));
  let down = cross(f, right);
  if (c.roll) {
    const a = (c.roll * Math.PI) / 180;
    const r2: V3 = [right[0] * Math.cos(a) + down[0] * Math.sin(a), right[1] * Math.cos(a) + down[1] * Math.sin(a), right[2] * Math.cos(a) + down[2] * Math.sin(a)];
    down = cross(f, r2);
    right = r2;
  }
  const R = [...right, ...down, ...f];
  const t: V3 = [-dot3(right, c.eye), -dot3(down, c.eye), -dot3(f, c.eye)];
  const a = c.pixelAspect ?? 1;
  const fpx = (c.width * a) / 2 / Math.tan((c.fov * Math.PI) / 360);
  return { R, t, C: c.eye, intr: { f: fpx, cx: (c.width - 1) / 2, cy: (c.height - 1) / 2, k1: c.k1 ?? 0, k2: c.k2 ?? 0, k3: 0, p1: 0, p2: 0, ...(a !== 1 ? { a } : {}) } };
}

/** Where a canonical point is in the (distorted) photo. */
export function projectPoint(c: SynthCamera, P: ArrayLike<number>): [number, number] {
  const { R, t, intr } = cameraOf(c);
  const x = R[0]! * P[0]! + R[1]! * P[1]! + R[2]! * P[2]! + t[0];
  const y = R[3]! * P[0]! + R[4]! * P[1]! + R[5]! * P[2]! + t[1];
  const z = R[6]! * P[0]! + R[7]! * P[1]! + R[8]! * P[2]! + t[2];
  const [xd, yd] = distort(intr, x / z, y / z);
  return [(intr.f * xd) / (intr.a ?? 1) + intr.cx, intr.f * yd + intr.cy];
}

const clampDisplay = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Render a photograph: linear RGB, exposed, clipped at 1 (a display-referred still), optionally blurred. */
export function renderPhoto(c: SynthCamera): LinearImage {
  const { R, intr } = cameraOf(c);
  const ss = c.supersample ?? 2;
  const W = c.width;
  const H = c.height;
  const out = new Float32Array(W * H * 3);
  const k = c.exposure ?? 1;
  for (let y = 0; y < H; y += 1)
    for (let x = 0; x < W; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < ss; j += 1)
        for (let i = 0; i < ss; i += 1) {
          const px = x + (i + 0.5) / ss - 0.5;
          const py = y + (j + 0.5) / ss - 0.5;
          const [rx, ry] = undistort(intr, ((px - intr.cx) * (intr.a ?? 1)) / intr.f, (py - intr.cy) / intr.f);
          const d: V3 = [R[0]! * rx + R[3]! * ry + R[6]!, R[1]! * rx + R[4]! * ry + R[7]!, R[2]! * rx + R[5]! * ry + R[8]!];
          const hit = trace(c.eye, d);
          if (!hit) continue;
          const v = radianceAt(hit.s, hit.sx, hit.sy);
          r += v[0];
          g += v[1];
          b += v[2];
        }
      const o = 3 * (y * W + x);
      out[o] = (r / (ss * ss)) * k;
      out[o + 1] = (g / (ss * ss)) * k;
      out[o + 2] = (b / (ss * ss)) * k;
    }
  if (c.blur && c.blur > 0.3) {
    for (let ch = 0; ch < 3; ch += 1) {
      const plane = new Float32Array(W * H);
      for (let i = 0; i < W * H; i += 1) plane[i] = out[3 * i + ch]!;
      const bl = gaussianBlur(plane, W, H, c.blur);
      for (let i = 0; i < W * H; i += 1) out[3 * i + ch] = bl[i]!;
    }
  }
  for (let i = 0; i < out.length; i += 1) out[i] = clampDisplay(out[i]!);
  return { width: W, height: H, data: out };
}

/** Render the equirectangular panorama from `position` with `heading` (the yaw of its centre column in the room), exposure k. */
export function renderPanorama(width: number, height: number, position: V3, heading: number, k = 1, ss = 2): LinearImage {
  const out = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    const pitch = (0.5 - (y + 0.5) / height) * 180;
    for (let x = 0; x < width; x += 1) {
      const yaw = ((x + 0.5) / width - 0.5) * 360;
      // 2 × 2 samples per pixel.
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < ss; j += 1)
        for (let i = 0; i < ss; i += 1) {
          const d = dirOf(yaw + heading + (((i + 0.5) / ss - 0.5) * 360) / width, pitch + (((j + 0.5) / ss - 0.5) * 180) / height);
          const hit = trace(position, d);
          if (!hit) continue;
          const v = radianceAt(hit.s, hit.sx, hit.sy);
          r += v[0];
          g += v[1];
          b += v[2];
        }
      const o = 3 * (y * width + x);
      // An HDR panorama: not clipped.
      out[o] = (r / (ss * ss)) * k;
      out[o + 1] = (g / (ss * ss)) * k;
      out[o + 2] = (b / (ss * ss)) * k;
    }
  }
  return { width, height, data: out };
}

/** A coloured LiDAR-like scan of the room: points every `spacing` metres (jittered), noise along the normal, in a Y- or Z-up frame. */
export function scanCloud(spacing: number, o: { up?: 'y' | 'z'; noise?: number; seed?: number; colour?: boolean } = {}): PointCloud {
  const up = o.up ?? 'y';
  const rand = rng(o.seed ?? 5);
  const pts: number[] = [];
  const cols: number[] = [];
  for (const s of ROOM) {
    const nu = Math.max(2, Math.round(s.width / spacing));
    const nv = Math.max(2, Math.round(s.height / spacing));
    for (let j = 0; j < nv; j += 1)
      for (let i = 0; i < nu; i += 1) {
        const sx = ((i + rand()) / nu) * s.width;
        const sy = ((j + rand()) / nv) * s.height;
        const p = surfacePoint(s, sx, sy);
        const e = (rand() - 0.5) * 2 * (o.noise ?? 0.002);
        const q = fromCanonical([p[0] + s.normal[0] * e, p[1] + s.normal[1] * e, p[2] + s.normal[2] * e], up);
        pts.push(q[0], q[1], q[2]);
        const v = radianceAt(s, sx, sy);
        cols.push(Math.round(srgbEncode(v[0]) * 255), Math.round(srgbEncode(v[1]) * 255), Math.round(srgbEncode(v[2]) * 255));
      }
  }
  const positions = Float32Array.from(pts);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3)
    for (let k = 0; k < 3; k += 1) {
      min[k] = Math.min(min[k]!, positions[i + k]!);
      max[k] = Math.max(max[k]!, positions[i + k]!);
    }
  return { positions, colors: o.colour === false ? null : Uint8Array.from(cols), origin: [0, 0, 0], count: positions.length / 3, named: [], bbox: { min, max }, notes: [] };
}

export const surfaceById = (id: string) => ROOM.find((s) => s.id === id)!;

/** A rectangle on a surface (metres from its top-left corner). */
export interface SurfaceRect {
  surface: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The rectangle's corners (TL, TR, BR, BL) in canonical coordinates. */
export function rectCorners3d(r: SurfaceRect): V3[] {
  const s = surfaceById(r.surface);
  return [surfacePoint(s, r.x0, r.y0), surfacePoint(s, r.x1, r.y0), surfacePoint(s, r.x1, r.y1), surfacePoint(s, r.x0, r.y1)];
}

/** The rectangle's corners in a photo: the region the artist would drag. */
export function regionCorners(c: SynthCamera, r: SurfaceRect): TextureRegion['corners'] {
  return rectCorners3d(r).map((P) => projectPoint(c, P)) as unknown as TextureRegion['corners'];
}

/** The ground truth texture of a rectangle at W × H: its albedo (lit: × the light, × exposure), supersampled. */
export function truthTexture(r: SurfaceRect, W: number, H: number, o: { lit?: boolean; exposure?: number; ss?: number } = {}): LinearImage {
  const s = surfaceById(r.surface);
  const ss = o.ss ?? 3;
  const out = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y += 1)
    for (let x = 0; x < W; x += 1) {
      let a = 0;
      let b = 0;
      let c = 0;
      for (let j = 0; j < ss; j += 1)
        for (let i = 0; i < ss; i += 1) {
          const sx = r.x0 + ((x + (i + 0.5) / ss) / W) * (r.x1 - r.x0);
          const sy = r.y0 + ((y + (j + 0.5) / ss) / H) * (r.y1 - r.y0);
          const v = o.lit ? radianceAt(s, sx, sy) : albedoAt(s.kind, sx, sy);
          a += v[0];
          b += v[1];
          c += v[2];
        }
      const k = (o.lit ? (o.exposure ?? 1) : 1) / (ss * ss);
      const q = 3 * (y * W + x);
      out[q] = a * k;
      out[q + 1] = b * k;
      out[q + 2] = c * k;
    }
  return { width: W, height: H, data: out };
}

/** The panorama's centre in the room (camera height, a little off the middle). */
export const PANO_POSITION: V3 = [0.2, 1.5, -0.3];

/** The sample set: what the preview and the tests photograph. */
export const SAMPLE_PHOTOS: { id: string; name: string; camera: Omit<SynthCamera, 'width' | 'height'>; region: SurfaceRect & { name: string } }[] = [
  { id: 'wall_A', name: 'storeroom_wall_A.jpg', camera: { eye: [-0.4, 1.45, 0.3], target: [0.6, 1.25, 2.5], fov: 62, k1: -0.08 }, region: { name: 'Brick wall', surface: 'back', x0: 1.8, y0: 0.9, x1: 3.4, y1: 2.1 } },
  { id: 'wall_B', name: 'storeroom_wall_B.jpg', camera: { eye: [0.9, 1.6, -0.6], target: [-2.2, 1.2, 0.4], fov: 56, exposure: 0.8 }, region: { name: 'Plaster wall', surface: 'west', x0: 1.4, y0: 0.6, x1: 3.0, y1: 1.8 } },
  { id: 'floor', name: 'storeroom_floor.jpg', camera: { eye: [0.3, 1.65, -1.0], target: [0.5, 0, 1.0], fov: 66, k1: -0.05 }, region: { name: 'Floor tiles', surface: 'floor', x0: 1.8, y0: 0.9, x1: 3.8, y1: 2.5 } },
];

// ---------------------------------------------------------------------------
// The sample set as references and pictures (the browser preview, the tests)
// ---------------------------------------------------------------------------

export interface SampleSetOptions {
  photo: { width: number; height: number; supersample?: number };
  panorama: { width: number; supersample?: number; heading: number };
  scan: { spacing: number; up: 'y' | 'z' };
}

export const SAMPLE_SET: SampleSetOptions = { photo: { width: 960, height: 720, supersample: 1 }, panorama: { width: 2048, supersample: 1, heading: 25 }, scan: { spacing: 0.05, up: 'z' } };

/** The sample's references as the ingest would record them (no checksums: nothing is on a drive). */
export function sampleReferences(o: SampleSetOptions = SAMPLE_SET, pano: { position: 'given' | 'unknown' } = { position: 'unknown' }) {
  const photos = SAMPLE_PHOTOS.map((p) => {
    const c = cameraOf({ ...p.camera, width: o.photo.width, height: o.photo.height });
    return {
      kind: 'photo' as const,
      name: p.name,
      path: p.name,
      from: 'sample' as const,
      format: 'jpg',
      checksum: null,
      bytes: null,
      width: o.photo.width,
      height: o.photo.height,
      points: null,
      encoding: 'srgb' as const,
      // As the stills' EXIF would say: a full-frame camera, the lens profile's distortion.
      camera: { body: 'Sample still camera', lens: 'Sample prime', focalMm: Math.round(((c.intr.f / o.photo.width) * 36) * 100) / 100, filmBackWidthMm: 36, distortion: { k1: c.intr.k1, k2: c.intr.k2, k3: 0, p1: 0, p2: 0 }, lensProfileId: null },
    };
  });
  return [
    ...photos,
    { kind: 'panorama' as const, name: 'storeroom_360.exr', path: 'storeroom_360.exr', from: 'sample' as const, format: 'exr', checksum: null, bytes: null, width: o.panorama.width, height: o.panorama.width / 2, points: null, encoding: 'acescg' as const, panorama: { headingDeg: null, position: pano.position === 'given' ? fromCanonical(PANO_POSITION, o.scan.up) : null } },
    { kind: 'scan' as const, name: 'storeroom.e57', path: 'storeroom.e57', from: 'sample' as const, format: 'e57', checksum: null, bytes: null, width: null, height: null, points: null as number | null, encoding: null, scan: { units: 'm' as const, up: o.scan.up } },
  ];
}

/** The sample photos' regions (corners in the photos, the real size), keyed by photo file name. */
export function sampleRegions(o: SampleSetOptions = SAMPLE_SET) {
  return SAMPLE_PHOTOS.map((p) => ({
    photo: p.name,
    name: p.region.name,
    corners: regionCorners({ ...p.camera, width: o.photo.width, height: o.photo.height }, p.region),
    size: { width: Math.round((p.region.x1 - p.region.x0) * 1000) / 1000, height: Math.round((p.region.y1 - p.region.y0) * 1000) / 1000, units: 'm' as const },
  }));
}

/** Render a sample reference by its path (a photo, the panorama) or make the scan. */
export function renderSample(path: string, o: SampleSetOptions = SAMPLE_SET): LinearImage | PointCloud {
  const p = SAMPLE_PHOTOS.find((x) => x.name === path);
  if (p) return renderPhoto({ ...p.camera, width: o.photo.width, height: o.photo.height, supersample: o.photo.supersample ?? 2 });
  if (path === 'storeroom_360.exr') return renderPanorama(o.panorama.width, o.panorama.width / 2, PANO_POSITION, o.panorama.heading, 1, o.panorama.supersample ?? 2);
  if (path === 'storeroom.e57') return scanCloud(o.scan.spacing, { up: o.scan.up });
  throw new Error(`No sample reference ${path}`);
}
