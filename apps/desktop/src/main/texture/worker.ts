import { parentPort } from 'node:worker_threads';
import { TEXTURE_UNIT_METRES, type TexturePlacement, type TextureReference, type TextureRegion, type TextureRunResult } from '@vcvfx/domain';
import { buildTextures } from '../../shared/texture/engine';
import { scanViewOf } from '../../shared/texture/scan-view';
import { cachedRegion } from '../../shared/texture/view';
import { CancelledError } from '../../shared/roto/engine';
import { TextureCache } from './cache';
import { exportTextures, type TextureExportJob, type TextureExportResult } from './export';
import { createTextureIO, type TextureIOJob } from './io';

/**
 * The texture worker thread (addendum 12 §4): builds and exports run here,
 * off the main process's event loop, one job per worker, as the clean
 * plate's and the isolation's do. Messages in: one job, then optionally
 * `cancel`. Messages out: `progress`, then `done` or `error`.
 */

export interface TextureBuildJob {
  io: TextureIOJob;
  references: TextureReference[];
  regions: TextureRegion[];
  placements: TexturePlacement[];
  revision: number;
  /** Longest texture edge of the review build. */
  workingWidth: number;
  luma: [number, number, number];
  /** The review cache (TextureCache root) and the task version it is filed under. */
  cache: string;
  version: number;
}

export type TextureWorkerIn = { type: 'build'; job: TextureBuildJob } | { type: 'export'; job: TextureExportJob } | { type: 'cancel' };

export type TextureWorkerOut =
  | { type: 'progress'; done: number; total: number }
  | { type: 'done'; result?: TextureRunResult; exported?: TextureExportResult }
  | { type: 'error'; message: string; cancelled: boolean };

export async function handleTexture(message: Exclude<TextureWorkerIn, { type: 'cancel' }>, signal: AbortSignal, post: (m: TextureWorkerOut) => void): Promise<void> {
  try {
    if (message.type === 'build') {
      const job = message.job;
      const io = createTextureIO(job.io, signal);
      const cache = TextureCache.at(job.cache);
      await cache.startBuild(job.version, job.revision);
      const out = await buildTextures(
        io,
        { references: job.references, regions: job.regions, placements: job.placements },
        { luma: job.luma, revision: job.revision, maxTexture: job.workingWidth, maxPhoto: 4096, progress: (done, total) => post({ type: 'progress', done, total }) },
        (r) => cache.putRegion(job.version, job.revision, cachedRegion(r)),
      );
      const scan = job.references.find((r) => r.kind === 'scan');
      if (out.cloud && scan?.scan) {
        await cache.putScan(job.version, job.revision, {
          ...scanViewOf(out.cloud, { up: scan.scan.up, planes: out.result.planes, threshold: 0.03 / TEXTURE_UNIT_METRES[scan.scan.units], panorama: out.panoramaPosition, patches: out.patches }),
          built: 'current',
        });
      }
      post({ type: 'done', result: out.result });
    } else {
      const exported = await exportTextures(message.job, { signal, onProgress: (done, total) => post({ type: 'progress', done, total }) });
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
  port.on('message', (m: TextureWorkerIn) => {
    if (m.type === 'cancel') controller.abort();
    else void handleTexture(m, controller.signal, (out) => port.postMessage(out)).finally(() => port.close());
  });
}
