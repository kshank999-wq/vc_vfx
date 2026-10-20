import { propagationRange, type RotoDirection, type RotoEngineId, type RotoKeyFrame, type RotoPropagationResult } from '@vcvfx/domain';
import type { Mask, RGBImage } from './image';
import { maskArea } from './image';
import { scaleStrokes, type EngineStroke } from './strokes';

/**
 * The segmentation engine contract (addendum 04). An engine segments a key
 * frame from paint (or adopts a reference matte), then steps frame to frame.
 * Everything an engine needs arrives in the request; everything it learns
 * (colour models, image features, the previous prediction) it keeps between
 * calls of one run. Engines are pure computation: frames and masks come and
 * go through `RotoRunIO`, so the same engine runs in the desktop's worker
 * thread and in the browser.
 *
 * Matte refinement (feather, shrink/grow, edge snap, and later e.g. a
 * matting network) is a separate stage — `MatteRefiner` in refine.ts — so a
 * new model or refiner is one new class registered beside the others.
 */

export type EngineSettings = Record<string, number | string | boolean>;

export interface EngineResult {
  /** At working resolution; soft on the edge. */
  mask: Mask;
  /** 0 … 1. */
  confidence: number;
  /** The pieces the confidence was made of, for the record and for tests. */
  detail: Record<string, number>;
}

export interface KeyRequest {
  frame: number;
  image: RGBImage;
  /** In working pixels. */
  strokes: EngineStroke[];
  /** The matte already there, for a key frame with no strokes (an accepted reference). */
  reference: Mask | null;
  settings: EngineSettings;
}

export interface StepRequest {
  prevFrame: number;
  nextFrame: number;
  prev: RGBImage;
  next: RGBImage;
  prevMask: Mask;
  /** 0 … 1: blend of the motion-compensated previous edge (RotoRefine.temporalSmoothing). */
  smoothing: number;
  settings: EngineSettings;
}

export interface SegmentationEngine {
  readonly id: RotoEngineId;
  readonly version: string;
  readonly label: string;
  key(req: KeyRequest): Promise<EngineResult>;
  step(req: StepRequest): Promise<EngineResult>;
  dispose?(): void;
}

export interface RotoRunRequest {
  partId: string;
  from: number;
  /** 'key' segments the key frame; forward/backward propagate from it (locally, up to the neighbouring keys). */
  directions: RotoDirection[];
  /** Delivered numbers of the shot's first and last frame. */
  first: number;
  last: number;
  keyFrames: Pick<RotoKeyFrame, 'frame' | 'strokes'>[];
  /** Working pixels per plate pixel. */
  scale: number;
  smoothing: number;
  settings: EngineSettings;
}

export interface RotoRunIO {
  /** A frame at working resolution. */
  frame(frame: number): Promise<RGBImage>;
  /** The cached matte of a frame (working resolution), or null. */
  getMask(frame: number): Promise<Mask | null>;
  putMask(frame: number, mask: Mask, confidence: number): Promise<void>;
  signal?: AbortSignal;
  progress?(done: number, total: number, frame: number): void;
}

export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}

/** Run one part from one key frame: the key, then each direction asked for. */
export async function runRoto(engine: SegmentationEngine, req: RotoRunRequest, io: RotoRunIO): Promise<RotoPropagationResult[]> {
  const key = req.keyFrames.find((k) => k.frame === req.from);
  if (!key) throw new Error(`Frame ${req.from} is not a key frame. Paint it first, or mark it as a reference.`);
  const ranges = req.directions
    .filter((d): d is 'forward' | 'backward' => d !== 'key')
    .map((d) => ({ direction: d, range: propagationRange({ keyFrames: req.keyFrames.map((k) => ({ ...k, correction: false, by: '', at: '' })) }, req.from, d, req.first, req.last) }));
  const total = 1 + ranges.reduce((n, r) => n + (r.range ? r.range.last - r.range.first + 1 : 0), 0);
  let done = 0;
  const check = () => {
    if (io.signal?.aborted) throw new CancelledError();
  };
  check();
  const image = await io.frame(req.from);
  const strokes = scaleStrokes(
    key.strokes.map((s) => ({ mode: s.mode, radius: s.radius, points: s.points })),
    req.scale,
  );
  const reference = strokes.length ? null : await io.getMask(req.from);
  if (!strokes.length && !reference) throw new Error(`Frame ${req.from} has no strokes and no matte to use as a reference. Paint it first.`);
  const keyResult = await engine.key({ frame: req.from, image, strokes, reference, settings: req.settings });
  await io.putMask(req.from, keyResult.mask, keyResult.confidence);
  done += 1;
  io.progress?.(done, total, req.from);
  const engineRef = { id: engine.id, version: engine.version, settings: req.settings };
  const results: RotoPropagationResult[] = [{ partId: req.partId, engine: engineRef, direction: 'key', from: req.from, frames: [{ frame: req.from, confidence: keyResult.confidence }] }];
  for (const { direction, range } of ranges) {
    if (!range) continue;
    const frames: { frame: number; confidence: number }[] = [];
    let prev = image;
    let prevMask = keyResult.mask;
    let prevFrame = req.from;
    const order = direction === 'forward' ? range.first : range.last;
    const end = direction === 'forward' ? range.last : range.first;
    const stepBy = direction === 'forward' ? 1 : -1;
    for (let f = order; direction === 'forward' ? f <= end : f >= end; f += stepBy) {
      check();
      const next = await io.frame(f);
      const r = maskArea(prevMask) === 0 ? { mask: { width: next.width, height: next.height, data: new Uint8Array(next.width * next.height) }, confidence: 0, detail: {} } : await engine.step({ prevFrame, nextFrame: f, prev, next, prevMask, smoothing: req.smoothing, settings: req.settings });
      await io.putMask(f, r.mask, r.confidence);
      frames.push({ frame: f, confidence: r.confidence });
      prev = next;
      prevMask = r.mask;
      prevFrame = f;
      done += 1;
      io.progress?.(done, total, f);
    }
    results.push({ partId: req.partId, engine: engineRef, direction, from: req.from, frames });
  }
  return results;
}
