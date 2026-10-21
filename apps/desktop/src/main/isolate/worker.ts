import { parentPort } from 'node:worker_threads';
import type { IsolateRunResult } from '@vcvfx/domain';
import { ShotIsolator, runIsolate, type IsolateSettings } from '../../shared/isolate/engine';
import { cachedMatte, cachedPlate } from '../../shared/isolate/view';
import { CancelledError } from '../../shared/roto/engine';
import { createKeyIO, type KeyIOJob } from '../key/io';
import { segmentationEngine, type Sam2Files } from '../roto/engines';
import { IsolateCache } from './cache';
import { exportIsolate, type IsolateExportJob, type IsolateExportResult } from './export';

/**
 * The sky/background isolation worker thread (addendum 11 §4): builds and
 * exports run here, off the main process's event loop, one job per worker,
 * as the clean plate's do. Messages in: one job, then optionally `cancel`.
 * Messages out: `progress`, then `done` or `error`. Cancelling stops between
 * frames; the main process also terminates the worker if it does not stop
 * promptly.
 */

export interface IsolateBuildJob {
  io: KeyIOJob;
  settings: IsolateSettings;
  revision: number;
  range: { first: number; last: number };
  /** Plate pixels per working pixel. */
  pxScale: number;
  /** The review cache (IsolateCache root) and the task version it is filed under. */
  cache: string;
  version: number;
  /** SAM 2.1's files when the subject's engine is SAM and its model is installed. */
  sam2?: Sam2Files;
}

export type IsolateWorkerIn = { type: 'build'; job: IsolateBuildJob } | { type: 'export'; job: IsolateExportJob } | { type: 'cancel' };

export type IsolateWorkerOut =
  | { type: 'progress'; done: number; total: number; frame?: number }
  | { type: 'done'; result?: IsolateRunResult; exported?: IsolateExportResult }
  | { type: 'error'; message: string; cancelled: boolean };

export async function handleIsolate(message: Exclude<IsolateWorkerIn, { type: 'cancel' }>, signal: AbortSignal, post: (m: IsolateWorkerOut) => void): Promise<void> {
  try {
    if (message.type === 'build') {
      const job = message.job;
      const io = createKeyIO(job.io, signal);
      const cache = IsolateCache.at(job.cache);
      await cache.startBuild(job.version, job.revision);
      const isolator = new ShotIsolator(job.settings, job.range, {
        pxScale: job.pxScale,
        space: job.io.space,
        ...(job.settings.target === 'background' ? { engine: () => segmentationEngine(job.settings.engine === 'sam2' && job.sam2 ? 'sam2' : 'track', job.sam2) } : {}),
      });
      const { analysis: _analysis, ...result } = await runIsolate(
        { ...io, signal, progress: (done, total, frame) => post({ type: 'progress', done, total, ...(frame !== undefined ? { frame } : {}) }) },
        isolator,
        { revision: job.revision },
        (m) => cache.putMatte(job.version, job.revision, m.frame, cachedMatte(m, job.io.space)),
        (p) => cache.putPlate(job.version, job.revision, p.frame, cachedPlate(p, job.io.space)),
      );
      post({ type: 'done', result });
    } else {
      const exported = await exportIsolate(message.job, { signal, onProgress: (done, total) => post({ type: 'progress', done, total }) });
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
  port.on('message', (m: IsolateWorkerIn) => {
    if (m.type === 'cancel') controller.abort();
    else void handleIsolate(m, controller.signal, (out) => port.postMessage(out)).finally(() => port.close());
  });
}
