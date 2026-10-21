import { parentPort } from 'node:worker_threads';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { dispatch, type CameraCommand, type CameraSession, type CommandOutcome } from '../../shared/camera/commands';
import type { SessionBase } from '../../shared/camera/session';
import { TsCameraSolver } from '../../shared/camera/solver';
import { grayOf, type GrayFrame } from '../../shared/camera/klt';
import { resizeMask } from '../../shared/roto/image';
import { FrameReader, type RotoFrameSpec } from '../roto/frames';
import { MaskStore } from '../roto/store';
import { writeAtomic } from '../atomic';
import { FileStore } from './store';

/**
 * The camera worker thread (addendum 06 §8): one command per worker. The
 * session is rebuilt here from what main sends — the shot's documents, the
 * frame source, the cache folders — and the shared dispatcher runs the
 * command. Frames are read by ffmpeg at the working size; roto mattes come
 * from the roto cache; exports are written into the shot package, never over
 * an approved version.
 */

export interface CameraJob {
  base: SessionBase;
  frames: RotoFrameSpec | null;
  store: string;
  roto: { root: string; version: number } | null;
  /** The shot's package folder, for exports; null when no output root is set. */
  shotFolder: string | null;
  /** The export's version is approved: never rewrite files already there. */
  approved: boolean;
  actor: string;
  now: string;
  generator: string;
  command: CameraCommand;
}

export type CameraWorkerIn = { type: 'run'; job: CameraJob } | { type: 'cancel' };
export type CameraWorkerOut = { type: 'progress'; label: string; done: number; total: number } | { type: 'done'; outcome: CommandOutcome } | { type: 'error'; message: string; cancelled: boolean };

export async function handleCamera(job: CameraJob, signal: AbortSignal, post: (m: CameraWorkerOut) => void): Promise<void> {
  try {
    const reader = job.frames ? new FrameReader(job.frames, job.base.working, { signal, chunk: 16, keep: 40 }) : null;
    const cache = new Map<number, GrayFrame>();
    const frame = async (f: number): Promise<GrayFrame> => {
      const hit = cache.get(f);
      if (hit) return hit;
      if (!reader) throw new Error('This shot has no frames to read.');
      const g = grayOf(await reader.frame(f));
      cache.set(f, g);
      if (cache.size > 24) cache.delete(cache.keys().next().value!);
      return g;
    };
    const rotoStore = job.roto ? MaskStore.at(job.roto.root) : null;
    const { width: W, height: H } = job.base.working;
    const session: CameraSession = {
      ...job.base,
      io: {
        frame,
        rotoMask: rotoStore
          ? async (parts, f) => {
              let out: Uint8Array | null = null;
              for (const part of parts) {
                const m = await rotoStore.get(part, job.roto!.version, f).catch(() => null);
                if (!m) continue;
                const r = m.width === W && m.height === H ? m : resizeMask(m, W, H);
                out ??= new Uint8Array(W * H);
                for (let i = 0; i < out.length; i += 1) if (r.data[i]! >= 128) out[i] = 1;
              }
              return out;
            }
          : undefined,
        readFile: async (path) => {
          const info = await stat(path);
          if (info.size > 2 * 1024 ** 3) throw new Error('The file is larger than 2 GB; VC VFX reads LiDAR files whole. Decimate it first.');
          const buf = await readFile(path);
          return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        },
        writeExport: job.shotFolder
          ? async (folder, files) => {
              const dir = join(job.shotFolder!, folder.section, folder.name);
              if (job.approved && (await readdir(dir).catch(() => [])).length) throw new Error(`${folder.name} is approved and already written; it is never rewritten. Reopen the task to make a new version.`);
              // An unapproved version is cleared (only its own folder) and written again.
              await rm(dir, { recursive: true, force: true });
              await mkdir(dir, { recursive: true });
              for (const f of files) await writeAtomic(join(dir, f.name), f.data);
              return { folder: `${folder.section}/${folder.name}`, files: files.map((f) => f.name) };
            }
          : undefined,
      },
      store: FileStore.at(job.store),
      solver: new TsCameraSolver(),
      actor: job.actor,
      now: () => new Date(job.now),
      generator: job.generator,
      signal,
      progress: (label, done, total) => post({ type: 'progress', label, done, total }),
    };
    const outcome = await dispatch(session, job.command);
    post({ type: 'done', outcome });
  } catch (error) {
    const cancelled = signal.aborted || (error as Error).message === 'Cancelled';
    post({ type: 'error', message: cancelled ? 'Cancelled' : (error as Error).message, cancelled });
  }
}

if (parentPort) {
  const port = parentPort;
  const controller = new AbortController();
  port.on('message', (m: CameraWorkerIn) => {
    if (m.type === 'cancel') controller.abort();
    else void handleCamera(m.job, controller.signal, (out) => port.postMessage(out)).finally(() => port.close());
  });
}
