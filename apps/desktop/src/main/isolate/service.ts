import { runWorkerJob, type WorkerJobOptions } from '../worker-job';
import type { IsolateWorkerIn, IsolateWorkerOut } from './worker';

/**
 * Runs sky and background isolation jobs in a worker thread (addendum 11
 * §4), as the clean plate does. The worker's file is passed in (the built
 * `out/main/isolate-worker.js`, or a bundle in tests).
 */

export type IsolateJobOptions = Omit<WorkerJobOptions, 'name'>;

export function runIsolateJob(message: Exclude<IsolateWorkerIn, { type: 'cancel' }>, o: IsolateJobOptions): Promise<IsolateWorkerOut & { type: 'done' }> {
  return runWorkerJob(message, { ...o, name: 'The isolation worker' });
}
