import { gaussian, mul3 } from './linalg';
import { project, rotX, rotY, rotZ, type Intrinsics, cameraToPose } from './geometry';
import { TrackBuilder, type TrackData } from './tracks';

/**
 * Synthetic ground truth for the camera solver (addendum 06): random 3D
 * points, known camera paths, and the tracks a perfect tracker would have
 * produced — with Gaussian noise, limited track lifetimes and outlier tracks
 * (independently moving points and tracks that jump to another feature).
 */

export function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type PathKind = 'dolly' | 'pan' | 'handheld' | 'nodal' | 'orbit';

export interface CameraPose {
  R: number[];
  t: number[];
  /** Camera centre in the world. */
  C: number[];
}

/**
 * A camera path in a Y-down, Z-forward world (the CV camera at frame 0 looks
 * down +Z from near the origin). Scene points live at z ≈ 8 … 22.
 */
export function cameraPath(kind: PathKind, frames: number, seed = 1): CameraPose[] {
  const rand = rng(seed);
  const g = gaussian(rand);
  // Smooth handheld noise: sum of a few sinusoids per channel.
  const waves = Array.from({ length: 6 }, () => Array.from({ length: 3 }, () => ({ a: g(), f: 0.03 + rand() * 0.12, p: rand() * Math.PI * 2 })));
  const wave = (ch: number, i: number, scale: number) => waves[ch]!.reduce((s, w) => s + w.a * Math.sin(w.f * i + w.p), 0) * scale;
  const out: CameraPose[] = [];
  for (let i = 0; i < frames; i += 1) {
    const s = frames > 1 ? i / (frames - 1) : 0;
    let C: number[];
    let Rcw: number[]; // camera → world
    switch (kind) {
      case 'dolly':
        // Sideways and slightly forward, no rotation.
        C = [-2 + 4 * s, 0.3 * Math.sin(s * Math.PI), 1.5 * s];
        Rcw = [1, 0, 0, 0, 1, 0, 0, 0, 1];
        break;
      case 'pan':
        // A truck to the right while panning left: rotation and translation together.
        C = [-1.5 + 3 * s, -0.2 * s, 0.5 * s];
        Rcw = mul3(rotY((-12 + 24 * s) * (Math.PI / 180)), rotX((2 - 4 * s) * (Math.PI / 180)));
        break;
      case 'handheld':
        C = [0.6 * s + wave(0, i, 0.03), wave(1, i, 0.03) - 0.1 * s, 0.4 * s + wave(2, i, 0.03)];
        Rcw = mul3(rotY(wave(3, i, 0.6) * (Math.PI / 180) + 4 * s * (Math.PI / 180)), mul3(rotX(wave(4, i, 0.6) * (Math.PI / 180)), rotZ(wave(5, i, 0.4) * (Math.PI / 180))));
        break;
      case 'orbit': {
        const a = (-20 + 40 * s) * (Math.PI / 180);
        C = [14 * Math.sin(a), -1, 14 - 14 * Math.cos(a)];
        Rcw = rotY(-a);
        break;
      }
      case 'nodal':
        C = [0, 0, 0];
        Rcw = mul3(rotY((-15 + 30 * s) * (Math.PI / 180)), rotX(3 * Math.sin(s * Math.PI) * (Math.PI / 180)));
        break;
    }
    const { R, t } = cameraToPose(C, Rcw);
    out.push({ R, t, C });
  }
  return out;
}

export function scenePoints(count: number, seed = 2, box = { x: [-9, 9], y: [-4, 3], z: [7, 22] }): Float64Array {
  const rand = rng(seed);
  const X = new Float64Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    X[3 * i] = box.x[0]! + rand() * (box.x[1]! - box.x[0]!);
    X[3 * i + 1] = box.y[0]! + rand() * (box.y[1]! - box.y[0]!);
    X[3 * i + 2] = box.z[0]! + rand() * (box.z[1]! - box.z[0]!);
  }
  return X;
}

export interface SyntheticShot {
  tracks: TrackData;
  path: CameraPose[];
  points: Float64Array;
  intr: Intrinsics;
  /** Track id → index of the true 3D point, or −1 for an outlier track. */
  truth: Map<number, number>;
  /** Track ids that are outliers. */
  outliers: Set<number>;
}

export interface ObserveOptions {
  width?: number;
  height?: number;
  intr?: Intrinsics;
  /** RMS of the 2D displacement added to each observation, pixels (σ per axis = noise/√2). */
  noise?: number;
  /** Share of tracks that are outliers. */
  outliers?: number;
  /** Mean track lifetime in frames (geometric); tracks also end when they leave the frame. */
  lifetime?: number;
  first?: number;
  seed?: number;
}

/** Track every point through the path with a perfect tracker, then degrade it. */
export function observe(path: CameraPose[], points: Float64Array, options: ObserveOptions = {}): SyntheticShot {
  const width = options.width ?? 1920;
  const height = options.height ?? 1080;
  const intr: Intrinsics = options.intr ?? { f: 1600, cx: (width - 1) / 2, cy: (height - 1) / 2, k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 };
  const first = options.first ?? 1001;
  const rand = rng(options.seed ?? 3);
  const g = gaussian(rand);
  const noise = (options.noise ?? 0.5) / Math.SQRT2;
  const lifetime = options.lifetime ?? 60;
  const outlierShare = options.outliers ?? 0.1;
  const F = path.length;
  const b = new TrackBuilder(width, height, first, first + F - 1);
  const truth = new Map<number, number>();
  const outliers = new Set<number>();
  const margin = 4;
  const inside = (p: [number, number] | null): p is [number, number] => !!p && p[0] >= margin && p[1] >= margin && p[0] <= width - 1 - margin && p[1] <= height - 1 - margin;
  const n = points.length / 3;
  for (let i = 0; i < n; i += 1) {
    const X = [points[3 * i]!, points[3 * i + 1]!, points[3 * i + 2]!];
    const isOutlier = rand() < outlierShare;
    const kind = rand() < 0.5 ? 'moving' : 'jump';
    const vel = [(rand() - 0.5) * 0.12, (rand() - 0.5) * 0.06, (rand() - 0.5) * 0.12];
    const jumpAt = Math.floor(rand() * F);
    const jump = [(rand() < 0.5 ? -1 : 1) * (6 + rand() * 20), (rand() < 0.5 ? -1 : 1) * (6 + rand() * 20)];
    let handle = -1;
    let id = -1;
    let born = 0;
    for (let f = 0; f < F; f += 1) {
      const P = isOutlier && kind === 'moving' ? [X[0]! + vel[0]! * f, X[1]! + vel[1]! * f, X[2]! + vel[2]! * f] : X;
      let p = project(intr, path[f]!.R, path[f]!.t, P);
      if (p && isOutlier && kind === 'jump' && f >= jumpAt && handle >= 0 && f - born > 3) p = [p[0] + jump[0]!, p[1] + jump[1]!];
      const visible = inside(p);
      const lost = handle >= 0 && rand() < 1 / lifetime;
      if (handle >= 0 && (!visible || lost)) {
        handle = -1;
      }
      if (handle < 0 && visible && (rand() < 0.35 || f === 0)) {
        handle = b.begin(first + f, p![0] + noise * g(), p![1] + noise * g());
        id = b.nextId - 1;
        born = f;
        truth.set(id, isOutlier ? -1 : i);
        if (isOutlier) outliers.add(id);
        continue;
      }
      if (handle >= 0 && visible) b.extend(handle, p![0] + noise * g(), p![1] + noise * g());
    }
  }
  return { tracks: b.build(2), path, points, intr, truth, outliers };
}

export function syntheticShot(kind: PathKind, options: ObserveOptions & { frames?: number; points?: number } = {}): SyntheticShot {
  const path = cameraPath(kind, options.frames ?? 100, (options.seed ?? 1) + 100);
  const pts = scenePoints(options.points ?? 700, (options.seed ?? 1) + 200);
  return observe(path, pts, options);
}
