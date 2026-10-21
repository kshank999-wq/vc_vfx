import { cleanPlateConfidence, cleanPlateReference, contactSheetFrames, suggestCleanPlateMode, type CleanPlateDocument, type CleanPlateMetrics, type CleanPlateOutputMode, type CleanPlateRunResult } from '@vcvfx/domain';
import type { LinearImage } from '../key/linear';
import { rectMatte } from '../key/mattes';
import { CancelledError } from '../roto/engine';
import { alignShot, between, scaleHomography, type FrameAlignment, type ShotAlignment } from './align';
import { HoleFill, fillStats, grow, type Candidate, type FillResult } from './fill';

/**
 * Building a clean plate (master spec §8; addendum 10 §4): the removal matte
 * of each frame from the artist's roto parts and boxes, the shot aligned to
 * its reference frame, then either one still plate in the reference frame's
 * coordinates or a plate per frame, each reconstructed from aligned
 * neighbouring frames and anchor frames spread over the shot. Frames and roto
 * mattes come and go through `CleanPlateIO`, so the same code runs in the
 * desktop's worker thread and in the browser preview. Everything is in linear
 * light; nothing here writes anything.
 */

export const CLEANPLATE_ENGINE_VERSION = '1.0.0';

export type CleanPlateSettings = Pick<CleanPlateDocument, 'remove' | 'mode' | 'alignment' | 'referenceFrame' | 'params' | 'guidance'>;

export interface CleanPlateIO {
  /** A frame at the size the build works at, in linear working RGB. */
  frame(frame: number): Promise<LinearImage>;
  /** A roto part's matte (0…1) on a frame at w × h, or null where it has none. */
  roto(partId: string, frame: number, width: number, height: number): Promise<Float32Array | null>;
  signal?: AbortSignal;
  progress?(done: number, total: number, frame?: number): void;
}

export const checkCancel = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new CancelledError();
};

/** What the analysis found: the alignment, the suggested mode, and the mode that will be built. */
export interface CleanPlateAnalysis {
  alignment: ShotAlignment;
  suggestion: { mode: CleanPlateOutputMode; static: boolean; motionPx: number; residualPx: number; exposureStops: number; reason: string };
  mode: CleanPlateOutputMode;
  reference: number;
}

export interface PlateOutput extends FillResult {
  frame: number;
  metrics: CleanPlateMetrics;
  confidenceValue: number;
}

export interface CleanerOptions {
  /** Plate pixels per working pixel (settings are in plate pixels). */
  pxScale: number;
  luma: readonly [number, number, number];
  /** Longest edge alignment works at. */
  alignWidth?: number;
  /** Frames kept in memory at once (a sequence's window and anchors are cut to fit). */
  maxResidentBytes?: number;
}

const NEAR = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48];

/** Is a frame range null (whole shot) or does it hold `f`? */
const inRange = (r: { first: number; last: number } | null, f: number) => !r || (r.first <= r.last && f >= r.first && f <= r.last);

/**
 * The removal matte of a frame at w × h: every enabled roto part and box that
 * applies on it, grown by the dilation. Null when nothing is removed there.
 */
export async function removalHole(settings: CleanPlateSettings, io: Pick<CleanPlateIO, 'roto'>, frame: number, w: number, h: number, pxScale: number): Promise<Uint8Array | null> {
  let hole: Uint8Array | null = null;
  for (const item of settings.remove) {
    if (!item.enabled || !inRange(item.frames, frame)) continue;
    let m: Float32Array | null;
    if (item.source.type === 'rect') {
      const r = item.source.rect;
      m = rectMatte({ x0: r.x0 / pxScale, y0: r.y0 / pxScale, x1: r.x1 / pxScale, y1: r.y1 / pxScale }, w, h, 1);
    } else m = await io.roto(item.source.partId, frame, w, h);
    if (!m) continue;
    hole ??= new Uint8Array(w * h);
    for (let i = 0; i < w * h; i += 1) if (m[i]! > 0.02) hole[i] = 1;
  }
  if (!hole) return null;
  const r = Math.round(settings.params.dilatePx / pxScale);
  return r > 0 ? grow(hole, w, h, r) : hole;
}

/** Frames spread over the shot (the anchors every plate may borrow from). */
export function anchorFrames(first: number, last: number, count: number): number[] {
  if (last <= first) return [first];
  return contactSheetFrames(first, last, Math.max(0, count - 2)).slice(0, Math.max(2, count));
}

/** Scale an analysis made at one size to another (`k`: new pixels per old pixel). */
export function scaleAnalysis(a: CleanPlateAnalysis, k: number): CleanPlateAnalysis {
  if (k === 1) return a;
  const frames = new Map<number, FrameAlignment>();
  for (const [f, x] of a.alignment.frames) frames.set(f, { ...x, H: a.alignment.static ? x.H : scaleHomography(x.H, k), residual: x.residual * k, motion: x.motion * k });
  return { ...a, alignment: { ...a.alignment, frames, motion: a.alignment.motion * k, residual: a.alignment.residual * k } };
}

/** The analysis as plain data (for a worker message or a cache file) and back. */
export const analysisToJson = (a: CleanPlateAnalysis) => ({ ...a, alignment: { ...a.alignment, frames: [...a.alignment.frames.values()] } });
export type CleanPlateAnalysisJson = ReturnType<typeof analysisToJson>;
export const analysisFromJson = (j: CleanPlateAnalysisJson): CleanPlateAnalysis => ({ ...j, alignment: { ...j.alignment, frames: new Map(j.alignment.frames.map((f) => [f.frame, f])) } });

/**
 * Builds clean plates of one shot with one set of settings, keeping what does
 * not change between frames: the removal mattes, the alignment, the frames a
 * sequence borrows from.
 */
export class ShotCleaner {
  analysis: CleanPlateAnalysis | null = null;
  private holes = new Map<number, Uint8Array | null>();
  private resident = new Map<number, LinearImage>();
  private size: { width: number; height: number } | null = null;

  constructor(
    readonly settings: CleanPlateSettings,
    readonly range: { first: number; last: number },
    readonly o: CleanerOptions,
  ) {}

  get reference(): number {
    return cleanPlateReference(this.settings, this.range.first, this.range.last);
  }

  get frames(): number[] {
    return Array.from({ length: this.range.last - this.range.first + 1 }, (_, i) => this.range.first + i);
  }

  async hole(io: CleanPlateIO, frame: number, w: number, h: number): Promise<Uint8Array | null> {
    if (this.holes.has(frame)) return this.holes.get(frame)!;
    const m = await removalHole(this.settings, io, frame, w, h, this.o.pxScale);
    this.holes.set(frame, m);
    // Keep up to ~256 MB of mattes: every frame of a shot at review sizes, fewer at plate resolution.
    if (this.holes.size > Math.max(32, Math.floor(256e6 / (w * h)))) this.holes.delete(this.holes.keys().next().value!);
    return m;
  }

  /** Align the shot and decide still or sequence. */
  async analyse(io: CleanPlateIO, progress?: (done: number, total: number, frame: number) => void): Promise<CleanPlateAnalysis> {
    if (!this.settings.remove.some((r) => r.enabled)) throw new Error('Choose what to remove first (step 1): a roto part or a box.');
    const reference = this.reference;
    const alignment = await alignShot(
      this.frames,
      reference,
      async (f) => {
        const image = await io.frame(f);
        this.size ??= { width: image.width, height: image.height };
        return { image, hole: await this.hole(io, f, image.width, image.height) };
      },
      { model: this.settings.alignment, luma: this.o.luma, maxWidth: this.o.alignWidth ?? 640 },
      { check: () => checkCancel(io.signal), ...(progress ? { progress } : {}) },
    );
    const k = this.o.pxScale;
    const s = { static: alignment.static, motionPx: round3(alignment.motion * k), residualPx: round3(alignment.residual * k), exposureStops: round3(alignment.exposureStops) };
    const suggested = suggestCleanPlateMode(s);
    const mode = this.settings.mode === 'auto' ? suggested.mode : this.settings.mode;
    this.analysis = { alignment, suggestion: { ...s, ...suggested }, mode, reference };
    return this.analysis;
  }

  /** Use an analysis made earlier (at this size). */
  useAnalysis(a: CleanPlateAnalysis): this {
    this.analysis = a;
    return this;
  }

  private need(): CleanPlateAnalysis {
    if (!this.analysis) throw new Error('Build the clean plate first (step 3).');
    return this.analysis;
  }

  /** The frames a plate of `t` borrows from (near ones, anchors, preferred), best first, and their weights. */
  candidatesFor(t: number, still: boolean): { frame: number; weight: number }[] {
    const { first, last } = this.range;
    const g = this.settings.guidance;
    const p = this.settings.params;
    const { window, anchors } = this.budget(still);
    const set = new Set<number>();
    for (const d of NEAR) {
      if (d > window) break;
      if (t - d >= first) set.add(t - d);
      if (t + d <= last) set.add(t + d);
    }
    for (const f of anchorFrames(first, last, anchors)) set.add(f);
    for (const f of g.prefer) if (f >= first && f <= last) set.add(f);
    for (const f of g.exclude) set.delete(f);
    set.delete(t);
    const prefer = new Set(g.prefer);
    const scale = Math.max(3, p.window);
    return [...set]
      .map((frame) => ({ frame, weight: (prefer.has(frame) ? 4 : 1) / (1 + Math.abs(frame - t) / scale) }))
      .sort((a, b) => b.weight - a.weight || a.frame - b.frame);
  }

  /** The window and anchors, cut down so the frames a sequence keeps fit the memory budget. */
  budget(still: boolean): { window: number; anchors: number } {
    const p = this.settings.params;
    const anchors0 = still ? Math.min(48, p.anchors * 2) : p.anchors;
    if (still || !this.size || !this.o.maxResidentBytes) return { window: p.window, anchors: anchors0 };
    const bytes = this.size.width * this.size.height * 13; // RGB float + matte
    const fit = Math.max(5, Math.floor(this.o.maxResidentBytes / bytes));
    let anchors = Math.min(anchors0, Math.max(2, Math.floor(fit / 3)));
    let window = Math.min(p.window, Math.max(1, Math.floor((fit - anchors - 1) / 2)));
    if (2 * window + 1 + anchors > fit) anchors = Math.max(2, fit - 2 * window - 1);
    window = Math.max(1, window);
    return { window, anchors };
  }

  private quality(f: number): number {
    const a = this.need().alignment.frames.get(f);
    if (!a) return 0.25;
    // In the pixels of the plate being built: what a misalignment costs is a blur at this resolution.
    return Math.max(0.25, Math.min(1, 1 - Math.max(0, a.residual - 0.5) / 2));
  }

  private candidate(t: number, f: number, image: LinearImage, hole: Uint8Array | null, weight: number): Candidate {
    const a = this.need().alignment;
    const gt = a.frames.get(t)?.gain ?? [1, 1, 1];
    const gf = a.frames.get(f)?.gain ?? [1, 1, 1];
    return { image, hole, H: between(a, t, f), gain: [gt[0] / gf[0], gt[1] / gf[1], gt[2] / gf[2]], weight, quality: this.quality(f) };
  }

  private async frameOf(io: CleanPlateIO, f: number, keep: boolean): Promise<LinearImage> {
    const hit = this.resident.get(f);
    if (hit) return hit;
    const img = await io.frame(f);
    this.size ??= { width: img.width, height: img.height };
    if (keep) this.resident.set(f, img);
    return img;
  }

  /** Drop resident frames a sequence no longer needs after frame `t`. */
  private release(t: number): void {
    const { window, anchors } = this.budget(false);
    const pinned = new Set([...anchorFrames(this.range.first, this.range.last, anchors), ...this.settings.guidance.prefer, ...this.settings.guidance.patches.map((x) => x.sourceFrame)]);
    for (const f of [...this.resident.keys()]) if (!pinned.has(f) && f < t - window + 1) this.resident.delete(f);
  }

  /**
   * The clean plate of frame `t` (sequence), or the still (any `t`: the plate
   * is in the reference frame's coordinates). `keep` holds frames in memory
   * for the next frame of a sequence.
   */
  async plate(io: CleanPlateIO, t: number, o: { keep?: boolean } = {}): Promise<PlateOutput> {
    const a = this.need();
    const still = a.mode === 'still';
    const target = still ? a.reference : Math.max(this.range.first, Math.min(this.range.last, t));
    const image = await this.frameOf(io, target, Boolean(o.keep) && !still);
    const { width: w, height: h } = image;
    const hole = await this.hole(io, target, w, h);
    const align = a.alignment.frames.get(target);
    const k = this.o.pxScale;
    const base = { residualPx: round3((align?.residual ?? 0) * k), motionPx: round3((align?.motion ?? 0) * k), exposureStops: round3(Math.log2(Math.max(1e-3, lumaOf(align?.gain ?? [1, 1, 1], this.o.luma)))) };
    const patches = this.settings.guidance.patches.filter((x) => x.enabled && (still || inRange(x.frames, target)));
    if (!hole && !patches.length) {
      const n = w * h;
      const out: FillResult = { width: w, height: h, plate: image.data, confidence: new Float32Array(n).fill(1), hole: new Uint8Array(n), inpainted: new Uint8Array(n), patched: new Uint8Array(n), support: new Uint8Array(n) };
      const metrics: CleanPlateMetrics = { hole: 0, coverage: 1, low: 0, meanHole: 1, ...base };
      return { ...out, frame: target, metrics, confidenceValue: cleanPlateConfidence(metrics) };
    }
    const p = this.settings.params;
    const fill = new HoleFill(image, hole ?? new Uint8Array(w * h), { tolerance: p.tolerance, luma: this.o.luma, featherPx: p.featherPx / k, maxCandidates: 16 });
    for (const c of this.candidatesFor(target, still)) {
      checkCancel(io.signal);
      const img = await this.frameOf(io, c.frame, Boolean(o.keep) && !still);
      const ch = await this.hole(io, c.frame, img.width, img.height);
      fill.add(this.candidate(target, c.frame, img, ch, c.weight));
    }
    for (const patch of patches) {
      const src = Math.max(this.range.first, Math.min(this.range.last, patch.sourceFrame));
      const img = await this.frameOf(io, src, Boolean(o.keep) && !still);
      const ch = await this.hole(io, src, img.width, img.height);
      const r = patch.rect;
      const region = rectMatte({ x0: r.x0 / k, y0: r.y0 / k, x1: r.x1 / k, y1: r.y1 / k }, w, h, 1.5);
      fill.patch(src === target ? { image, hole: null, H: [1, 0, 0, 0, 1, 0, 0, 0, 1], gain: [1, 1, 1], weight: 1, quality: 1 } : this.candidate(target, src, img, ch, 1), region);
    }
    if (o.keep && !still) this.release(target);
    const out = fill.resolve();
    const s = fillStats(out);
    const metrics: CleanPlateMetrics = { hole: round4(s.hole), coverage: round4(s.coverage), low: round4(s.low), meanHole: round4(s.meanHole), ...base };
    return { ...out, frame: target, metrics, confidenceValue: cleanPlateConfidence(metrics) };
  }

  /** Forget the frames held for a sequence. */
  clear(): void {
    this.resident.clear();
  }
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const round4 = (v: number) => Math.round(v * 10_000) / 10_000;
const lumaOf = (g: readonly number[], luma: readonly [number, number, number]) => luma[0] * g[0]! + luma[1] * g[1]! + luma[2] * g[2]!;

/**
 * Build the shot: analyse, then the still or every frame's plate, handing
 * each to `onFrame` (to cache it for review). Returns what
 * `recordCleanPlateRun` records.
 */
export async function runCleanPlate(io: CleanPlateIO, cleaner: ShotCleaner, o: { revision: number }, onFrame: (out: PlateOutput) => Promise<void> | void): Promise<CleanPlateRunResult & { analysis: CleanPlateAnalysis }> {
  const n = cleaner.range.last - cleaner.range.first + 1;
  const total0 = 2 * n;
  let fillTotal = n;
  const report = (done: number, frame?: number) => io.progress?.(done, total0 + fillTotal, frame);
  const analysis = await cleaner.analyse(io, (done, _t, f) => report(done, f));
  const frames: CleanPlateRunResult['frames'] = [];
  if (analysis.mode === 'still') {
    fillTotal = 1;
    const out = await cleaner.plate(io, analysis.reference);
    await onFrame(out);
    frames.push({ frame: out.frame, confidence: out.confidenceValue, metrics: out.metrics });
    report(total0 + 1, out.frame);
  } else {
    for (const f of cleaner.frames) {
      checkCancel(io.signal);
      const out = await cleaner.plate(io, f, { keep: true });
      await onFrame(out);
      frames.push({ frame: f, confidence: out.confidenceValue, metrics: out.metrics });
      report(total0 + frames.length, f);
    }
    cleaner.clear();
  }
  return {
    mode: analysis.mode,
    alignment: analysis.alignment.model,
    reference: analysis.reference,
    first: cleaner.range.first,
    last: cleaner.range.last,
    frames,
    suggestion: analysis.suggestion,
    revision: o.revision,
    algorithm: `vcvfx-cleanplate@${CLEANPLATE_ENGINE_VERSION}`,
    analysis,
  };
}
