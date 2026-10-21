import { parentPort } from 'node:worker_threads';
import type { CleanPlateRunResult } from '@vcvfx/domain';
import { ShotCleaner, runCleanPlate, type CleanPlateSettings } from '../../shared/cleanplate/engine';
import { cachedPlate } from '../../shared/cleanplate/view';
import { CancelledError } from '../../shared/roto/engine';
import { createKeyIO, type KeyIOJob } from '../key/io';
import { PlateCache } from './cache';
import { exportCleanPlate, type CleanPlateExportJob, type CleanPlateExportResult } from './export';

/**
 * The clean-plate worker thread (addendum 10 §7): builds and exports run
 * here, off the main process's event loop, one job per worker, as the key's
 * do. Messages in: one job, then optionally `cancel`. Messages out:
 * `progress`, then `done` or `error`. Cancelling stops between frames; the
 * main process also terminates the worker if it does not stop promptly.
 */

export interface BuildJob {
  io: KeyIOJob;
  settings: CleanPlateSettings;
  revision: number;
  range: { first: number; last: number };
  /** Plate pixels per working pixel. */
  pxScale: number;
  /** The review cache (PlateCache root) and the task version it is filed under. */
  cache: string;
  version: number;
}

export type CleanPlateWorkerIn = { type: 'build'; job: BuildJob } | { type: 'export'; job: CleanPlateExportJob } | { type: 'cancel' };

export type CleanPlateWorkerOut =
  | { type: 'progress'; done: number; total: number; frame?: number }
  | { type: 'done'; result?: CleanPlateRunResult; exported?: CleanPlateExportResult }
  | { type: 'error'; message: string; cancelled: boolean };

export async function handleCleanPlate(message: Exclude<CleanPlateWorkerIn, { type: 'cancel' }>, signal: AbortSignal, post: (m: CleanPlateWorkerOut) => void): Promise<void> {
  try {
    if (message.type === 'build') {
      const job = message.job;
      const io = createKeyIO(job.io, signal);
      const cache = PlateCache.at(job.cache);
      await cache.startBuild(job.version, job.revision);
      const cleaner = new ShotCleaner(job.settings, job.range, { pxScale: job.pxScale, luma: job.io.space.luma });
      const { analysis: _analysis, ...result } = await runCleanPlate({ ...io, signal, progress: (done, total, frame) => post({ type: 'progress', done, total, ...(frame !== undefined ? { frame } : {}) }) }, cleaner, { revision: job.revision }, (out) =>
        cache.put(job.version, job.revision, out.frame, cachedPlate(out, job.io.space)),
      );
      post({ type: 'done', result });
    } else {
      const exported = await exportCleanPlate(message.job, { signal, onProgress: (done, total) => post({ type: 'progress', done, total }) });
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
  port.on('message', (m: CleanPlateWorkerIn) => {
    if (m.type === 'cancel') controller.abort();
    else void handleCleanPlate(m, controller.signal, (out) => port.postMessage(out)).finally(() => port.close());
  });
}
