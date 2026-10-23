import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  backgroundReferences,
  handoffShot,
  keyConfidenceSummary,
  keyMetadata,
  keyNames,
  keySettings,
  keySubjectStale,
  keyTaskVersion,
  rotoTaskVersion,
  shotState,
  versionTag,
  type BgMatchInput,
  type KeyExportInput,
  type KeyRunResult,
  type KeySubjectRunInput,
  type Project,
  type ScreenKind,
} from '@vcvfx/domain';
import type { FfmpegCaps } from '../../shared/ffmpeg-args';
import type { KeyDetectResult, KeyExportOptions, KeyFrameView, KeySessionInfo } from '../../shared/key/bridge-types';
import { shotScreenModel, ShotKeyer, type KeySettings } from '../../shared/key/engine';
import { estimateMatch, matchSamples } from '../../shared/key/look';
import { sampleColour } from '../../shared/key/screen';
import { frameView } from '../../shared/key/view';
import { planeToMask } from '../../shared/roto/image';
import { shotFolder, sourceFiles } from '../package-shot';
import { outputRootProblem } from '../paths';
import { workingSize as rotoWorkingSize } from '../roto/frames';
import { MaskStore } from '../roto/store';
import { backgroundSpec, keyFrameSource, keyWorkingSize, type KeySourceResult } from './frames';
import { createKeyIO, type KeyIOJob, type RotoSource, type SubjectSource } from './io';
import type { Sam2Files } from '../roto/engines';
import { runKeyJob } from './service';

/**
 * The main-process side of keying (addendum 09), called by ipc-key.ts. No
 * Electron here: where things live is passed in, so it is tested against a
 * temporary folder with the real ffmpeg.
 */

export interface KeyEnv {
  ffmpeg: string | null;
  caps: FfmpegCaps;
  /** userData/Roto Cache (repair and garbage mattes from roto, and the repair seed). */
  rotoCacheRoot: string;
  /** userData/Key Cache (processed review mattes). */
  keyCacheRoot: string;
  /** The built worker (out/main/key-worker.js). */
  workerFile: string;
  generator: string;
  /** SAM 2's files, checked (throws why not); absent or throwing: the Auto subject runs with Track. */
  sam2?: () => Promise<Sam2Files>;
  /** Whether SAM 2 can run here, for the panel. */
  sam2Status?: () => Promise<{ available: boolean; reason: string | null; label: string }>;
}

const noFfmpeg = 'Keying reads frames with ffmpeg, and none was found. Reinstall VC VFX or set ffmpeg in Settings.';
const noScreen = 'Pick the screen colour first: Auto key, or the eyedropper.';

async function source(project: Project, shotId: string, outputRoot: string | null, env: KeyEnv): Promise<KeySourceResult> {
  if (!env.ffmpeg) return { ok: false, reason: noFfmpeg };
  return keyFrameSource(project, shotId, outputRoot, { ffmpeg: env.ffmpeg, caps: env.caps });
}

function rotoSource(project: Project, shotId: string, projectKey: string, env: KeyEnv): RotoSource | null {
  const state = shotState(project, shotId);
  if (!state?.roto) return null;
  return { store: new MaskStore(env.rotoCacheRoot, projectKey, shotId).root, version: rotoTaskVersion(state), parts: state.roto.parts };
}

function settingsOf(project: Project, shotId: string): KeySettings {
  const doc = shotState(project, shotId)?.key;
  if (!doc?.screen) throw new Error(noScreen);
  return { screen: doc.screen, params: doc.params, links: doc.links, despill: doc.despill, lightWrap: doc.lightWrap, subject: { source: doc.subject.source, partId: doc.subject.partId, marginPx: doc.subject.marginPx, outside: doc.subject.outside } };
}

/** The Auto segmentation's masks, when it has run with the current seed (a stale run is not used). */
function subjectSource(project: Project, shotId: string, projectKey: string, env: KeyEnv): SubjectSource | null {
  const doc = shotState(project, shotId)?.key;
  if (!doc || doc.subject.source !== 'auto' || !doc.subject.run || keySubjectStale(doc)) return null;
  const confidence: Record<string, number> = {};
  for (const f of doc.subject.run.frames) confidence[String(f.frame)] = f.confidence;
  return { store: new MaskStore(env.keyCacheRoot, projectKey, shotId).root, version: doc.subject.run.taskVersion, confidence, removes: !doc.subject.run.engine.startsWith('track') };
}

/** The segmentation runs at most this wide (SAM 2 sees 1024² whatever it is given; Track is quicker smaller). */
const SUBJECT_WIDTH = 1024;

async function ioJob(project: Project, req: { shotId: string; projectKey: string }, outputRoot: string | null, env: KeyEnv, size: 'working' | 'plate' | { maxWidth: number }): Promise<{ job: KeyIOJob; src: Extract<KeySourceResult, { ok: true }>; pxScale: number }> {
  const src = await source(project, req.shotId, outputRoot, env);
  if (!src.ok) throw new Error(src.reason);
  const plate = src.spec.plate;
  const workingWidth = shotState(project, req.shotId)?.key?.workingWidth ?? 1920;
  const dims = size === 'plate' ? plate : size === 'working' ? keyWorkingSize(plate, workingWidth) : keyWorkingSize(plate, Math.min(workingWidth, size.maxWidth));
  const bg = backgroundSpec(project, req.shotId, { ffmpeg: env.ffmpeg!, caps: env.caps }, src.space);
  return { job: { frames: src.spec, size: dims, space: src.space, roto: rotoSource(project, req.shotId, req.projectKey, env), background: bg.spec, subject: subjectSource(project, req.shotId, req.projectKey, env) }, src, pxScale: plate.width / dims.width };
}

export async function keySession(project: Project, shotId: string, outputRoot: string | null, env: KeyEnv): Promise<KeySessionInfo> {
  const state = shotState(project, shotId);
  if (!state) throw new Error(`No shot ${shotId}`);
  const references = backgroundReferences(project, shotId);
  const empty: KeySessionInfo = { available: false, reason: null, frames: '', plate: null, working: null, first: 0, last: 0, encoding: { label: '', linear: false, note: null }, background: { available: false, label: '', reason: null }, references, exportable: false, fileBackground: true };
  if (!state.tasks.some((t) => t.kind === 'key')) return { ...empty, reason: 'This shot has no Green/blue-screen key task. Add it to key the shot.' };
  const src = await source(project, shotId, outputRoot, env);
  if (!src.ok) return { ...empty, reason: src.reason };
  const working = keyWorkingSize(src.spec.plate, state.key?.workingWidth ?? 1920);
  const bg = backgroundSpec(project, shotId, { ffmpeg: env.ffmpeg!, caps: env.caps }, src.space);
  const sam2 = env.sam2Status ? await env.sam2Status().catch((e: Error) => ({ available: false, reason: e.message, label: 'SAM 2.1' })) : { available: false, reason: 'SAM 2 is not set up in this build.', label: 'SAM 2.1' };
  return {
    subjectEngines: { sam2, track: { available: true } },
    available: true,
    reason: null,
    frames: src.spec.label,
    plate: src.spec.plate,
    working,
    first: src.spec.first,
    last: src.spec.last,
    encoding: { label: src.space.label, linear: src.space.linear, note: src.space.linear ? null : 'The source encoding is unknown: the key works on code values, not linear light. Set the source encoding in Plates for a linear key.' },
    background: { available: bg.spec !== null, label: bg.spec?.label ?? '', reason: bg.reason },
    references,
    exportable: true,
    fileBackground: true,
  };
}

export async function keyDetect(project: Project, req: { shotId: string; projectKey: string; kind: ScreenKind | null }, outputRoot: string | null, env: KeyEnv, o: { signal?: AbortSignal } = {}): Promise<KeyDetectResult> {
  const { job } = await ioJob(project, req, outputRoot, env, { maxWidth: 960 });
  const out = await runKeyJob({ type: 'detect', job: { io: job, kind: req.kind } }, { workerFile: env.workerFile, ...(o.signal ? { signal: o.signal } : {}) });
  if (!out.detected) throw new Error('No screen colour was found');
  return out.detected;
}

/** Review keys stay warm between frames: the clean-plate model and frames are kept per shot, size and settings. */
const previews = new Map<string, { keyer: ShotKeyer; io: ReturnType<typeof createKeyIO>; job: KeyIOJob; pxScale: number }>();

async function previewKeyer(project: Project, req: { shotId: string; projectKey: string; maxWidth: number }, outputRoot: string | null, env: KeyEnv) {
  const { job, pxScale, src } = await ioJob(project, req, outputRoot, env, { maxWidth: req.maxWidth });
  const settings = settingsOf(project, req.shotId);
  const doc = shotState(project, req.shotId)!.key!;
  const key = JSON.stringify([req.projectKey, req.shotId, src.spec.label, job.size, keySettings(doc), shotState(project, req.shotId)?.roto?.parts.map((p) => [p.id, p.frames.length]) ?? null]);
  let hit = previews.get(key);
  if (!hit) {
    const io = createKeyIO(job);
    const model = await shotScreenModel(io, settings, src.spec.first, src.spec.last);
    hit = { keyer: new ShotKeyer(settings, model), io, job, pxScale };
    previews.set(key, hit);
    while (previews.size > 3) previews.delete(previews.keys().next().value!);
  }
  return hit;
}

export async function keyFrameView(project: Project, req: { shotId: string; projectKey: string; frame: number; maxWidth: number; wrap: boolean; match: boolean }, outputRoot: string | null, env: KeyEnv): Promise<KeyFrameView> {
  const p = await previewKeyer(project, req, outputRoot, env);
  const frame = Math.max(p.job.frames.first, Math.min(p.job.frames.last, Math.round(req.frame)));
  const img = await p.io.frame(frame);
  const out = await p.keyer.keyAt(p.io, frame, img, { pxScale: p.pxScale, luma: p.job.space.luma, foreground: true, wrapPreview: req.wrap });
  const doc = shotState(project, req.shotId)!.key!;
  return frameView(frame, img, out, p.job.space, { wrap: req.wrap, match: req.match ? doc.match.suggestion : null, viewLabel: `${p.job.space.label} → Rec.709 (approx.), for viewing` });
}

export async function keySample(project: Project, req: { shotId: string; projectKey: string; frame: number; x: number; y: number; radius: number }, outputRoot: string | null, env: KeyEnv): Promise<{ rgb: [number, number, number] }> {
  const { job, pxScale } = await ioJob(project, req, outputRoot, env, 'working');
  const io = createKeyIO(job);
  const img = await io.frame(Math.max(job.frames.first, Math.min(job.frames.last, Math.round(req.frame))));
  return { rgb: sampleColour(img, req.x / pxScale, req.y / pxScale, Math.max(1, req.radius / pxScale)) };
}

export async function keyProcess(
  project: Project,
  req: { shotId: string; projectKey: string; first?: number; last?: number },
  outputRoot: string | null,
  env: KeyEnv,
  o: { signal?: AbortSignal; onProgress?: (done: number, total: number, frame?: number) => void } = {},
): Promise<KeyRunResult> {
  const state = shotState(project, req.shotId);
  if (!state?.key) throw new Error(noScreen);
  const settings = settingsOf(project, req.shotId);
  const { job, pxScale } = await ioJob(project, req, outputRoot, env, 'working');
  const first = Math.max(job.frames.first, req.first ?? job.frames.first);
  const last = Math.min(job.frames.last, req.last ?? job.frames.last);
  if (last < first) throw new Error('No frames to process');
  const out = await runKeyJob(
    { type: 'process', job: { io: job, settings, revision: state.key.revision, range: { first, last }, cache: new MaskStore(env.keyCacheRoot, req.projectKey, req.shotId).root, version: keyTaskVersion(state), pxScale } },
    { workerFile: env.workerFile, ...(o.signal ? { signal: o.signal } : {}), ...(o.onProgress ? { onProgress: o.onProgress } : {}) },
  );
  if (!out.result) throw new Error('The key produced nothing');
  return out.result;
}

export async function keyMatch(project: Project, req: { shotId: string; projectKey: string; frame: number }, outputRoot: string | null, env: KeyEnv): Promise<BgMatchInput> {
  const p = await previewKeyer(project, { ...req, maxWidth: 1280 }, outputRoot, env);
  const frame = Math.max(p.job.frames.first, Math.min(p.job.frames.last, Math.round(req.frame)));
  const img = await p.io.frame(frame);
  const out = await p.keyer.keyAt(p.io, frame, img, { pxScale: p.pxScale, luma: p.job.space.luma, foreground: true });
  if (!out.background) throw new Error('Choose a background reference first (step 5).');
  const s = matchSamples(out.fg!, out.alpha, out.background, Math.max(4, Math.round(img.width / 60)));
  const m = estimateMatch(s.fg, s.bg, p.job.space.luma);
  return { gain: m.gain, offset: m.offset, exposureStops: Math.round(m.exposureStops * 1000) / 1000, samples: m.samples, confidence: m.confidence, frame };
}

/**
 * The Auto subject segmentation (addendum 18): SAM 2 when it is installed and
 * asked for (or Auto), else Track, run from the seed over the whole shot at
 * ≤ 1024 px; the masks go to the key cache. The renderer records the result
 * with `recordKeySubjectRun`.
 */
export async function keySubject(
  project: Project,
  req: { shotId: string; projectKey: string },
  outputRoot: string | null,
  env: KeyEnv,
  o: { signal?: AbortSignal; onProgress?: (done: number, total: number, frame?: number) => void } = {},
): Promise<KeySubjectRunInput> {
  const state = shotState(project, req.shotId);
  const doc = state?.key;
  if (!state || !doc?.screen) throw new Error(noScreen);
  if (doc.subject.source !== 'auto') throw new Error('Set the subject to Auto first.');
  const settings = settingsOf(project, req.shotId);
  const { job, pxScale, src } = await ioJob(project, req, outputRoot, env, { maxWidth: SUBJECT_WIDTH });
  let engine: 'sam2' | 'track' = doc.subject.engine === 'track' ? 'track' : 'sam2';
  let sam2: Sam2Files | undefined;
  let fallback: string | null = null;
  if (engine === 'sam2') {
    try {
      if (!env.sam2) throw new Error('SAM 2 is not set up in this build.');
      sam2 = await env.sam2();
    } catch (error) {
      if (doc.subject.engine === 'sam2') throw error;
      engine = 'track';
      fallback = `SAM 2 not available (${(error as Error).message}); the Track engine was used`;
    }
  }
  const seedFrame = doc.subject.seed.frame ?? Math.round((src.spec.first + src.spec.last) / 2);
  const seed = doc.subject.seed.box || doc.subject.seed.points.length ? { box: doc.subject.seed.box, points: doc.subject.seed.points } : null;
  const version = keyTaskVersion(state);
  const out = await runKeyJob(
    { type: 'subject', job: { io: { ...job, subject: null }, settings, engine, ...(sam2 ? { sam2 } : {}), seedFrame, seed, pxScale, cache: new MaskStore(env.keyCacheRoot, req.projectKey, req.shotId).root, version } },
    { workerFile: env.workerFile, ...(o.signal ? { signal: o.signal } : {}), ...(o.onProgress ? { onProgress: o.onProgress } : {}) },
  );
  if (!out.subject) throw new Error('The segmentation produced nothing');
  return { engine: out.subject.engine, revision: doc.subject.revision, seedFrame: Math.max(src.spec.first, Math.min(src.spec.last, seedFrame)), seededBy: out.subject.seededBy, first: src.spec.first, last: src.spec.last, frames: out.subject.frames, fallback };
}

/** "Repair with roto": the key of `frame` becomes the roto part's matte there (roto's working size). */
export async function keySeedRoto(project: Project, req: { shotId: string; projectKey: string; partId: string; frame: number }, outputRoot: string | null, env: KeyEnv): Promise<{ confidence: number }> {
  const state = shotState(project, req.shotId);
  if (!state) throw new Error(`No shot ${req.shotId}`);
  const src = await source(project, req.shotId, outputRoot, env);
  if (!src.ok) throw new Error(src.reason);
  const size = rotoWorkingSize(src.spec.plate, state.roto?.workingWidth ?? 1920);
  const p = await previewKeyer(project, { shotId: req.shotId, projectKey: req.projectKey, maxWidth: size.width }, outputRoot, env);
  const frame = Math.max(p.job.frames.first, Math.min(p.job.frames.last, Math.round(req.frame)));
  const img = await p.io.frame(frame);
  const out = await p.keyer.keyAt(p.io, frame, img, { pxScale: p.pxScale, luma: p.job.space.luma, foreground: false });
  let mask = planeToMask(out.alpha, out.width, out.height);
  if (mask.width !== size.width || mask.height !== size.height) {
    const { resizeMask } = await import('../../shared/roto/image');
    mask = resizeMask(mask, size.width, size.height);
  }
  // The roto task version the part will be in (a shot without roto starts at v001).
  const version = state.tasks.some((t) => t.kind === 'roto') ? rotoTaskVersion(state) : 1;
  await new MaskStore(env.rotoCacheRoot, req.projectKey, req.shotId).put(req.partId, version, frame, mask);
  return { confidence: Math.max(0.3, out.confidence) };
}

export async function keyExport(
  project: Project,
  req: { shotId: string; projectKey: string; operator: string; options: KeyExportOptions },
  outputRoot: string,
  env: KeyEnv,
  o: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void; now?: Date } = {},
): Promise<{ record: KeyExportInput; folder: string; files: number }> {
  const problem = outputRootProblem(outputRoot, sourceFiles(project));
  if (problem) throw new Error(problem);
  const state = shotState(project, req.shotId);
  const shot = handoffShot(project, req.shotId);
  const doc = state?.key;
  if (!state || !shot || !doc?.screen) throw new Error(noScreen);
  const settings = settingsOf(project, req.shotId);
  const task = state.tasks.find((t) => t.kind === 'key');
  if (!task) throw new Error('This shot has no Green/blue-screen key task.');
  const version = task.version;
  const name = state.vfxShotId ?? shot.shotId;
  const keys = join(shotFolder(project, req.shotId, outputRoot), '03_KEYS');
  const folder = join(keys, keyNames.folder(name, version));
  const metadataName = keyNames.metadata(name, version);
  if (task.state === 'approved' && (await stat(join(folder, metadataName)).catch(() => null))) {
    throw new Error(`Key ${versionTag(version)} is approved and already written; it is never rewritten. Reopen the key to make a new version.`);
  }
  await mkdir(keys, { recursive: true });
  const plate = await ioJob(project, req, outputRoot, env, 'plate');
  const working = await ioJob(project, req, outputRoot, env, 'working');
  const options = { ...req.options, lightWrap: doc.lightWrap.output };
  const at = (o.now ?? new Date()).toISOString();
  const out = await runKeyJob(
    { type: 'export', job: { io: plate.job, modelIO: working.job, model: null, settings, shot: name, version, approved: task.state === 'approved', folder, first: plate.src.spec.first, last: plate.src.spec.last, options, generator: env.generator } },
    { workerFile: env.workerFile, ...(o.signal ? { signal: o.signal } : {}), ...(o.onProgress ? { onProgress: o.onProgress } : {}) },
  );
  const exported = out.exported;
  if (!exported) throw new Error('The export produced nothing');
  const wrapWritten = options.lightWrap && plate.job.background !== null;
  const files = {
    alpha: keyNames.alphaPattern(name, version),
    alphaExr: options.alphaExr ? keyNames.alphaExrPattern(name, version) : null,
    foreground: options.foreground ? keyNames.foregroundPattern(name, version) : null,
    core: options.core ? keyNames.corePattern(name, version) : null,
    edge: options.edge ? keyNames.edgePattern(name, version) : null,
    lightWrap: wrapWritten ? keyNames.lightWrapPattern(name, version) : null,
    shadow: doc.params.shadowPass ? keyNames.shadowPattern(name, version) : null,
    mattesExr: doc.params.shadowPass && options.alphaExr ? keyNames.mattesExrPattern(name, version) : null,
  };
  const meta = keyMetadata(project, req.shotId, {
    version,
    first: plate.src.spec.first,
    last: plate.src.spec.last,
    width: exported.width,
    height: exported.height,
    encoding: plate.src.space.label,
    linear: plate.src.space.linear,
    source: plate.src.spec.label,
    files,
    alphaExr: options.alphaExr,
    generator: env.generator,
    writtenAt: at,
    by: req.operator,
    background: plate.job.background ? `${plate.job.background.label} (${plate.job.background.file ? (plate.job.background.encoding === plate.src.space.encoding ? 'EXR read as linear in the working encoding' : 'read as sRGB') : 'a frame of this shot'})` : null,
  });
  const exportFrames = exported.frames;
  await writeFile(join(folder, metadataName), `${JSON.stringify({ ...meta, exportedConfidence: exportFrames }, null, 2)}\n`);
  await writeFile(join(folder, keyNames.readme()), readme(name, version, meta.colour.encoding, files, task.state === 'approved'));
  const values = exportFrames.map((f) => f.confidence);
  const summary = keyConfidenceSummary(doc);
  const record: KeyExportInput = {
    version,
    folder: `03_KEYS/${keyNames.folder(name, version)}`,
    alpha: files.alpha,
    foreground: files.foreground,
    core: files.core,
    edge: files.edge,
    lightWrap: files.lightWrap,
    shadow: files.shadow,
    mattesExr: files.mattesExr,
    alphaExr: options.alphaExr,
    first: plate.src.spec.first,
    last: plate.src.spec.last,
    frames: exportFrames.length,
    width: exported.width,
    height: exported.height,
    encoding: plate.src.space.label,
    despill: Boolean(options.foreground && doc.despill.enabled),
    confidence: { mean: values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1000) / 1000 : summary.mean, min: values.length ? Math.min(...values) : summary.min, low: exportFrames.filter((f) => f.confidence < 0.6).map((f) => f.frame) },
    algorithm: `${doc.algorithm.id}@${doc.algorithm.version}`,
    revision: doc.revision,
    metadata: `03_KEYS/${keyNames.folder(name, version)}/${metadataName}`,
    files: exported.files.length + 2,
  };
  return { record, folder, files: record.files };
}

function readme(shot: string, version: number, encoding: string, files: Record<string, string | null>, approved: boolean): string {
  const v = versionTag(version);
  const lines = [
    `${shot} key ${v} — VC VFX`,
    '',
    'What is here',
    `  ${files['alpha']}   16-bit PNG alpha (straight): 0 = background, full = foreground.`,
    files['alphaExr'] ? `  ${files['alphaExr']}   the same alpha as half-float EXR (one channel, named Y).` : null,
    files['foreground'] ? `  ${files['foreground']}   the foreground: RGBA half-float EXR, premultiplied, despilled, ${encoding}. No look, no grade, no composite.` : null,
    files['core'] ? `  ${files['core']}   the core matte (solid inside).` : null,
    files['edge'] ? `  ${files['edge']}   the edge matte (soft edge, before the core and the garbage/holdout mattes).` : null,
    files['lightWrap'] ? `  ${files['lightWrap']}   a light-wrap layer, RGB half-float EXR: add it over your composite (it is not in the foreground).` : null,
    files['shadow'] ? `  ${files['shadow']}   the shadow pass: 16-bit PNG, the density of shadows cast on the screen (0 none … 1 black), not in the alpha.` : null,
    files['mattesExr'] ? `  ${files['mattesExr']}   half-float EXR with the alpha (A) and the shadow density (shadow.A) as layers.` : null,
    `  ${keyNames.metadata(shot, version)}   the screen colour, every setting, the suggested background match and per-frame confidence.`,
    '',
    'Comping it',
    '  over = foreground + (1 − alpha) × background   (the foreground is already premultiplied).',
    files['shadow'] ? '  With the shadow pass: background × (1 − shadow) before the over (a Merge multiply in Nuke; tint or soften the shadow to taste).' : null,
    '  The suggested colour match in the JSON is a suggestion; it is not applied to these files.',
    '',
    approved ? 'This key version is approved.' : 'This key version is not approved yet: it is a prep deliverable for review.',
    '',
  ];
  return lines.filter((l) => l !== null).join('\n');
}
