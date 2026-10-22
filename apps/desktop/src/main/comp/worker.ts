import { parentPort } from 'node:worker_threads';
import { bakeComp, renderComp, type CompBakeJob, type CompRenderJob, type CompRenderResult } from './render';

/**
 * The comp worker thread (addendum 13 §5): renders and bakes run here, off
 * the main process's event loop, one job per worker, as the other modules'.
 * Messages in: one job, then optionally `cancel`. Messages out: `progress`,
 * then `done` or `error`. Cancelling stops between frames; the main process
 * also terminates the worker if it does not stop promptly.
 */

export type CompWorkerIn = { type: 'render'; job: CompRenderJob } | { type: 'bake'; job: CompBakeJob } | { type: 'cancel' };

export type CompWorkerOut =
  | { type: 'progress'; done: number; total: number; frame?: number }
  | { type: 'done'; rendered?: CompRenderResult; baked?: { files: string[] } }
  | { type: 'error'; message: string; cancelled: boolean };

export async function handleComp(message: Exclude<CompWorkerIn, { type: 'cancel' }>, signal: AbortSignal, post: (m: CompWorkerOut) => void): Promise<void> {
  const onProgress = (done: number, total: number, frame?: number) => post({ type: 'progress', done, total, ...(frame !== undefined ? { frame } : {}) });
  try {
    if (message.type === 'render') post({ type: 'done', rendered: await renderComp(message.job, { signal, onProgress }) });
    else post({ type: 'done', baked: await bakeComp(message.job, { signal, onProgress }) });
  } catch (error) {
    const cancelled = signal.aborted || (error as Error).message === 'Cancelled';
    post({ type: 'error', message: cancelled ? 'Cancelled' : (error as Error).message, cancelled });
  }
}

if (parentPort) {
  const port = parentPort;
  const controller = new AbortController();
  port.on('message', (m: CompWorkerIn) => {
    if (m.type === 'cancel') controller.abort();
    else void handleComp(m, controller.signal, (out) => port.postMessage(out)).finally(() => port.close());
  });
}
