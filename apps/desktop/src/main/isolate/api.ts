import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_ISOLATE_PARAMS,
  ISOLATE_TASK,
  isolateDoc,
  isolateMetadata,
  isolateNames,
  isolateSeedProblem,
  isolateTaskVersion,
  handoffShot,
  rotoTaskVersion,
  shotState,
  versionTag,
  type IsolateExportInput,
  type IsolateRunResult,
  type IsolateTarget,
  type Project,
} from '@vcvfx/domain';
import type { IsolateEngineChoice, IsolateExportOutcome, IsolateFrameView, IsolateSessionInfo } from '../../shared/isolate/bridge-types';
import type { IsolateSettings } from '../../shared/isolate/engine';
import { frameView } from '../../shared/isolate/view';
import type { FfmpegCaps } from '../../shared/ffmpeg-args';
import { shotFolder, sourceFiles } from '../package-shot';
import { isSampleHandoff, outputRootProblem } from '../paths';
import { keyFrameSource, keyWorkingSize, type KeySourceResult } from '../key/frames';
import { createKeyIO, type KeyIOJob, type RotoSource } from '../key/io';
import type { Sam2Files } from '../roto/engines';
import { MaskStore } from '../roto/store';
import { IsolateCache } from './cache';
import { runIsolateJob } from './service';

/**
 * The main-process side of sky isolation and background removal (addendum
 * 11), called by ipc-isolate.ts. No Electron here: where things live is
 * passed in, so it is tested against a temporary folder with the real ffmpeg.
 * Frames are read as the key and the clean plate read them (the newest
 * plates, else the source, in linear light); a subject's roto mattes come from
 * the roto cache.
 */

export interface IsolateEnv {
  ffmpeg: string | null;
  caps: FfmpegCaps;
  /** userData/Roto Cache (a subject's roto part). */
  rotoCacheRoot: string;
  /** userData/Isolate Cache (built mattes and plates for review). */
  cacheRoot: string;
  /** The built worker (out/main/isolate-worker.js). */
  workerFile: string;
  generator: string;
  /** Frames the background plate may hold in memory at plate resolution (default 1.5 GB). */
  maxResidentBytes?: number;
  /** The subject's engines (roto's: Track always, SAM 2.1 when installed); Track alone when not given. */
  engines?: () => Promise<IsolateEngineChoice[]>;
  /** SAM 2.1's files, checked; throws why they are not usable. */
  sam2?: () => Promise<Sam2Files>;
}

const noFfmpeg = 'Isolation reads frames with ffmpeg, and none was found. Reinstall VC VFX or set ffmpeg in Settings.';
const TRACK_ONLY: IsolateEngineChoice[] = [{ id: 'track', label: 'Track (classical)', available: true, reason: null }];
const taskName = (t: IsolateTarget) => (t === 'sky' ? 'Sky isolation' : 'Background removal');

async function source(project: Project, shotId: string, outputRoot: string | null, env: IsolateEnv): Promise<KeySourceResult> {
  if (isSampleHandoff(project.handoffPath)) return { ok: false, reason: 'The sample project has no media on disk. Open a real handoff to isolate its sky or subject.' };
  if (!env.ffmpeg) return { ok: false, reason: noFfmpeg };
  return keyFrameSource(project, shotId, outputRoot, { ffmpeg: env.ffmpeg, caps: env.caps });
}

function rotoSource(project: Project, shotId: string, projectKey: string, env: IsolateEnv): RotoSource | null {
  const state = shotState(project, shotId);
  if (!state?.roto) return null;
  return { store: new MaskStore(env.rotoCacheRoot, projectKey, shotId).root, version: rotoTaskVersion(state), parts: state.roto.parts };
}

export function isolateSettingsOf(project: Project, shotId: string, target: IsolateTarget): IsolateSettings {
  const doc = isolateDoc(shotState(project, shotId), target);
  const problem = isolateSeedProblem(doc, target);
  if (problem) throw new Error(problem);
  // The sky needs nothing to start: the defaults.
  if (!doc) return { target, seed: { mode: 'auto', frame: null, rect: null, partId: null }, engine: 'track', keyFrames: [], params: { ...DEFAULT_ISOLATE_PARAMS } };
  return { target, seed: doc.seed, engine: doc.engine, keyFrames: doc.keyFrames, params: doc.params };
}

async function ioJob(project: Project, req: { shotId: string; projectKey: string; target: IsolateTarget }, outputRoot: string | null, env: IsolateEnv, size: 'working' | 'plate'): Promise<{ job: KeyIOJob; src: Extract<KeySourceResult, { ok: true }>; pxScale: number }> {
  const src = await source(project, req.shotId, outputRoot, env);
  if (!src.ok) throw new Error(src.reason);
  const plate = src.spec.plate;
  const dims = size === 'plate' ? plate : keyWorkingSize(plate, isolateDoc(shotState(project, req.shotId), req.target)?.workingWidth ?? 960);
  return { job: { frames: src.spec, size: dims, space: src.space, roto: rotoSource(project, req.shotId, req.projectKey, env), background: null }, src, pxScale: plate.width / dims.width };
}

export async function isolateSession(project: Project, shotId: string, target: IsolateTarget, outputRoot: string | null, env: IsolateEnv): Promise<IsolateSessionInfo> {
  const state = shotState(project, shotId);
  if (!state) throw new Error(`No shot ${shotId}`);
  const engines = target === 'background' && env.engines ? await env.engines() : TRACK_ONLY;
  const empty: IsolateSessionInfo = { available: false, reason: null, frames: '', plate: null, working: null, first: 0, last: 0, encoding: { label: '', linear: false, note: null }, exportable: false, engines };
  if (!state.tasks.some((t) => t.kind === ISOLATE_TASK[target])) return { ...empty, reason: `This shot has no ${taskName(target)} task. Add it to work on it here.` };
  const src = await source(project, shotId, outputRoot, env);
  if (!src.ok) return { ...empty, reason: src.reason };
  return {
    available: true,
    reason: null,
    frames: src.spec.label,
    plate: src.spec.plate,
    working: keyWorkingSize(src.spec.plate, isolateDoc(state, target)?.workingWidth ?? 960),
    first: src.spec.first,
    last: src.spec.last,
    encoding: { label: src.space.label, linear: src.space.linear, note: src.space.linear ? null : 'The source encoding is unknown: the isolation is built on code values, not linear light, and written as 16-bit PNG. Set the source encoding in Plates for linear EXR outputs.' },
    exportable: true,
    engines,
  };
}

/** Readers stay warm between frame requests (per shot and size). */
const readers = new Map<string, ReturnType<typeof createKeyIO>>();

export async function isolateFrameView(project: Project, req: { shotId: string; projectKey: string; target: IsolateTarget; frame: number; maxWidth: number }, outputRoot: string | null, env: IsolateEnv): Promise<IsolateFrameView> {
  const state = shotState(project, req.shotId);
  if (!state) throw new Error(`No shot ${req.shotId}`);
  const { job, src } = await ioJob(project, req, outputRoot, env, 'working');
  const key = JSON.stringify([req.projectKey, req.shotId, src.spec.label, job.size]);
  let io = readers.get(key);
  if (!io) {
    io = createKeyIO(job);
    readers.set(key, io);
    while (readers.size > 3) readers.delete(readers.keys().next().value!);
  }
  const frame = Math.max(job.frames.first, Math.min(job.frames.last, Math.round(req.frame)));
  const img = await io.frame(frame);
  const doc = isolateDoc(state, req.target);
  // The newest build of this task version: current when it used the settings as they are now.
  const version = isolateTaskVersion(state, req.target);
  const run = doc?.runs.filter((r) => r.taskVersion === version).at(-1) ?? null;
  const cache = new IsolateCache(env.cacheRoot, req.projectKey, req.shotId, req.target);
  const m = run ? await cache.getMatte(version, run.revision, frame) : null;
  const p = run ? await cache.getPlate(version, run.revision, frame) : null;
  return frameView(frame, img, m, p, job.space, { built: run && run.revision === doc?.revision ? 'current' : 'stale', viewLabel: `${job.space.label} → Rec.709 (approx.), for viewing` });
}

async function sam2For(settings: IsolateSettings, env: IsolateEnv): Promise<Sam2Files | undefined> {
  if (settings.target !== 'background' || settings.engine !== 'sam2') return undefined;
  if (!env.sam2) throw new Error('SAM 2.1 is not available in this build; choose Track.');
  return env.sam2();
}

export async function isolateBuild(
  project: Project,
  req: { shotId: string; projectKey: string; target: IsolateTarget },
  outputRoot: string | null,
  env: IsolateEnv,
  o: { signal?: AbortSignal; onProgress?: (done: number, total: number, frame?: number) => void } = {},
): Promise<IsolateRunResult> {
  const state = shotState(project, req.shotId);
  if (!state) throw new Error(`No shot ${req.shotId}`);
  const settings = isolateSettingsOf(project, req.shotId, req.target);
  const doc = isolateDoc(state, req.target);
  const { job, pxScale } = await ioJob(project, req, outputRoot, env, 'working');
  const sam2 = await sam2For(settings, env);
  const out = await runIsolateJob(
    {
      type: 'build',
      job: { io: job, settings, revision: doc?.revision ?? 0, range: { first: job.frames.first, last: job.frames.last }, pxScale, cache: new IsolateCache(env.cacheRoot, req.projectKey, req.shotId, req.target).root, version: isolateTaskVersion(state, req.target), ...(sam2 ? { sam2 } : {}) },
    },
    { workerFile: env.workerFile, ...(o.signal ? { signal: o.signal } : {}), ...(o.onProgress ? { onProgress: o.onProgress } : {}) },
  );
  if (!out.result) throw new Error('The build produced nothing');
  return out.result;
}

export async function isolateExport(
  project: Project,
  req: { shotId: string; projectKey: string; target: IsolateTarget; operator: string },
  outputRoot: string,
  env: IsolateEnv,
  o: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void; now?: Date } = {},
): Promise<IsolateExportOutcome> {
  // Never under the source paths (§19): the output root is checked against every source file.
  const problem = outputRootProblem(outputRoot, sourceFiles(project));
  if (problem) throw new Error(problem);
  const { target } = req;
  const state = shotState(project, req.shotId);
  const shot = handoffShot(project, req.shotId);
  const doc = isolateDoc(state, target);
  if (!state || !shot || !doc) throw new Error(`Build the ${target === 'sky' ? 'sky isolation' : 'background removal'} first (step 3).`);
  const settings = isolateSettingsOf(project, req.shotId, target);
  const task = state.tasks.find((t) => t.kind === ISOLATE_TASK[target]);
  if (!task) throw new Error(`This shot has no ${taskName(target)} task.`);
  const names = isolateNames(target);
  const version = task.version;
  const name = state.vfxShotId ?? shot.shotId;
  const mattes = join(shotFolder(project, req.shotId, outputRoot), '02_MATTES_ROTO');
  const folder = join(mattes, names.folder(name, version));
  const metadataName = names.metadata(name, version);
  if (task.state === 'approved' && (await stat(join(folder, metadataName)).catch(() => null))) {
    throw new Error(`${taskName(target)} ${versionTag(version)} is approved and already written; it is never rewritten. Reopen it to make a new version.`);
  }
  await mkdir(mattes, { recursive: true });
  const plate = await ioJob(project, req, outputRoot, env, 'plate');
  const working = await ioJob(project, req, outputRoot, env, 'working');
  const format = plate.src.space.linear ? 'exr' : 'png';
  const first = plate.src.spec.first;
  const last = plate.src.spec.last;
  const sam2 = await sam2For(settings, env);
  const out = await runIsolateJob(
    { type: 'export', job: { io: plate.job, workingIO: working.job, settings, target, shot: name, version, approved: task.state === 'approved', folder, first, last, format, generator: env.generator, maxResidentBytes: env.maxResidentBytes ?? 1.5e9, ...(sam2 ? { sam2 } : {}) } },
    { workerFile: env.workerFile, ...(o.signal ? { signal: o.signal } : {}), ...(o.onProgress ? { onProgress: o.onProgress } : {}) },
  );
  const exported = out.exported;
  if (!exported) throw new Error('The export produced nothing');
  const files = {
    matte: names.mattePattern(name, version),
    matteExr: format === 'exr' ? names.matteExrPattern(name, version) : null,
    foreground: names.foregroundPattern(name, version, format),
    plate: names.platePattern(name, version, format),
    confidence: names.confidencePattern(name, version),
    plateConfidence: names.plateConfidencePattern(name, version),
  };
  const at = (o.now ?? new Date()).toISOString();
  const meta = isolateMetadata(project, req.shotId, target, {
    version,
    first,
    last,
    width: exported.width,
    height: exported.height,
    encoding: plate.src.space.label,
    linear: plate.src.space.linear,
    source: plate.src.spec.label,
    files,
    format,
    engine: exported.engine,
    generator: env.generator,
    writtenAt: at,
    by: req.operator,
    perFrame: exported.frames,
    alignment: exported.alignment,
  });
  await writeFile(join(folder, metadataName), `${JSON.stringify(meta, null, 2)}\n`);
  await writeFile(join(folder, names.readme()), readme(name, target, version, meta.colour.encoding, format, files, task.state === 'approved'));
  const values = exported.frames.map((f) => f.confidence);
  const done = exported.frames;
  const mean = (pick: (f: (typeof done)[number]) => number) => (done.length ? Math.round((done.reduce((a, f) => a + pick(f), 0) / done.length) * 10_000) / 10_000 : 0);
  const record: IsolateExportInput = {
    version,
    target,
    folder: `02_MATTES_ROTO/${names.folder(name, version)}`,
    matte: files.matte,
    matteExr: files.matteExr,
    foreground: files.foreground,
    plate: files.plate,
    confidence: files.confidence,
    plateConfidence: files.plateConfidence,
    format,
    first,
    last,
    frames: exported.frames.length,
    width: exported.width,
    height: exported.height,
    encoding: plate.src.space.label,
    summary: {
      mean: values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1000) / 1000 : 0,
      min: values.length ? Math.min(...values) : 0,
      low: exported.frames.filter((f) => f.confidence < 0.6).map((f) => f.frame),
      flicker: mean((f) => f.metrics.flicker),
      unresolved: mean((f) => f.metrics.unresolved),
    },
    algorithm: `${doc.algorithm.id}@${doc.algorithm.version}`,
    engine: exported.engine,
    revision: doc.revision,
    metadata: `02_MATTES_ROTO/${names.folder(name, version)}/${metadataName}`,
    files: exported.files.length + 2,
  };
  return { record, folder, files: record.files };
}

function readme(shot: string, target: IsolateTarget, version: number, encoding: string, format: 'exr' | 'png', files: Record<string, string | null>, approved: boolean): string {
  const v = versionTag(version);
  const sky = target === 'sky';
  const what = sky ? 'sky isolation' : 'background removal';
  return [
    `${shot} ${what} ${v} — VC VFX`,
    '',
    'What is here (one file per frame, the plates’ frame numbers)',
    `  ${files['matte']}   16-bit straight alpha of ${sky ? 'everything in front of the sky (1 = skyline, trees, wires, people; 0 = sky). The sky matte is its inverse.' : 'the subject (1 = subject, 0 = background).'}`,
    files['matteExr'] ? `  ${files['matteExr']}   the same matte as a one-channel half-float EXR.` : null,
    `  ${files['foreground']}   the ${sky ? 'foreground' : 'subject'} ${format === 'exr' ? `as RGBA half-float EXR, ${encoding}, premultiplied` : 'as RGB 16-bit PNG of the source code values, premultiplied (alpha in the matte)'}, with the ${sky ? 'sky' : 'background'}'s colour unmixed out of its edge. No look, no grade.`,
    `  ${files['plate']}   the ${sky ? 'sky' : 'background'} alone: behind the ${sky ? 'foreground' : 'subject'}, rebuilt from the frames that saw it (aligned for the camera), else filled from what is around it.`,
    `  ${files['confidence']}   16-bit confidence of the matte: full = sure; dark = an uncertain edge.`,
    `  ${files['plateConfidence']}   16-bit confidence of the plate: full = seen; black = never seen (filled): paint it, or leave it to the comp.`,
    `  ${isolateNames(target).metadata(shot, version)}   the sequence manifest: every setting, the seed and the painted corrections, the engine, the alignment of every frame, per-frame confidence and its reasons.`,
    '',
    'How it was made',
    sky
      ? '  The sky was found by its cues (brightness, colour, smoothness, position) and colour models, cut with a graph cut, kept consistent'
      : '  The subject was segmented on the seed frame from the artist’s box, paint or roto part and propagated through the shot,',
    sky ? '  through the shot with the neighbouring frames aligned by the camera’s motion; the edge was unmixed in linear light so branches,' : '  corrections re-propagated locally; the edge was unmixed in linear light against the background plate, so hair and motion blur',
    sky ? '  wires and hair keep fractional alpha, and smoothed in time where the picture did not change. The camera media was only read.' : '  keep fractional alpha, and smoothed in time where the picture did not change. The camera media was only read.',
    '',
    approved ? `This ${what} version is approved.` : `This ${what} version is not approved yet: it is a prep deliverable for review.`,
    '',
  ]
    .filter((l) => l !== null)
    .join('\n');
}
