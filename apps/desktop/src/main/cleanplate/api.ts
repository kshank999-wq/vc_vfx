import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  cleanPlateConfidenceSummary,
  cleanPlateMetadata,
  cleanPlateNames,
  cleanPlateTaskVersion,
  handoffShot,
  rotoTaskVersion,
  shotState,
  versionTag,
  type CleanPlateExportInput,
  type CleanPlateRunResult,
  type Project,
} from '@vcvfx/domain';
import type { CleanPlateExportOutcome, CleanPlateFrameView, CleanPlateSessionInfo } from '../../shared/cleanplate/bridge-types';
import { removalHole, type CleanPlateSettings } from '../../shared/cleanplate/engine';
import { frameView } from '../../shared/cleanplate/view';
import type { FfmpegCaps } from '../../shared/ffmpeg-args';
import { shotFolder, sourceFiles } from '../package-shot';
import { isSampleHandoff, outputRootProblem } from '../paths';
import { keyFrameSource, keyWorkingSize, type KeySourceResult } from '../key/frames';
import { createKeyIO, type KeyIOJob, type RotoSource } from '../key/io';
import { MaskStore } from '../roto/store';
import { PlateCache } from './cache';
import { runCleanPlateJob } from './service';

/**
 * The main-process side of clean plates (addendum 10), called by
 * ipc-cleanplate.ts. No Electron here: where things live is passed in, so it
 * is tested against a temporary folder with the real ffmpeg. Frames are read
 * as the key reads them (the newest plates, else the source, in linear
 * light); the subject's roto mattes come from the roto cache.
 */

export interface CleanPlateEnv {
  ffmpeg: string | null;
  caps: FfmpegCaps;
  /** userData/Roto Cache (the mattes of the parts being removed). */
  rotoCacheRoot: string;
  /** userData/Clean Plate Cache (built plates for review). */
  cacheRoot: string;
  /** The built worker (out/main/cleanplate-worker.js). */
  workerFile: string;
  generator: string;
  /** Frames an export may hold in memory at plate resolution (default 1.5 GB). */
  maxResidentBytes?: number;
}

const noFfmpeg = 'Clean plates read frames with ffmpeg, and none was found. Reinstall VC VFX or set ffmpeg in Settings.';
const noRemove = 'Choose what to remove first (step 1): a roto part or a box.';

async function source(project: Project, shotId: string, outputRoot: string | null, env: CleanPlateEnv): Promise<KeySourceResult> {
  if (isSampleHandoff(project.handoffPath)) return { ok: false, reason: 'The sample project has no media on disk. Open a real handoff to build its clean plate.' };
  if (!env.ffmpeg) return { ok: false, reason: noFfmpeg };
  return keyFrameSource(project, shotId, outputRoot, { ffmpeg: env.ffmpeg, caps: env.caps });
}

function rotoSource(project: Project, shotId: string, projectKey: string, env: CleanPlateEnv): RotoSource | null {
  const state = shotState(project, shotId);
  if (!state?.roto) return null;
  return { store: new MaskStore(env.rotoCacheRoot, projectKey, shotId).root, version: rotoTaskVersion(state), parts: state.roto.parts };
}

export function settingsOf(project: Project, shotId: string): CleanPlateSettings {
  const doc = shotState(project, shotId)?.cleanPlate;
  if (!doc || !doc.remove.some((r) => r.enabled)) throw new Error(noRemove);
  return { remove: doc.remove, mode: doc.mode, alignment: doc.alignment, referenceFrame: doc.referenceFrame, params: doc.params, guidance: doc.guidance };
}

async function ioJob(project: Project, req: { shotId: string; projectKey: string }, outputRoot: string | null, env: CleanPlateEnv, size: 'working' | 'plate'): Promise<{ job: KeyIOJob; src: Extract<KeySourceResult, { ok: true }>; pxScale: number }> {
  const src = await source(project, req.shotId, outputRoot, env);
  if (!src.ok) throw new Error(src.reason);
  const plate = src.spec.plate;
  const dims = size === 'plate' ? plate : keyWorkingSize(plate, shotState(project, req.shotId)?.cleanPlate?.workingWidth ?? 960);
  return { job: { frames: src.spec, size: dims, space: src.space, roto: rotoSource(project, req.shotId, req.projectKey, env), background: null }, src, pxScale: plate.width / dims.width };
}

export async function cleanPlateSession(project: Project, shotId: string, outputRoot: string | null, env: CleanPlateEnv): Promise<CleanPlateSessionInfo> {
  const state = shotState(project, shotId);
  if (!state) throw new Error(`No shot ${shotId}`);
  const empty: CleanPlateSessionInfo = { available: false, reason: null, frames: '', plate: null, working: null, first: 0, last: 0, encoding: { label: '', linear: false, note: null }, exportable: false };
  if (!state.tasks.some((t) => t.kind === 'clean_plate')) return { ...empty, reason: 'This shot has no Clean plate task. Add it to build a clean plate.' };
  const src = await source(project, shotId, outputRoot, env);
  if (!src.ok) return { ...empty, reason: src.reason };
  return {
    available: true,
    reason: null,
    frames: src.spec.label,
    plate: src.spec.plate,
    working: keyWorkingSize(src.spec.plate, state.cleanPlate?.workingWidth ?? 960),
    first: src.spec.first,
    last: src.spec.last,
    encoding: { label: src.space.label, linear: src.space.linear, note: src.space.linear ? null : 'The source encoding is unknown: the clean plate is built on code values, not linear light, and written as 16-bit PNG. Set the source encoding in Plates for a linear EXR plate.' },
    exportable: true,
  };
}

/** Readers stay warm between frame requests (per shot, size and roto mattes). */
const readers = new Map<string, { io: ReturnType<typeof createKeyIO>; job: KeyIOJob; pxScale: number }>();

export async function cleanPlateFrameView(project: Project, req: { shotId: string; projectKey: string; frame: number; maxWidth: number }, outputRoot: string | null, env: CleanPlateEnv): Promise<CleanPlateFrameView> {
  const state = shotState(project, req.shotId);
  if (!state) throw new Error(`No shot ${req.shotId}`);
  const { job, pxScale, src } = await ioJob(project, req, outputRoot, env, 'working');
  const key = JSON.stringify([req.projectKey, req.shotId, src.spec.label, job.size, state.roto?.parts.map((p) => [p.id, p.frames.length]) ?? null]);
  let hit = readers.get(key);
  if (!hit) {
    hit = { io: createKeyIO(job), job, pxScale };
    readers.set(key, hit);
    while (readers.size > 3) readers.delete(readers.keys().next().value!);
  }
  const frame = Math.max(job.frames.first, Math.min(job.frames.last, Math.round(req.frame)));
  const img = await hit.io.frame(frame);
  const doc = state.cleanPlate;
  const hole = doc && doc.remove.some((r) => r.enabled) ? await removalHole(settingsOf(project, req.shotId), hit.io, frame, img.width, img.height, pxScale) : null;
  // The newest build of this task version: current when it used the settings as they are now.
  const version = cleanPlateTaskVersion(state);
  const run = doc?.runs.filter((r) => r.taskVersion === version).at(-1) ?? null;
  const cache = new PlateCache(env.cacheRoot, req.projectKey, req.shotId);
  const still = run?.mode === 'still' ? run.reference : null;
  const cached = run ? await cache.get(version, run.revision, still ?? frame) : null;
  return frameView(frame, img, hole, cached, job.space, { built: run && run.revision === doc?.revision ? 'current' : 'stale', stillFrame: cached ? still : null, viewLabel: `${job.space.label} → Rec.709 (approx.), for viewing` });
}

export async function cleanPlateBuild(
  project: Project,
  req: { shotId: string; projectKey: string },
  outputRoot: string | null,
  env: CleanPlateEnv,
  o: { signal?: AbortSignal; onProgress?: (done: number, total: number, frame?: number) => void } = {},
): Promise<CleanPlateRunResult> {
  const state = shotState(project, req.shotId);
  if (!state?.cleanPlate) throw new Error(noRemove);
  const settings = settingsOf(project, req.shotId);
  const { job, pxScale } = await ioJob(project, req, outputRoot, env, 'working');
  const out = await runCleanPlateJob(
    { type: 'build', job: { io: job, settings, revision: state.cleanPlate.revision, range: { first: job.frames.first, last: job.frames.last }, pxScale, cache: new PlateCache(env.cacheRoot, req.projectKey, req.shotId).root, version: cleanPlateTaskVersion(state) } },
    { workerFile: env.workerFile, ...(o.signal ? { signal: o.signal } : {}), ...(o.onProgress ? { onProgress: o.onProgress } : {}) },
  );
  if (!out.result) throw new Error('The build produced nothing');
  return out.result;
}

export async function cleanPlateExport(
  project: Project,
  req: { shotId: string; projectKey: string; operator: string },
  outputRoot: string,
  env: CleanPlateEnv,
  o: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void; now?: Date } = {},
): Promise<CleanPlateExportOutcome> {
  // Never under the source paths (§19): the output root is checked against every source file.
  const problem = outputRootProblem(outputRoot, sourceFiles(project));
  if (problem) throw new Error(problem);
  const state = shotState(project, req.shotId);
  const shot = handoffShot(project, req.shotId);
  const doc = state?.cleanPlate;
  if (!state || !shot || !doc) throw new Error(noRemove);
  const settings = settingsOf(project, req.shotId);
  const task = state.tasks.find((t) => t.kind === 'clean_plate');
  if (!task) throw new Error('This shot has no Clean plate task.');
  const version = task.version;
  const name = state.vfxShotId ?? shot.shotId;
  const plates = join(shotFolder(project, req.shotId, outputRoot), '04_CLEAN_PLATES');
  const folder = join(plates, cleanPlateNames.folder(name, version));
  const metadataName = cleanPlateNames.metadata(name, version);
  if (task.state === 'approved' && (await stat(join(folder, metadataName)).catch(() => null))) {
    throw new Error(`Clean plate ${versionTag(version)} is approved and already written; it is never rewritten. Reopen the clean plate to make a new version.`);
  }
  await mkdir(plates, { recursive: true });
  const plate = await ioJob(project, req, outputRoot, env, 'plate');
  const working = await ioJob(project, req, outputRoot, env, 'working');
  const format = plate.src.space.linear ? 'exr' : 'png';
  const first = plate.src.spec.first;
  const last = plate.src.spec.last;
  const out = await runCleanPlateJob(
    { type: 'export', job: { io: plate.job, workingIO: working.job, settings, shot: name, version, approved: task.state === 'approved', folder, first, last, format, generator: env.generator, maxResidentBytes: env.maxResidentBytes ?? 1.5e9 } },
    { workerFile: env.workerFile, ...(o.signal ? { signal: o.signal } : {}), ...(o.onProgress ? { onProgress: o.onProgress } : {}) },
  );
  const exported = out.exported;
  if (!exported) throw new Error('The export produced nothing');
  const still = exported.mode === 'still';
  const files = {
    plate: still ? cleanPlateNames.stillFile(name, version, exported.reference, format) : cleanPlateNames.platePattern(name, version, format),
    confidence: still ? cleanPlateNames.confidenceFile(name, version, exported.reference) : cleanPlateNames.confidencePattern(name, version),
    unresolved: still ? cleanPlateNames.unresolvedFile(name, version, exported.reference) : cleanPlateNames.unresolvedPattern(name, version),
  };
  const at = (o.now ?? new Date()).toISOString();
  const meta = cleanPlateMetadata(project, req.shotId, {
    version,
    mode: exported.mode,
    reference: exported.reference,
    first,
    last,
    width: exported.width,
    height: exported.height,
    encoding: plate.src.space.label,
    linear: plate.src.space.linear,
    source: plate.src.spec.label,
    files,
    format,
    generator: env.generator,
    writtenAt: at,
    by: req.operator,
    alignment: { model: exported.alignment, frames: exported.aligned },
  });
  await writeFile(join(folder, metadataName), `${JSON.stringify({ ...meta, exported: { frames: exported.frames, budget: exported.budget } }, null, 2)}\n`);
  await writeFile(join(folder, cleanPlateNames.readme()), readme(name, version, exported.mode, exported.reference, meta.colour.encoding, format, files, task.state === 'approved'));
  const values = exported.frames.map((f) => f.confidence);
  const holes = exported.frames.filter((f) => f.metrics.hole > 0);
  const avg = (pick: (f: { metrics: { coverage: number; low: number } }) => number) => (holes.length ? Math.round((holes.reduce((a, f) => a + pick(f), 0) / holes.length) * 1000) / 1000 : 0);
  const summary = cleanPlateConfidenceSummary(doc);
  const record: CleanPlateExportInput = {
    version,
    folder: `04_CLEAN_PLATES/${cleanPlateNames.folder(name, version)}`,
    mode: exported.mode,
    plate: files.plate,
    confidence: files.confidence,
    unresolved: files.unresolved,
    format,
    reference: exported.reference,
    first,
    last,
    frames: exported.frames.length,
    width: exported.width,
    height: exported.height,
    encoding: plate.src.space.label,
    summary: {
      mean: values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1000) / 1000 : summary.mean,
      min: values.length ? Math.min(...values) : summary.min,
      low: exported.frames.filter((f) => f.confidence < 0.6).map((f) => f.frame),
      coverage: avg((f) => f.metrics.coverage),
      unresolved: avg((f) => f.metrics.low),
    },
    algorithm: `${doc.algorithm.id}@${doc.algorithm.version}`,
    revision: doc.revision,
    metadata: `04_CLEAN_PLATES/${cleanPlateNames.folder(name, version)}/${metadataName}`,
    files: exported.files.length + 2,
  };
  return { record, folder, files: record.files };
}

function readme(shot: string, version: number, mode: 'still' | 'sequence', reference: number, encoding: string, format: 'exr' | 'png', files: Record<string, string>, approved: boolean): string {
  const v = versionTag(version);
  const kind = format === 'exr' ? `RGB half-float EXR, ${encoding}. No look, no grade.` : 'RGB 16-bit PNG of the source code values (the source encoding was unknown).';
  return [
    `${shot} clean plate ${v} — VC VFX`,
    '',
    'What is here',
    mode === 'still'
      ? `  ${files['plate']}   one still clean plate, in the coordinates of frame ${reference}: ${kind}`
      : `  ${files['plate']}   a clean plate per frame, in each frame's own coordinates: ${kind}`,
    `  ${files['confidence']}   16-bit confidence: full = seen clean in several agreeing frames; dark = rebuilt from one frame, frames disagreed, or (black) never seen and filled spatially.`,
    `  ${files['unresolved']}   16-bit mask of what is unresolved: paint it, or give the build a patch ("take this region from that frame") and build again.`,
    `  ${cleanPlateNames.metadata(shot, version)}   what was removed, every setting, the alignment of every frame to frame ${reference} (homographies in plate pixels, residuals, exposure gains) and per-frame confidence.`,
    '',
    'How it was made',
    '  Outside the removed area the pixels are the frame’s own. Inside, they are borrowed from other frames of the shot,',
    '  aligned by homography to this frame and matched to its exposure, and voted on; what no frame saw is filled spatially',
    '  and marked unresolved. The camera media was only read.',
    '',
    approved ? 'This clean plate version is approved.' : 'This clean plate version is not approved yet: it is a prep deliverable for review.',
    '',
  ].join('\n');
}
