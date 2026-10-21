import { runWorkerJob, type WorkerJobOptions } from '../worker-job';
import type { CleanPlateWorkerIn, CleanPlateWorkerOut } from './worker';

/**
 * Runs clean-plate jobs in a worker thread (addendum 10 §7), as the key does:
 * progress is reported, and Cancel stops a job between frames — or
 * terminates the thread if it has not stopped within a few seconds. The
 * worker's file is passed in (the built `out/main/cleanplate-worker.js`, or a
 * bundle in tests).
 */

export type CleanPlateJobOptions = Omit<WorkerJobOptions, 'name'>;

export function runCleanPlateJob(message: Exclude<CleanPlateWorkerIn, { type: 'cancel' }>, o: CleanPlateJobOptions): Promise<CleanPlateWorkerOut & { type: 'done' }> {
  return runWorkerJob(message, { ...o, name: 'The clean-plate worker' });
}
