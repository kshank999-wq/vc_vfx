import { Worker } from 'node:worker_threads';

/**
 * One job in a worker thread (the clean plate's and the isolation's,
 * addenda 10 and 11): the job message is posted, progress is reported, and
 * Cancel posts `cancel` — the worker stops between frames — or terminates
 * the thread if it has not stopped within a few seconds. The worker answers
 * `progress`, then `done` or `error`.
 */

export type WorkerJobOut<Done> = { type: 'progress'; done: number; total: number; frame?: number } | (Done & { type: 'done' }) | { type: 'error'; message: string; cancelled: boolean };

export interface WorkerJobOptions {
  workerFile: string;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, frame?: number) => void;
  graceMs?: number;
  /** What the worker is called when it stops on its own ("the clean-plate worker"). */
  name: string;
}

export function runWorkerJob<Done extends { type: 'done' }>(message: unknown, o: WorkerJobOptions): Promise<Done> {
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
      worker.postMessage({ type: 'cancel' });
      killer = setTimeout(() => finish(() => reject(new Error('Cancelled'))), o.graceMs ?? 3000);
    };
    o.signal?.addEventListener('abort', onAbort, { once: true });
    worker.on('message', (m: WorkerJobOut<Done>) => {
      if (m.type === 'progress') o.onProgress?.(m.done, m.total, m.frame);
      else if (m.type === 'done') finish(() => resolvePromise(m as Done));
      else finish(() => reject(new Error((m as { message: string }).message)));
    });
    worker.on('error', (e) => finish(() => reject(e)));
    worker.on('exit', (code) => finish(() => reject(new Error(o.signal?.aborted ? 'Cancelled' : `${o.name} stopped (exit ${code})`))));
    worker.postMessage(message);
  });
}
