import { runWorkerJob, type WorkerJobOptions } from '../worker-job';
import type { TextureWorkerIn, TextureWorkerOut } from './worker';

/**
 * Runs texture builds and exports in a worker thread (addendum 12 §4), as the
 * clean plate and the isolation do. The worker's file is passed in (the built
 * `out/main/texture-worker.js`, or a bundle in tests).
 */

export type TextureJobOptions = Omit<WorkerJobOptions, 'name'>;

export function runTextureJob(message: Exclude<TextureWorkerIn, { type: 'cancel' }>, o: TextureJobOptions): Promise<TextureWorkerOut & { type: 'done' }> {
  return runWorkerJob(message, { ...o, name: 'The texture worker' });
}
