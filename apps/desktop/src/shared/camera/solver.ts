import { bundleAdjust, type BAProblem, type IntrinsicKey, type RobustLoss } from './bundle';
import { mul3, mulv3, median, nearestRotation, t3 } from './linalg';
import { pixelToRay, slerpRotation, type Intrinsics } from './geometry';
import { centreOf, ransacPnP, refinePose, reprojection, triangulate } from './pose';
import {
  centreFundamental,
  essentialCost,
  gric,
  poseFromEssential,
  ransacEssential,
  ransacFundamental,
  ransacHomography,
  rotationHomographyCost,
  sampson,
  toEssential,
} from './two-view';
import type { TrackData } from './tracks';

/**
 * The camera solver (master spec §10; addendum 06): incremental structure
 * from motion over a shot's feature tracks, in pure TypeScript.
 *
 *  1. Keyframes: frames spaced so neighbours share most tracks but have moved.
 *  2. Model selection: for keyframe pairs, F and H by RANSAC, compared with
 *     GRIC. No pair with parallax → a rotation-only (nodal) shot.
 *  3. Focal length, when not given: self-calibration from the parallax
 *     pairs' fundamental matrices (Mendonça–Cipolla cost, principal point at
 *     the centre); for a nodal shot from the homographies (K⁻¹HK a rotation).
 *  4. Initial pair: the parallax pair with the widest triangulation angle;
 *     E by RANSAC on normalised coordinates, pose by cheirality.
 *  5. Keyframes registered outward (PnP: robust LM from the neighbour's pose,
 *     RANSAC-DLT fallback), new points triangulated, local bundle adjustment,
 *     periodic global keyframe adjustment, outliers dropped.
 *  6. Every other frame by PnP from its neighbours' poses; remaining tracks
 *     triangulated; a final global bundle adjustment over all frames with the
 *     requested intrinsics refined; outliers dropped; adjusted again.
 *
 * It sits behind `CameraSolver` so a native backend (Ceres, COLMAP) can
 * replace it without the rest of the module changing.
 */

export const TS_SOLVER_ID = 'vcvfx-ts';
export const TS_SOLVER_VERSION = '1.0.0';

export interface SolveSettings {
  /** Focal length: known (held unless refined), approximate (a start, refined), or unknown (self-calibrated, refined). */
  focal: { mode: 'known' | 'approx' | 'unknown'; px?: number };
  /** Starting distortion (normalised Brown–Conrady). */
  distortion?: Partial<Pick<Intrinsics, 'k1' | 'k2' | 'k3' | 'p1' | 'p2'>>;
  /** Which intrinsics the final adjustments refine. Focal is refined for approx/unknown regardless. */
  refine?: { focal?: boolean; k1k2?: boolean; k3?: boolean; p1p2?: boolean };
  /** Principal point; the image centre when absent. */
  principal?: { cx: number; cy: number };
  loss?: RobustLoss;
  /** Robust loss scale, pixels. */
  lossScale?: number;
  /** Observations further than this from their reprojection are dropped (pixels; also ≥ 3 × the robust σ). */
  outlierPx?: number;
  /** Track ids not to use. */
  exclude?: ReadonlySet<number>;
  /** Fixed 3D points seen at a pixel on a frame (surveyed control points), in the solve's world. */
  controlPoints?: { frame: number; u: number; v: number; X: [number, number, number] }[];
  /** Priors on tracks' 3D positions (LiDAR correspondences): sigma in world units. */
  pointPriors?: { trackId: number; X: [number, number, number]; sigma: number }[];
  /** Start from this solve (re-adjust in place) instead of from scratch. */
  initial?: SolveResult;
  /** Force (true) or forbid (false) a nodal solve; undefined decides. */
  nodal?: boolean;
  /**
   * The plate's pixel aspect (stored pixel width / height; addendum 17). The
   * solve models fx = f / a, fy = f with distortion on physical coordinates;
   * `focal.px` and the result's `intrinsics.f` are the vertical focal in plate
   * pixels (= the focal in de-squeezed pixels). Residuals stay in plate pixels.
   */
  pixelAspect?: number;
}

export interface SolvedFrame {
  frame: number;
  solved: boolean;
  /** World → camera (CV convention). */
  R: number[];
  t: number[];
  keyframe: boolean;
  /** RMS reprojection error of the inlier observations on this frame (pixels). */
  rms: number;
  /** Inlier observations on this frame. */
  tracks: number;
}

export interface SolvedTrack {
  id: number;
  /** World position; null when not triangulated. */
  X: [number, number, number] | null;
  /** RMS reprojection error over the track's inlier observations (pixels). */
  rms: number;
  /** Inlier and total observations. */
  inliers: number;
  observations: number;
}

export interface SolveStats {
  rms: number;
  medianError: number;
  framesSolved: number;
  framesTotal: number;
  tracksUsed: number;
  tracksTotal: number;
  points: number;
  keyframes: number;
  nodal: boolean;
  confidence: number;
  observations: number;
  minTracksPerFrame: number;
  warnings: string[];
  timings: { init: number; keyframes: number; frames: number; finalBA: number; total: number };
  baIterations: number;
  focalInitialPx: number | null;
}

export interface SolveResult {
  ok: boolean;
  reason: string | null;
  engine: { id: string; version: string };
  width: number;
  height: number;
  intrinsics: Intrinsics;
  frames: SolvedFrame[];
  tracks: SolvedTrack[];
  stats: SolveStats;
}

export interface SolveContext {
  signal?: { aborted: boolean };
  progress?: (stage: string, done: number, total: number) => void;
  /** Called between stages so a browser page stays responsive. */
  yieldNow?: () => Promise<void>;
}

export interface CameraSolver {
  readonly id: string;
  readonly version: string;
  solve(tracks: TrackData, settings: SolveSettings, ctx?: SolveContext): Promise<SolveResult>;
}

export class SolveCancelled extends Error {
  constructor() {
    super('Cancelled');
  }
}

// ---------------------------------------------------------------------------
// Working state
// ---------------------------------------------------------------------------

interface Work {
  td: TrackData;
  F: number; // frame count
  first: number;
  nT: number;
  /** Per frame (index), observation list: track indices. */
  frameTracks: Int32Array[];
  /** Per track-observation (offset + k): dropped as an outlier. */
  bad: Uint8Array;
  /** Track excluded entirely. */
  excluded: Uint8Array;
  /** Track 3D position or NaN. */
  X: Float64Array;
  hasX: Uint8Array;
  /** Per frame pose. */
  R: Float64Array;
  t: Float64Array;
  posed: Uint8Array;
  keyframe: Uint8Array;
  intr: Intrinsics;
  nodal: boolean;
  /** Track index of a control point (fixed) — they are extra pseudo-tracks at the end. */
  fixedPoint: Uint8Array;
}

const obsIndex = (w: Work, track: number, fi: number) => w.td.offset[track]! + (fi + w.first - w.td.start[track]!);
const obsUV = (w: Work, track: number, fi: number): [number, number] => {
  const o = obsIndex(w, track, fi) * 2;
  return [w.td.xy[o]!, w.td.xy[o + 1]!];
};
const poseOf = (w: Work, fi: number) => ({ R: Array.from(w.R.subarray(9 * fi, 9 * fi + 9)), t: Array.from(w.t.subarray(3 * fi, 3 * fi + 3)) });

function setPose(w: Work, fi: number, R: ArrayLike<number>, t: ArrayLike<number>): void {
  w.R.set(R, 9 * fi);
  w.t.set(t, 3 * fi);
  w.posed[fi] = 1;
}

function sharedTracks(w: Work, a: number, b: number): number[] {
  const set = new Set<number>();
  for (const k of w.frameTracks[a]!) if (!w.excluded[k]) set.add(k);
  const out: number[] = [];
  for (const k of w.frameTracks[b]!) if (set.has(k)) out.push(k);
  return out;
}

function pairPoints(w: Work, a: number, b: number, tracks: number[]): { x1: Float64Array; x2: Float64Array } {
  const x1 = new Float64Array(tracks.length * 2);
  const x2 = new Float64Array(tracks.length * 2);
  tracks.forEach((k, i) => {
    const p = obsUV(w, k, a);
    const q = obsUV(w, k, b);
    x1[2 * i] = p[0];
    x1[2 * i + 1] = p[1];
    x2[2 * i] = q[0];
    x2[2 * i + 1] = q[1];
  });
  return { x1, x2 };
}

function raysOf(intr: Intrinsics, pts: Float64Array): Float64Array {
  const out = new Float64Array(pts.length);
  for (let i = 0; i < pts.length / 2; i += 1) {
    const r = pixelToRay(intr, pts[2 * i]!, pts[2 * i + 1]!);
    out[2 * i] = r[0];
    out[2 * i + 1] = r[1];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bundle adjustment over a chosen set of frames and points
// ---------------------------------------------------------------------------

interface BAScope {
  frames: number[]; // frame indices, sorted
  freeFrames: Set<number>;
  points?: Set<number>; // track indices; all triangulated tracks seen by the frames when absent
  refine?: Partial<Record<IntrinsicKey, boolean>>;
  gauge?: { fixed: number; scale: number | null } | null;
  iterations?: number;
  tolerance?: number;
  loss?: RobustLoss;
  delta?: number;
  priors?: { trackId: number; X: [number, number, number]; sigma: number }[];
  control?: { frame: number; u: number; v: number; X: [number, number, number] }[];
}

function runBA(w: Work, scope: BAScope, signal?: { aborted: boolean }): { rms: number; iterations: number } {
  const frames = scope.frames;
  const camIndex = new Map<number, number>();
  frames.forEach((f, i) => camIndex.set(f, i));
  const pts: number[] = [];
  const ptIndex = new Map<number, number>();
  const want = (k: number) => w.hasX[k] && !w.excluded[k] && (!scope.points || scope.points.has(k));
  for (const f of frames) {
    for (const k of w.frameTracks[f]!) {
      if (ptIndex.has(k) || !want(k)) continue;
      if (w.bad[obsIndex(w, k, f)]) continue;
      ptIndex.set(k, pts.length);
      pts.push(k);
    }
  }
  const control = (scope.control ?? []).filter((c) => camIndex.has(c.frame - w.first));
  const nc = frames.length;
  const npAll = pts.length + control.length;
  const obsCam: number[] = [];
  const obsPt: number[] = [];
  const obsUVs: number[] = [];
  const obsRef: number[] = []; // index into track-observations, or −1 for control
  for (const f of frames) {
    for (const k of w.frameTracks[f]!) {
      const pi = ptIndex.get(k);
      if (pi === undefined) continue;
      const oi = obsIndex(w, k, f);
      if (w.bad[oi]) continue;
      const uv = obsUV(w, k, f);
      obsCam.push(camIndex.get(f)!);
      obsPt.push(pi);
      obsUVs.push(uv[0], uv[1]);
      obsRef.push(oi);
    }
  }
  control.forEach((c, j) => {
    obsCam.push(camIndex.get(c.frame - w.first)!);
    obsPt.push(pts.length + j);
    obsUVs.push(c.u, c.v);
    obsRef.push(-1);
  });
  // Drop points with fewer than two observations in scope (they cannot move usefully).
  const count = new Int32Array(npAll);
  for (const p of obsPt) count[p]! += 1;
  const R = new Float64Array(nc * 9);
  const t = new Float64Array(nc * 3);
  const camFixed = new Uint8Array(nc * 6);
  frames.forEach((f, i) => {
    R.set(w.R.subarray(9 * f, 9 * f + 9), 9 * i);
    t.set(w.t.subarray(3 * f, 3 * f + 3), 3 * i);
    if (!scope.freeFrames.has(f)) camFixed.fill(1, 6 * i, 6 * i + 6);
    if (w.nodal) camFixed.fill(1, 6 * i + 3, 6 * i + 6);
  });
  if (scope.gauge && !w.nodal) {
    const a = camIndex.get(scope.gauge.fixed);
    if (a !== undefined) camFixed.fill(1, 6 * a, 6 * a + 6);
    if (scope.gauge.scale !== null) {
      const b = camIndex.get(scope.gauge.scale);
      if (b !== undefined && a !== undefined) {
        // Hold the largest component of b's position relative to a, in a's frame — i.e. the baseline's scale.
        const tb = [t[3 * b]!, t[3 * b + 1]!, t[3 * b + 2]!];
        let big = 0;
        for (let k = 1; k < 3; k += 1) if (Math.abs(tb[k]!) > Math.abs(tb[big]!)) big = k;
        camFixed[6 * b + 3 + big] = 1;
      }
    }
  }
  const X = new Float64Array(npAll * 3);
  const pointFixed = new Uint8Array(npAll);
  pts.forEach((k, i) => {
    X.set(w.X.subarray(3 * k, 3 * k + 3), 3 * i);
    if (count[i]! < 2 && !scope.priors?.some((p) => w.td.ids[k] === p.trackId)) pointFixed[i] = 1;
  });
  control.forEach((c, j) => {
    X.set(c.X, 3 * (pts.length + j));
    pointFixed[pts.length + j] = 1;
  });
  const priors: BAProblem['priors'] = [];
  for (const pr of scope.priors ?? []) {
    const k = trackIndexById(w, pr.trackId);
    const pi = k < 0 ? undefined : ptIndex.get(k);
    if (pi !== undefined) priors.push({ point: pi, X: pr.X, sigma: pr.sigma });
  }
  const problem: BAProblem = {
    intr: w.intr,
    refine: scope.refine ?? {},
    R,
    t,
    camFixed,
    X,
    pointFixed,
    priors,
    obsCam: Int32Array.from(obsCam),
    obsPt: Int32Array.from(obsPt),
    obsUV: Float64Array.from(obsUVs),
  };
  const res = bundleAdjust(problem, { loss: scope.loss ?? 'huber', delta: scope.delta ?? 1.5, maxIterations: scope.iterations ?? 15, tolerance: scope.tolerance ?? 1e-6, nodal: w.nodal, ...(signal ? { signal } : {}) });
  frames.forEach((f, i) => {
    w.R.set(R.subarray(9 * i, 9 * i + 9), 9 * f);
    w.t.set(t.subarray(3 * i, 3 * i + 3), 3 * f);
  });
  pts.forEach((k, i) => w.X.set(X.subarray(3 * i, 3 * i + 3), 3 * k));
  return { rms: res.rms, iterations: res.iterations };
}

function trackIndexById(w: Work, id: number): number {
  const ids = w.td.ids;
  let lo = 0;
  let hi = ids.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ids[mid] === id) return mid;
    if (ids[mid]! < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return ids.indexOf(id);
}

/** Drop observations whose residual exceeds max(minPx, k·σ) among the given frames; returns how many. */
function rejectOutliers(w: Work, frames: number[], minPx: number, k = 3): number {
  const res: number[] = [];
  const list: { oi: number; r: number }[] = [];
  for (const f of frames) {
    if (!w.posed[f]) continue;
    const { R, t } = poseOf(w, f);
    for (const tr of w.frameTracks[f]!) {
      if (!w.hasX[tr] || w.excluded[tr]) continue;
      const oi = obsIndex(w, tr, f);
      if (w.bad[oi]) continue;
      const uv = obsUV(w, tr, f);
      const r = reprojection(w.intr, R, t, w.X, uv[0], uv[1], 3 * tr);
      res.push(r);
      list.push({ oi, r });
    }
  }
  if (!res.length) return 0;
  const sigma = 1.4826 * median(res);
  const th = Math.max(minPx, k * sigma);
  let n = 0;
  for (const { oi, r } of list)
    if (r > th) {
      w.bad[oi] = 1;
      n += 1;
    }
  return n;
}

/** Tracks whose good observations on posed frames are < 2, or behind a camera: un-triangulate. */
function pruneTracks(w: Work, frames: number[]): void {
  const good = new Int32Array(w.nT);
  for (const f of frames) for (const k of w.frameTracks[f]!) if (w.hasX[k] && !w.bad[obsIndex(w, k, f)]) good[k]! += 1;
  for (let k = 0; k < w.nT; k += 1) if (w.hasX[k] && good[k]! < 2) w.hasX[k] = 0;
}

/** Triangulate tracks not yet triangulated that are seen in ≥ 2 of the posed `frames`. */
function triangulateNew(w: Work, frames: number[], options: { minAngle: number; maxRms: number; only?: Set<number> }): number {
  const posedFrames = frames.filter((f) => w.posed[f]);
  const seen = new Map<number, number[]>();
  for (const f of posedFrames) {
    for (const k of w.frameTracks[f]!) {
      if (w.hasX[k] || w.excluded[k] || w.bad[obsIndex(w, k, f)]) continue;
      if (options.only && !options.only.has(k)) continue;
      const list = seen.get(k);
      if (list) list.push(f);
      else seen.set(k, [f]);
    }
  }
  let made = 0;
  for (const [k, fs] of seen) {
    if (fs.length < 2) continue;
    // At most 12 views spread over the track.
    const step = Math.max(1, Math.floor(fs.length / 12));
    const use = fs.filter((_, i) => i % step === 0 || i === fs.length - 1);
    const views = use.map((f) => {
      const { R, t } = poseOf(w, f);
      const uv = obsUV(w, k, f);
      return { R, t, C: centreOf(R, t), u: uv[0], v: uv[1] };
    });
    const tp = triangulate(w.intr, views);
    if (process.env['VCVFX_DEBUG_SOLVE'] && options.only && made < 1000) (globalThis as unknown as { __dbg: unknown[] }).__dbg = [...(((globalThis as unknown as { __dbg?: unknown[] }).__dbg) ?? []), tp ? [Math.round(tp.rms * 100) / 100, Math.round((tp.angle * 180) / Math.PI * 100) / 100] : null];
    if (!tp || (!w.nodal && tp.angle < options.minAngle) || tp.rms > options.maxRms) continue;
    // In front of every view it is seen in.
    let front = true;
    for (const f of fs) {
      const { R, t } = poseOf(w, f);
      const z = R[6]! * tp.X[0]! + R[7]! * tp.X[1]! + R[8]! * tp.X[2]! + t[2]!;
      if (!(z > 0)) {
        front = false;
        break;
      }
    }
    if (!front) continue;
    w.X.set(tp.X, 3 * k);
    w.hasX[k] = 1;
    made += 1;
  }
  return made;
}

/** 2D–3D matches on a frame: points and observations of triangulated tracks. */
function matchesOn(w: Work, f: number): { tracks: number[]; X: Float64Array; uv: Float64Array } {
  const tracks: number[] = [];
  for (const k of w.frameTracks[f]!) if (w.hasX[k] && !w.excluded[k] && !w.bad[obsIndex(w, k, f)]) tracks.push(k);
  const X = new Float64Array(tracks.length * 3);
  const uv = new Float64Array(tracks.length * 2);
  tracks.forEach((k, i) => {
    X.set(w.X.subarray(3 * k, 3 * k + 3), 3 * i);
    const p = obsUV(w, k, f);
    uv[2 * i] = p[0];
    uv[2 * i + 1] = p[1];
  });
  return { tracks, X, uv };
}

/** Register a frame from an initial pose; returns success. */
function registerFrame(w: Work, f: number, init: { R: number[]; t: number[] }, inlierPx: number): boolean {
  const m = matchesOn(w, f);
  if (m.tracks.length < 6) return false;
  let r = refinePose(w.intr, init, m.X, m.uv, { delta: inlierPx / 2, inlierPx, fixTranslation: w.nodal });
  const enough = (x: { inliers: number }) => x.inliers >= Math.min(12, m.tracks.length) && x.inliers >= 0.4 * m.tracks.length;
  if (!enough(r) && !w.nodal) {
    const alt = ransacPnP(w.intr, m.X, m.uv, { thresholdPx: inlierPx });
    if (alt && alt.inliers > r.inliers) r = alt;
  }
  if (!enough(r)) return false;
  setPose(w, f, r.R, r.t);
  m.tracks.forEach((k, i) => {
    if (r.residuals[i]! > inlierPx * 3) w.bad[obsIndex(w, k, f)] = 1;
  });
  return true;
}

// ---------------------------------------------------------------------------
// The solver
// ---------------------------------------------------------------------------

export class TsCameraSolver implements CameraSolver {
  readonly id = TS_SOLVER_ID;
  readonly version = TS_SOLVER_VERSION;

  async solve(td: TrackData, settings: SolveSettings, ctx: SolveContext = {}): Promise<SolveResult> {
    return solveTracks(td, settings, ctx);
  }
}

function checkCancel(ctx: SolveContext): void {
  if (ctx.signal?.aborted) throw new SolveCancelled();
}

function emptyResult(td: TrackData, intr: Intrinsics, reason: string, warnings: string[] = []): SolveResult {
  return {
    ok: false,
    reason,
    engine: { id: TS_SOLVER_ID, version: TS_SOLVER_VERSION },
    width: td.width,
    height: td.height,
    intrinsics: intr,
    frames: [],
    tracks: [],
    stats: {
      rms: 0,
      medianError: 0,
      framesSolved: 0,
      framesTotal: td.last - td.first + 1,
      tracksUsed: 0,
      tracksTotal: td.ids.length,
      points: 0,
      keyframes: 0,
      nodal: false,
      confidence: 0,
      observations: 0,
      minTracksPerFrame: 0,
      warnings: [reason, ...warnings],
      timings: { init: 0, keyframes: 0, frames: 0, finalBA: 0, total: 0 },
      baIterations: 0,
      focalInitialPx: null,
    },
  };
}

/** Choose keyframes: frame indices. */
function chooseKeyframes(w: Work, minTracks: number): number[] {
  const kfs: number[] = [];
  const valid = (f: number) => w.frameTracks[f]!.length >= minTracks;
  let start = 0;
  while (start < w.F && !valid(start)) start += 1;
  if (start >= w.F) return kfs;
  kfs.push(start);
  const target = 0.04 * Math.max(w.td.width, w.td.height);
  let last = start;
  for (let f = start + 1; f < w.F; f += 1) {
    if (!valid(f)) continue;
    const shared = sharedTracks(w, last, f);
    const base = Math.max(1, w.frameTracks[last]!.length);
    const disp: number[] = [];
    for (const k of shared) {
      const a = obsUV(w, k, last);
      const b = obsUV(w, k, f);
      disp.push(Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    const d = median(disp);
    const ratio = shared.length / base;
    const gap = f - last;
    if (d >= target || ratio < 0.65 || shared.length < 3 * minTracks || gap >= 15) {
      // Prefer the previous frame when this one already lost too much overlap.
      const choose = (ratio < 0.5 || shared.length < 2 * minTracks) && f - 1 > last ? f - 1 : f;
      kfs.push(choose);
      last = choose;
      if (choose !== f) f -= 1;
    }
  }
  if (kfs[kfs.length - 1] !== w.F - 1 && valid(w.F - 1)) kfs.push(w.F - 1);
  return kfs;
}

export async function solveTracks(td: TrackData, settings: SolveSettings, ctx: SolveContext = {}): Promise<SolveResult> {
  const t0 = Date.now();
  const F = td.last - td.first + 1;
  const width = td.width;
  const height = td.height;
  const cx = settings.principal?.cx ?? (width - 1) / 2;
  const cy = settings.principal?.cy ?? (height - 1) / 2;
  const dist = settings.distortion ?? {};
  const focalGiven = settings.focal.px && settings.focal.px > 0 ? settings.focal.px : null;
  // Pixel aspect: the picture is `width × aspect` de-squeezed pixels wide; focal lengths are in those (square) pixels.
  const aspect = settings.pixelAspect && settings.pixelAspect > 0 ? settings.pixelAspect : 1;
  const shownWidth = width * aspect;
  const intr: Intrinsics = { f: focalGiven ?? 1.2 * shownWidth, cx, cy, k1: dist.k1 ?? 0, k2: dist.k2 ?? 0, k3: dist.k3 ?? 0, p1: dist.p1 ?? 0, p2: dist.p2 ?? 0, ...(aspect !== 1 ? { a: aspect } : {}) };
  // Image → de-squeezed coordinates (x × aspect), for the self-calibration that assumes square pixels.
  const S = [aspect, 0, 0, 0, 1, 0, 0, 0, 1];
  const Si = [1 / aspect, 0, 0, 0, 1, 0, 0, 0, 1];
  const warnings: string[] = [];
  const outlierPx = settings.outlierPx ?? 3;
  const loss = settings.loss ?? 'huber';
  const delta = settings.lossScale ?? 1.5;
  const refineFocal = settings.focal.mode !== 'known' || Boolean(settings.refine?.focal);
  const refine: Partial<Record<IntrinsicKey, boolean>> = {
    f: refineFocal,
    k1: Boolean(settings.refine?.k1k2),
    k2: Boolean(settings.refine?.k1k2),
    k3: Boolean(settings.refine?.k3),
    p1: Boolean(settings.refine?.p1p2),
    p2: Boolean(settings.refine?.p1p2),
  };
  const nT = td.ids.length;
  // Frame → tracks.
  const lists: number[][] = Array.from({ length: F }, () => []);
  const excluded = new Uint8Array(nT);
  for (let k = 0; k < nT; k += 1) {
    if (settings.exclude?.has(td.ids[k]!)) excluded[k] = 1;
    for (let j = 0; j < td.length[k]!; j += 1) {
      const fi = td.start[k]! + j - td.first;
      if (fi >= 0 && fi < F) lists[fi]!.push(k);
    }
  }
  const w: Work = {
    td,
    F,
    first: td.first,
    nT,
    frameTracks: lists.map((l) => Int32Array.from(l)),
    bad: new Uint8Array(td.xy.length / 2),
    excluded,
    X: new Float64Array(nT * 3),
    hasX: new Uint8Array(nT),
    R: new Float64Array(F * 9),
    t: new Float64Array(F * 3),
    posed: new Uint8Array(F),
    keyframe: new Uint8Array(F),
    intr,
    nodal: false,
    fixedPoint: new Uint8Array(nT),
  };
  const minTracks = 8;
  const priors = settings.pointPriors ?? [];
  const control = settings.controlPoints ?? [];
  const timings = { init: 0, keyframes: 0, frames: 0, finalBA: 0, total: 0 };
  let baIterations = 0;
  let focalInitialPx: number | null = focalGiven;

  // ----- warm start: re-adjust an existing solve --------------------------
  if (settings.initial && settings.initial.ok) {
    const init = settings.initial;
    Object.assign(intr, init.intrinsics);
    if (aspect !== 1) intr.a = aspect;
    else delete intr.a;
    for (const fr of init.frames) {
      const fi = fr.frame - td.first;
      if (fi < 0 || fi >= F || !fr.solved) continue;
      setPose(w, fi, fr.R, fr.t);
      if (fr.keyframe) w.keyframe[fi] = 1;
    }
    const byId = new Map(init.tracks.map((tr) => [tr.id, tr]));
    for (let k = 0; k < nT; k += 1) {
      const tr = byId.get(td.ids[k]!);
      if (tr?.X && !excluded[k]) {
        w.X.set(tr.X, 3 * k);
        w.hasX[k] = 1;
      }
    }
    w.nodal = init.stats.nodal;
    const all = Array.from({ length: F }, (_, i) => i).filter((f) => w.posed[f]);
    triangulateNew(w, all, { minAngle: (1 * Math.PI) / 180, maxRms: outlierPx * 2 });
    return finish(w, settings, { all, refine, loss, delta, outlierPx, priors, control, warnings, timings, t0, baIterations, focalInitialPx, gauge: null, ctx });
  }

  ctx.progress?.('Choosing keyframes', 0, 1);
  const kfs = chooseKeyframes(w, minTracks);
  if (kfs.length < 2) return emptyResult(td, intr, 'Not enough tracks to solve: every frame needs at least 8 tracked features, and two frames that share them.');
  checkCancel(ctx);
  await ctx.yieldNow?.();

  // ----- model selection on keyframe pairs ---------------------------------
  ctx.progress?.('Measuring parallax', 0, kfs.length);
  interface PairInfo {
    a: number;
    b: number;
    tracks: number[];
    x1: Float64Array;
    x2: Float64Array;
    F: number[] | null;
    H: number[] | null;
    fInliers: number;
    hInliers: number;
    parallax: boolean;
  }
  const pairs: PairInfo[] = [];
  for (let i = 0; i < kfs.length - 1; i += 1) {
    for (let d = 1; d <= 3 && i + d < kfs.length; d += 1) {
      const a = kfs[i]!;
      const b = kfs[i + d]!;
      const tracks = sharedTracks(w, a, b);
      if (tracks.length < 30) continue;
      const { x1, x2 } = pairPoints(w, a, b, tracks);
      const Fr = ransacFundamental(x1, x2, { threshold: 1.5, maxIterations: 300, seed: 17 + i * 7 + d });
      const Hr = ransacHomography(x1, x2, { threshold: 2, maxIterations: 150, seed: 29 + i * 7 + d });
      if (!Fr || !Hr) continue;
      const gF = gric(Fr.errors, 1, 3, 7);
      const gH = gric(Hr.errors, 1, 2, 8);
      pairs.push({ a, b, tracks, x1, x2, F: Fr.model, H: Hr.model, fInliers: Fr.count, hInliers: Hr.count, parallax: gF < gH && Hr.count < 0.95 * Fr.count });
    }
    if (i % 4 === 0) {
      ctx.progress?.('Measuring parallax', i, kfs.length);
      checkCancel(ctx);
      await ctx.yieldNow?.();
    }
  }
  const parallaxPairs = pairs.filter((p) => p.parallax);
  let nodal = settings.nodal ?? parallaxPairs.length < Math.max(1, Math.round(0.08 * pairs.length));
  if (settings.nodal === false) nodal = false;

  // ----- focal length -----------------------------------------------------
  const searchFocal = (cost: (f: number) => number): number => {
    const lo = Math.log(0.25 * shownWidth);
    const hi = Math.log(8 * shownWidth);
    let best = lo;
    let bestC = Infinity;
    const N = 160;
    for (let i = 0; i <= N; i += 1) {
      const lf = lo + ((hi - lo) * i) / N;
      const c = cost(Math.exp(lf));
      if (c < bestC) {
        bestC = c;
        best = lf;
      }
    }
    let a = best - (hi - lo) / N;
    let b = best + (hi - lo) / N;
    const g = (Math.sqrt(5) - 1) / 2;
    for (let it = 0; it < 40; it += 1) {
      const c1 = b - g * (b - a);
      const c2 = a + g * (b - a);
      if (cost(Math.exp(c1)) < cost(Math.exp(c2))) b = c2;
      else a = c1;
    }
    return Math.exp((a + b) / 2);
  };
  if (!focalGiven) {
    if (!nodal) {
      // F in centred, de-squeezed coordinates: x' = S·x̃, so F' = S⁻ᵀ F̃ S⁻¹.
      const Fs = parallaxPairs.map((p) => mul3(mul3(Si, centreFundamental(p.F!, cx, cy)), Si));
      intr.f = searchFocal((f) => median(Fs.map((Fm) => essentialCost(Fm, f))));
    } else {
      const Hs = pairs.map((p) => {
        // H in principal-point-centred coordinates: T⁻¹ H T with T = translate(c).
        const T = [1, 0, cx, 0, 1, cy, 0, 0, 1];
        const Ti = [1, 0, -cx, 0, 1, -cy, 0, 0, 1];
        return mul3(mul3(S, mul3(mul3(Ti, p.H!), T)), Si);
      });
      intr.f = searchFocal((f) => median(Hs.map((H) => rotationHomographyCost(H, f))));
    }
    focalInitialPx = intr.f;
  }
  timings.init = Date.now() - t0;
  checkCancel(ctx);
  await ctx.yieldNow?.();

  w.nodal = nodal;
  let gauge: { fixed: number; scale: number | null } | null = null;
  const kfDone: number[] = [];

  if (!nodal) {
    // ----- initial pair -----------------------------------------------------
    let best: { pair: PairInfo; R: number[]; t: number[]; inl: Uint8Array; score: number } | null = null;
    // Score every parallax pair with E = KᵀFK from its F (cheap), then refine the winner's E by RANSAC on rays.
    const K = [intr.f / aspect, 0, 0, 0, intr.f, 0, 0, 0, 1];
    const scorePair = (p: PairInfo, E: number[], r1: Float64Array, r2: Float64Array, inl: Uint8Array) => {
      const pose = poseFromEssential(E, r1, r2, inl);
      if (pose.front < 0.8 * pose.tested) return null;
      const Rt = t3(pose.R);
      const angles: number[] = [];
      for (let i = 0; i < p.tracks.length; i += 1) {
        if (!inl[i]) continue;
        const v1 = [r1[2 * i]!, r1[2 * i + 1]!, 1];
        const v2 = mulv3(Rt, [r2[2 * i]!, r2[2 * i + 1]!, 1]);
        const c = (v1[0]! * v2[0]! + v1[1]! * v2[1]! + v1[2]! * v2[2]!) / (Math.hypot(...v1) * Math.hypot(...v2));
        angles.push(Math.acos(Math.max(-1, Math.min(1, c))));
      }
      let count = 0;
      for (let i = 0; i < inl.length; i += 1) count += inl[i]!;
      return { R: pose.R, t: pose.t, score: median(angles) * Math.sqrt(count) };
    };
    for (const p of parallaxPairs) {
      const r1 = raysOf(intr, p.x1);
      const r2 = raysOf(intr, p.x2);
      const E = toEssential(mul3(mul3(K, centreFundamental(p.F!, cx, cy)), K));
      const inl = new Uint8Array(p.tracks.length);
      for (let i = 0; i < p.tracks.length; i += 1) inl[i] = sampson(p.F!, p.x1[2 * i]!, p.x1[2 * i + 1]!, p.x2[2 * i]!, p.x2[2 * i + 1]!) < 2.25 ? 1 : 0;
      const sc = scorePair(p, E, r1, r2, inl);
      if (sc && (!best || sc.score > best.score)) best = { pair: p, R: sc.R, t: sc.t, inl, score: sc.score };
    }
    if (best) {
      const p = best.pair;
      const r1 = raysOf(intr, p.x1);
      const r2 = raysOf(intr, p.x2);
      const Er = ransacEssential(r1, r2, intr.f, { threshold: 1.5, maxIterations: 300, seed: 3 + p.a });
      if (Er && Er.count >= 20) {
        const sc = scorePair(p, Er.model, r1, r2, Er.inliers);
        if (sc) best = { pair: p, R: sc.R, t: sc.t, inl: Er.inliers, score: sc.score };
      }
    }
    if (!best) {
      if (settings.nodal === false) return emptyResult(td, intr, 'No pair of frames has enough parallax to start the solve.', warnings);
      nodal = true;
      w.nodal = true;
    } else {
      const { pair } = best;
      const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      setPose(w, pair.a, I, [0, 0, 0]);
      setPose(w, pair.b, best.R, best.t);
      w.keyframe[pair.a] = 1;
      w.keyframe[pair.b] = 1;
      gauge = { fixed: pair.a, scale: pair.b };
      const inlierTracks = new Set(pair.tracks.filter((_, i) => best!.inl[i]));
      triangulateNew(w, [pair.a, pair.b], { minAngle: (0.25 * Math.PI) / 180, maxRms: outlierPx * 2, only: inlierTracks });
      const r0 = runBA(w, { frames: [pair.a, pair.b], freeFrames: new Set([pair.b]), gauge, iterations: 20, loss, delta }, ctx.signal);
      baIterations += r0.iterations;
      rejectOutliers(w, [pair.a, pair.b], outlierPx);
      pruneTracks(w, [pair.a, pair.b]);
      if (process.env['VCVFX_DEBUG_SOLVE']) console.log('DEBUG init pair', pair.a, pair.b, 'inliers', inlierTracks.size, 'points', Array.from(w.hasX).reduce((x, y) => x + y, 0), 'BA rms', r0.rms, 'f', w.intr.f, 'score', best.score, 't', best.t);
      kfDone.push(pair.a, pair.b);

      // ----- register keyframes outward -----------------------------------
      const kIndex = new Map(kfs.map((f, i) => [f, i]));
      let lo = kIndex.get(pair.a)!;
      let hi = kIndex.get(pair.b)!;
      // Keyframes between the pair first.
      const pending: number[] = [];
      for (let i = lo + 1; i < hi; i += 1) pending.push(kfs[i]!);
      let sinceGlobal = 0;
      const registerKf = (f: number, from: number): boolean => {
        const ok = registerFrame(w, f, poseOf(w, from), outlierPx);
        if (!ok) return false;
        w.keyframe[f] = 1;
        kfDone.push(f);
        kfDone.sort((x, y) => x - y);
        triangulateNew(w, kfDone, { minAngle: (1 * Math.PI) / 180, maxRms: outlierPx * 2 });
        // Local adjustment: the new keyframe and its 4 nearest registered keyframes free.
        const pos = kfDone.indexOf(f);
        const windowFrames = kfDone.slice(Math.max(0, pos - 4), Math.min(kfDone.length, pos + 5));
        const free = new Set(windowFrames);
        if (gauge) free.delete(gauge.fixed);
        const pointsInWindow = new Set<number>();
        for (const wf of windowFrames) for (const k of w.frameTracks[wf]!) if (w.hasX[k]) pointsInWindow.add(k);
        const r = runBA(w, { frames: kfDone, freeFrames: free, points: pointsInWindow, iterations: 8, loss, delta }, ctx.signal);
        baIterations += r.iterations;
        sinceGlobal += 1;
        if (sinceGlobal >= 6) {
          const g = runBA(w, { frames: kfDone, freeFrames: new Set(kfDone), gauge, iterations: 10, loss, delta }, ctx.signal);
          baIterations += g.iterations;
          rejectOutliers(w, kfDone, outlierPx);
          pruneTracks(w, kfDone);
          sinceGlobal = 0;
        }
        return true;
      };
      for (const f of pending) {
        const from = kfDone.reduce((bst, x) => (Math.abs(x - f) < Math.abs(bst - f) ? x : bst), kfDone[0]!);
        registerKf(f, from);
      }
      let loOpen = lo > 0;
      let hiOpen = hi < kfs.length - 1;
      let step = 0;
      while (loOpen || hiOpen) {
        checkCancel(ctx);
        // Prefer the side with more 2D–3D matches.
        const cand: { f: number; from: number; side: 'lo' | 'hi'; m: number }[] = [];
        if (loOpen) cand.push({ f: kfs[lo - 1]!, from: kfs[lo]!, side: 'lo', m: matchesOn(w, kfs[lo - 1]!).tracks.length });
        if (hiOpen) cand.push({ f: kfs[hi + 1]!, from: kfs[hi]!, side: 'hi', m: matchesOn(w, kfs[hi + 1]!).tracks.length });
        cand.sort((x, y) => y.m - x.m);
        const c = cand[0]!;
        const ok = registerKf(c.f, kfDone.includes(c.from) ? c.from : kfDone[c.side === 'lo' ? 0 : kfDone.length - 1]!);
        if (c.side === 'lo') {
          lo -= 1;
          if (!ok) warnings.push(`Keyframe ${c.f + td.first} could not be registered; frames before it may be unsolved.`);
          loOpen = ok && lo > 0;
        } else {
          hi += 1;
          if (!ok) warnings.push(`Keyframe ${c.f + td.first} could not be registered; frames after it may be unsolved.`);
          hiOpen = ok && hi < kfs.length - 1;
        }
        step += 1;
        if (step % 3 === 0) {
          ctx.progress?.('Solving keyframes', kfDone.length, kfs.length);
          await ctx.yieldNow?.();
        }
      }
      // Global keyframe adjustment with the intrinsics.
      const g = runBA(w, { frames: kfDone, freeFrames: new Set(kfDone), gauge, iterations: 50, tolerance: 1e-10, loss, delta, refine }, ctx.signal);
      baIterations += g.iterations;
      rejectOutliers(w, kfDone, outlierPx);
      pruneTracks(w, kfDone);
      triangulateNew(w, kfDone, { minAngle: (1 * Math.PI) / 180, maxRms: outlierPx * 2 });
      const g2 = runBA(w, { frames: kfDone, freeFrames: new Set(kfDone), gauge, iterations: 30, tolerance: 1e-10, loss, delta, refine }, ctx.signal);
      baIterations += g2.iterations;
    }
  }

  if (nodal) {
    // ----- rotation-only: chain homography rotations through keyframes ------
    warnings.push('Rotation-only (nodal) camera: no parallax between frames, so the camera position cannot be solved. Solved as a nodal pan from a fixed point; track points are directions at a nominal distance.');
    w.nodal = true;
    const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const fx = intr.f / aspect;
    const K = [fx, 0, cx, 0, intr.f, cy, 0, 0, 1];
    const Ki = [1 / fx, 0, -cx / fx, 0, 1 / intr.f, -cy / intr.f, 0, 0, 1];
    setPose(w, kfs[0]!, I, [0, 0, 0]);
    w.keyframe[kfs[0]!] = 1;
    kfDone.push(kfs[0]!);
    for (let i = 1; i < kfs.length; i += 1) {
      const a = kfs[i - 1]!;
      const b = kfs[i]!;
      if (!w.posed[a]) break;
      const tracks = sharedTracks(w, a, b);
      if (tracks.length < 8) {
        warnings.push(`Keyframe ${b + td.first} shares too few tracks with the one before it.`);
        break;
      }
      const { x1, x2 } = pairPoints(w, a, b, tracks);
      const Hr = ransacHomography(x1, x2, { threshold: 2, seed: 41 + i });
      if (!Hr) break;
      const Rrel = nearestRotation(mul3(mul3(Ki, Hr.model), K));
      const Ra = poseOf(w, a).R;
      setPose(w, b, mul3(Rrel, Ra), [0, 0, 0]);
      w.keyframe[b] = 1;
      kfDone.push(b);
    }
    // Points: directions from the first keyframe that sees them, at distance 10.
    for (const f of kfDone) {
      const { R } = poseOf(w, f);
      const Rt = t3(R);
      for (const k of w.frameTracks[f]!) {
        if (w.hasX[k] || w.excluded[k]) continue;
        const seenElsewhere = kfDone.some((g) => g !== f && w.frameTracks[g]!.includes(k));
        if (!seenElsewhere) continue;
        const uv = obsUV(w, k, f);
        const r = pixelToRay(intr, uv[0], uv[1]);
        const d = mulv3(Rt, [r[0], r[1], 1]);
        const n = Math.hypot(...d);
        w.X.set([(d[0]! / n) * 10, (d[1]! / n) * 10, (d[2]! / n) * 10], 3 * k);
        w.hasX[k] = 1;
      }
    }
    const g = runBA(w, { frames: kfDone, freeFrames: new Set(kfDone.slice(1)), iterations: 25, loss, delta, refine }, ctx.signal);
    baIterations += g.iterations;
    rejectOutliers(w, kfDone, outlierPx);
    pruneTracks(w, kfDone);
    gauge = { fixed: kfDone[0]!, scale: null };
  }
  timings.keyframes = Date.now() - t0 - timings.init;
  checkCancel(ctx);
  await ctx.yieldNow?.();

  // ----- every other frame -------------------------------------------------
  ctx.progress?.('Solving every frame', 0, F);
  const posedKf = kfDone.filter((f) => w.posed[f]).sort((a, b) => a - b);
  if (posedKf.length < 2) return emptyResult(td, intr, 'The solve could not register enough keyframes.', warnings);
  for (let f = 0; f < F; f += 1) {
    if (w.posed[f]) continue;
    // Neighbouring posed keyframes.
    let prev = -1;
    let next = -1;
    for (const k of posedKf) {
      if (k < f) prev = k;
      else if (k > f && next < 0) next = k;
    }
    let init: { R: number[]; t: number[] };
    if (prev >= 0 && next >= 0) {
      const s = (f - prev) / (next - prev);
      const A = poseOf(w, prev);
      const B = poseOf(w, next);
      const Ca = centreOf(A.R, A.t);
      const Cb = centreOf(B.R, B.t);
      const R = slerpRotation(A.R, B.R, s);
      const C = [Ca[0]! + s * (Cb[0]! - Ca[0]!), Ca[1]! + s * (Cb[1]! - Ca[1]!), Ca[2]! + s * (Cb[2]! - Ca[2]!)];
      init = { R, t: mulv3(R, C).map((v) => -v) };
    } else {
      // Outside the keyframes: start from the nearest solved frame.
      let near = -1;
      for (let d = 1; d < F; d += 1) {
        if (f - d >= 0 && w.posed[f - d]) {
          near = f - d;
          break;
        }
        if (f + d < F && w.posed[f + d]) {
          near = f + d;
          break;
        }
      }
      if (near < 0) continue;
      init = poseOf(w, near);
    }
    registerFrame(w, f, init, outlierPx);
    if (f % 20 === 0) {
      ctx.progress?.('Solving every frame', f, F);
      checkCancel(ctx);
      await ctx.yieldNow?.();
    }
  }
  const all = Array.from({ length: F }, (_, i) => i).filter((f) => w.posed[f]);
  triangulateNew(w, all, { minAngle: (1 * Math.PI) / 180, maxRms: outlierPx * 2 });
  timings.frames = Date.now() - t0 - timings.init - timings.keyframes;
  checkCancel(ctx);
  await ctx.yieldNow?.();
  return finish(w, settings, { all, refine, loss, delta, outlierPx, priors, control, warnings, timings, t0, baIterations, focalInitialPx, gauge, ctx });
}

async function finish(
  w: Work,
  settings: SolveSettings,
  o: {
    all: number[];
    refine: Partial<Record<IntrinsicKey, boolean>>;
    loss: RobustLoss;
    delta: number;
    outlierPx: number;
    priors: NonNullable<SolveSettings['pointPriors']>;
    control: NonNullable<SolveSettings['controlPoints']>;
    warnings: string[];
    timings: SolveStats['timings'];
    t0: number;
    baIterations: number;
    focalInitialPx: number | null;
    gauge: { fixed: number; scale: number | null } | null;
    ctx: SolveContext;
  },
): Promise<SolveResult> {
  const { all, ctx } = o;
  const td = w.td;
  const tBA = Date.now();
  ctx.progress?.('Final bundle adjustment', 0, 2);
  // With priors or control points the world is pinned by them; otherwise hold the gauge.
  const pinned = o.priors.length >= 3 || o.control.length >= 3;
  const gauge = pinned ? null : (o.gauge ?? (all.length ? { fixed: all[0]!, scale: w.nodal ? null : (all[Math.min(all.length - 1, Math.max(1, Math.floor(all.length / 4)))] ?? null) } : null));
  let r = runBA(w, { frames: all, freeFrames: new Set(all), gauge, iterations: 12, loss: o.loss, delta: o.delta, refine: o.refine, priors: o.priors, control: o.control }, ctx.signal);
  let iterations = o.baIterations + r.iterations;
  rejectOutliers(w, all, o.outlierPx);
  pruneTracks(w, all);
  triangulateNew(w, all, { minAngle: (1 * Math.PI) / 180, maxRms: o.outlierPx * 2 });
  ctx.progress?.('Final bundle adjustment', 1, 2);
  await ctx.yieldNow?.();
  checkCancel(ctx);
  r = runBA(w, { frames: all, freeFrames: new Set(all), gauge, iterations: 8, loss: o.loss, delta: o.delta, refine: o.refine, priors: o.priors, control: o.control }, ctx.signal);
  iterations += r.iterations;
  rejectOutliers(w, all, o.outlierPx, 3.5);
  pruneTracks(w, all);
  o.timings.finalBA = Date.now() - tBA;

  // ----- report ---------------------------------------------------------------
  const F = w.F;
  const frames: SolvedFrame[] = [];
  const perTrackS2 = new Float64Array(w.nT);
  const perTrackIn = new Int32Array(w.nT);
  const allRes: number[] = [];
  let minTracks = Infinity;
  for (let f = 0; f < F; f += 1) {
    const { R, t } = poseOf(w, f);
    let s2 = 0;
    let n = 0;
    if (w.posed[f]) {
      for (const k of w.frameTracks[f]!) {
        if (!w.hasX[k] || w.excluded[k] || w.bad[obsIndex(w, k, f)]) continue;
        const uv = obsUV(w, k, f);
        const e = reprojection(w.intr, R, t, w.X, uv[0], uv[1], 3 * k);
        if (!Number.isFinite(e)) continue;
        s2 += e * e;
        n += 1;
        perTrackS2[k]! += e * e;
        perTrackIn[k]! += 1;
        allRes.push(e);
      }
      minTracks = Math.min(minTracks, n);
    }
    frames.push({ frame: f + w.first, solved: Boolean(w.posed[f]), R, t, keyframe: Boolean(w.keyframe[f]), rms: n ? Math.sqrt(s2 / n) : 0, tracks: n });
  }
  const tracks: SolvedTrack[] = [];
  let used = 0;
  for (let k = 0; k < w.nT; k += 1) {
    const has = Boolean(w.hasX[k]) && !w.excluded[k];
    if (has) used += 1;
    tracks.push({
      id: td.ids[k]!,
      X: has ? [w.X[3 * k]!, w.X[3 * k + 1]!, w.X[3 * k + 2]!] : null,
      rms: perTrackIn[k]! ? Math.sqrt(perTrackS2[k]! / perTrackIn[k]!) : 0,
      inliers: perTrackIn[k]!,
      observations: td.length[k]!,
    });
  }
  let s2 = 0;
  for (const e of allRes) s2 += e * e;
  const rms = allRes.length ? Math.sqrt(s2 / allRes.length) : 0;
  const framesSolved = frames.filter((f) => f.solved).length;
  const solvedTracks = frames.filter((f) => f.solved).map((f) => f.tracks);
  const medTracks = median(solvedTracks);
  if (!Number.isFinite(minTracks)) minTracks = 0;
  if (framesSolved < F) o.warnings.push(`${F - framesSolved} of ${F} frames could not be solved.`);
  if (minTracks < 12 && framesSolved) o.warnings.push(`Some frames have only ${minTracks} good tracks; their cameras are weakly determined.`);
  // Focal observability: a shot with almost no rotation cannot tell focal from depth.
  if (o.refine.f && settings.focal.mode !== 'known') {
    const solvedIdx = frames.filter((f) => f.solved);
    let maxRot = 0;
    for (const a of solvedIdx) {
      const d = mul3(a.R, t3(solvedIdx[0]!.R));
      maxRot = Math.max(maxRot, Math.acos(Math.max(-1, Math.min(1, (d[0]! + d[4]! + d[8]! - 1) / 2))));
    }
    if ((maxRot * 180) / Math.PI < 3) o.warnings.push(`The camera turns only ${((maxRot * 180) / Math.PI).toFixed(1)}° over the shot, so the focal length is poorly determined from the footage. Enter the lens's focal length and film back for a reliable solve.`);
  }
  const coverage = F ? framesSolved / F : 0;
  const rmsScore = Math.max(0, Math.min(1, 1.25 - rms / 2));
  const support = Math.max(0, Math.min(1, medTracks / 30));
  const confidence = Math.max(0, Math.min(1, coverage * rmsScore * (0.5 + 0.5 * support) * (minTracks >= 6 ? 1 : 0.5)));
  o.timings.total = Date.now() - o.t0;
  return {
    ok: framesSolved > 0,
    reason: framesSolved > 0 ? null : 'No frame could be solved.',
    engine: { id: TS_SOLVER_ID, version: TS_SOLVER_VERSION },
    width: td.width,
    height: td.height,
    intrinsics: { ...w.intr },
    frames,
    tracks,
    stats: {
      rms,
      medianError: median(allRes),
      framesSolved,
      framesTotal: F,
      tracksUsed: used,
      tracksTotal: w.nT,
      points: used,
      keyframes: frames.filter((f) => f.keyframe).length,
      nodal: w.nodal,
      confidence,
      observations: allRes.length,
      minTracksPerFrame: minTracks,
      warnings: o.warnings,
      timings: o.timings,
      baIterations: iterations,
      focalInitialPx: o.focalInitialPx,
    },
  };
}
