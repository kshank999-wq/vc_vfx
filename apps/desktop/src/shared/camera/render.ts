import { undistort, type Intrinsics } from './geometry';
import { rng } from './synthetic';

/**
 * A tiny software renderer for synthetic camera-tracking shots (addendum 06):
 * textured rectangles in 3D, ray-cast per sample with a depth buffer,
 * supersampled for anti-aliased edges, through the full lens model (so a
 * distorted lens can be rendered too). Procedural textures — random tiles,
 * checkers, a "screen" — give the corners a tracker needs. Used by the
 * end-to-end tests (render → detect → track → solve) and to make the browser
 * preview's sample shot.
 */

export type Vec3 = [number, number, number];

export interface Texture {
  kind: 'tiles' | 'checker' | 'screen' | 'plain';
  /** Cells across the quad's u edge (v follows the aspect). */
  cells: number;
  seed: number;
  tint: Vec3;
}

export interface Quad {
  /** A corner and the two (perpendicular) edges from it. */
  origin: Vec3;
  u: Vec3;
  v: Vec3;
  texture: Texture;
  name?: string;
}

export interface RenderOptions {
  width: number;
  height: number;
  intr: Intrinsics;
  /** World → camera (CV convention: y down, z forward). */
  R: ArrayLike<number>;
  t: ArrayLike<number>;
  supersample?: number;
}

export interface RGBImage {
  width: number;
  height: number;
  data: Uint8Array;
}

const rayCache = new Map<string, Float32Array>();

/** Camera-space rays (x, y, 1) for every sample, cached per size and lens. */
function raysFor(width: number, height: number, k: Intrinsics, ss: number): Float32Array {
  const key = `${width}x${height}:${ss}:${k.f}:${k.cx}:${k.cy}:${k.k1}:${k.k2}:${k.k3}:${k.p1}:${k.p2}`;
  const hit = rayCache.get(key);
  if (hit) return hit;
  const W = width * ss;
  const H = height * ss;
  const out = new Float32Array(W * H * 2);
  for (let y = 0; y < H; y += 1) {
    const py = (y + 0.5) / ss - 0.5;
    for (let x = 0; x < W; x += 1) {
      const px = (x + 0.5) / ss - 0.5;
      const r = undistort(k, (px - k.cx) / k.f, (py - k.cy) / k.f);
      out[2 * (y * W + x)] = r[0];
      out[2 * (y * W + x) + 1] = r[1];
    }
  }
  if (rayCache.size > 6) rayCache.delete(rayCache.keys().next().value!);
  rayCache.set(key, out);
  return out;
}

function hash2(x: number, y: number, seed: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Texture colour at quad coordinates (a, b) ∈ [0, 1]², linear 0 … 1 per channel. */
export function textureAt(t: Texture, a: number, b: number, aspect: number): Vec3 {
  let g: number;
  switch (t.kind) {
    case 'tiles': {
      const ca = a * t.cells;
      const cb = b * t.cells * aspect;
      const ia = Math.floor(ca);
      const ib = Math.floor(cb);
      const base = 0.12 + 0.76 * hash2(ia, ib, t.seed);
      // A second, finer octave of smaller tiles at lower contrast: more corners.
      const fa = Math.floor(ca * 3);
      const fb = Math.floor(cb * 3);
      const fine = (hash2(fa, fb, t.seed + 7) - 0.5) * 0.22;
      g = Math.min(1, Math.max(0, base + fine));
      break;
    }
    case 'checker': {
      const ia = Math.floor(a * t.cells);
      const ib = Math.floor(b * t.cells * aspect);
      g = (ia + ib) % 2 === 0 ? 0.85 : 0.12;
      break;
    }
    case 'screen': {
      // A bezel, a dark screen with bright UI blocks.
      const m = 0.06;
      if (a < m || a > 1 - m || b < m * aspect * 0 + m || b > 1 - m) g = 0.08;
      else {
        const sa = (a - m) / (1 - 2 * m);
        const sb = (b - m) / (1 - 2 * m);
        const ia = Math.floor(sa * 6);
        const ib = Math.floor(sb * 4);
        const fa = sa * 6 - ia;
        const fb = sb * 4 - ib;
        const on = hash2(ia, ib, t.seed) > 0.45 && fa > 0.12 && fa < 0.88 && fb > 0.15 && fb < 0.85;
        g = on ? 0.55 + 0.4 * hash2(ia, ib, t.seed + 3) : 0.18;
      }
      break;
    }
    default:
      g = 0.5;
  }
  return [g * t.tint[0], g * t.tint[1], g * t.tint[2]];
}

/** Render the quads. */
export function renderScene(quads: readonly Quad[], o: RenderOptions): RGBImage {
  const ss = o.supersample ?? 2;
  const W = o.width * ss;
  const H = o.height * ss;
  const rays = raysFor(o.width, o.height, o.intr, ss);
  const R = o.R;
  const t = o.t;
  // Camera centre in the world.
  const C: Vec3 = [-(R[0]! * t[0]! + R[3]! * t[1]! + R[6]! * t[2]!), -(R[1]! * t[0]! + R[4]! * t[1]! + R[7]! * t[2]!), -(R[2]! * t[0]! + R[5]! * t[1]! + R[8]! * t[2]!)];
  const depth = new Float32Array(W * H).fill(Infinity);
  const col = new Float32Array(W * H * 3);
  // Sky: a soft vertical gradient.
  for (let y = 0; y < H; y += 1) {
    const s = y / H;
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 3;
      col[i] = 0.55 - 0.2 * s;
      col[i + 1] = 0.62 - 0.2 * s;
      col[i + 2] = 0.72 - 0.15 * s;
    }
  }
  const light = [0.3, -0.8, -0.5];
  const ln = Math.hypot(...light);
  for (const q of quads) {
    const u = q.u;
    const v = q.v;
    const uu = u[0] * u[0] + u[1] * u[1] + u[2] * u[2];
    const vv = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    const n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const nn = Math.hypot(...n);
    const shade = 0.55 + 0.45 * Math.abs((n[0] * light[0]! + n[1] * light[1]! + n[2] * light[2]!) / (nn * ln));
    const aspect = Math.sqrt(vv / uu);
    // Screen bounding box from the corners (all four in front), with a margin for distortion.
    const corners: Vec3[] = [q.origin, add(q.origin, u), add(add(q.origin, u), v), add(q.origin, v)];
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let behind = false;
    for (const P of corners) {
      const xc = R[0]! * P[0] + R[1]! * P[1] + R[2]! * P[2] + t[0]!;
      const yc = R[3]! * P[0] + R[4]! * P[1] + R[5]! * P[2] + t[1]!;
      const zc = R[6]! * P[0] + R[7]! * P[1] + R[8]! * P[2] + t[2]!;
      if (zc <= 0.05) {
        behind = true;
        break;
      }
      const px = o.intr.f * (xc / zc) + o.intr.cx;
      const py = o.intr.f * (yc / zc) + o.intr.cy;
      x0 = Math.min(x0, px);
      y0 = Math.min(y0, py);
      x1 = Math.max(x1, px);
      y1 = Math.max(y1, py);
    }
    let sx0 = 0;
    let sy0 = 0;
    let sx1 = W - 1;
    let sy1 = H - 1;
    if (!behind) {
      const marginPx = 0.12 * Math.max(o.width, o.height) * (Math.abs(o.intr.k1) + Math.abs(o.intr.k2) + Math.abs(o.intr.p1) + Math.abs(o.intr.p2)) + 2;
      sx0 = Math.max(0, Math.floor((x0 - marginPx + 0.5) * ss));
      sy0 = Math.max(0, Math.floor((y0 - marginPx + 0.5) * ss));
      sx1 = Math.min(W - 1, Math.ceil((x1 + marginPx + 0.5) * ss));
      sy1 = Math.min(H - 1, Math.ceil((y1 + marginPx + 0.5) * ss));
      if (sx0 > sx1 || sy0 > sy1) continue;
    }
    const oc: Vec3 = [q.origin[0] - C[0], q.origin[1] - C[1], q.origin[2] - C[2]];
    const num = n[0] * oc[0] + n[1] * oc[1] + n[2] * oc[2];
    for (let y = sy0; y <= sy1; y += 1) {
      for (let x = sx0; x <= sx1; x += 1) {
        const i = y * W + x;
        const rx = rays[2 * i]!;
        const ry = rays[2 * i + 1]!;
        // World direction d = Rᵀ (rx, ry, 1)
        const dx = R[0]! * rx + R[3]! * ry + R[6]!;
        const dy = R[1]! * rx + R[4]! * ry + R[7]!;
        const dz = R[2]! * rx + R[5]! * ry + R[8]!;
        const den = n[0] * dx + n[1] * dy + n[2] * dz;
        if (Math.abs(den) < 1e-12) continue;
        const s = num / den; // depth along the ray (z = 1 in camera space)
        if (s <= 0.01 || s >= depth[i]!) continue;
        const px = C[0] + s * dx - q.origin[0];
        const py = C[1] + s * dy - q.origin[1];
        const pz = C[2] + s * dz - q.origin[2];
        const a = (px * u[0] + py * u[1] + pz * u[2]) / uu;
        const b = (px * v[0] + py * v[1] + pz * v[2]) / vv;
        if (a < 0 || a > 1 || b < 0 || b > 1) continue;
        depth[i] = s;
        const c = textureAt(q.texture, a, b, aspect);
        col[3 * i] = c[0] * shade;
        col[3 * i + 1] = c[1] * shade;
        col[3 * i + 2] = c[2] * shade;
      }
    }
  }
  // Box-filter the samples down.
  const out = new Uint8Array(o.width * o.height * 3);
  const k = 1 / (ss * ss);
  for (let y = 0; y < o.height; y += 1)
    for (let x = 0; x < o.width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < ss; j += 1)
        for (let i = 0; i < ss; i += 1) {
          const s = ((y * ss + j) * W + x * ss + i) * 3;
          r += col[s]!;
          g += col[s + 1]!;
          b += col[s + 2]!;
        }
      const o3 = (y * o.width + x) * 3;
      out[o3] = Math.round(Math.min(1, Math.max(0, r * k)) * 255);
      out[o3 + 1] = Math.round(Math.min(1, Math.max(0, g * k)) * 255);
      out[o3 + 2] = Math.round(Math.min(1, Math.max(0, b * k)) * 255);
    }
  return { width: o.width, height: o.height, data: out };
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

/** Axis-aligned box as its five visible faces' quads (no bottom). Y is down: `y` is the top. */
function box(c: Vec3, size: Vec3, texture: Texture, name: string): Quad[] {
  const [x, y, z] = c;
  const [sx, sy, sz] = size;
  const x0 = x - sx / 2;
  const z0 = z - sz / 2;
  return [
    { name: `${name} front`, origin: [x0, y, z0], u: [sx, 0, 0], v: [0, sy, 0], texture },
    { name: `${name} back`, origin: [x0, y, z0 + sz], u: [sx, 0, 0], v: [0, sy, 0], texture: { ...texture, seed: texture.seed + 1 } },
    { name: `${name} left`, origin: [x0, y, z0], u: [0, 0, sz], v: [0, sy, 0], texture: { ...texture, seed: texture.seed + 2 } },
    { name: `${name} right`, origin: [x0 + sx, y, z0], u: [0, 0, sz], v: [0, sy, 0], texture: { ...texture, seed: texture.seed + 3 } },
    { name: `${name} top`, origin: [x0, y, z0], u: [sx, 0, 0], v: [0, 0, sz], texture: { ...texture, seed: texture.seed + 4 } },
  ];
}

/**
 * A small set: a textured floor, back and side walls, some boxes, a poster and
 * a screen, in the solver's Y-down world (the camera starts near the origin
 * looking down +Z). Units are metres.
 */
export function roomScene(seed = 1): Quad[] {
  const r = rng(seed);
  const tint = (): Vec3 => [0.75 + 0.25 * r(), 0.75 + 0.25 * r(), 0.75 + 0.25 * r()];
  const quads: Quad[] = [
    { name: 'floor', origin: [-9, 2, 2], u: [18, 0, 0], v: [0, 0, 26], texture: { kind: 'tiles', cells: 22, seed: seed + 11, tint: [0.95, 0.85, 0.7] } },
    { name: 'back wall', origin: [-9, -6, 28], u: [18, 0, 0], v: [0, 8, 0], texture: { kind: 'tiles', cells: 26, seed: seed + 12, tint: [0.85, 0.9, 1] } },
    { name: 'left wall', origin: [-9, -6, 2], u: [0, 0, 26], v: [0, 8, 0], texture: { kind: 'tiles', cells: 30, seed: seed + 13, tint: [1, 0.9, 0.85] } },
    { name: 'right wall', origin: [9, -6, 2], u: [0, 0, 26], v: [0, 8, 0], texture: { kind: 'tiles', cells: 30, seed: seed + 14, tint: [0.9, 1, 0.9] } },
    { name: 'poster', origin: [-3.2, -3.2, 27.9], u: [2.4, 0, 0], v: [0, 1.6, 0], texture: { kind: 'checker', cells: 8, seed: seed + 15, tint: [1, 0.95, 0.8] } },
    { name: 'screen', origin: [1.2, -3.6, 27.85], u: [3.2, 0, 0], v: [0, 1.8, 0], texture: { kind: 'screen', cells: 1, seed: seed + 16, tint: [0.75, 0.9, 1] } },
  ];
  quads.push(...box([-4, 0.8, 12], [2, 1.2, 2], { kind: 'tiles', cells: 6, seed: seed + 20, tint: tint() }, 'box A'));
  quads.push(...box([3.5, 0.4, 16], [2.5, 1.6, 1.6], { kind: 'tiles', cells: 7, seed: seed + 30, tint: tint() }, 'box B'));
  quads.push(...box([0.5, 1.2, 9], [1.2, 0.8, 1.2], { kind: 'tiles', cells: 5, seed: seed + 40, tint: tint() }, 'box C'));
  quads.push(...box([-1.5, -0.5, 20], [1.6, 2.5, 1.6], { kind: 'tiles', cells: 6, seed: seed + 50, tint: tint() }, 'pillar'));
  return quads;
}

/** Sample points on the quads' surfaces (a synthetic LiDAR scan), with the texture's colour. */
export function sampleSurface(quads: readonly Quad[], spacing: number, seed = 9): { points: Float32Array; colors: Uint8Array } {
  const r = rng(seed);
  const pts: number[] = [];
  const cols: number[] = [];
  for (const q of quads) {
    const lu = Math.hypot(...q.u);
    const lv = Math.hypot(...q.v);
    const n = Math.max(4, Math.round((lu * lv) / (spacing * spacing)));
    for (let i = 0; i < n; i += 1) {
      const a = r();
      const b = r();
      pts.push(q.origin[0] + a * q.u[0] + b * q.v[0], q.origin[1] + a * q.u[1] + b * q.v[1], q.origin[2] + a * q.u[2] + b * q.v[2]);
      const c = textureAt(q.texture, a, b, lv / lu);
      cols.push(Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255));
    }
  }
  return { points: Float32Array.from(pts), colors: Uint8Array.from(cols) };
}
