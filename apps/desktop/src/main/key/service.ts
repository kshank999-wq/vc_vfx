import { Worker } from 'node:worker_threads';
import type { KeyWorkerIn, KeyWorkerOut } from './worker';

/**
 * Runs key jobs in a worker thread (addendum 09 §4), as roto does: heavy
 * pixel work never blocks the main process, progress is reported, and Cancel
 * stops a job between frames — or terminates the thread if it has not
 * stopped within a few seconds. The worker's file is passed in (the built
 * `out/main/key-worker.js`, or a bundle in tests).
 */

export interface KeyJobOptions {
  workerFile: string;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, frame?: number) => void;
  graceMs?: number;
}

export function runKeyJob(message: Exclude<KeyWorkerIn, { type: 'cancel' }>, o: KeyJobOptions): Promise<KeyWorkerOut & { type: 'done' }> {
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
      worker.postMessage({ type: 'cancel' } satisfies KeyWorkerIn);
      killer = setTimeout(() => finish(() => reject(new Error('Cancelled'))), o.graceMs ?? 3000);
    };
    o.signal?.addEventListener('abort', onAbort, { once: true });
    worker.on('message', (m: KeyWorkerOut) => {
      if (m.type === 'progress') o.onProgress?.(m.done, m.total, m.frame);
      else if (m.type === 'done') finish(() => resolvePromise(m));
      else finish(() => reject(new Error(m.message)));
    });
    worker.on('error', (e) => finish(() => reject(e)));
    worker.on('exit', (code) => finish(() => reject(new Error(o.signal?.aborted ? 'Cancelled' : `The key worker stopped (exit ${code})`))));
    worker.postMessage(message);
  });
}
