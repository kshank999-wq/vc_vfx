import { runWorkerJob, type WorkerJobOptions } from '../worker-job';
import type { LightingWorkerIn, LightingWorkerOut } from './worker';

/**
 * Runs lighting analyses and exports in a worker thread (addendum 14 §4), as
 * the other modules do. The worker's file is passed in (the built
 * `out/main/lighting-worker.js`, or a bundle in tests).
 */

export type LightingJobOptions = Omit<WorkerJobOptions, 'name'>;

export function runLightingJob(message: Exclude<LightingWorkerIn, { type: 'cancel' }>, o: LightingJobOptions): Promise<LightingWorkerOut & { type: 'done' }> {
  return runWorkerJob(message, { ...o, name: 'The lighting worker' });
}
