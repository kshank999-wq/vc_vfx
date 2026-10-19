import type { WebContents } from 'electron';
import type { JobProgress } from '../shared/bridge';

/** Long-running work (hashing, packaging, ffmpeg): cancellable, with progress events. */

const running = new Map<string, AbortController>();

export function startJob(jobId: string): AbortSignal {
  running.get(jobId)?.abort();
  const controller = new AbortController();
  running.set(jobId, controller);
  return controller.signal;
}

export function endJob(jobId: string): void {
  running.delete(jobId);
}

export function cancelJob(jobId: string): void {
  running.get(jobId)?.abort();
}

/** A sender that drops events faster than ~20 a second, keeping the last. */
export function progressSender(contents: WebContents, jobId: string, label: string) {
  let last = 0;
  return (done: number, total: number, detail?: string, force = false) => {
    const now = Date.now();
    if (!force && now - last < 50 && done < total) return;
    last = now;
    if (contents.isDestroyed()) return;
    const progress: JobProgress = { jobId, label, done, total, ...(detail ? { detail } : {}) };
    contents.send('job:progress', progress);
  };
}
