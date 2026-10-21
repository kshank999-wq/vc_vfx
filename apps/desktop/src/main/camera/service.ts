import { Worker } from 'node:worker_threads';
import type { CommandOutcome } from '../../shared/camera/commands';
import type { CameraJob, CameraWorkerIn, CameraWorkerOut } from './worker';

/**
 * Runs a camera command in a worker thread (addendum 06 §8), like roto's
 * service: progress events, and Cancel — politely (the solver and tracker
 * check between steps), or by terminating the thread after a grace period.
 */
export function runCameraJob(job: CameraJob, o: { workerFile: string; signal?: AbortSignal; onProgress?: (label: string, done: number, total: number) => void; graceMs?: number }): Promise<CommandOutcome> {
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
      worker.postMessage({ type: 'cancel' } satisfies CameraWorkerIn);
      killer = setTimeout(() => finish(() => reject(new Error('Cancelled'))), o.graceMs ?? 5000);
    };
    o.signal?.addEventListener('abort', onAbort, { once: true });
    worker.on('message', (m: CameraWorkerOut) => {
      if (m.type === 'progress') o.onProgress?.(m.label, m.done, m.total);
      else if (m.type === 'done') finish(() => resolvePromise(m.outcome));
      else finish(() => reject(new Error(m.message)));
    });
    worker.on('error', (e) => finish(() => reject(e)));
    worker.on('exit', (code) => finish(() => reject(new Error(o.signal?.aborted ? 'Cancelled' : `The camera worker stopped (exit ${code})`))));
    worker.postMessage({ type: 'run', job } satisfies CameraWorkerIn);
  });
}
