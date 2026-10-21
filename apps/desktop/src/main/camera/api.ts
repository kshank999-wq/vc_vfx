import { camtrackTaskVersion, newCamTrackDocument, shotState, track2dTaskVersion, type Project } from '@vcvfx/domain';
import type { TrackSessionInfo, TrackViewData, ViewerFrame } from '../../shared/bridge';
import { COMMAND_SPECS, type CameraCommand, type CommandOutcome } from '../../shared/camera/commands';
import { sessionBase, trackWorkingSize, viewData } from '../../shared/camera/session';
import type { FfmpegCaps } from '../../shared/ffmpeg-args';
import type { FrameCache } from '../frame-cache';
import { outputRootProblem } from '../paths';
import { shotFolder, sourceFiles } from '../package-shot';
import { rotoFrameSource, type FrameSourceResult } from '../roto/frames';
import { MaskStore } from '../roto/store';
import { viewerFrame } from '../viewer';
import { runCameraJob } from './service';
import { FileStore } from './store';

/**
 * The main-process side of camera and 2D tracking (addendum 06 §8), called
 * by ipc.ts. No Electron here: locations are passed in, so it is tested with
 * the real ffmpeg against a temporary folder.
 */

export interface CameraEnv {
  ffmpeg: string | null;
  caps: FfmpegCaps;
  /** userData/Track Cache */
  cacheRoot: string;
  /** userData/Roto Cache (for exclusion / occlusion mattes). */
  rotoCacheRoot: string;
  frameCache: FrameCache;
  /** The built worker (out/main/camera-worker.js). */
  workerFile: string;
  generator: string;
}

const noFfmpeg = 'Tracking reads frames with ffmpeg, and none was found. Reinstall VC VFX or set ffmpeg in Settings.';

async function source(project: Project, shotId: string, outputRoot: string | null, env: CameraEnv): Promise<FrameSourceResult> {
  if (!env.ffmpeg) return { ok: false, reason: noFfmpeg };
  return rotoFrameSource(project, shotId, outputRoot, { ffmpeg: env.ffmpeg, caps: env.caps, cacheDir: env.frameCache.dir });
}

const hasTask = (project: Project, shotId: string) => shotState(project, shotId)?.tasks.some((t) => t.kind === 'camera_track' || t.kind === 'track_2d') ?? false;

export async function trackSession(project: Project, req: { shotId: string; workingWidth?: number }, outputRoot: string | null, env: CameraEnv): Promise<TrackSessionInfo> {
  const empty = (reason: string): TrackSessionInfo => ({ available: false, reason, frames: '', plate: null, working: null, first: 0, last: 0, fps: 24, exportable: false, lidarFromDisk: true });
  if (!shotState(project, req.shotId)) throw new Error(`No shot ${req.shotId}`);
  if (!hasTask(project, req.shotId)) return empty('This shot has no camera-track or 2D-track task. Add one to track it.');
  const src = await source(project, req.shotId, outputRoot, env);
  if (!src.ok) return empty(src.reason);
  const doc = shotState(project, req.shotId)?.camtrack ?? newCamTrackDocument(project, req.shotId);
  const working = trackWorkingSize(src.spec.plate, req.workingWidth ?? doc.trackSettings.workingWidth);
  return { available: true, reason: null, frames: src.spec.label, plate: src.spec.plate, working, first: src.spec.first, last: src.spec.last, fps: src.spec.frameRate, exportable: true, lidarFromDisk: true };
}

export async function trackFrame(project: Project, req: { text: string; shotId: string; projectKey: string; frame: number; maxWidth: number; prefetch?: boolean }, outputRoot: string | null, env: CameraEnv): Promise<ViewerFrame> {
  if (!env.ffmpeg) throw new Error(noFfmpeg);
  const src = await source(project, req.shotId, outputRoot, env);
  if (!src.ok) throw new Error(src.reason);
  return viewerFrame(
    project,
    { text: req.text, shotId: req.shotId, projectKey: req.projectKey, layer: src.plates ? 'plates' : 'source', ...(src.plates ? { version: src.plates } : {}), frame: req.frame, view: 'rec709', maxWidth: req.maxWidth, ...(req.prefetch ? { prefetch: true } : {}) },
    outputRoot,
    { cache: env.frameCache, ffmpeg: env.ffmpeg, caps: env.caps },
  );
}

/** The track cache's data for drawing. */
export async function trackView(project: Project, req: { shotId: string; projectKey: string; clouds?: boolean }, env: Pick<CameraEnv, 'cacheRoot'>): Promise<TrackViewData> {
  return viewData(shotState(project, req.shotId)?.camtrack, new FileStore(env.cacheRoot, req.projectKey, req.shotId), Boolean(req.clouds));
}

/** Run one command in the camera worker. */
export async function trackCommand(
  project: Project,
  req: { shotId: string; projectKey: string; operator: string; command: CameraCommand; workingWidth?: number },
  outputRoot: string | null,
  env: CameraEnv,
  o: { signal?: AbortSignal; onProgress?: (label: string, done: number, total: number) => void; now?: Date } = {},
): Promise<CommandOutcome> {
  const state = shotState(project, req.shotId);
  if (!state) throw new Error(`No shot ${req.shotId}`);
  if (!COMMAND_SPECS[req.command.verb]) throw new Error(`Unknown command ${req.command.verb}`);
  const src = await source(project, req.shotId, outputRoot, env);
  if (!src.ok) throw new Error(src.reason);
  const doc = state.camtrack ?? newCamTrackDocument(project, req.shotId);
  const working = trackWorkingSize(src.spec.plate, req.workingWidth ?? doc.trackSettings.workingWidth);
  const base = sessionBase(project, req.shotId, { first: src.spec.first, last: src.spec.last, fps: src.spec.frameRate }, src.spec.plate, working);
  const exporting = req.command.verb === 'export_camera' || req.command.verb === 'track2d_export';
  let folder: string | null = null;
  let approved = false;
  if (exporting && outputRoot) {
    const problem = outputRootProblem(outputRoot, sourceFiles(project));
    if (problem) throw new Error(problem);
    folder = shotFolder(project, req.shotId, outputRoot);
    const task = state.tasks.find((t) => t.kind === (req.command.verb === 'export_camera' ? 'camera_track' : 'track_2d'));
    approved = task?.state === 'approved';
  }
  const rotoVersion = state.tasks.find((t) => t.kind === 'roto')?.version ?? 1;
  return runCameraJob(
    {
      base,
      frames: src.spec,
      store: new FileStore(env.cacheRoot, req.projectKey, req.shotId).root,
      roto: state.roto ? { root: new MaskStore(env.rotoCacheRoot, req.projectKey, req.shotId).root, version: rotoVersion } : null,
      shotFolder: folder,
      approved,
      actor: req.operator,
      now: (o.now ?? new Date()).toISOString(),
      generator: env.generator,
      command: req.command,
    },
    { workerFile: env.workerFile, ...(o.signal ? { signal: o.signal } : {}), ...(o.onProgress ? { onProgress: o.onProgress } : {}) },
  );
}

export { camtrackTaskVersion, track2dTaskVersion };
