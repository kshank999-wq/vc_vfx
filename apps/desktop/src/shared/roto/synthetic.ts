import type { RGBImage } from './image';

/**
 * Synthetic shots for the roto engines (addendum 04): rendered frame by
 * frame, deterministically, with exact ground-truth mattes. The tests measure
 * the engines against them; the browser preview, which has no media, paints
 * on the "figure" scene so paint-to-roto can be tried for real.
 */

const hash = (x: number, y: number, s: number): number => {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** Smooth value noise, 0…1. */
function valueNoise(x: number, y: number, cell: number, seed: number): number {
  const fx = x / cell;
  const fy = y / cell;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const a = hash(x0, y0, seed);
  const b = hash(x0 + 1, y0, seed);
  const c = hash(x0, y0 + 1, seed);
  const d = hash(x0 + 1, y0 + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

export interface SyntheticScene {
  width: number;
  height: number;
  frames: number;
  render(n: number): RGBImage;
  /** Ground truth: 1 inside the part (default: the whole subject). */
  truth(n: number, part?: string): Uint8Array;
  parts: string[];
}

const clamp8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

export interface DiscOptions {
  width?: number;
  height?: number;
  frames?: number;
  radius?: number;
  /** Pixels per frame. */
  speed?: [number, number];
  /** Sensor noise, code values (σ-ish). */
  noise?: number;
  /** From this frame on the disc jumps far away — a failure propagation cannot follow. */
  teleportAt?: number;
  seed?: number;
}

/** A moving orange disc over a textured background, with noise. */
export function discScene(options: DiscOptions = {}): SyntheticScene {
  const width = options.width ?? 320;
  const height = options.height ?? 240;
  const frames = options.frames ?? 24;
  const radius = options.radius ?? Math.round(Math.min(width, height) * 0.15);
  const [vx, vy] = options.speed ?? [4, 1.5];
  const noise = options.noise ?? 6;
  const seed = options.seed ?? 3;
  const centre = (n: number): [number, number] => {
    const jump = options.teleportAt !== undefined && n >= options.teleportAt ? [width * 0.38, -height * 0.05] : [0, 0];
    return [width * 0.25 + vx * n + jump[0]!, height * 0.45 + vy * n + jump[1]!];
  };
  const background = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const t = valueNoise(x, y, 18, seed) * 0.6 + valueNoise(x, y, 5, seed + 1) * 0.4;
    const stripe = Math.sin(x / 7 + y / 11) * 0.5 + 0.5;
    const i = (y * width + x) * 3;
    background[i] = 60 + 70 * t + 18 * stripe;
    background[i + 1] = 80 + 60 * t + 10 * stripe;
    background[i + 2] = 95 + 55 * t;
  }
  const inside = (n: number, x: number, y: number) => {
    const [cx, cy] = centre(n);
    return (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= radius * radius;
  };
  return {
    width,
    height,
    frames,
    parts: ['subject'],
    render(n) {
      const data = new Uint8Array(width * height * 3);
      const [cx, cy] = centre(n);
      for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 3;
        let r = background[i]!;
        let g = background[i + 1]!;
        let b = background[i + 2]!;
        // Anti-aliased edge, gentle shading inside.
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const a = Math.min(1, Math.max(0, radius - d + 0.5));
        if (a > 0) {
          const shade = 1 - 0.25 * ((x - cx + radius) / (2 * radius));
          r = r * (1 - a) + 235 * shade * a;
          g = g * (1 - a) + 120 * shade * a;
          b = b * (1 - a) + 40 * shade * a;
        }
        const nz = (hash(x, y, seed * 977 + n) - 0.5) * 2 * noise;
        data[i] = clamp8(r + nz);
        data[i + 1] = clamp8(g + nz * 0.9);
        data[i + 2] = clamp8(b + nz * 1.1);
      }
      return { width, height, data };
    },
    truth(n) {
      const out = new Uint8Array(width * height);
      for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) out[y * width + x] = inside(n, x, y) ? 1 : 0;
      return out;
    },
  };
}

interface Shape {
  part: string;
  color: [number, number, number];
  inside(x: number, y: number): boolean;
}

const capsule = (ax: number, ay: number, bx: number, by: number, r: number) => (x: number, y: number) => {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((x - ax) * dx + (y - ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return (ax + t * dx - x) ** 2 + (ay + t * dy - y) ** 2 <= r * r;
};

/**
 * A figure walking across a textured wall: head, torso, a swinging arm and
 * legs — the preview's demo shot, with parts for the hierarchy.
 */
export function figureScene(options: { width?: number; height?: number; frames?: number; seed?: number } = {}): SyntheticScene {
  const width = options.width ?? 640;
  const height = options.height ?? 338;
  const frames = options.frames ?? 128;
  const seed = options.seed ?? 5;
  const u = height / 338;
  const background = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const i = (y * width + x) * 3;
    const t = valueNoise(x, y, 26 * u, seed) * 0.55 + valueNoise(x, y, 6 * u, seed + 1) * 0.45;
    if (y > height * 0.82) {
      // Floor.
      const plank = Math.floor(x / (60 * u)) % 2;
      background[i] = 92 + 30 * t + 8 * plank;
      background[i + 1] = 84 + 26 * t + 6 * plank;
      background[i + 2] = 70 + 20 * t;
    } else {
      // A teal wall with panels.
      const panel = (Math.floor(x / (110 * u)) + Math.floor(y / (90 * u))) % 2;
      background[i] = 52 + 34 * t + 6 * panel;
      background[i + 1] = 98 + 40 * t + 6 * panel;
      background[i + 2] = 102 + 38 * t + 4 * panel;
    }
  }
  const shapes = (n: number): Shape[] => {
    const p = n / Math.max(1, frames - 1);
    const cx = width * (0.22 + 0.5 * p);
    const bob = Math.sin(n * 0.5) * 3 * u;
    const top = height * 0.2 + bob;
    const swing = Math.sin(n * 0.25) * 0.6;
    const shoulderX = cx + 4 * u;
    const shoulderY = top + 70 * u;
    const armLen = 78 * u;
    const handX = shoulderX + Math.sin(swing) * armLen;
    const handY = shoulderY + Math.cos(swing) * armLen;
    const stride = Math.sin(n * 0.25) * 18 * u;
    const hipY = top + 150 * u;
    return [
      { part: 'legs', color: [38, 46, 92], inside: capsule(cx - 8 * u, hipY, cx - 8 * u - stride, height * 0.86, 11 * u) },
      { part: 'legs', color: [38, 46, 92], inside: capsule(cx + 8 * u, hipY, cx + 8 * u + stride, height * 0.86, 11 * u) },
      { part: 'torso', color: [168, 42, 52], inside: (x, y) => Math.abs(x - cx) <= 28 * u && y >= top + 52 * u && y <= hipY + 6 * u && !(y < top + 60 * u && Math.abs(x - cx) > 22 * u) },
      { part: 'head', color: [226, 176, 142], inside: (x, y) => (x - cx) ** 2 + (y - (top + 28 * u)) ** 2 <= (22 * u) ** 2 },
      { part: 'arm', color: [186, 52, 60], inside: capsule(shoulderX, shoulderY, handX, handY, 10 * u) },
      { part: 'arm', color: [226, 176, 142], inside: (x, y) => (x - handX) ** 2 + (y - handY) ** 2 <= (10 * u) ** 2 },
    ];
  };
  return {
    width,
    height,
    frames,
    parts: ['subject', 'head', 'torso', 'arm', 'legs'],
    render(n) {
      const data = new Uint8Array(width * height * 3);
      const list = shapes(n);
      for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 3;
        let rgb: [number, number, number] = [background[i]!, background[i + 1]!, background[i + 2]!];
        // 2×2 supersampling for soft edges.
        let acc = [0, 0, 0];
        let any = false;
        for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]] as const) {
          let c: [number, number, number] = rgb;
          for (const s of list) if (s.inside(x + ox, y + oy)) {
            c = s.color;
            any = true;
          }
          acc = [acc[0]! + c[0], acc[1]! + c[1], acc[2]! + c[2]];
        }
        if (any) rgb = [acc[0]! / 4, acc[1]! / 4, acc[2]! / 4];
        const nz = (hash(x, y, seed * 131 + n) - 0.5) * 8;
        data[i] = clamp8(rgb[0] + nz);
        data[i + 1] = clamp8(rgb[1] + nz);
        data[i + 2] = clamp8(rgb[2] + nz);
      }
      return { width, height, data };
    },
    truth(n, part = 'subject') {
      const out = new Uint8Array(width * height);
      const list = shapes(n).filter((s) => part === 'subject' || s.part === part);
      for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) if (list.some((s) => s.inside(x + 0.5, y + 0.5))) out[y * width + x] = 1;
      return out;
    },
  };
}
