import type { LinearImage } from '../key/linear';

/**
 * A synthetic clean-plate shot with exact ground truth (addendum 10 §6),
 * rendered in scene-linear light, frame by frame, deterministically. The
 * tests measure the reconstruction against it; the browser preview, which has
 * no media, builds clean plates of it for real.
 *
 * A textured wall (band-limited value noise in several octaves, mortar lines,
 * a few warm and cool patches, so there are corners to track and nothing
 * aliases) seen by a camera that pans, zooms and rolls a little — each frame
 * is the wall through a known homography. In front of it a crew member (a
 * textured capsule-and-head figure, soft-edged) walks across the frame, and a
 * light stand stands still in the world: what it hides is never seen, the
 * area a clean plate cannot reconstruct and must flag. Optionally the
 * exposure drifts (a per-frame gain), and sensor noise.
 */

export interface CleanPlateSceneOptions {
  width?: number;
  height?: number;
  frames?: number;
  /** Camera motion: 'pan' (pan, zoom and roll), 'static' (locked off). */
  camera?: 'pan' | 'static';
  /** Pixels the camera pans over the shot (at this size). */
  pan?: number;
  /** Exposure drift amplitude (0: none; 0.1: ±10 %). */
  drift?: number;
  /** Noise σ in linear units. */
  noise?: number;
  /** Include the light stand that is never moved (an area never revealed). */
  stand?: boolean;
  seed?: number;
}

export interface CleanPlateScene {
  width: number;
  height: number;
  frames: number;
  /** The frame as shot: linear RGB. */
  render(n: number): LinearImage;
  /** The ground truth clean plate of frame n (the wall alone, same exposure). */
  clean(n: number): LinearImage;
  /** Coverage of the walking crew member (0…1). */
  crew(n: number): Float32Array;
  /** Coverage of the light stand (0…1). */
  stand(n: number): Float32Array;
  /** Ground truth: frame `a` pixel → frame `b` pixel (row-major 3×3). */
  homography(a: number, b: number): number[];
  /** Exposure gain of frame n. */
  gain(n: number): number;
}

const hash = (x: number, y: number, s: number): number => {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** Smooth value noise (quintic interpolation), period `scale` world units. */
function valueNoise(x: number, y: number, scale: number, seed: number): number {
  const fx = x / scale;
  const fy = y / scale;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const sx = tx * tx * tx * (tx * (tx * 6 - 15) + 10);
  const sy = ty * ty * ty * (ty * (ty * 6 - 15) + 10);
  const a = hash(x0, y0, seed);
  const b = hash(x0 + 1, y0, seed);
  const c = hash(x0, y0 + 1, seed);
  const d = hash(x0 + 1, y0 + 1, seed);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}

export const mul3 = (a: readonly number[], b: readonly number[]): number[] => {
  const o = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) for (let k = 0; k < 3; k += 1) o[i * 3 + j]! += a[i * 3 + k]! * b[k * 3 + j]!;
  return o;
};

export function inv3(m: readonly number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const inv = [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det);
  return inv.map((v) => v / inv[8]!);
}

export function cleanPlateScene(options: CleanPlateSceneOptions = {}): CleanPlateScene {
  const width = options.width ?? 320;
  const height = options.height ?? 180;
  const frames = options.frames ?? 24;
  const seed = options.seed ?? 7;
  const u = height / 180;
  const pan = options.camera === 'static' ? 0 : (options.pan ?? 0.3 * width);
  const drift = options.drift ?? 0;
  const noise = options.noise ?? 0;
  const withStand = options.stand ?? true;

  /** Image pixel → wall (world) coordinates for frame n: a pan, a slow zoom and a little roll about the frame centre. */
  const toWorld = (n: number): number[] => {
    if (options.camera === 'static') return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const t = frames > 1 ? n / (frames - 1) : 0;
    const s = 1 + 0.06 * (t - 0.5); // zoom
    const r = 0.02 * Math.sin(Math.PI * t); // roll, radians
    const tx = pan * (t - 0.5);
    const ty = 0.08 * pan * Math.sin(2 * Math.PI * t);
    const cx = width / 2;
    const cy = height / 2;
    const cos = Math.cos(r) * s;
    const sin = Math.sin(r) * s;
    // A slight keystone so it is a true homography, not just a similarity.
    const k = 0.00004 * (t - 0.5) / u;
    const M = [cos, -sin, cx + tx, sin, cos, cy + ty, k, 0, 1];
    return mul3(M, [1, 0, -cx, 0, 1, -cy, 0, 0, 1]);
  };
  const worldOf = Array.from({ length: frames }, (_, n) => toWorld(n));

  const wall = (X: number, Y: number): [number, number, number] => {
    const n1 = valueNoise(X, Y, 24 * u, seed);
    const n2 = valueNoise(X, Y, 11 * u, seed + 1);
    const n3 = valueNoise(X, Y, 6 * u, seed + 2);
    const big = valueNoise(X, Y, 70 * u, seed + 3);
    // Mortar: soft dark lines of a brick bond.
    const by = Y / (14 * u);
    const row = Math.floor(by);
    const bx = X / (30 * u) + (row % 2 ? 0.5 : 0);
    const dy = Math.abs(by - Math.round(by)) * 14 * u;
    const dx = Math.abs(bx - Math.round(bx)) * 30 * u;
    const mortar = Math.min(1, Math.exp(-((dy / (1.2 * u)) ** 2)) + Math.exp(-((dx / (1.2 * u)) ** 2)));
    const lum = 0.08 + 0.16 * n1 + 0.08 * n2 + 0.04 * n3;
    const warm = 0.5 + 0.5 * (big - 0.5) * 2;
    const r = lum * (1.1 + 0.35 * warm);
    const g = lum * (0.92 + 0.1 * warm);
    const b = lum * (0.85 - 0.25 * warm);
    const m = 1 - 0.55 * mortar;
    return [r * m, g * m, b * m];
  };

  /**
   * The wall, tabulated once at 2 samples per world unit over everything the
   * camera sees, and read bilinearly: the frames and the ground truth are both
   * made from this table, so the truth is exact, and a frame costs a lookup.
   */
  const corners: [number, number][] = [];
  for (const G of worldOf)
    for (const [x, y] of [
      [0, 0],
      [width, 0],
      [width, height],
      [0, height],
    ] as const) {
      const w = G[6]! * x + G[7]! * y + G[8]!;
      corners.push([(G[0]! * x + G[1]! * y + G[2]!) / w, (G[3]! * x + G[4]! * y + G[5]!) / w]);
    }
  const TX0 = Math.floor(Math.min(...corners.map((c) => c[0])) - 4);
  const TY0 = Math.floor(Math.min(...corners.map((c) => c[1])) - 4);
  const TS = 2;
  const TW = Math.ceil((Math.max(...corners.map((c) => c[0])) + 4 - TX0) * TS) + 2;
  const TH = Math.ceil((Math.max(...corners.map((c) => c[1])) + 4 - TY0) * TS) + 2;
  const table = new Float32Array(TW * TH * 3);
  for (let j = 0; j < TH; j += 1)
    for (let i = 0; i < TW; i += 1) {
      const v = wall(TX0 + i / TS, TY0 + j / TS);
      const o = 3 * (j * TW + i);
      table[o] = v[0];
      table[o + 1] = v[1];
      table[o + 2] = v[2];
    }
  const wallAt = (X: number, Y: number): [number, number, number] => {
    const fx = Math.min(TW - 1.001, Math.max(0, (X - TX0) * TS));
    const fy = Math.min(TH - 1.001, Math.max(0, (Y - TY0) * TS));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const a = 3 * (y0 * TW + x0);
    const b = a + 3;
    const c = a + 3 * TW;
    const d = c + 3;
    const out: [number, number, number] = [0, 0, 0];
    for (let k = 0; k < 3; k += 1) {
      const top = table[a + k]! + (table[b + k]! - table[a + k]!) * tx;
      const bot = table[c + k]! + (table[d + k]! - table[c + k]!) * tx;
      out[k] = top + (bot - top) * ty;
    }
    return out;
  };

  const cover = (sd: number) => (sd <= -0.5 ? 1 : sd >= 0.5 ? 0 : 0.5 - sd);
  const capsule = (px: number, py: number, ax: number, ay: number, bx: number, by: number, r: number) => {
    const dx = bx - ax;
    const dy = by - ay;
    let t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(ax + t * dx - px, ay + t * dy - py) - r;
  };

  /** The crew member walks across the wall (world coordinates) from left to right. */
  const crewAt = (n: number) => {
    const t = frames > 1 ? n / (frames - 1) : 0;
    // Start and end in world coordinates so the figure crosses the frame whatever the camera does.
    const cx = width * (0.12 + 0.76 * t) + pan * (t - 0.5);
    const top = height * 0.18;
    return { cx, top, bob: 2 * u * Math.sin(2 * Math.PI * t * 4) };
  };
  const stand = { x0: width * 0.62, x1: width * 0.62 + 9 * u, y0: height * 0.3, y1: height * 1.1 };

  interface Layers {
    crew: Float32Array;
    crewRgb: Float32Array;
    stand: Float32Array;
    clean: Float32Array;
  }
  /** The two mattes alone (no wall texture): what a roto of them would give. */
  const matteCache = new Map<number, { crew: Float32Array; stand: Float32Array }>();
  const mattes = (n: number) => {
    const hit = matteCache.get(n);
    if (hit) return hit;
    const G = worldOf[Math.max(0, Math.min(frames - 1, n))]!;
    const crew = new Float32Array(width * height);
    const standA = new Float32Array(width * height);
    const c = crewAt(n);
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) {
        const i = y * width + x;
        const w = G[6]! * x + G[7]! * y + G[8]!;
        const X = (G[0]! * x + G[1]! * y + G[2]!) / w;
        const Y = (G[3]! * x + G[4]! * y + G[5]!) / w;
        // Cheap reject far from the figure.
        if (Math.abs(X - c.cx) < 40 * u && Y > c.top - 4 * u) {
          const head = Math.hypot(X - c.cx, Y - (c.top + 12 * u + c.bob)) - 11 * u;
          const body = capsule(X, Y, c.cx, c.top + 30 * u + c.bob, c.cx, c.top + 95 * u, 17 * u);
          const legs = capsule(X, Y, c.cx - 6 * u, c.top + 95 * u, c.cx - 8 * u, height * 1.2, 7 * u);
          const legs2 = capsule(X, Y, c.cx + 6 * u, c.top + 95 * u, c.cx + 9 * u, height * 1.2, 7 * u);
          crew[i] = cover(Math.min(head, body, legs, legs2));
        }
        if (withStand) standA[i] = cover(Math.max(stand.x0 - X, X - stand.x1, stand.y0 - Y, Y - stand.y1));
      }
    const out = { crew, stand: standA };
    matteCache.set(n, out);
    if (matteCache.size > 96) matteCache.delete(matteCache.keys().next().value!);
    return out;
  };

  const cache = new Map<number, Layers>();
  const layers = (n: number): Layers => {
    const hit = cache.get(n);
    if (hit) return hit;
    const G = worldOf[Math.max(0, Math.min(frames - 1, n))]!;
    const { crew, stand: standA } = mattes(n);
    const crewRgb = new Float32Array(width * height * 3);
    const clean = new Float32Array(width * height * 3);
    const gain = 1 + drift * Math.sin((2 * Math.PI * n) / Math.max(8, frames / 2));
    const c = crewAt(n);
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) {
        const i = y * width + x;
        const w = G[6]! * x + G[7]! * y + G[8]!;
        const X = (G[0]! * x + G[1]! * y + G[2]!) / w;
        const Y = (G[3]! * x + G[4]! * y + G[5]!) / w;
        const [r, g, b] = wallAt(X, Y);
        clean[3 * i] = r * gain;
        clean[3 * i + 1] = g * gain;
        clean[3 * i + 2] = b * gain;
        // The crew member, in world coordinates (so it moves with the wall plus its walk).
        if (crew[i]! > 0) {
          const shade = 0.6 + 0.4 * valueNoise(X, Y, 5 * u, seed + 9);
          const isHead = Y < c.top + 24 * u + c.bob;
          crewRgb[3 * i] = (isHead ? 0.5 : 0.05) * shade * gain;
          crewRgb[3 * i + 1] = (isHead ? 0.3 : 0.07) * shade * gain;
          crewRgb[3 * i + 2] = (isHead ? 0.22 : 0.16) * shade * gain;
        }
      }
    const out = { crew, crewRgb, stand: standA, clean };
    cache.set(n, out);
    if (cache.size > 12) cache.delete(cache.keys().next().value!);
    return out;
  };

  return {
    width,
    height,
    frames,
    gain: (n) => 1 + drift * Math.sin((2 * Math.PI * n) / Math.max(8, frames / 2)),
    homography: (a, b) => mul3(inv3(worldOf[b]!), worldOf[a]!).map((v, _i, arr) => v / arr[8]!),
    crew: (n) => mattes(n).crew.slice(),
    stand: (n) => mattes(n).stand.slice(),
    clean: (n) => ({ width, height, data: layers(n).clean.slice() }),
    render(n) {
      const L = layers(n);
      const data = new Float32Array(width * height * 3);
      const gain = 1 + drift * Math.sin((2 * Math.PI * n) / Math.max(8, frames / 2));
      for (let i = 0; i < width * height; i += 1) {
        const ac = L.crew[i]!;
        const as = L.stand[i]!;
        for (let ch = 0; ch < 3; ch += 1) {
          let v = L.clean[3 * i + ch]! * (1 - ac) + L.crewRgb[3 * i + ch]!;
          // The light stand: dark metal, in front of everything.
          v = v * (1 - as) + as * 0.03 * gain;
          if (noise) v += (hash(i, ch, seed * 7919 + n) + hash(i, ch + 3, seed * 31 + n) - 1) * noise * 2.45;
          data[3 * i + ch] = v;
        }
      }
      return { width, height, data };
    },
  };
}
