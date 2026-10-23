import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  combineAlpha,
  editsMatte,
  handoffShot,
  rivalFrames,
  rotoConfidenceSummary,
  rotoMetadata,
  rotoNames,
  rotoPart,
  rotoTaskVersion,
  shotState,
  type Project,
  type RotoDirection,
  type RotoExportInput,
  type RotoPropagationResult,
} from '@vcvfx/domain';
import type { RotoEngineInfo, RotoMaskData, RotoSession, ViewerFrame } from '../../shared/bridge';
import type { FfmpegCaps } from '../../shared/ffmpeg-args';
import { resizeMask, type Mask } from '../../shared/roto/image';
import { refineMatte } from '../../shared/roto/refine';
import { sam2EngineVersion } from '../../shared/roto/sam2';
import { TRACK_VERSION } from '../../shared/roto/track';
import type { FrameCache } from '../frame-cache';
import { shotFolder } from '../package-shot';
import { outputRootProblem } from '../paths';
import { sourceFiles } from '../package-shot';
import { viewerFrame } from '../viewer';
import { modelDir, modelStatus, sam2Model, verifyModel } from './models';
import { loadOrt } from './sam2-ort';
import { rotoFrameSource, workingSize, type FrameSourceResult } from './frames';
import { runExportJob, runRotoJob } from './service';
import { MaskStore } from './store';

/**
 * The main-process side of paint-to-roto (addendum 04), called by ipc.ts. No
 * Electron here: where things live is passed in, so it is tested against a
 * temporary folder with the real ffmpeg.
 */

export interface RotoEnv {
  ffmpeg: string | null;
  caps: FfmpegCaps;
  /** userData/Roto Cache */
  cacheRoot: string;
  /** The viewer's frame cache (also holds the view LUTs). */
  frameCache: FrameCache;
  userData: string;
  packaged: boolean;
  /** Where onnxruntime-node may be (sam2-ort.ts `ortCandidates`). */
  ort: string[];
  /** The SAM 2 model chosen in Settings (models.ts `sam2Model`); empty: the default. */
  sam2Model?: string;
  /** The built worker (out/main/roto-worker.js). */
  workerFile: string;
  generator: string;
}

const noFfmpeg = 'Roto reads frames with ffmpeg, and none was found. Reinstall VC VFX or set ffmpeg in Settings.';

async function source(project: Project, shotId: string, outputRoot: string | null, env: RotoEnv): Promise<FrameSourceResult> {
  if (!env.ffmpeg) return { ok: false, reason: noFfmpeg };
  return rotoFrameSource(project, shotId, outputRoot, { ffmpeg: env.ffmpeg, caps: env.caps, cacheDir: env.frameCache.dir });
}

/** Where SAM 2.1's model files are, checked (the model verified in a packaged build); throws why not. */
export async function sam2Files(env: Pick<RotoEnv, 'userData' | 'packaged' | 'ort' | 'sam2Model'>): Promise<{ ort: string[]; encoder: string; decoder: string; model: string }> {
  const model = sam2Model(env.sam2Model);
  const status = await modelStatus(env.userData, env.packaged, model);
  if (!status.usable) throw new Error(status.reason ?? 'The SAM 2 model is not available.');
  if (env.packaged) {
    const verified = await verifyModel(env.userData, model);
    if (!verified.ok) throw new Error(verified.reason);
  }
  const dir = modelDir(env.userData, model);
  return { ort: env.ort, encoder: join(dir, model.files[0]!.name), decoder: join(dir, model.files[1]!.name), model: model.id };
}

export async function engineInfo(env: Pick<RotoEnv, 'userData' | 'packaged' | 'ort' | 'sam2Model'>): Promise<RotoEngineInfo[]> {
  const status = await modelStatus(env.userData, env.packaged, sam2Model(env.sam2Model));
  const ort = loadOrt(env.ort);
  const samReason = !ort.ok ? ort.reason : status.reason;
  return [
    { id: 'track', label: 'Track (classical)', version: TRACK_VERSION, available: true, reason: null },
    {
      id: 'sam2',
      label: 'SAM 2.1 (AI)',
      version: sam2EngineVersion(sam2Model(env.sam2Model).id),
      available: ort.ok && status.usable,
      reason: ort.ok && status.usable ? null : samReason,
      model: { label: status.label, approxBytes: status.approxBytes, present: status.present, pinned: status.pinned, downloadable: ort.ok && (status.pinned || !env.packaged) && !status.present },
    },
  ];
}

export async function rotoSession(project: Project, shotId: string, outputRoot: string | null, env: RotoEnv): Promise<RotoSession> {
  const state = shotState(project, shotId);
  if (!state) throw new Error(`No shot ${shotId}`);
  const engines = await engineInfo(env);
  if (!state.tasks.some((t) => t.kind === 'roto')) return { available: false, reason: 'This shot has no Paint-to-roto task. Add it to paint roto.', frames: '', plate: null, working: null, first: 0, last: 0, engines, exportable: false };
  const src = await source(project, shotId, outputRoot, env);
  if (!src.ok) return { available: false, reason: src.reason, frames: '', plate: null, working: null, first: 0, last: 0, engines, exportable: false };
  const working = workingSize(src.spec.plate, state.roto?.workingWidth ?? 1920);
  return { available: true, reason: null, frames: src.spec.label, plate: src.spec.plate, working, first: src.spec.first, last: src.spec.last, engines, exportable: true };
}

/** A frame for painting on: the plates when there are some, else the source; the viewer's own cache. */
export async function rotoFrame(project: Project, req: { text: string; shotId: string; projectKey: string; frame: number; maxWidth: number; prefetch?: boolean }, outputRoot: string | null, env: RotoEnv): Promise<ViewerFrame> {
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

const plateWidth = (project: Project, shotId: string, fallback: number) => handoffShot(project, shotId)?.resolution?.width ?? shotState(project, shotId)?.probe?.resolution?.width ?? fallback;

/**
 * A part's matte on a frame (or the combined subject matte, partId null) as
 * the overlay shows it: refined, at most `maxWidth` wide. Null where there is
 * none yet.
 */
export async function rotoMask(project: Project, req: { shotId: string; projectKey: string; partId: string | null; frame: number; maxWidth: number }, env: RotoEnv): Promise<RotoMaskData | null> {
  const state = shotState(project, req.shotId);
  const doc = state?.roto;
  if (!state || !doc) return null;
  const store = new MaskStore(env.cacheRoot, req.projectKey, req.shotId);
  const version = rotoTaskVersion(state);
  const refined = new Map<string, Mask>();
  const own = async (partId: string): Promise<Mask | null> => {
    if (refined.has(partId)) return refined.get(partId)!;
    const part = rotoPart(doc, partId);
    if (!part || !part.frames.some((f) => f.frame === req.frame)) return null;
    const m = await store.get(partId, version, req.frame);
    if (!m) return null;
    const r = refineMatte(m, part.refine, { pxScale: plateWidth(project, req.shotId, m.width) / m.width, guide: null, upscaled: false });
    refined.set(partId, r);
    return r;
  };
  let out: Mask | null;
  if (req.partId) out = await own(req.partId);
  else {
    for (const p of doc.parts) await own(p.id);
    const any = [...refined.values()][0];
    if (!any) return null;
    out = { width: any.width, height: any.height, data: combineAlpha(doc, any.width * any.height, (id) => refined.get(id)?.data ?? null) };
  }
  if (!out) return null;
  const w = Math.min(out.width, Math.max(32, Math.round(req.maxWidth)));
  const sized = w === out.width ? out : resizeMask(out, w, Math.max(1, Math.round((out.height * w) / out.width)));
  return { width: sized.width, height: sized.height, alpha: sized.data };
}

export async function rotoRun(
  project: Project,
  req: { shotId: string; projectKey: string; partId: string; from: number; directions: RotoDirection[] },
  outputRoot: string | null,
  env: RotoEnv,
  o: { signal?: AbortSignal; onProgress?: (done: number, total: number, frame?: number) => void } = {},
): Promise<RotoPropagationResult[]> {
  const state = shotState(project, req.shotId);
  const doc = state?.roto;
  const part = rotoPart(doc, req.partId);
  if (!state || !doc || !part) throw new Error('Paint the key frame first.');
  if (!part.keyFrames.some((k) => k.frame === req.from)) throw new Error(`Frame ${req.from} is not a key frame of ${part.name}. Paint it first.`);
  const src = await source(project, req.shotId, outputRoot, env);
  if (!src.ok) throw new Error(src.reason);
  const working = workingSize(src.spec.plate, doc.workingWidth);
  const sam2 = part.engine.id === 'sam2' ? await sam2Files(env) : undefined;
  return runRotoJob(
    {
      frames: src.spec,
      working,
      store: new MaskStore(env.cacheRoot, req.projectKey, req.shotId).root,
      version: rotoTaskVersion(state),
      engine: part.engine.id,
      ...(sam2 ? { sam2 } : {}),
      request: {
        partId: part.id,
        from: req.from,
        directions: req.directions,
        first: src.spec.first,
        last: src.spec.last,
        keyFrames: part.keyFrames.map((k) => ({ frame: k.frame, strokes: k.strokes, correction: editsMatte(part, k.frame) })),
        scale: working.width / src.spec.plate.width,
        smoothing: part.refine.temporalSmoothing,
        settings: part.engine.settings,
        rivals: rivalFrames(part, req.from),
      },
    },
    { workerFile: env.workerFile, ...(o.signal ? { signal: o.signal } : {}), ...(o.onProgress ? { onProgress: o.onProgress } : {}) },
  );
}

/**
 * Write the mattes of the current roto version into the package, and the
 * metadata beside them. Returns the record for `recordRotoExport` (the caller
 * records it; that also puts roto up for review).
 */
export async function rotoExport(
  project: Project,
  req: { shotId: string; projectKey: string; operator: string; exr: boolean },
  outputRoot: string,
  env: RotoEnv,
  o: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void; now?: Date } = {},
): Promise<{ record: RotoExportInput; folder: string; files: number }> {
  const problem = outputRootProblem(outputRoot, sourceFiles(project));
  if (problem) throw new Error(problem);
  const state = shotState(project, req.shotId);
  const shot = handoffShot(project, req.shotId);
  const doc = state?.roto;
  if (!state || !shot || !doc || !doc.parts.some((p) => p.frames.length)) throw new Error('There are no mattes to export yet. Paint and propagate first.');
  if (!env.ffmpeg) throw new Error(noFfmpeg);
  const src = await source(project, req.shotId, outputRoot, env);
  if (!src.ok) throw new Error(src.reason);
  const task = state.tasks.find((t) => t.kind === 'roto')!;
  const version = task.version;
  const name = state.vfxShotId ?? shot.shotId;
  const folder = join(shotFolder(project, req.shotId, outputRoot), '02_MATTES_ROTO');
  await mkdir(folder, { recursive: true });
  const metadataName = rotoNames.metadata(name, version);
  if (task.state === 'approved' && (await stat(join(folder, metadataName)).catch(() => null))) {
    throw new Error(`Roto ${metadataName.replace(/\.json$/, '')} is approved and already written; it is never rewritten. Reopen roto to make a new version.`);
  }
  const at = (o.now ?? new Date()).toISOString();
  const exported = await runExportJob(
    { frames: src.spec, shot: name, version, approved: task.state === 'approved', folder, first: src.spec.first, last: src.spec.last, parts: doc.parts, exr: req.exr, ffmpeg: env.ffmpeg, generator: env.generator },
    new MaskStore(env.cacheRoot, req.projectKey, req.shotId).root,
    { workerFile: env.workerFile, ...(o.signal ? { signal: o.signal } : {}), ...(o.onProgress ? { onProgress: o.onProgress } : {}) },
  );
  const meta = rotoMetadata(project, req.shotId, { version, first: src.spec.first, last: src.spec.last, width: exported.width, height: exported.height, bitDepth: 16, exr: req.exr, workingWidth: doc.workingWidth, generator: env.generator, writtenAt: at, by: req.operator });
  const metaFile = { ...meta, source: src.spec.label, view: `${src.spec.view.label} (for analysis only; nothing is baked into plates or mattes)`, refiners: exported.refiners };
  await writeFile(join(folder, metadataName), `${JSON.stringify(metaFile, null, 2)}\n`);
  const summary = rotoConfidenceSummary(doc);
  const record: RotoExportInput = {
    version,
    folder: `02_MATTES_ROTO/${rotoNames.matteFolder(name, version)}`,
    pattern: rotoNames.mattePattern(name, version),
    parts: doc.parts.map((p) => ({ partId: p.id, name: p.name, folder: `02_MATTES_ROTO/${rotoNames.partFolder(name, p.id, version)}`, pattern: rotoNames.partPattern(name, p.id, version) })),
    first: src.spec.first,
    last: src.spec.last,
    frames: src.spec.last - src.spec.first + 1,
    width: exported.width,
    height: exported.height,
    bitDepth: 16,
    exr: req.exr,
    confidence: { mean: summary.mean, min: summary.min, low: summary.low },
    engines: [...new Set(doc.parts.flatMap((p) => p.frames.map((f) => f.engine)).filter(Boolean))],
    metadata: `02_MATTES_ROTO/${metadataName}`,
  };
  return { record, folder, files: exported.files.length + 1 };
}
