import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';
import {
  LIGHTING_TASK,
  estimateSpec,
  findLensProfile,
  handoffShot,
  lightingDoc,
  lightingExportProblem,
  lightingFrames,
  lightingNames,
  lightingTaskVersion,
  newCamTrackDocument,
  shotState,
  versionTag,
  type LightingAiReviewInput,
  type LightingAnalysisInput,
  type LightingDocument,
  type LightingExportFormat,
  type LightingExportInput,
  type LightingReference,
  type LightingReferenceInput,
  type LightingReferenceKind,
  type Project,
} from '@vcvfx/domain';
import type { FfmpegCaps } from '../../shared/ffmpeg-args';
import type { ModelClient } from '../../shared/ai/protocol';
import { decodeSolve } from '../../shared/camera/codec';
import { sceneCameras } from '../../shared/camera/coords';
import { toDisplay, workingSpace, type LinearImage } from '../../shared/key/linear';
import type { CameraPriors } from '../../shared/lighting/analyse';
import type { LightingExportOutcome, LightingFrameView, LightingHandoffReference, LightingIngestSource, LightingReferenceView, LightingSessionInfo } from '../../shared/lighting/bridge-types';
import { reviewRequest, runLightingReview } from '../../shared/lighting/ai-review';
import { relight, relightModel, matchScore, rigBall } from '../../shared/lighting/relight';
import { silhouetteNormals } from '../../shared/lighting/shading';
import { sha256File } from '../hash';
import { cameraRawProblem } from '../image-sequence';
import { shotFolder, sourceFiles } from '../package-shot';
import { isSampleHandoff, outputRootProblem, resolveFromHandoff } from '../paths';
import { probeSize } from '../roto/frames';
import { FileStore } from '../camera/store';
import { referenceFile as textureReferenceFile } from '../texture/api';
import { createLightingIO, lightingIOJob, plateSource, referenceFile, type LightingIOJob, type LightingPictureSpec } from './io';
import { runLightingJob } from './service';
import type { LightingAnalyseJob, LightingRefJob } from './worker';

/**
 * The main-process side of the lighting and lens analysis (addendum 14),
 * called by ipc-lighting.ts. No Electron here: where things live is passed
 * in, so it is tested against a temporary folder with the real ffmpeg.
 * References and the plate are only ever read.
 */

export interface LightingEnv {
  ffmpeg: string | null;
  caps: FfmpegCaps;
  /** The built worker (out/main/lighting-worker.js). */
  workerFile: string;
  generator: string;
  /** userData/Track Cache: the camera track's solves (for the camera at the analysed frame). */
  trackCacheRoot: string;
  /** The AI review: the model client (vc-vfx.com), whether the artist allowed frames for this project, a JPEG encoder. */
  ai?: { model: ModelClient; framesAllowed(projectKey: string): Promise<boolean>; signedIn(): Promise<boolean>; jpeg(rgb: Uint8ClampedArray, width: number, height: number): string } | null;
}

const ANALYSIS_WIDTH = 640;
const slash = (p: string) => p.split(sep).join('/');
const KIND_OF: Partial<Record<string, LightingReferenceKind>> = { hdri: 'hdri', panorama: 'hdri' };
const PICTURE_EXT = new Set(['jpg', 'jpeg', 'png', 'tif', 'tiff', 'exr', 'hdr', 'dpx']);

const docOf = (project: Project, shotId: string): LightingDocument | null => lightingDoc(shotState(project, shotId));

/** A reference's file on disk (a Textures panorama by its id; null for the sample's and plate frames). */
export function lightingReferenceFile(project: Project, shotId: string, ref: Pick<LightingReference, 'path' | 'from'>): string | null {
  if (ref.from === 'texture') {
    const t = shotState(project, shotId)?.texture?.references.find((r) => r.id === ref.path);
    return t ? textureReferenceFile(project, t) : null;
  }
  return referenceFile(project, ref);
}

/** Every reference file of every shot: what an output root must stay out of, as the media. */
export function lightingReferenceFiles(project: Project): string[] {
  return project.shots.flatMap((s) => (s.lighting?.references ?? []).map((r) => lightingReferenceFile(project, s.shotId, r)).filter((p): p is string => p !== null));
}

const sizeFor = (plate: { width: number; height: number }) => {
  const width = Math.min(plate.width, ANALYSIS_WIDTH);
  return { width, height: Math.max(16, Math.round((plate.height * width) / plate.width)) };
};

const kelvinFrom = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(/(\d{4,5})/.exec(v)?.[1]) : NaN;
  return Number.isFinite(n) && n >= 1500 && n <= 20000 ? n : null;
};

/** What the analysis knows about the camera before looking: the camera track and the metadata (addendum 14 §3.7). */
export async function cameraPriors(project: Project, shotId: string, frame: number, doc: LightingDocument | null, env: Pick<LightingEnv, 'trackCacheRoot'>, projectKey: string, plate: { width: number; height: number }) {
  const state = shotState(project, shotId)!;
  const shot = handoffShot(project, shotId)!;
  const cam = state.camtrack ?? newCamTrackDocument(project, shotId);
  const selection = cam.camera;
  const record = state.camtrack?.activeSolve ? state.camtrack.solves.find((s) => s.number === state.camtrack!.activeSolve) ?? null : null;
  let pose: { position: [number, number, number]; rotation: number[] } | null = null;
  if (record && state.camtrack) {
    const bytes = await new FileStore(env.trackCacheRoot, projectKey, shotId).get(record.file).catch(() => null);
    if (bytes) {
      const T = state.camtrack.coords.transform;
      const cams = sceneCameras(decodeSolve(bytes), { s: T.s, R: T.R, t: [T.t[0]!, T.t[1]!, T.t[2]!] });
      const at = cams.reduce<(typeof cams)[number] | null>((best, c) => (!best || Math.abs(c.frame - frame) < Math.abs(best.frame - frame) ? c : best), null);
      if (at) pose = { position: at.position, rotation: at.rotation };
    }
  }
  const focalMeta = shot.camera.focalLengthMm ?? (cam.lens.focalMm && cam.lens.focalMode === 'known' ? cam.lens.focalMm : null);
  const profile = findLensProfile(project.lensProfiles, { cameraId: selection?.cameraId ?? null, modeId: selection?.modeId ?? null, lens: shot.camera.lens ?? cam.lens.name, focalMm: focalMeta });
  const R = pose?.rotation;
  const pitch = R ? (Math.asin(Math.max(-1, Math.min(1, -R[5]!))) * 180) / Math.PI : null;
  const roll = R ? (Math.atan2(R[3]!, R[4]!) * 180) / Math.PI : null;
  const camExtra = shot.camera as Record<string, unknown>;
  const wbMeta = kelvinFrom(camExtra['whiteBalance'] ?? camExtra['whiteBalanceK'] ?? camExtra['colorTemperature'] ?? camExtra['wb']);
  const priors: CameraPriors = {
    focalMm: record?.intrinsics.focalMm ?? focalMeta ?? null,
    focalSource: record?.intrinsics.focalMm ? 'solve' : focalMeta ? 'metadata' : null,
    filmBackMm: selection?.filmBackMm ?? null,
    filmBackSource: state.camtrack?.camera ? 'camera_track' : selection?.source === 'handoff' && shot.camera.filmBackMm ? 'handoff' : selection ? 'database' : 'nominal',
    pitchDeg: pitch,
    rollDeg: roll,
    k1: record ? record.intrinsics.k1 : profile ? profile.distortion.k1 : null,
    k1Source: record ? 'solve' : profile ? 'profile' : null,
    iris: shot.camera.iris ?? null,
    focusDistance: shot.camera.focusDistance ?? null,
    subjectDistanceM: doc?.settings.subjectDistanceM ?? 3,
    subjectDistanceSource: 'setting',
  };
  // The ground: with a solve whose coordinates have a ground plane, the camera's height above it; else 1.5 m, assumed.
  const units = state.camtrack?.coords.units ?? 'm';
  const toM = { m: 1, cm: 0.01, mm: 0.001, ft: 0.3048, in: 0.0254 }[units];
  const ground = pose && state.camtrack?.coords.ground && pose.position[1] > 0 ? { heightM: pose.position[1] * toM, source: 'solve' as const } : { heightM: 1.5, source: 'assumed' as const };
  const whiteBalance = doc?.settings.whiteBalanceK ? { kelvin: doc.settings.whiteBalanceK, source: 'artist' as const } : wbMeta ? { kelvin: wbMeta, source: 'metadata' as const } : { kelvin: null, source: 'assumed' as const };
  return { priors, ground, whiteBalance, pose, units, upAxis: state.camtrack?.coords.upAxis ?? 'y', record };
}

export async function lightingSession(project: Project, shotId: string, projectKey: string, outputRoot: string | null, env: LightingEnv): Promise<LightingSessionInfo> {
  const state = shotState(project, shotId);
  const shot = handoffShot(project, shotId);
  if (!state || !shot) throw new Error(`No shot ${shotId}`);
  const ai = { available: false, reason: 'Sign in (VC VFX › Account) and allow AI to see frames of this project to ask for a second opinion.' as string | null };
  const empty: LightingSessionInfo = { available: false, reason: null, exportable: false, fromDisk: false, frames: '', plate: null, first: 0, last: 0, fps: 24, analysisWidth: ANALYSIS_WIDTH, encoding: { label: '', linear: false, note: null }, camera: { focal: null, filmBack: null, solve: null, whiteBalance: null, iris: null }, subject: { source: 'none', label: 'none' }, sky: { source: 'none', label: 'none' }, handoff: [], references: [], ai };
  if (!state.tasks.some((t) => t.kind === LIGHTING_TASK)) return { ...empty, reason: 'This shot has no Lighting and lens analysis task. Add it to work on it here.' };
  const src = await plateSource(project, shotId, outputRoot, env);
  if (!src.ok) return { ...empty, reason: src.reason };
  const job = await lightingIOJob(project, shotId, outputRoot, { ffmpeg: env.ffmpeg!, caps: env.caps }, src);
  const doc = docOf(project, shotId);
  const { priors, whiteBalance, record } = await cameraPriors(project, shotId, lightingFrames(doc, src.spec.first, src.spec.last)[0]!, doc, env, projectKey, src.spec.plate);
  const handoff: LightingHandoffReference[] = shot.references
    .filter((r) => KIND_OF[r.kind])
    // One file named twice (as the panorama and as the HDRI) is one HDRI.
    .filter((r, i, all) => all.findIndex((o) => o.path === r.path && KIND_OF[o.kind]) === i)
    .map((r) => {
      const file = resolveFromHandoff(project.handoffPath, r.path);
      return { kind: KIND_OF[r.kind]!, path: r.path, name: basename(r.path), from: 'handoff' as const, onDisk: Boolean(file && existsSync(file)) };
    });
  for (const t of state.texture?.references ?? []) {
    if (t.kind !== 'panorama' || handoff.some((h) => h.from === 'handoff' && h.path === t.path)) continue;
    const file = textureReferenceFile(project, t);
    handoff.push({ kind: 'hdri', path: t.id, name: `${t.name} (Textures)`, from: 'texture', onDisk: Boolean(file && existsSync(file)) });
  }
  const references = await Promise.all(
    (doc?.references ?? []).map(async (r) => {
      if (r.from === 'plate') return { id: r.id, onDisk: true, changed: false };
      const file = lightingReferenceFile(project, shotId, r);
      const st = file ? await stat(file).catch(() => null) : null;
      return { id: r.id, onDisk: Boolean(st), changed: Boolean(st && r.bytes !== null && st.size !== r.bytes) };
    }),
  );
  const subject = job.subject[0] ?? null;
  const aiReady = Boolean(env.ai && (await env.ai.signedIn()) && (await env.ai.framesAllowed(projectKey)));
  return {
    available: true,
    reason: null,
    exportable: true,
    fromDisk: true,
    frames: src.spec.label,
    plate: src.spec.plate,
    first: src.spec.first,
    last: src.spec.last,
    fps: src.spec.frameRate,
    analysisWidth: ANALYSIS_WIDTH,
    encoding: { label: src.space.label, linear: src.space.linear, note: src.space.linear ? null : 'The source encoding is unknown: the analysis works on code values, not linear light. Set the source encoding in Plates.' },
    camera: {
      focal: priors.focalMm ? `${+priors.focalMm.toFixed(2)} mm (${priors.focalSource === 'solve' ? 'camera track' : 'metadata'})` : null,
      filmBack: priors.filmBackMm ? `${+priors.filmBackMm.width.toFixed(2)} × ${+priors.filmBackMm.height.toFixed(2)} mm (${priors.filmBackSource.replace('_', ' ')})` : null,
      solve: record ? `solve ${record.number}, RMS ${record.stats.rms.toFixed(2)} px` : null,
      whiteBalance: whiteBalance.kelvin ? `${whiteBalance.kelvin} K (${whiteBalance.source})` : null,
      iris: priors.iris,
    },
    subject: subject ? { source: subject.source as 'roto' | 'bg_matte' | 'key_alpha', label: subject.label } : { source: 'none', label: 'No subject matte exported yet (Roto, Key or Sky & BG › Export)' },
    sky: job.sky ? { source: 'sky_matte', label: job.sky.label } : { source: 'none', label: 'Detected from the frame, if there is one' },
    handoff,
    references,
    ai: env.ai ? (aiReady ? { available: true, reason: null } : ai) : { available: false, reason: 'The AI review is not available in this build.' },
  };
}

/** Read references without touching them: sha256, size, picture size; a ball in the plate needs nothing read. */
export async function lightingIngest(
  project: Project,
  shotId: string,
  kind: LightingReferenceKind,
  sources: readonly LightingIngestSource[],
  frame: number | null,
  env: LightingEnv,
  o: { signal?: AbortSignal; onProgress?: (done: number, total: number, detail?: string) => void } = {},
): Promise<LightingReferenceInput[]> {
  if (!shotState(project, shotId)?.tasks.some((t) => t.kind === LIGHTING_TASK)) throw new Error('This shot has no Lighting and lens analysis task.');
  const out: LightingReferenceInput[] = [];
  const label = kind === 'hdri' ? 'HDRI' : kind === 'chrome_ball' ? 'Chrome ball' : 'Grey ball';
  let i = 0;
  for (const src of sources) {
    o.onProgress?.(i, sources.length, basename(src.path));
    if (o.signal?.aborted) throw new Error('Cancelled');
    if (src.from === 'sample') throw new Error('The sample references live in the browser preview.');
    if (src.from === 'plate') {
      if (kind === 'hdri') throw new Error('An HDRI is a file, not a plate frame.');
      if (frame === null) throw new Error('Choose the frame the ball is held up in.');
      out.push({ kind, name: `${label} at frame ${frame}`, from: 'plate', path: '', frame, circle: null, headingDeg: null, format: '', checksum: null, bytes: null, width: null, height: null, encoding: null });
      i += 1;
      continue;
    }
    const file = src.from === 'handoff' ? resolveFromHandoff(project.handoffPath, src.path) : src.from === 'texture' ? lightingReferenceFile(project, shotId, { path: src.path, from: 'texture' }) : src.path;
    if (!file || !existsSync(file)) throw new Error(`${src.path} is not on the drive.`);
    const ext = extname(file).slice(1).toLowerCase();
    if (cameraRawProblem(file)) throw new Error(`${basename(file)} is camera raw: convert it to TIFF or EXR first; VC VFX reads the result.`);
    if (!PICTURE_EXT.has(ext)) throw new Error(`${basename(file)}: not a picture VC VFX reads (JPEG, PNG, TIFF, EXR, HDR, DPX).`);
    if (!env.ffmpeg) throw new Error('Reading references needs ffmpeg, and none was found.');
    const { sha256, bytes } = await sha256File(file, { ...(o.signal ? { signal: o.signal } : {}) });
    const size = await probeSize(env.ffmpeg, file);
    const linear = ext === 'exr' || ext === 'hdr';
    out.push({ kind, name: basename(file), from: src.from, path: src.from === 'disk' ? file : src.path, frame: null, circle: null, headingDeg: null, format: ext, checksum: { algorithm: 'sha256', value: sha256 }, bytes, width: size.width, height: size.height, encoding: linear ? 'linear_rec709' : 'srgb' });
    i += 1;
  }
  o.onProgress?.(sources.length, sources.length);
  return out;
}

function pictureSpec(project: Project, shotId: string, r: LightingReference): LightingPictureSpec {
  const file = lightingReferenceFile(project, shotId, r);
  if (!file || !existsSync(file)) throw new Error(`${r.name} is not on the drive (${file ?? r.path}).`);
  if (!r.width || !r.height) throw new Error(`${r.name}: its picture size is not known`);
  return { file, encoding: r.encoding, width: r.width, height: r.height };
}

const pictureCache = new Map<string, LightingReferenceView>();

/** A reference picture for the viewer (8-bit, the viewer's view). */
export async function lightingImage(project: Project, req: { shotId: string; projectKey: string; id: string; maxWidth: number }, outputRoot: string | null, env: LightingEnv): Promise<LightingReferenceView> {
  const doc = docOf(project, req.shotId);
  const r = doc?.references.find((x) => x.id === req.id);
  if (!r) throw new Error(`No reference ${req.id}`);
  if (!env.ffmpeg) throw new Error('Reading references needs ffmpeg, and none was found.');
  const src = await plateSource(project, req.shotId, outputRoot, env);
  if (!src.ok) throw new Error(src.reason);
  const space = src.space;
  if (r.from === 'plate') {
    const job = await lightingIOJob(project, req.shotId, outputRoot, { ffmpeg: env.ffmpeg, caps: env.caps }, src);
    const k = Math.min(1, req.maxWidth / src.spec.plate.width);
    const size = { width: Math.max(16, Math.round(src.spec.plate.width * k)), height: Math.max(16, Math.round(src.spec.plate.height * k)) };
    const img = await createLightingIO(job).frame(r.frame ?? src.spec.first, size.width, size.height);
    return { width: img.width, height: img.height, rgb: toDisplay(img.data, img.width * img.height, space), label: `Plate frame ${r.frame} → Rec.709 (approx.), for viewing` };
  }
  const spec = pictureSpec(project, req.shotId, r);
  const key = JSON.stringify([spec, req.maxWidth, r.checksum?.value ?? null]);
  const hit = pictureCache.get(key);
  if (hit) return hit;
  const { readReferencePicture } = await import('./io');
  const img = await readReferencePicture(env.ffmpeg, env.caps, spec, space.encoding, req.maxWidth);
  const view = { width: img.width, height: img.height, rgb: toDisplay(img.data, img.width * img.height, space), label: `${r.name} · ${r.encoding ?? 'srgb'} → Rec.709 (approx.), for viewing` };
  pictureCache.set(key, view);
  while (pictureCache.size > 6) pictureCache.delete(pictureCache.keys().next().value!);
  return view;
}

/** Relight models kept between preview requests (per project, shot, frame and analysis). */
const models = new Map<string, { model: ReturnType<typeof relightModel>; frame: LinearImage } | null>();

export async function lightingFrameView(project: Project, req: { shotId: string; projectKey: string; request: { frame: number; maxWidth: number; rig: import('@vcvfx/domain').LightSpec[] | null } }, outputRoot: string | null, env: LightingEnv): Promise<LightingFrameView> {
  const started = Date.now();
  const state = shotState(project, req.shotId);
  if (!state) throw new Error(`No shot ${req.shotId}`);
  const src = await plateSource(project, req.shotId, outputRoot, env);
  if (!src.ok) throw new Error(src.reason);
  const doc = docOf(project, req.shotId);
  const frame = Math.max(src.spec.first, Math.min(src.spec.last, Math.round(req.request.frame)));
  const size = sizeFor(src.spec.plate);
  const job = await lightingIOJob(project, req.shotId, outputRoot, { ffmpeg: env.ffmpeg!, caps: env.caps }, src);
  const io = createLightingIO(job);
  const a = doc?.analysis ?? null;
  const space = src.space;
  const key = JSON.stringify([req.projectKey, req.shotId, frame, a?.at ?? null, a?.revision ?? null, job.subject[0]?.source ?? null]);
  let entry = models.get(key);
  if (entry === undefined) {
    const img = await io.frame(frame, size.width, size.height);
    let model: ReturnType<typeof relightModel> | null = null;
    const pref = job.subject.map((s) => s.source);
    if (a && pref.length) {
      let matte: Float32Array | null = null;
      for (const s of pref) {
        matte = await io.matte(s, frame, size.width, size.height);
        if (matte?.some((v) => v > 0.5)) break;
      }
      const lens = a.lens;
      const fb = lens.filmBackMm ?? { width: 36, height: 24 };
      const focalPx = lens.focalMm ? (lens.focalMm.value / fb.width) * size.width : 0.9 * size.width;
      const field = matte ? silhouetteNormals(matte, size.width, size.height, 0.5, { focalPx, cx: size.width / 2, cy: size.height / 2 }) : null;
      if (field) model = relightModel(img, field.normals, field.mask, { pitchDeg: a.tilt.pitchDeg, rollDeg: a.tilt.rollDeg }, a.lights.map(estimateSpec), a.whiteBalance.source === 'assumed' ? null : a.whiteBalance.kelvin, space.luma);
    }
    entry = model ? { model, frame: img } : { model: null as never, frame: img };
    models.set(key, entry);
    while (models.size > 4) models.delete(models.keys().next().value!);
  }
  const img = entry!.frame;
  const n = img.width * img.height;
  const rgb = toDisplay(img.data, n, space);
  const m = entry!.model as ReturnType<typeof relightModel> | null;
  const rig = req.request.rig;
  let relit: Uint8ClampedArray | null = null;
  let ball: LightingFrameView['ball'] = null;
  let match: number | null = null;
  if (rig) {
    if (m) {
      relit = toDisplay(relight(m, rig).data, n, space);
      match = matchScore(m, rig);
    }
    const b = rigBall(rig, { pitchDeg: a?.tilt.pitchDeg ?? 0, rollDeg: a?.tilt.rollDeg ?? 0 }, a && a.whiteBalance.source !== 'assumed' ? a.whiteBalance.kelvin : null, 160);
    ball = { size: 160, rgb: toDisplay(b.image.data, 160 * 160, space), alpha: Uint8Array.from(b.alpha, (v) => Math.round(v * 255)) };
  }
  return {
    frame,
    width: img.width,
    height: img.height,
    rgb,
    relit,
    mask: m ? Uint8Array.from(m.mask, (v) => (v ? 255 : 0)) : null,
    ball,
    match,
    built: a ? (a.revision === doc!.revision ? 'current' : 'stale') : 'none',
    label: `${space.label} → Rec.709 (approx.), for viewing`,
    ms: Date.now() - started,
  };
}

/** Build the worker's analysis job. */
export async function analyseJob(project: Project, shotId: string, projectKey: string, outputRoot: string | null, env: LightingEnv): Promise<{ job: LightingAnalyseJob; io: LightingIOJob }> {
  const state = shotState(project, shotId);
  if (!state) throw new Error(`No shot ${shotId}`);
  const src = await plateSource(project, shotId, outputRoot, env);
  if (!src.ok) throw new Error(src.reason);
  const doc = docOf(project, shotId);
  const io = await lightingIOJob(project, shotId, outputRoot, { ffmpeg: env.ffmpeg!, caps: env.caps }, src);
  const frames = lightingFrames(doc, src.spec.first, src.spec.last);
  const { priors, ground, whiteBalance } = await cameraPriors(project, shotId, frames[0]!, doc, env, projectKey, src.spec.plate);
  const refs = doc?.references ?? [];
  const balls = (kind: 'chrome_ball' | 'grey_ball'): LightingRefJob[] =>
    refs
      .filter((r) => r.kind === kind)
      .map((r) => {
        if (!r.circle) throw new Error(`${r.name}: mark the ball’s circle first (step 1).`);
        return { id: r.id, circle: r.circle, frame: r.from === 'plate' ? r.frame : null, spec: r.from === 'plate' ? null : pictureSpec(project, shotId, r) };
      });
  const h = refs.find((r) => r.kind === 'hdri');
  const size = sizeFor(src.spec.plate);
  return {
    io,
    job: {
      io,
      frames,
      plate: src.spec.plate,
      ...size,
      subject: doc?.settings.subject ?? 'auto',
      useSky: doc?.settings.useSky ?? true,
      references: { chrome: balls('chrome_ball'), grey: balls('grey_ball'), hdri: h ? { id: h.id, spec: pictureSpec(project, shotId, h), headingDeg: h.headingDeg } : null },
      priors,
      ground,
      whiteBalance,
      revision: doc?.revision ?? 0,
    },
  };
}

export async function lightingAnalyse(
  project: Project,
  req: { shotId: string; projectKey: string },
  outputRoot: string | null,
  env: LightingEnv,
  o: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<LightingAnalysisInput> {
  const { job } = await analyseJob(project, req.shotId, req.projectKey, outputRoot, env);
  const out = await runLightingJob({ type: 'analyse', job }, { workerFile: env.workerFile, ...(o.signal ? { signal: o.signal } : {}), ...(o.onProgress ? { onProgress: o.onProgress } : {}) });
  if (!out.analysis) throw new Error('The analysis produced nothing');
  return out.analysis;
}

export const LIGHTING_DEFAULT_FORMATS: LightingExportFormat[] = ['unreal', 'json', 'usd', 'blender', 'report'];

export async function lightingExport(
  project: Project,
  req: { shotId: string; projectKey: string; operator: string; formats: LightingExportFormat[]; text: string },
  outputRoot: string,
  env: LightingEnv,
  o: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void; now?: Date } = {},
): Promise<LightingExportOutcome> {
  // Never under the source paths (§19): the output root is checked against every camera file and every reference.
  const problem = outputRootProblem(outputRoot, [...sourceFiles(project), ...lightingReferenceFiles(project)]);
  if (problem) throw new Error(problem.replace('a source media folder', 'a source media or reference folder'));
  const state = shotState(project, req.shotId);
  const shot = handoffShot(project, req.shotId);
  if (!state || !shot) throw new Error(`No shot ${req.shotId}`);
  const doc = docOf(project, req.shotId);
  const exportProblem = lightingExportProblem(doc);
  if (exportProblem || !doc) throw new Error(exportProblem ?? 'Analyse the frame first (step 2).');
  const task = state.tasks.find((t) => t.kind === LIGHTING_TASK);
  if (!task) throw new Error('This shot has no Lighting and lens analysis task.');
  const version = task.version;
  const name = state.vfxShotId ?? shot.shotId;
  const folderName = lightingNames.folder(name, version);
  const folder = join(shotFolder(project, req.shotId, outputRoot), '09_PROJECT_DATA', folderName);
  if (task.state === 'approved' && (await stat(join(folder, lightingNames.rig(lightingNames.stem(name, version)))).catch(() => null))) {
    throw new Error(`The light rig ${versionTag(version)} is approved and already written; it is never rewritten. Reopen it to make a new version.`);
  }
  const formats = [...new Set<LightingExportFormat>(['json', ...req.formats])];
  const src = await plateSource(project, req.shotId, outputRoot, env);
  const io = src.ok ? await lightingIOJob(project, req.shotId, outputRoot, { ffmpeg: env.ffmpeg!, caps: env.caps }, src) : null;
  const frame = doc.analysis?.frame ?? (src.ok ? lightingFrames(doc, src.spec.first, src.spec.last)[0]! : null);
  const plate = src.ok ? src.spec.plate : (shot.resolution ?? { width: 1920, height: 1080 });
  const { pose, units, upAxis } = await cameraPriors(project, req.shotId, frame ?? 0, doc, env, req.projectKey, plate);
  const hdriRef = doc.references.find((r) => r.kind === 'hdri');
  const hdriAbs = hdriRef ? lightingReferenceFile(project, req.shotId, hdriRef) : null;
  const scaleTo = Math.min(1, 960 / plate.width);
  const out = await runLightingJob(
    {
      type: 'export',
      job: {
        projectText: req.text,
        shotId: req.shotId,
        io,
        frame,
        frameSize: { width: Math.round(plate.width * scaleTo), height: Math.round(plate.height * scaleTo) },
        scene: { solve: pose ? { position: pose.position, rotation: pose.rotation, units, upAxis } : null, width: plate.width, height: plate.height, pitchDeg: doc.analysis?.tilt.pitchDeg ?? 0, rollDeg: doc.analysis?.tilt.rollDeg ?? 0, subjectCentre: doc.analysis?.subject.centre ?? null },
        folder,
        shot: name,
        version,
        approved: task.state === 'approved',
        formats,
        generator: env.generator,
        writtenAt: (o.now ?? new Date()).toISOString(),
        operator: req.operator,
        gamut: src.ok && src.space.encoding === 'linear_rec709' ? 'rec709' : 'ap1',
        hdri: hdriAbs ? slash(relative(folder, hdriAbs)) : null,
      },
    },
    { workerFile: env.workerFile, ...(o.signal ? { signal: o.signal } : {}), ...(o.onProgress ? { onProgress: o.onProgress } : {}) },
  );
  const exported = out.exported;
  if (!exported) throw new Error('The export produced nothing');
  const record: LightingExportInput = {
    version,
    folder: `09_PROJECT_DATA/${folderName}`,
    files: exported.files,
    formats,
    lights: exported.lights,
    camera: exported.camera,
    revision: doc.revision,
    editRevision: doc.editRevision,
    algorithm: `${doc.algorithm.id}@${doc.algorithm.version}`,
  };
  return { record, folder, files: exported.files.length };
}

/** Ask the AI assistant for a second opinion (only with the artist's consent to let AI see frames of this project). */
export async function lightingAiReview(project: Project, req: { shotId: string; projectKey: string; jobId: string; note?: string }, outputRoot: string | null, env: LightingEnv, o: { signal?: AbortSignal } = {}): Promise<LightingAiReviewInput> {
  if (!env.ai) throw new Error('The AI review is not available in this build.');
  if (!(await env.ai.signedIn())) throw new Error('Sign in (VC VFX › Account) to ask the AI assistant.');
  if (!(await env.ai.framesAllowed(req.projectKey))) throw new Error('Allow AI to see frames of this project first (the AI panel’s switch): the review sends one downscaled frame.');
  const doc = docOf(project, req.shotId);
  if (!doc?.analysis) throw new Error('Analyse the frame first (step 2): the review looks at the estimate.');
  const src = await plateSource(project, req.shotId, outputRoot, env);
  if (!src.ok) throw new Error(src.reason);
  const io = createLightingIO(await lightingIOJob(project, req.shotId, outputRoot, { ffmpeg: env.ffmpeg!, caps: env.caps }, src), o.signal);
  const w = Math.min(768, src.spec.plate.width);
  const h = Math.round((src.spec.plate.height * w) / src.spec.plate.width);
  const img = await io.frame(doc.analysis.frame, w, h);
  const rgb = toDisplay(img.data, w * h, workingSpace(src.space.encoding));
  const data = env.ai.jpeg(rgb, w, h);
  const state = shotState(project, req.shotId)!;
  return runLightingReview(env.ai.model, reviewRequest(doc, { mediaType: 'image/jpeg', data }, state.vfxShotId ?? req.shotId, req.jobId, req.note), o.signal);
}

export { lightingTaskVersion };
