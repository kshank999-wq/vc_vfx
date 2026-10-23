import { parentPort } from 'node:worker_threads';
import type { KeyRunResult, ScreenKind } from '@vcvfx/domain';
import { CancelledError } from '../../shared/roto/engine';
import { analysisFrames, detectShotScreen, runKey, shotScreenModel, ShotKeyer, type KeySettings } from '../../shared/key/engine';
import { planeToMask } from '../../shared/roto/image';
import { MaskStore } from '../roto/store';
import { exportKey, modelToJson, type KeyExportJob, type KeyExportResult } from './export';
import { createKeyIO, SUBJECT_PART, type KeyIOJob } from './io';
import type { KeyRect, KeySubjectPoint } from '@vcvfx/domain';
import { seedFromKey, seedFromOperator, runSubject } from '../../shared/key/subject-run';
import { toDisplay } from '../../shared/key/linear';
import { segmentationEngine, type Sam2Files } from '../roto/engines';

/**
 * The key worker thread (addendum 09 §4): detection, processing and export
 * run here, off the main process's event loop, one job per worker. Messages
 * in: one job, then optionally `cancel`. Messages out: `progress`, then
 * `done` or `error`. Cancelling stops between frames; the main process also
 * terminates the worker if it does not stop promptly.
 */

export interface DetectJob {
  io: KeyIOJob;
  kind: ScreenKind | null;
}

export interface ProcessJob {
  io: KeyIOJob;
  settings: KeySettings;
  revision: number;
  range: { first: number; last: number };
  /** Where processed mattes are cached (8-bit, working size): a MaskStore root, part `alpha`. */
  cache: string;
  version: number;
  /** Plate pixels per working pixel. */
  pxScale: number;
}

/** The Auto subject segmentation (addendum 18): seed on one frame, then propagate over the shot. */
export interface SubjectJob {
  /** Frames at the size the segmentation runs at (≤ 1024 px wide). */
  io: KeyIOJob;
  settings: KeySettings;
  engine: 'sam2' | 'track';
  sam2?: Sam2Files;
  seedFrame: number;
  /** The operator's seed in plate pixels, or null: seeded from the key's confident foreground. */
  seed: { box: KeyRect | null; points: KeySubjectPoint[] } | null;
  /** Plate pixels per segmentation pixel. */
  pxScale: number;
  /** Where the masks go (a MaskStore root, part `subject`). */
  cache: string;
  version: number;
}

export interface SubjectResult {
  engine: string;
  seededBy: 'operator' | 'key';
  frames: { frame: number; confidence: number }[];
}

export interface ModelJob {
  io: KeyIOJob;
  settings: KeySettings;
}

export type KeyWorkerIn =
  | { type: 'detect'; job: DetectJob }
  | { type: 'process'; job: ProcessJob }
  | { type: 'model'; job: ModelJob }
  | { type: 'subject'; job: SubjectJob }
  | { type: 'export'; job: KeyExportJob }
  | { type: 'cancel' };

export type KeyWorkerOut =
  | { type: 'progress'; done: number; total: number; frame?: number }
  | { type: 'done'; detected?: { kind: ScreenKind; rgb: [number, number, number]; coverage: number; frames: number[] }; result?: KeyRunResult; model?: KeyExportJob['model']; exported?: KeyExportResult; subject?: SubjectResult }
  | { type: 'error'; message: string; cancelled: boolean };

export async function handleKey(message: Exclude<KeyWorkerIn, { type: 'cancel' }>, signal: AbortSignal, post: (m: KeyWorkerOut) => void): Promise<void> {
  try {
    if (message.type === 'detect') {
      const { io: spec, kind } = message.job;
      const io = createKeyIO(spec, signal);
      const frames = analysisFrames(spec.frames.first, spec.frames.last, 3);
      const d = await detectShotScreen({ ...io, progress: undefined }, frames, kind);
      post({ type: 'done', detected: { kind: d.kind, rgb: d.rgb, coverage: Math.round(d.coverage * 1000) / 1000, frames: d.frames } });
    } else if (message.type === 'subject') {
      const job = message.job;
      const io = createKeyIO(job.io, signal);
      const { width: w, height: h } = job.io.size;
      const first = job.io.frames.first;
      const last = job.io.frames.last;
      const from = Math.max(first, Math.min(last, job.seedFrame));
      let seed = job.seed ? seedFromOperator(job.seed.box, job.seed.points, job.pxScale, w, h) : null;
      if (!seed) {
        // The key's own confident foreground on the seed frame (the key without a prior).
        const plain: KeySettings = { ...job.settings, subject: { source: 'none', partId: null, marginPx: 12, outside: true } };
        const keyer = new ShotKeyer(plain, await shotScreenModel(io, plain, first, last));
        const out = await keyer.keyAt(io, from, await io.frame(from), { pxScale: job.pxScale, luma: job.io.space.luma, foreground: false });
        seed = seedFromKey(out.alpha, w, h);
        if (!seed) throw new Error(`The key finds nothing solid on frame ${from} to start the subject from. Draw a box round the subject, or click on it.`);
      }
      const engine = await segmentationEngine(job.engine, job.sam2);
      const store = MaskStore.at(job.cache);
      const display = new Uint8ClampedArray(w * h * 3);
      try {
        const frames = await runSubject(engine, seed, from, { first, last }, {
          signal,
          frame: async (f) => {
            const img = await io.frame(f);
            return { width: img.width, height: img.height, data: toDisplay(img.data, img.width * img.height, job.io.space, display).slice() };
          },
          put: (f, mask) => store.put(SUBJECT_PART, job.version, f, mask),
          progress: (done, total, frame) => post({ type: 'progress', done, total, frame }),
        });
        post({ type: 'done', subject: { engine: `${engine.id}@${engine.version}`, seededBy: seed.seededBy, frames } });
      } finally {
        engine.dispose?.();
      }
    } else if (message.type === 'model') {
      const io = createKeyIO(message.job.io, signal);
      const model = await shotScreenModel(io, message.job.settings, message.job.io.frames.first, message.job.io.frames.last);
      post({ type: 'done', model: modelToJson(model) });
    } else if (message.type === 'process') {
      const job = message.job;
      const io = createKeyIO(job.io, signal);
      const model = await shotScreenModel(io, job.settings, job.io.frames.first, job.io.frames.last);
      const keyer = new ShotKeyer(job.settings, model);
      const store = MaskStore.at(job.cache);
      const result = await runKey(
        { ...io, progress: (done, total, frame) => post({ type: 'progress', done, total, frame }) },
        keyer,
        job.range,
        { pxScale: job.pxScale, luma: job.io.space.luma, revision: job.revision },
        (f, out) => store.put('alpha', job.version, f, planeToMask(out.alpha, out.width, out.height)),
      );
      post({ type: 'done', result, model: modelToJson(model) });
    } else {
      const exported = await exportKey(message.job, { signal, onProgress: (done, total) => post({ type: 'progress', done, total }) });
      post({ type: 'done', exported });
    }
  } catch (error) {
    const cancelled = error instanceof CancelledError || signal.aborted || (error as Error).message === 'Cancelled';
    post({ type: 'error', message: cancelled ? 'Cancelled' : (error as Error).message, cancelled });
  }
}

if (parentPort) {
  const port = parentPort;
  const controller = new AbortController();
  port.on('message', (m: KeyWorkerIn) => {
    if (m.type === 'cancel') controller.abort();
    else void handleKey(m, controller.signal, (out) => port.postMessage(out)).finally(() => port.close());
  });
}
