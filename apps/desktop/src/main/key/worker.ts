import { parentPort } from 'node:worker_threads';
import type { KeyRunResult, ScreenKind } from '@vcvfx/domain';
import { CancelledError } from '../../shared/roto/engine';
import { analysisFrames, detectShotScreen, runKey, shotScreenModel, ShotKeyer, type KeySettings } from '../../shared/key/engine';
import { planeToMask } from '../../shared/roto/image';
import { MaskStore } from '../roto/store';
import { exportKey, modelToJson, type KeyExportJob, type KeyExportResult } from './export';
import { createKeyIO, type KeyIOJob } from './io';

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

export interface ModelJob {
  io: KeyIOJob;
  settings: KeySettings;
}

export type KeyWorkerIn =
  | { type: 'detect'; job: DetectJob }
  | { type: 'process'; job: ProcessJob }
  | { type: 'model'; job: ModelJob }
  | { type: 'export'; job: KeyExportJob }
  | { type: 'cancel' };

export type KeyWorkerOut =
  | { type: 'progress'; done: number; total: number; frame?: number }
  | { type: 'done'; detected?: { kind: ScreenKind; rgb: [number, number, number]; coverage: number; frames: number[] }; result?: KeyRunResult; model?: KeyExportJob['model']; exported?: KeyExportResult }
  | { type: 'error'; message: string; cancelled: boolean };

export async function handleKey(message: Exclude<KeyWorkerIn, { type: 'cancel' }>, signal: AbortSignal, post: (m: KeyWorkerOut) => void): Promise<void> {
  try {
    if (message.type === 'detect') {
      const { io: spec, kind } = message.job;
      const io = createKeyIO(spec, signal);
      const frames = analysisFrames(spec.frames.first, spec.frames.last, 3);
      const d = await detectShotScreen({ ...io, progress: undefined }, frames, kind);
      post({ type: 'done', detected: { kind: d.kind, rgb: d.rgb, coverage: Math.round(d.coverage * 1000) / 1000, frames: d.frames } });
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
