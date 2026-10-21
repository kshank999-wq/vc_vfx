import { Worker } from 'node:worker_threads';
import type { CleanPlateWorkerIn, CleanPlateWorkerOut } from './worker';

/**
 * Runs clean-plate jobs in a worker thread (addendum 10 §7), as the key does:
 * progress is reported, and Cancel stops a job between frames — or
 * terminates the thread if it has not stopped within a few seconds. The
 * worker's file is passed in (the built `out/main/cleanplate-worker.js`, or a
 * bundle in tests).
 */

export interface CleanPlateJobOptions {
  workerFile: string;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, frame?: number) => void;
  graceMs?: number;
}

export function runCleanPlateJob(message: Exclude<CleanPlateWorkerIn, { type: 'cancel' }>, o: CleanPlateJobOptions): Promise<CleanPlateWorkerOut & { type: 'done' }> {
  return new Promise((resolvePromise, reject) => {
    if (o.signal?.aborted) return reject(new Error('Cancelled'));
    const worker = new Worker(o.workerFile);
    let settled = false;
    let killer: ReturnType<typeof setTimeout> | null = null;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (killer) clearTimeout(killer);
      o.signal?.removeEventListener('abort', onAbort);
      fn();
      void worker.terminate();
    };
    const onAbort = () => {
      worker.postMessage({ type: 'cancel' } satisfies CleanPlateWorkerIn);
      killer = setTimeout(() => finish(() => reject(new Error('Cancelled'))), o.graceMs ?? 3000);
    };
    o.signal?.addEventListener('abort', onAbort, { once: true });
    worker.on('message', (m: CleanPlateWorkerOut) => {
      if (m.type === 'progress') o.onProgress?.(m.done, m.total, m.frame);
      else if (m.type === 'done') finish(() => resolvePromise(m));
      else finish(() => reject(new Error(m.message)));
    });
    worker.on('error', (e) => finish(() => reject(e)));
    worker.on('exit', (code) => finish(() => reject(new Error(o.signal?.aborted ? 'Cancelled' : `The clean-plate worker stopped (exit ${code})`))));
    worker.postMessage(message);
  });
}
