import { Worker } from 'node:worker_threads';
import type { RotoPropagationResult } from '@vcvfx/domain';
import type { ExportJob, ExportResult } from './export';
import type { RunJob, WorkerIn, WorkerOut } from './worker';

/**
 * Runs roto jobs in a worker thread (addendum 04): heavy pixel work never
 * blocks the main process, a job reports progress as it goes, and Cancel
 * stops it — politely between frames, or by terminating the thread if it does
 * not stop within a few seconds. No Electron here: the worker's file is passed
 * in (the built `out/main/roto-worker.js`, or a bundle in tests).
 */

export interface WorkerJobOptions {
  workerFile: string;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, frame?: number) => void;
  /** How long to wait for a polite stop before terminating, ms. */
  graceMs?: number;
}

function runInWorker(message: Exclude<WorkerIn, { type: 'cancel' }>, o: WorkerJobOptions): Promise<WorkerOut & { type: 'done' }> {
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
      worker.postMessage({ type: 'cancel' } satisfies WorkerIn);
      killer = setTimeout(() => finish(() => reject(new Error('Cancelled'))), o.graceMs ?? 3000);
    };
    o.signal?.addEventListener('abort', onAbort, { once: true });
    worker.on('message', (m: WorkerOut) => {
      if (m.type === 'progress') o.onProgress?.(m.done, m.total, m.frame);
      else if (m.type === 'done') finish(() => resolvePromise(m));
      else finish(() => reject(new Error(m.message)));
    });
    worker.on('error', (e) => finish(() => reject(e)));
    worker.on('exit', (code) => finish(() => reject(new Error(o.signal?.aborted ? 'Cancelled' : `The roto worker stopped (exit ${code})`))));
    worker.postMessage(message);
  });
}

export async function runRotoJob(job: RunJob, o: WorkerJobOptions): Promise<RotoPropagationResult[]> {
  const out = await runInWorker({ type: 'run', job }, o);
  return out.results ?? [];
}

export async function runExportJob(job: ExportJob, store: string, o: WorkerJobOptions): Promise<ExportResult> {
  const out = await runInWorker({ type: 'export', job, store }, o);
  if (!out.exported) throw new Error('The export produced nothing');
  return out.exported;
}
