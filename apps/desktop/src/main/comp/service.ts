import { runWorkerJob, type WorkerJobOptions } from '../worker-job';
import type { CompWorkerIn, CompWorkerOut } from './worker';

/**
 * Runs comp renders and bakes in a worker thread (addendum 13 §5), as the
 * other modules do. The worker's file is passed in (the built
 * `out/main/comp-worker.js`, or a bundle in tests).
 */

export type CompJobOptions = Omit<WorkerJobOptions, 'name'>;

export function runCompJob(message: Exclude<CompWorkerIn, { type: 'cancel' }>, o: CompJobOptions): Promise<CompWorkerOut & { type: 'done' }> {
  return runWorkerJob(message, { ...o, name: 'The comp worker' });
}
