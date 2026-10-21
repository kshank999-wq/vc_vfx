import { isolateConfidence, isolateCorrectionRange, isolateSeedFrame, isolateSeedProblem, type IsolateDocument, type IsolateMetrics, type IsolateRect, type IsolateRunResult, type IsolateTarget } from '@vcvfx/domain';
import { alignShot, between, scaleHomography, type ShotAlignment } from '../cleanplate/align';
import { ShotCleaner, type CleanPlateAnalysis, type CleanPlateSettings } from '../cleanplate/engine';
import { resizeLinear, toDisplay, type LinearImage, type WorkingSpace } from '../key/linear';
import { CancelledError, type SegmentationEngine } from '../roto/engine';
import { resizePlane, squaredDistance, type Mask, type RGBImage } from '../roto/image';
import { rasterizeStrokes, scaleStrokes, SEED_EXCLUDE, SEED_INCLUDE, type EngineStroke } from '../roto/strokes';
import { TrackEngine } from '../roto/track';
import { edgeShare, foregroundOf, refineMatte, smoothTemporal } from './matte';
import { HARD_BG, HARD_FG, binaryCut, cleanSky, cutSize, separationOf, skyFeatures, softLabels, withPrior } from './sky';

/**
 * Sky isolation and background removal (master spec §11; addendum 11 §3).
 * Frames and roto mattes come and go through `IsolateIO`, so the same code
 * runs in the desktop's worker thread and in the browser preview. Everything
 * is in linear light; nothing here writes anything.
 *
 *  1. Analyse, at the working size: the camera's motion (the clean plate's
 *     homography alignment to the seed frame); then
 *       sky — per-frame sky cues and colour models at a cut size, the
 *       neighbouring frames' cues aligned by the homographies as a temporal
 *       prior (not where something moves in front of the sky: occluders keep
 *       their own evidence and are pushed to the foreground), painted
 *       corrections carried to the frames around them, a graph cut;
 *       background — the subject segmented on the seed frame from a box, paint
 *       or a roto part by the roto engines (Track, or SAM 2.1 when its model
 *       is there), propagated through the shot frame to frame, corrections on
 *       key frames re-segmented and propagated locally (as roto does);
 *     the result is a soft foreground probability per frame.
 *  2. Mattes, at the size asked for (the working size for review, the plate's
 *     for export): the edge unmixed in linear light (matte.ts), smoothed in
 *     time against the previous frame (motion-compensated), the premultiplied
 *     foreground with the sky/background unmixed out of its edge.
 *  3. Plates: the sky (or background) behind the foreground rebuilt from the
 *     frames that saw it — the clean plate's `ShotCleaner` with the matte as
 *     what to remove — and what no frame saw filled spatially and flagged.
 */

export const ISOLATE_ENGINE_VERSION = '1.0.0';
/** The roto-part id the plate builder is given for the foreground (never a real part). */
const FOREGROUND_PART = '__isolate_fg';

export type IsolateSettings = Pick<IsolateDocument, 'target' | 'seed' | 'engine' | 'keyFrames' | 'params'>;

export interface IsolateIO {
  /** A frame at the size this pass works at, in linear working RGB. */
  frame(frame: number): Promise<LinearImage>;
  /** A roto part's matte (0…1) on a frame at w × h, or null where it has none. */
  roto(partId: string, frame: number, width: number, height: number): Promise<Float32Array | null>;
  signal?: AbortSignal;
  progress?(done: number, total: number, frame?: number): void;
}

export const checkCancel = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new CancelledError();
};

export interface IsolatorOptions {
  /** Plate pixels per working pixel (settings and strokes are in plate pixels). */
  pxScale: number;
  space: WorkingSpace;
  /** Longest edge of the sky's cues and cut (480). */
  cutWidth?: number;
  /** Longest edge the alignment works at (640). */
  alignWidth?: number;
  /** The subject's segmentation engine (background removal); the Track engine by default. */
  engine?: () => Promise<SegmentationEngine>;
  /** Sensor noise σ, linear (for the matte's noise floor). */
  noise?: number;
  /** Frames the background plate may hold in memory at once at plate resolution. */
  maxResidentBytes?: number;
}

/** What the analysis found: the alignment and a soft foreground probability per frame. */
export interface IsolateAnalysis {
  target: IsolateTarget;
  reference: number;
  alignment: ShotAlignment;
  /** The size of the probabilities (and of the working frames' holes). */
  probSize: { width: number; height: number };
  /** The working size (the alignment's pixels). */
  working: { width: number; height: number };
  /** P(foreground)·255 per frame. */
  probs: Map<number, Uint8Array>;
  /** How decisive the segmentation was per frame (0 … 1). */
  separation: Map<number, number>;
  engine: string;
}

export interface MatteOutput {
  frame: number;
  width: number;
  height: number;
  alpha: Float32Array;
  /** Premultiplied, linear. */
  fg: Float32Array;
  /** Per-pixel confidence of the matte. */
  confidence: Float32Array;
  band: Uint8Array;
  metrics: Omit<IsolateMetrics, 'unresolved'>;
}

export interface PlateOutput {
  frame: number;
  width: number;
  height: number;
  /** The sky (or background) alone, linear. */
  plate: Float32Array;
  /** Per pixel: 1 seen (or rebuilt from agreeing frames), 0 never seen. */
  confidence: Float32Array;
  /** 1 where the plate behind the foreground is unresolved (never seen; wants paint). */
  unresolved: Uint8Array;
  /** Share of the plate behind the edge (sky) or the subject (background) that is unresolved. */
  share: number;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const round4 = (v: number) => Math.round(v * 10_000) / 10_000;
const toU8 = (p: Float32Array) => Uint8Array.from(p, (v) => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255)));
const fromU8 = (p: Uint8Array) => Float32Array.from(p, (v) => v / 255);

/** Strokes standing for a box prompt: the middle of the box painted in, a frame round it painted out. */
export function boxStrokes(r: IsolateRect): EngineStroke[] {
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  const s = Math.min(w, h);
  const cx = (r.x0 + r.x1) / 2;
  const off = 0.05 * s + 3;
  const rad = 0.03 * s + 2;
  return [
    { mode: 'include', radius: Math.max(1.5, 0.22 * w), points: [[cx, r.y0 + 0.2 * h], [cx, r.y1 - 0.2 * h]] },
    { mode: 'exclude', radius: rad, points: [[r.x0 - off, r.y0 - off], [r.x1 + off, r.y0 - off], [r.x1 + off, r.y1 + off], [r.x0 - off, r.y1 + off], [r.x0 - off, r.y0 - off]] },
  ];
}

/** Any-pixel downscale of a mask (a coarse pixel is on when any of its pixels is). */
function pool(src: Uint8Array, w: number, h: number, nw: number, nh: number): Uint8Array {
  if (w === nw && h === nh) return src;
  const out = new Uint8Array(nw * nh);
  for (let y = 0; y < h; y += 1) {
    const yy = Math.min(nh - 1, Math.floor((y * nh) / h));
    for (let x = 0; x < w; x += 1) if (src[y * w + x]) out[yy * nw + Math.min(nw - 1, Math.floor((x * nw) / w))] = 1;
  }
  return out;
}

/** Nearest-neighbour upscale of a binary mask, grown by one pixel so nothing thin slips between samples. */
function expand(src: Uint8Array, w: number, h: number, nw: number, nh: number): Float32Array {
  const out = new Float32Array(nw * nh);
  if (w === nw && h === nh) {
    for (let i = 0; i < out.length; i += 1) out[i] = src[i]!;
    return out;
  }
  const sx = w / nw;
  const sy = h / nh;
  for (let y = 0; y < nh; y += 1)
    for (let x = 0; x < nw; x += 1) {
      const fx = (x + 0.5) * sx - 0.5;
      const fy = (y + 0.5) * sy - 0.5;
      const x0 = Math.max(0, Math.floor(fx));
      const y0 = Math.max(0, Math.floor(fy));
      const x1 = Math.min(w - 1, x0 + 1);
      const y1 = Math.min(h - 1, y0 + 1);
      if (src[y0 * w + x0] || src[y0 * w + x1] || src[y1 * w + x0] || src[y1 * w + x1]) out[y * nw + x] = 1;
    }
  return out;
}

/** Sample a mask at another frame's pixels through H (this frame's pixel → that frame's pixel). */
function warpPlane(src: Float32Array, sw: number, sh: number, H: readonly number[], w: number, h: number, outside = Number.NaN): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      const d = H[6]! * x + H[7]! * y + H[8]!;
      const u = (H[0]! * x + H[1]! * y + H[2]!) / d;
      const v = (H[3]! * x + H[4]! * y + H[5]!) / d;
      if (!(u >= -0.5 && v >= -0.5 && u <= sw - 0.5 && v <= sh - 0.5)) {
        out[y * w + x] = outside;
        continue;
      }
      const fx = Math.min(sw - 1, Math.max(0, u));
      const fy = Math.min(sh - 1, Math.max(0, v));
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = Math.min(sw - 1, x0 + 1);
      const y1 = Math.min(sh - 1, y0 + 1);
      const tx = fx - x0;
      const ty = fy - y0;
      const top = src[y0 * sw + x0]! + (src[y0 * sw + x1]! - src[y0 * sw + x0]!) * tx;
      const bot = src[y1 * sw + x0]! + (src[y1 * sw + x1]! - src[y1 * sw + x0]!) * tx;
      out[y * w + x] = top + (bot - top) * ty;
    }
  return out;
}

/**
 * Isolates one shot with one set of settings: analyse once, then mattes and
 * plates at whatever size is asked for.
 */
export class ShotIsolator {
  analysis: IsolateAnalysis | null = null;
  /** The foreground of each frame (α > 0.02) at the analysis's working size, kept for the plates. */
  private holes = new Map<number, Uint8Array>();
  engineLabel = 'track';

  constructor(
    readonly settings: IsolateSettings,
    readonly range: { first: number; last: number },
    readonly o: IsolatorOptions,
  ) {}

  get frames(): number[] {
    return Array.from({ length: this.range.last - this.range.first + 1 }, (_, i) => this.range.first + i);
  }

  get seedFrame(): number {
    return isolateSeedFrame(this.settings, this.range.first, this.range.last);
  }

  /** Strokes on a frame, in plate pixels. */
  private strokesOn(frame: number): EngineStroke[] {
    return (this.settings.keyFrames.find((k) => k.frame === frame)?.strokes ?? []).map((s) => ({ mode: s.mode, radius: s.radius, points: s.points }));
  }

  /** Analyse the shot at the IO's (working) size. Progress counts every frame read. */
  async analyse(io: IsolateIO, progress?: (done: number, total: number, frame?: number) => void): Promise<IsolateAnalysis> {
    const problem = isolateSeedProblem({ seed: this.settings.seed, keyFrames: this.settings.keyFrames } as IsolateDocument, this.settings.target);
    if (problem) throw new Error(problem);
    this.analysis = this.settings.target === 'sky' ? await this.analyseSky(io, progress) : await this.analyseSubject(io, progress);
    return this.analysis;
  }

  useAnalysis(a: IsolateAnalysis): this {
    this.analysis = a;
    return this;
  }

  /** The total of the progress steps a whole build reports. */
  steps(): number {
    const n = this.range.last - this.range.first + 1;
    const corrections = this.settings.target === 'background' ? this.settings.keyFrames.filter((k) => k.frame !== this.seedFrame && k.strokes.length).length * n : 0;
    return (this.settings.target === 'sky' ? 4 * n : 3 * n + corrections) + 2 * n;
  }

  private async analyseSky(io: IsolateIO, progress?: (done: number, total: number, frame?: number) => void): Promise<IsolateAnalysis> {
    const frames = this.frames;
    const total = this.steps();
    let done = 0;
    const reference = this.seedFrame;
    const p = this.settings.params;
    const space = this.o.space;
    let working = { width: 0, height: 0 };
    const alignment = await alignShot(
      frames,
      reference,
      async (f) => {
        const image = await io.frame(f);
        working = { width: image.width, height: image.height };
        return { image, hole: null };
      },
      { model: 'auto', luma: space.luma, maxWidth: this.o.alignWidth ?? 640 },
      { check: () => checkCancel(io.signal), progress: (_d, _t, f) => progress?.(++done, total, f) },
    );
    const cut = cutSize(working.width, working.height, this.o.cutWidth ?? 480);
    const kc = cut.width / working.width;
    const N = cut.width * cut.height;
    // Per frame at the cut size: P(foreground) from cues + colour, sky-colour, log luminance, the display picture.
    const fgP = new Map<number, Uint8Array>();
    const skyCol = new Map<number, Uint8Array>();
    const logL = new Map<number, Float32Array>();
    const display = new Map<number, Uint8ClampedArray>();
    for (const f of frames) {
      checkCancel(io.signal);
      const img = await io.frame(f);
      const feat = skyFeatures(resizeLinear(img, cut.width, cut.height), space, p.skyBias);
      fgP.set(f, toU8(feat.fg));
      skyCol.set(f, toU8(feat.skyColour));
      logL.set(f, feat.logL);
      display.set(f, feat.display);
      progress?.(++done, total, f);
    }
    const Hcut = (t: number, s: number) => scaleHomography(between(alignment, t, s), kc);
    // Painted frames, their strokes rasterised at the cut size on their own frame.
    const keys = this.settings.keyFrames.filter((k) => k.strokes.length);
    const strokeScale = kc / this.o.pxScale;
    const painted = new Map<number, Uint8Array>(keys.map((k) => [k.frame, rasterizeStrokes(scaleStrokes(this.strokesOn(k.frame), strokeScale), cut.width, cut.height)]));
    const probs = new Map<number, Uint8Array>();
    const separation = new Map<number, number>();
    const smooth = p.temporalSmoothing;
    for (const t of frames) {
      checkCancel(io.signal);
      const own = fromU8(fgP.get(t)!);
      const L = logL.get(t)!;
      const col = skyCol.get(t)!;
      // Temporal prior: the neighbours' probabilities aligned onto this frame; their log luminance for what moves.
      const near = [-2, -1, 1, 2].map((d) => t + d).filter((f) => f >= this.range.first && f <= this.range.last);
      const priorSum = new Float32Array(N);
      const priorW = new Float32Array(N);
      const diffs: Float32Array[] = [];
      for (const f of near) {
        const H = Hcut(t, f);
        const wp = warpPlane(fromU8(fgP.get(f)!), cut.width, cut.height, H, cut.width, cut.height);
        const wl = warpPlane(logL.get(f)!, cut.width, cut.height, H, cut.width, cut.height);
        const wgt = 1 / Math.abs(f - t);
        const diff = new Float32Array(N);
        for (let i = 0; i < N; i += 1) {
          if (Number.isNaN(wp[i]!)) {
            diff[i] = Number.NaN;
            continue;
          }
          priorSum[i]! += wgt * wp[i]!;
          priorW[i]! += wgt;
          diff[i] = Math.abs(L[i]! - wl[i]!);
        }
        diffs.push(diff);
      }
      const pf = new Float32Array(N);
      for (let i = 0; i < N; i += 1) {
        // Something moves here (it differs from where the camera says the world was, in most neighbours).
        let moved = 0;
        let seen = 0;
        for (const d of diffs) {
          if (Number.isNaN(d[i]!)) continue;
          seen += 1;
          if (d[i]! > 0.5) moved += 1;
        }
        const moving = seen > 0 && moved * 2 > seen;
        let v = own[i]!;
        if (moving && p.protectOccluders) {
          // An occluder in front of the sky: its own evidence, pushed towards the foreground unless it is plainly sky.
          if (col[i]! < 200) v = withPrior(v, 0.85, 1);
        } else if (priorW[i]! > 0 && smooth > 0) v = withPrior(v, priorSum[i]! / priorW[i]!, 0.9 * smooth);
        pf[i] = v;
      }
      // Paint: hard on its own frame; carried to the frames it reaches (aligned) as a strong prior.
      let hard: Uint8Array | null = null;
      for (const k of keys) {
        const r = isolateCorrectionRange({ keyFrames: this.settings.keyFrames }, k.frame, this.range.first, this.range.last);
        if (t < r.first || t > r.last) continue;
        const seeds = painted.get(k.frame)!;
        if (k.frame === t) {
          hard ??= new Uint8Array(N);
          for (let i = 0; i < N; i += 1) if (seeds[i]) hard[i] = seeds[i] === SEED_INCLUDE ? HARD_FG : HARD_BG;
          continue;
        }
        const plane = new Float32Array(N);
        for (let i = 0; i < N; i += 1) plane[i] = seeds[i] === SEED_INCLUDE ? 1 : seeds[i] === SEED_EXCLUDE ? -1 : 0;
        const warped = warpPlane(plane, cut.width, cut.height, Hcut(t, k.frame), cut.width, cut.height, 0);
        for (let i = 0; i < N; i += 1) {
          const s = warped[i]!;
          if (s > 0.5) pf[i] = withPrior(pf[i]!, 0.97, 4);
          else if (s < -0.5) pf[i] = withPrior(pf[i]!, 0.03, 4);
        }
      }
      const img: RGBImage = { width: cut.width, height: cut.height, data: display.get(t)! };
      const labels = cleanSky(binaryCut(img, pf, hard, { gamma: 30, lambda: 1 }), pf, hard, cut.width, cut.height);
      probs.set(t, toU8(softLabels(labels, display.get(t)!, cut.width, cut.height)));
      separation.set(t, round3(separationOf(pf)));
      progress?.(++done, total, t);
    }
    this.engineLabel = 'sky-cues';
    return { target: 'sky', reference, alignment, probSize: cut, working, probs, separation, engine: `sky-cues@${ISOLATE_ENGINE_VERSION}` };
  }

  private async analyseSubject(io: IsolateIO, progress?: (done: number, total: number, frame?: number) => void): Promise<IsolateAnalysis> {
    const frames = this.frames;
    const total = this.steps();
    let done = 0;
    const space = this.o.space;
    const seed = this.settings.seed;
    const seedFrame = this.seedFrame;
    const smoothing = this.settings.params.temporalSmoothing;
    const first = this.range.first;
    const last = this.range.last;
    const displays = new Map<number, RGBImage>();
    const displayOf = async (f: number): Promise<RGBImage> => {
      const hit = displays.get(f);
      if (hit) return hit;
      const img = await io.frame(f);
      const d: RGBImage = { width: img.width, height: img.height, data: toDisplay(img.data, img.width * img.height, space) };
      displays.set(f, d);
      if (displays.size > 6) displays.delete(displays.keys().next().value!);
      return d;
    };
    const s0 = await displayOf(seedFrame);
    const w = s0.width;
    const h = s0.height;
    const masks = new Map<number, Mask>();
    const separation = new Map<number, number>();
    const engine = this.o.engine ? await this.o.engine() : new TrackEngine();
    this.engineLabel = `${engine.id}@${engine.version}`;
    const toWorking = (strokes: EngineStroke[]) => scaleStrokes(strokes, 1 / this.o.pxScale);
    /** Propagate from `from` over [a, b] in one direction. */
    const propagate = async (from: number, a: number, b: number, dir: 1 | -1) => {
      let prevF = from;
      for (let f = from + dir; dir > 0 ? f <= b : f >= a; f += dir) {
        checkCancel(io.signal);
        const prevMask = masks.get(prevF)!;
        const r = await engine.step({ prevFrame: prevF, nextFrame: f, prev: await displayOf(prevF), next: await displayOf(f), prevMask, smoothing, settings: {} });
        masks.set(f, r.mask);
        separation.set(f, round3(r.confidence));
        prevF = f;
        progress?.(++done, total, f);
      }
    };
    try {
      if (seed.mode === 'roto' && seed.partId) {
        // The subject already rotoscoped: its mattes as they are, frames without one carried from the nearest that has.
        const have: number[] = [];
        for (const f of frames) {
          checkCancel(io.signal);
          const m = await io.roto(seed.partId, f, w, h);
          if (m) {
            masks.set(f, { width: w, height: h, data: toU8(m) });
            separation.set(f, 0.95);
            have.push(f);
          }
          progress?.(++done, total, f);
        }
        if (!have.length) throw new Error('The roto part has no mattes in this shot. Propagate it in the Roto tab first.');
        for (let i = 0; i < have.length; i += 1) {
          const f = have[i]!;
          const next = have[i + 1] ?? last + 1;
          if (next > f + 1) await propagate(f, f + 1, next - 1, 1);
        }
        if (have[0]! > first) await propagate(have[0]!, first, have[0]! - 1, -1);
      } else {
        const strokes = seed.mode === 'box' && seed.rect ? toWorking(boxStrokes(seed.rect)) : toWorking(this.strokesOn(seedFrame));
        const k = await engine.key({ frame: seedFrame, image: s0, strokes, reference: null, settings: {} });
        masks.set(seedFrame, k.mask);
        separation.set(seedFrame, round3(k.confidence));
        progress?.(++done, total, seedFrame);
        await propagate(seedFrame, seedFrame, last, 1);
        // Backwards from the seed: the engine learns the subject again from the seed frame.
        await engine.key({ frame: seedFrame, image: s0, strokes: [], reference: k.mask, settings: {} });
        await propagate(seedFrame, first, seedFrame, -1);
      }
      // Corrections: each painted key frame (other than a paint seed) re-segmented around its paint and carried
      // to halfway to its neighbouring key frames (the seed frame counts as one), nearest the seed first.
      const keyDoc = { keyFrames: [...this.settings.keyFrames, { frame: seedFrame, strokes: [], correction: false, by: '', at: '' }] };
      const corrections = this.settings.keyFrames
        .filter((kf) => kf.strokes.length && !(seed.mode === 'paint' && kf.frame === seedFrame))
        .sort((a, b) => Math.abs(a.frame - seedFrame) - Math.abs(b.frame - seedFrame) || a.frame - b.frame);
      for (const kf of corrections) {
        if (kf.frame < first || kf.frame > last) continue;
        const image = await displayOf(kf.frame);
        const r = await engine.key({ frame: kf.frame, image, strokes: toWorking(this.strokesOn(kf.frame)), reference: masks.get(kf.frame) ?? null, settings: {} });
        masks.set(kf.frame, r.mask);
        separation.set(kf.frame, round3(r.confidence));
        const range = isolateCorrectionRange(keyDoc, kf.frame, first, last);
        await propagate(kf.frame, kf.frame, range.last, 1);
        await engine.key({ frame: kf.frame, image, strokes: [], reference: r.mask, settings: {} });
        await propagate(kf.frame, range.first, kf.frame, -1);
        done += Math.max(0, frames.length - (range.last - range.first + 1));
      }
    } finally {
      engine.dispose?.();
    }
    const alignment = await alignShot(
      frames,
      seedFrame,
      async (f) => {
        const image = await io.frame(f);
        const m = masks.get(f);
        return { image, hole: m ? Uint8Array.from(m.data, (v) => (v > 12 ? 1 : 0)) : null };
      },
      { model: 'auto', luma: space.luma, maxWidth: this.o.alignWidth ?? 640 },
      { check: () => checkCancel(io.signal), progress: (_d, _t, f) => progress?.(++done, total, f) },
    );
    const probs = new Map<number, Uint8Array>();
    for (const f of frames) probs.set(f, masks.get(f)?.data ?? new Uint8Array(w * h));
    return { target: 'background', reference: seedFrame, alignment, probSize: { width: w, height: h }, working: { width: w, height: h }, probs, separation, engine: this.engineLabel };
  }

  private need(): IsolateAnalysis {
    if (!this.analysis) throw new Error('Build first (step 3).');
    return this.analysis;
  }

  /** The camera's motion and residual of a frame, plate pixels. */
  private motionOf(f: number): { motionPx: number; residualPx: number } {
    const a = this.need().alignment.frames.get(f);
    const k = this.o.pxScale;
    return { motionPx: round3((a?.motion ?? 0) * k), residualPx: round3((a?.residual ?? 0) * k) };
  }

  /** One frame's matte at the image's size (`pxScale`: plate pixels per pixel of it); `B`: the known plate behind (background). */
  private matteOf(f: number, img: LinearImage, pxScale: number, prev: { alpha: Float32Array; image: LinearImage; frame: number } | null, B: Float32Array | null): MatteOutput {
    const a = this.need();
    const p = this.settings.params;
    const { width: W, height: H } = img;
    const prob = resizePlane(fromU8(a.probs.get(f)!), a.probSize.width, a.probSize.height, W, H);
    const r = refineMatte(
      img,
      prob,
      {
        target: a.target,
        luma: this.o.space.luma,
        softness: p.edgeSoftnessPx / pxScale,
        grow: p.growPx / pxScale,
        detail: p.edgeDetail,
        k: W / a.probSize.width,
        spill: p.spill,
        ...(this.o.noise !== undefined ? { noise: this.o.noise } : {}),
      },
      B,
    );
    let flicker = 0;
    if (prev && prev.frame === f - 1) {
      const Hw = scaleHomography(between(a.alignment, f, f - 1), W / a.working.width);
      flicker = smoothTemporal({ alpha: r.alpha, band: r.band, image: img }, prev, Hw, 0.6 * p.temporalSmoothing, this.o.space.luma);
    }
    const fg = foregroundOf(img, r.alpha, r.band, r.B, p.spill, r.F);
    let fgShare = 0;
    for (let i = 0; i < r.alpha.length; i += 1) if (r.alpha[i]! >= 0.5) fgShare += 1;
    const metrics: MatteOutput['metrics'] = {
      foreground: round4(fgShare / (W * H)),
      edge: round4(edgeShare(r.alpha)),
      separation: a.separation.get(f) ?? 0,
      contrast: round3(r.contrast),
      flicker: round4(flicker),
      ...this.motionOf(f),
    };
    return { frame: f, width: W, height: H, alpha: r.alpha, fg, confidence: r.confidence, band: r.band, metrics };
  }

  /** Remember a frame's foreground (α > 0.02), at the working size, for the plate builder. */
  private keepHole(f: number, alpha: Float32Array, W: number, H: number): void {
    const a = this.need();
    const on = new Uint8Array(W * H);
    for (let i = 0; i < on.length; i += 1) if (alpha[i]! > 0.02) on[i] = 1;
    this.holes.set(f, pool(on, W, H, a.working.width, a.working.height));
  }

  /** The foreground of a frame (working size) at w × h: what the plate builder rebuilds behind. */
  private holeAt(f: number, w: number, h: number): Float32Array | null {
    const a = this.need();
    const hole = this.holes.get(f);
    if (!hole) return null;
    return expand(hole, a.working.width, a.working.height, w, h);
  }

  /** The clean plate's builder, told the foreground is what to remove, at the IO's size. */
  private async plateBuilder(io: IsolateIO, pxScale: number) {
    const a = this.need();
    const sky = a.target === 'sky';
    const settings: CleanPlateSettings = {
      remove: [{ id: 'r1', label: '', source: { type: 'roto', partId: FOREGROUND_PART }, frames: null, enabled: true }],
      mode: 'sequence',
      alignment: 'auto',
      referenceFrame: a.reference,
      params: { dilatePx: sky ? 0 : this.settings.params.plateGrowPx, window: 12, anchors: 16, tolerance: 0.06, featherPx: 0 },
      guidance: { prefer: [], exclude: [], patches: [] },
    };
    const first = await io.frame(this.range.first);
    const k = first.width / a.working.width;
    const scaled = k === 1 ? a.alignment : { ...a.alignment, frames: new Map([...a.alignment.frames].map(([f, x]) => [f, { ...x, H: a.alignment.static ? x.H : scaleHomography(x.H, k), residual: x.residual * k, motion: x.motion * k }])) };
    const analysis: CleanPlateAnalysis = { alignment: scaled, suggestion: { mode: 'sequence', static: a.alignment.static, motionPx: 0, residualPx: 0, exposureStops: 0, reason: '' }, mode: 'sequence', reference: a.reference };
    const cleaner = new ShotCleaner(settings, this.range, { pxScale, luma: this.o.space.luma, ...(this.o.maxResidentBytes ? { maxResidentBytes: this.o.maxResidentBytes } : {}) }).useAnalysis(analysis);
    const plateIO = {
      frame: (f: number) => io.frame(f),
      roto: async (_id: string, f: number, w: number, h: number) => this.holeAt(f, w, h),
      ...(io.signal ? { signal: io.signal } : {}),
    };
    return {
      cleaner,
      plate: async (f: number): Promise<PlateOutput> => {
        const out = await cleaner.plate(plateIO, f, { keep: true });
        const { width: W, height: H } = out;
        const n = W * H;
        const conf = out.confidence;
        // What no frame saw is filled from the plate round it; its confidence falls off with the distance from what was seen.
        const seen = new Uint8Array(n);
        let anyUnseen = false;
        for (let i = 0; i < n; i += 1) {
          if (out.inpainted[i]) anyUnseen = true;
          else seen[i] = 1;
        }
        const scale = W / a.working.width;
        const d2 = anyUnseen ? squaredDistance(seen, W, H) : null;
        if (d2) for (let i = 0; i < n; i += 1) if (out.inpainted[i]) conf[i] = Math.max(conf[i]!, Math.exp(-Math.sqrt(d2[i]!) / (3 * scale)));
        // Unresolved: for the sky, only near what was seen (where a new sky can show through); deep behind
        // buildings the plate is filled too, but nobody will see it.
        const near = (12 * scale) ** 2;
        const unresolved = new Uint8Array(n);
        let need = 0;
        let low = 0;
        for (let i = 0; i < n; i += 1) {
          if (!out.hole[i]) continue;
          if (conf[i]! < 0.5 && (!sky || !d2 || d2[i]! <= near)) unresolved[i] = 1;
          // Sky: what matters is the plate behind the edge (where the new sky will show through), not behind solid buildings.
          if (sky && !hasSkyNear(out.hole, W, H, i)) continue;
          need += 1;
          if (conf[i]! < 0.5) low += 1;
        }
        return { frame: f, width: W, height: H, plate: out.plate, confidence: conf, unresolved, share: need ? round4(low / need) : 0 };
      },
    };
  }

  /**
   * Mattes and plates of every frame, in order. `io` is the size the mattes
   * are made at (`pxScale`: plate pixels per pixel of it); `plateIO` the
   * plates' (default the same). The sky: every matte, then every plate
   * (rebuilt behind the refined matte, thin wires and branches included); the
   * sky plate is made at the working size — it is smooth — and the export
   * takes the frame's own pixels wherever the sky is seen. The background:
   * frame by frame, the plate first (rebuilt behind the segmentation), then
   * the matte, its edge unmixed against that plate — the background really
   * behind the edge, seen in other frames, not a guess from its neighbours.
   */
  async outputs(
    io: IsolateIO,
    o: { pxScale: number; plateIO?: IsolateIO; platePxScale?: number; progress?: (frame: number) => void },
    onMatte: (m: MatteOutput) => Promise<void> | void,
    onPlate: (p: PlateOutput) => Promise<void> | void,
  ): Promise<void> {
    const a = this.need();
    const plateIO = o.plateIO ?? io;
    const platePx = o.platePxScale ?? o.pxScale;
    let prev: { alpha: Float32Array; image: LinearImage; frame: number } | null = null;
    if (a.target === 'sky') {
      for (const f of this.frames) {
        checkCancel(io.signal);
        const img = await io.frame(f);
        const m = this.matteOf(f, img, o.pxScale, prev, null);
        this.keepHole(f, m.alpha, m.width, m.height);
        await onMatte(m);
        prev = { alpha: m.alpha, image: img, frame: f };
        o.progress?.(f);
      }
      const builder = await this.plateBuilder(plateIO, platePx);
      for (const f of this.frames) {
        checkCancel(io.signal);
        await onPlate(await builder.plate(f));
        o.progress?.(f);
      }
      builder.cleaner.clear();
      return;
    }
    // The subject: its segmentation (soft edge included) is what the plate is rebuilt behind.
    for (const f of this.frames) {
      const pr = a.probs.get(f)!;
      this.holes.set(f, pool(Uint8Array.from(pr, (v) => (v > 5 ? 1 : 0)), a.probSize.width, a.probSize.height, a.working.width, a.working.height));
    }
    const builder = await this.plateBuilder(plateIO, platePx);
    for (const f of this.frames) {
      checkCancel(io.signal);
      const plate = await builder.plate(f);
      await onPlate(plate);
      o.progress?.(f);
      const img = await io.frame(f);
      const B = plate.width === img.width && plate.height === img.height ? plate.plate : null;
      const m = this.matteOf(f, img, o.pxScale, prev, B);
      await onMatte(m);
      prev = { alpha: m.alpha, image: img, frame: f };
      o.progress?.(f);
    }
    builder.cleaner.clear();
  }
}

/** Is a foreground pixel next to the sky (a pixel of the edge, where the sky shows through)? */
function hasSkyNear(hole: Uint8Array, w: number, h: number, i: number): boolean {
  const x = i % w;
  const y = (i - x) / w;
  for (let dy = -2; dy <= 2; dy += 1)
    for (let dx = -2; dx <= 2; dx += 1) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      if (!hole[yy * w + xx]) return true;
    }
  return false;
}

/**
 * Build the shot: analyse, the mattes, then the plates, handing each to
 * `onMatte` / `onPlate` (to cache them for review). Returns what
 * `recordIsolateRun` records.
 */
export async function runIsolate(
  io: IsolateIO,
  isolator: ShotIsolator,
  o: { revision: number },
  onMatte: (m: MatteOutput) => Promise<void> | void,
  onPlate: (p: PlateOutput) => Promise<void> | void,
): Promise<IsolateRunResult & { analysis: IsolateAnalysis }> {
  const total = isolator.steps();
  let done = 0;
  const report = (frame?: number) => io.progress?.(++done, total, frame);
  const analysis = await isolator.analyse(io, (d, _t, f) => {
    done = d;
    io.progress?.(d, total, f);
  });
  const metrics = new Map<number, Omit<IsolateMetrics, 'unresolved'>>();
  const unresolved = new Map<number, number>();
  await isolator.outputs(
    io,
    { pxScale: isolator.o.pxScale, progress: report },
    async (m) => {
      metrics.set(m.frame, m.metrics);
      await onMatte(m);
    },
    async (p) => {
      unresolved.set(p.frame, p.share);
      await onPlate(p);
    },
  );
  const frames = isolator.frames.map((f) => {
    const m: IsolateMetrics = { ...metrics.get(f)!, unresolved: unresolved.get(f) ?? 0 };
    return { frame: f, confidence: isolateConfidence(m), metrics: m };
  });
  return {
    first: isolator.range.first,
    last: isolator.range.last,
    frames,
    alignment: analysis.alignment.model,
    revision: o.revision,
    engine: analysis.engine,
    algorithm: `vcvfx-isolate@${ISOLATE_ENGINE_VERSION}`,
    analysis,
  };
}
