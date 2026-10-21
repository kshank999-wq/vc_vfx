import { buildPyramid, trackPoints, type PyramidLevel } from '../roto/flow';
import { sampleBilinear } from '../roto/image';
import { detectCorners } from './features';
import { median } from './linalg';
import { TrackBuilder, type TrackData } from './tracks';

/**
 * Feature tracking through a shot for the camera solver (addendum 06):
 * Shi–Tomasi corners tracked frame to frame with roto's pyramidal
 * Lucas–Kanade (Bouguet), each step checked forward–backward and by the
 * normalised cross-correlation of the window, seeded with the median motion of
 * the previous step, with fresh corners detected where tracks have thinned
 * out. Regions can be excluded per frame (moving objects: a roto matte, a
 * drawn rectangle). Positions are recorded in plate pixels.
 */

export interface GrayFrame {
  width: number;
  height: number;
  /** Luma 0 … 1. */
  data: Float32Array;
}

export interface TrackFramesIO {
  /** A frame at the working size. */
  frame(f: number): Promise<GrayFrame>;
  /** Where features are allowed on a frame (1) at the working size; null: everywhere. */
  mask?(f: number): Promise<Uint8Array | null>;
}

export interface KltOptions {
  maxFeatures?: number;
  /** Minimum distance between features, working pixels. */
  minDistance?: number;
  quality?: number;
  /** Lucas–Kanade window half-size. */
  window?: number;
  levels?: number;
  /** Forward–backward error allowed, working pixels. */
  fbThreshold?: number;
  /** Window NCC (frame to frame) below which a track stops. */
  minNcc?: number;
  /** Detect new corners when the live tracks fall below this share of maxFeatures. */
  redetect?: number;
  /** Tracks shorter than this are dropped. */
  minLength?: number;
  /** Detect on the first frame only (then just follow those features). */
  detectOnce?: boolean;
}

export const KLT_DEFAULTS: Required<KltOptions> = { maxFeatures: 500, minDistance: 0, quality: 0.01, window: 7, levels: 0, fbThreshold: 0.5, minNcc: 0.8, redetect: 0.85, minLength: 4, detectOnce: false };
export const KLT_VERSION = '1.0.0';

export interface TrackRunRequest {
  /** Delivered numbers of the shot's range. */
  first: number;
  last: number;
  /** Track from this frame to `to` (backward when to < from). */
  from: number;
  to: number;
  working: { width: number; height: number };
  plate: { width: number; height: number };
  /** Only detect inside this rectangle (plate pixels). */
  region?: { x0: number; y0: number; x1: number; y1: number } | null;
  /** First id to use (so new tracks never collide with existing ones). */
  nextId?: number;
  options?: KltOptions;
}

export interface TrackRunContext {
  signal?: { aborted: boolean };
  progress?: (done: number, total: number, frame: number) => void;
  yieldNow?: () => Promise<void>;
}

export class TrackCancelled extends Error {
  constructor() {
    super('Cancelled');
  }
}

/** NCC of two (2r+1)² windows centred on fractional points. */
function windowNcc(a: Float32Array, b: Float32Array, w: number, h: number, ax: number, ay: number, bx: number, by: number, r: number): number {
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  let n = 0;
  for (let j = -r; j <= r; j += 1)
    for (let i = -r; i <= r; i += 1) {
      const va = sampleBilinear(a, w, h, ax + i, ay + j);
      const vb = sampleBilinear(b, w, h, bx + i, by + j);
      sa += va;
      sb += vb;
      saa += va * va;
      sbb += vb * vb;
      sab += va * vb;
      n += 1;
    }
  const ca = saa - (sa * sa) / n;
  const cb = sbb - (sb * sb) / n;
  if (ca <= 1e-9 || cb <= 1e-9) return 0;
  return (sab - (sa * sb) / n) / Math.sqrt(ca * cb);
}

/** Track features through frames. */
export async function trackFrames(io: TrackFramesIO, req: TrackRunRequest, ctx: TrackRunContext = {}): Promise<TrackData> {
  const o = { ...KLT_DEFAULTS, ...(req.options ?? {}) };
  const { width: W, height: H } = req.working;
  const sx = req.plate.width / W;
  const sy = req.plate.height / H;
  const toPlate = (x: number, y: number): [number, number] => [(x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5];
  const toWork = (x: number, y: number): [number, number] => [(x + 0.5) / sx - 0.5, (y + 0.5) / sy - 0.5];
  const levels = o.levels || Math.max(3, Math.min(6, Math.round(Math.log2(Math.max(W, H) / 40))));
  const minDistance = o.minDistance || Math.max(5, Math.round(Math.max(W, H) / 110));
  const dir = req.to >= req.from ? 1 : -1;
  const frames: number[] = [];
  for (let f = req.from; dir > 0 ? f <= req.to : f >= req.to; f += dir) if (f >= req.first && f <= req.last) frames.push(f);
  // Live tracks: working-pixel position and the positions so far (plate pixels, in visit order).
  interface Live {
    x: number;
    y: number;
    visits: number[];
    startFrame: number;
  }
  const finished: Live[] = [];
  let live: Live[] = [];
  let prev: { f: number; pyr: PyramidLevel[]; gray: Float32Array } | null = null;
  let velocity: [number, number] = [0, 0];
  const region = req.region
    ? (() => {
        const a = toWork(req.region.x0, req.region.y0);
        const b = toWork(req.region.x1, req.region.y1);
        return { x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1]) };
      })()
    : null;
  const inRegion = (x: number, y: number) => !region || (x >= region.x0 && x <= region.x1 && y >= region.y0 && y <= region.y1);
  const margin = 3;
  for (let k = 0; k < frames.length; k += 1) {
    if (ctx.signal?.aborted) throw new TrackCancelled();
    const f = frames[k]!;
    const g = await io.frame(f);
    if (g.width !== W || g.height !== H) throw new Error(`Frame ${f} is ${g.width}×${g.height}, expected ${W}×${H}`);
    const mask = io.mask ? await io.mask(f) : null;
    const pyr = buildPyramid(g.data, W, H, levels);
    if (prev && live.length) {
      const pts = new Float32Array(live.length * 2);
      live.forEach((t, i) => {
        pts[2 * i] = t.x;
        pts[2 * i + 1] = t.y;
      });
      const fwd = trackPoints(prev.pyr, pyr, pts, { win: o.window, guess: velocity, iterations: 12 });
      const moved = new Float32Array(live.length * 2);
      for (let i = 0; i < live.length; i += 1) {
        moved[2 * i] = pts[2 * i]! + fwd.dx[i]!;
        moved[2 * i + 1] = pts[2 * i + 1]! + fwd.dy[i]!;
      }
      const bwd = trackPoints(pyr, prev.pyr, moved, { win: o.window, guess: [-velocity[0], -velocity[1]], iterations: 12 });
      const next: Live[] = [];
      const dxs: number[] = [];
      const dys: number[] = [];
      for (let i = 0; i < live.length; i += 1) {
        const t = live[i]!;
        const nx = moved[2 * i]!;
        const ny = moved[2 * i + 1]!;
        const bx = nx + bwd.dx[i]!;
        const by = ny + bwd.dy[i]!;
        const fb = Math.hypot(bx - t.x, by - t.y);
        let keep = fwd.ok[i] === 1 && bwd.ok[i] === 1 && fb <= o.fbThreshold && nx >= margin && ny >= margin && nx <= W - 1 - margin && ny <= H - 1 - margin;
        if (keep && mask && !mask[Math.round(ny) * W + Math.round(nx)]) keep = false;
        if (keep && o.minNcc > 0 && windowNcc(prev.gray, g.data, W, H, t.x, t.y, nx, ny, 4) < o.minNcc) keep = false;
        if (keep) {
          dxs.push(nx - t.x);
          dys.push(ny - t.y);
          t.x = nx;
          t.y = ny;
          t.visits.push(...toPlate(nx, ny));
          next.push(t);
        } else finished.push(t);
      }
      live = next;
      if (dxs.length >= 8) velocity = [median(dxs), median(dys)];
    }
    // Fresh corners where tracks have thinned out.
    if (k === 0 || (!o.detectOnce && live.length < o.redetect * o.maxFeatures)) {
      const existing = new Float32Array(live.length * 2);
      live.forEach((t, i) => {
        existing[2 * i] = t.x;
        existing[2 * i + 1] = t.y;
      });
      const corners = detectCorners(g.data, W, H, { maxFeatures: o.maxFeatures - live.length, minDistance, quality: o.quality, existing, mask, region, border: o.window + 2 });
      for (const c of corners) {
        if (!inRegion(c.x, c.y)) continue;
        live.push({ x: c.x, y: c.y, visits: [...toPlate(c.x, c.y)], startFrame: f });
      }
    }
    prev = { f, pyr, gray: g.data };
    ctx.progress?.(k + 1, frames.length, f);
    if (k % 4 === 3) await ctx.yieldNow?.();
  }
  finished.push(...live);
  const b = new TrackBuilder(req.plate.width, req.plate.height, req.first, req.last, req.nextId ?? 1);
  // Order by first frame so ids follow the shot.
  const tracks = finished
    .filter((t) => t.visits.length / 2 >= o.minLength)
    .map((t) => {
      const n = t.visits.length / 2;
      if (dir > 0) return { start: t.startFrame, xy: t.visits };
      // Backward: reverse into forward order; it starts at the last frame visited.
      const xy: number[] = [];
      for (let i = n - 1; i >= 0; i -= 1) xy.push(t.visits[2 * i]!, t.visits[2 * i + 1]!);
      return { start: t.startFrame - (n - 1), xy };
    })
    .sort((a, c) => a.start - c.start);
  for (const t of tracks) {
    const h = b.begin(t.start, t.xy[0]!, t.xy[1]!);
    for (let i = 1; i < t.xy.length / 2; i += 1) b.extend(h, t.xy[2 * i]!, t.xy[2 * i + 1]!);
  }
  return b.build();
}

/** Rec.709 luma of 8-bit RGB as 0 … 1. */
export function grayOf(rgb: { width: number; height: number; data: Uint8Array | Uint8ClampedArray }, channels = 3): GrayFrame {
  const n = rgb.width * rgb.height;
  const out = new Float32Array(n);
  const d = rgb.data;
  for (let i = 0, j = 0; i < n; i += 1, j += channels) out[i] = (0.2126 * d[j]! + 0.7152 * d[j + 1]! + 0.0722 * d[j + 2]!) / 255;
  return { width: rgb.width, height: rgb.height, data: out };
}
