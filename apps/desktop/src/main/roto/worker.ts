import { parentPort } from 'node:worker_threads';
import type { RotoPropagationResult } from '@vcvfx/domain';
import { CancelledError, runRoto, type RotoRunRequest, type SegmentationEngine } from '../../shared/roto/engine';
import { resizeMask } from '../../shared/roto/image';
import { segmentationEngine, type Sam2Files } from './engines';
import { exportMattes, type ExportJob, type ExportResult } from './export';
import { FrameReader, type RotoFrameSpec } from './frames';
import { MaskStore } from './store';

/**
 * The roto worker thread (addendum 04): propagation and export run here, off
 * the main process's event loop, one job per worker. Messages in: one
 * `run`/`export` job, then optionally `cancel`. Messages out: `progress`,
 * then `done` or `error`. Cancelling stops between frames; the main process
 * also terminates the worker if it does not stop promptly.
 */

export interface RunJob {
  frames: RotoFrameSpec;
  working: { width: number; height: number };
  store: string;
  version: number;
  engine: 'track' | 'sam2';
  sam2?: Sam2Files;
  request: RotoRunRequest;
}

export type WorkerIn = { type: 'run'; job: RunJob } | { type: 'export'; job: ExportJob; store: string } | { type: 'cancel' };
export type WorkerOut =
  | { type: 'progress'; done: number; total: number; frame?: number }
  | { type: 'done'; results?: RotoPropagationResult[]; exported?: ExportResult }
  | { type: 'error'; message: string; cancelled: boolean };

const engineFor = (job: RunJob): Promise<SegmentationEngine> => segmentationEngine(job.engine, job.sam2);

export async function handle(message: Exclude<WorkerIn, { type: 'cancel' }>, signal: AbortSignal, post: (m: WorkerOut) => void): Promise<void> {
  try {
    if (message.type === 'run') {
      const { job } = message;
      const store = MaskStore.at(job.store);
      const reader = new FrameReader(job.frames, job.working, { signal });
      const engine = await engineFor(job);
      try {
        const results = await runRoto(engine, job.request, {
          frame: (f) => reader.frame(f),
          // A matte made at another working size (the setting changed) is scaled to this one.
          getMask: async (f) => {
            const m = await store.get(job.request.partId, job.version, f);
            return m && (m.width !== job.working.width || m.height !== job.working.height) ? resizeMask(m, job.working.width, job.working.height) : m;
          },
          putMask: (f, m) => store.put(job.request.partId, job.version, f, m),
          signal,
          progress: (done, total, frame) => post({ type: 'progress', done, total, frame }),
        });
        post({ type: 'done', results });
      } finally {
        engine.dispose?.();
      }
    } else {
      const exported = await exportMattes(message.job, MaskStore.at(message.store), { signal, onProgress: (done, total) => post({ type: 'progress', done, total }) });
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
  port.on('message', (m: WorkerIn) => {
    if (m.type === 'cancel') controller.abort();
    else void handle(m, controller.signal, (out) => port.postMessage(out)).finally(() => port.close());
  });
}
