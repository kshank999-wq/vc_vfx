import { parseProject, shotState } from '@vcvfx/domain';
import type { ApiResult, JobProgress, TrackCommandRequest, TrackSessionInfo, TrackShotInput, TrackViewData, ViewerFrame } from '../shared/bridge';
import { COMMAND_SPECS, dispatch, type CameraCommand, type CameraSession } from '../shared/camera/commands';
import { checkerboardPdf } from '../shared/camera/calibration';
import { grayOf, type GrayFrame } from '../shared/camera/klt';
import { MemoryStore, sessionBase, viewData } from '../shared/camera/session';
import { TsCameraSolver } from '../shared/camera/solver';
import { viewerTimeline } from '../shared/viewer';

/**
 * Camera and 2D tracking in the browser preview (addendum 06 §9). The
 * preview has no media, so the sample project's tracking shots run on a
 * bundled synthetic shot (scripts/make-track-sample.ts): 48 rendered frames
 * of a room on a truck-and-pan move, and a LiDAR scan of the room. The
 * shared command dispatcher runs here, in the page — detect, track, solve,
 * align to the scan, 2D tracks — on those frames for real. Track data stays
 * in memory. Exports, which write into a package on disk, are the desktop
 * app's.
 */

const FRAMES = import.meta.glob<string>('./assets/track-sample/*.jpg', { eager: true, query: '?url', import: 'default' });
const SCAN = import.meta.glob<string>('./assets/track-sample/scan.ply', { eager: true, query: '?url', import: 'default' });
export const PREVIEW_TRACK = { width: 640, height: 360, frames: 48 };
/** The path the preview's "Choose a file" gives the bundled scan. */
export const SAMPLE_SCAN = 'sample/alley_scan.ply';
const frameUrl = (k: number): string | undefined => FRAMES[`./assets/track-sample/f${String(k + 1).padStart(3, '0')}.jpg`];

const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const fail = <T>(error: string): ApiResult<T> => ({ ok: false, error });
const LABEL = 'sample frames (synthetic tracking shot)';

export interface CameraPreview {
  session(input: TrackShotInput): Promise<ApiResult<TrackSessionInfo>>;
  frame(input: TrackShotInput & { frame: number; maxWidth: number }): Promise<ApiResult<ViewerFrame>>;
  view(input: TrackShotInput & { clouds?: boolean }): Promise<ApiResult<TrackViewData>>;
  command(input: TrackCommandRequest): Promise<ApiResult<{ ok: true; summary: string; data: Record<string, unknown>; ops: unknown[] } | { ok: false; error: string }>>;
  chooseLidar(): Promise<ApiResult<string | null>>;
  calibrationTarget(input: { cols: number; rows: number; squareMm: number; marginMm: number }): Promise<ApiResult<{ path: string } | null>>;
  cancel(jobId: string): boolean;
}

export function createCameraPreview(options: { desktopOnly: (what: string) => string; progress: (p: JobProgress) => void }): CameraPreview {
  const stores = new Map<string, MemoryStore>();
  const storeFor = (shotId: string) => {
    let s = stores.get(shotId);
    if (!s) stores.set(shotId, (s = new MemoryStore()));
    return s;
  };
  const gray = new Map<number, GrayFrame>();
  const jobs = new Map<string, AbortController>();

  const context = (text: string, shotId: string) => {
    const parsed = parseProject(text);
    if (!parsed.ok) return { error: parsed.reason } as const;
    const project = parsed.project;
    const state = shotState(project, shotId);
    const timeline = viewerTimeline(project, shotId);
    if (!state) return { error: `No shot ${shotId}` } as const;
    if (project.handoffPath !== 'sample') return { error: options.desktopOnly('tracking reads the frames on the drive.') } as const;
    if (!timeline) return { error: 'The frame range is unknown.' } as const;
    // The bundled shot is 48 frames: the sample's tracking runs on the first 48 of the shot.
    const first = timeline.first;
    const last = Math.min(timeline.last, first + PREVIEW_TRACK.frames - 1);
    const fps = project.handoff.shots.find((s) => s.shotId === shotId)?.frameRate ?? 24;
    return { project, state, first, last, fps } as const;
  };

  const decode = async (index: number): Promise<GrayFrame> => {
    const hit = gray.get(index);
    if (hit) return hit;
    const url = frameUrl(index);
    if (!url) throw new Error(`No sample frame ${index + 1}`);
    const blob = await (await fetch(url)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const g = canvas.getContext('2d', { willReadFrequently: true });
    if (!g) throw new Error('This browser cannot read the sample frames.');
    g.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const data = g.getImageData(0, 0, canvas.width, canvas.height);
    const frame = grayOf({ width: data.width, height: data.height, data: data.data }, 4);
    gray.set(index, frame);
    return frame;
  };

  return {
    async session({ text, shotId }) {
      const empty = (reason: string, sample = true): TrackSessionInfo => ({ available: false, reason, frames: '', plate: null, working: null, first: 0, last: 0, fps: 24, exportable: false, lidarFromDisk: false, ...(sample ? { sample: true } : {}) });
      const c = context(text, shotId);
      if ('error' in c) return ok(empty(c.error ?? 'Unavailable', false));
      if (!c.state.tasks.some((t) => t.kind === 'camera_track' || t.kind === 'track_2d')) return ok(empty('This shot has no camera-track or 2D-track task. Add one to track it.'));
      const size = { width: PREVIEW_TRACK.width, height: PREVIEW_TRACK.height };
      return ok({ available: true, reason: null, frames: LABEL, plate: size, working: size, first: c.first, last: c.last, fps: c.fps, exportable: false, lidarFromDisk: false, sample: true });
    },

    async frame({ text, shotId, frame }) {
      const c = context(text, shotId);
      if ('error' in c) return fail(c.error ?? 'Unavailable');
      const f = Math.min(c.last, Math.max(c.first, Math.round(frame)));
      const url = frameUrl(f - c.first);
      return url ? ok({ url, frame: f, viewLabel: 'Sample frames (synthetic tracking shot)' }) : fail('No sample frame');
    },

    async view({ text, shotId, clouds }) {
      const c = context(text, shotId);
      if ('error' in c) return fail(c.error ?? 'Unavailable');
      return ok(await viewData(c.state.camtrack, storeFor(shotId), Boolean(clouds)));
    },

    async command(input) {
      const c = context(input.text, input.shotId);
      if ('error' in c) return fail(c.error ?? 'Unavailable');
      const command = input.command as unknown as CameraCommand;
      if (!COMMAND_SPECS[command.verb]) return fail(`Unknown command ${command.verb}`);
      const controller = new AbortController();
      jobs.set(input.jobId, controller);
      const size = { width: PREVIEW_TRACK.width, height: PREVIEW_TRACK.height };
      let last = 0;
      try {
        const session: CameraSession = {
          ...sessionBase(c.project, input.shotId, { first: c.first, last: c.last, fps: c.fps }, size, size),
          io: {
            frame: (f) => decode(Math.min(c.last, Math.max(c.first, f)) - c.first),
            readFile: async (path) => {
              const url = SCAN['./assets/track-sample/scan.ply'];
              if (path !== SAMPLE_SCAN || !url) throw new Error(options.desktopOnly('LiDAR files are read from the drive.'));
              return new Uint8Array(await (await fetch(url)).arrayBuffer());
            },
            // No writeExport: the dispatcher answers that exports are the desktop app's.
          },
          store: storeFor(input.shotId),
          solver: new TsCameraSolver(),
          actor: input.operator,
          now: () => new Date(),
          generator: 'VC VFX preview',
          signal: controller.signal,
          progress: (label, done, total) => {
            const now = performance.now();
            if (now - last < 80 && done < total) return;
            last = now;
            options.progress({ jobId: input.jobId, label, done, total, detail: '' });
          },
          // Let the page paint and take a cancel between steps.
          yieldNow: () => new Promise((r) => setTimeout(r, 0)),
        };
        const outcome = await dispatch(session, command);
        return ok(outcome.ok ? { ok: true as const, summary: outcome.summary, data: outcome.data, ops: outcome.ops } : { ok: false as const, error: outcome.error });
      } catch (error) {
        return fail(controller.signal.aborted ? 'Cancelled' : (error as Error).message);
      } finally {
        jobs.delete(input.jobId);
      }
    },

    async chooseLidar() {
      // The browser cannot read a scan off the drive; the sample's alley scan is bundled.
      return ok(SAMPLE_SCAN);
    },

    async calibrationTarget(spec) {
      const pdf = checkerboardPdf(spec);
      const name = `checkerboard_${spec.cols}x${spec.rows}_${spec.squareMm}mm.pdf`;
      const url = URL.createObjectURL(new Blob([pdf as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      return ok({ path: name });
    },

    cancel(jobId) {
      const j = jobs.get(jobId);
      j?.abort();
      return Boolean(j);
    },
  };
}
