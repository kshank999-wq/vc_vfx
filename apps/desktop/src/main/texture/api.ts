import { existsSync } from 'node:fs';
import { open, stat, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import {
  TEXTURE_TASK,
  TEXTURE_UNIT_METRES,
  findLensProfile,
  handoffShot,
  pixelAspectOf,
  shotState,
  textureBuildProblem,
  textureDoc,
  textureMetadata,
  textureNames,
  textureTaskVersion,
  versionTag,
  type Project,
  type TextureCamera,
  type TextureDocument,
  type TextureExportInput,
  type TextureReference,
  type TextureReferenceInput,
  type TextureReferenceKind,
  type TextureRunResult,
} from '@vcvfx/domain';
import type { FfmpegCaps } from '../../shared/ffmpeg-args';
import type { TextureExportOutcome, TextureHandoffReference, TextureImageRequest, TextureImageView, TextureIngestSource, TextureScanView, TextureSessionInfo } from '../../shared/texture/bridge-types';
import { cameraFromExif, parseExif } from '../../shared/texture/exif';
import { scanViewOf } from '../../shared/texture/scan-view';
import { TEXTURE_SPACE, shrinkRgb, srgb8 } from '../../shared/texture/view';
import type { PointCloud } from '../../shared/camera/lidar';
import { sha256File } from '../hash';
import { cameraRawProblem } from '../image-sequence';
import { shotFolder, sourceFiles } from '../package-shot';
import { isSampleHandoff, outputRootProblem, resolveFromHandoff } from '../paths';
import { probeSize } from '../roto/frames';
import { TextureCache } from './cache';
import { readPicture, readScan, type TextureIOJob } from './io';
import type { TextureExportResult } from './export';
import { runTextureJob } from './service';

/**
 * The main-process side of texture extraction (addendum 12), called by
 * ipc-texture.ts. No Electron here: where things live is passed in, so it is
 * tested against a temporary folder with the real ffmpeg. References are only
 * ever read: checksummed and measured on ingest, decoded for a build, never
 * written to.
 */

export interface TextureEnv {
  ffmpeg: string | null;
  caps: FfmpegCaps;
  /** userData/Texture Cache (built textures for review). */
  cacheRoot: string;
  /** The built worker (out/main/texture-worker.js). */
  workerFile: string;
  generator: string;
}

const noFfmpeg = 'Texture extraction reads the photos with ffmpeg, and none was found. Reinstall VC VFX or set ffmpeg in Settings.';
const KIND_OF: Partial<Record<string, TextureReferenceKind>> = { reference_photo: 'photo', panorama: 'panorama', hdri: 'panorama', lidar: 'scan', survey: 'scan' };
const PICTURE_EXT = new Set(['jpg', 'jpeg', 'png', 'tif', 'tiff', 'exr', 'hdr', 'dpx', 'webp']);
const SCAN_EXT = new Set(['e57', 'ply', 'las', 'obj', 'xyz', 'pts', 'csv', 'txt']);

/** Where a reference is on disk (null for the sample's). */
export function referenceFile(project: Project, ref: Pick<TextureReference, 'path' | 'from'>): string | null {
  if (ref.from === 'sample') return null;
  if (ref.from === 'handoff') return resolveFromHandoff(project.handoffPath, ref.path);
  return ref.path;
}

/** Every reference file of every shot: what an output root must stay out of, as the media. */
export function referenceFiles(project: Project): string[] {
  return project.shots.flatMap((s) => (s.texture?.references ?? []).map((r) => referenceFile(project, r)).filter((p): p is string => p !== null));
}

function docOf(project: Project, shotId: string): TextureDocument {
  const doc = textureDoc(shotState(project, shotId));
  if (!doc) throw new Error('Add the references first (step 1).');
  return doc;
}

export function textureIOJob(project: Project, doc: TextureDocument, env: TextureEnv): TextureIOJob {
  if (!env.ffmpeg) throw new Error(noFfmpeg);
  const files: TextureIOJob['files'] = {};
  for (const r of doc.references) {
    const file = referenceFile(project, r);
    if (!file) throw new Error(`${r.name} is the sample's: the sample project has no references on a drive.`);
    if (!existsSync(file)) throw new Error(`${r.name} is not on the drive (${file}).`);
    files[r.id] = { file, kind: r.kind, encoding: r.encoding, width: r.width, height: r.height };
  }
  return { ffmpeg: env.ffmpeg, caps: env.caps, files };
}

export async function textureSession(project: Project, shotId: string, env: TextureEnv): Promise<TextureSessionInfo> {
  const state = shotState(project, shotId);
  const shot = handoffShot(project, shotId);
  if (!state || !shot) throw new Error(`No shot ${shotId}`);
  const empty: TextureSessionInfo = { available: false, reason: null, exportable: false, fromDisk: false, handoff: [], references: [], working: { label: TEXTURE_SPACE.label, linear: true } };
  if (!state.tasks.some((t) => t.kind === TEXTURE_TASK)) return { ...empty, reason: 'This shot has no Texture extraction task. Add it to work on it here.' };
  if (isSampleHandoff(project.handoffPath)) return { ...empty, reason: 'The sample project has no references on a drive. Open a real handoff to extract textures.' };
  if (!env.ffmpeg) return { ...empty, reason: noFfmpeg };
  const handoff: TextureHandoffReference[] = shot.references
    .filter((r) => KIND_OF[r.kind])
    // One file named twice (a 360 listed as the panorama and as the HDRI) is one reference.
    .filter((r, i, all) => all.findIndex((o) => o.path === r.path && KIND_OF[o.kind]) === i)
    .map((r) => {
      const file = resolveFromHandoff(project.handoffPath, r.path);
      return { kind: KIND_OF[r.kind]!, path: r.path, name: basename(r.path), onDisk: Boolean(file && existsSync(file)) };
    });
  const references = await Promise.all(
    (state.texture?.references ?? []).map(async (r) => {
      const file = referenceFile(project, r);
      const st = file ? await stat(file).catch(() => null) : null;
      return { id: r.id, onDisk: Boolean(st), changed: Boolean(st && r.bytes !== null && st.size !== r.bytes) };
    }),
  );
  return { available: true, reason: null, exportable: true, fromDisk: true, handoff, references, working: { label: TEXTURE_SPACE.label, linear: true } };
}

async function headBytes(file: string, n: number): Promise<Uint8Array> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return new Uint8Array(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

/**
 * Read references without touching them: the file's sha256 and size, a
 * picture's pixel size and (from EXIF) its camera, with the project's lens
 * profile for that lens when there is one; a scan's point count. The
 * renderer records each with `addTextureReference`.
 */
export async function textureIngest(
  project: Project,
  shotId: string,
  kind: TextureReferenceKind,
  sources: readonly TextureIngestSource[],
  env: TextureEnv,
  o: { signal?: AbortSignal; onProgress?: (done: number, total: number, detail?: string) => void } = {},
): Promise<TextureReferenceInput[]> {
  if (!shotState(project, shotId)?.tasks.some((t) => t.kind === TEXTURE_TASK)) throw new Error('This shot has no Texture extraction task.');
  if (kind !== 'scan' && !env.ffmpeg) throw new Error(noFfmpeg);
  const out: TextureReferenceInput[] = [];
  let i = 0;
  for (const src of sources) {
    o.onProgress?.(i, sources.length, basename(src.path));
    if (o.signal?.aborted) throw new Error('Cancelled');
    if (src.from === 'sample') throw new Error('The sample set lives in the browser preview.');
    const file = src.from === 'handoff' ? resolveFromHandoff(project.handoffPath, src.path) : src.path;
    if (!file || !existsSync(file)) throw new Error(`${src.path} is not on the drive.`);
    const ext = extname(file).slice(1).toLowerCase();
    if (kind !== 'scan') {
      if (cameraRawProblem(file)) throw new Error(`${basename(file)} is camera raw: convert it to TIFF or EXR first; VC VFX reads the result.`);
      if (!PICTURE_EXT.has(ext)) throw new Error(`${basename(file)}: not a picture VC VFX reads (JPEG, PNG, TIFF, EXR, HDR, DPX).`);
    } else if (!SCAN_EXT.has(ext)) throw new Error(`${basename(file)}: not a scan VC VFX reads (E57, PLY, LAS, OBJ, XYZ, PTS, CSV).`);
    const { sha256, bytes } = await sha256File(file, { ...(o.signal ? { signal: o.signal } : {}) });
    const base = { name: basename(file), path: src.from === 'handoff' ? src.path : file, from: src.from, format: ext, checksum: { algorithm: 'sha256' as const, value: sha256 }, bytes };
    if (kind === 'scan') {
      const cloud = await readScan(file);
      out.push({ ...base, kind, width: null, height: null, points: cloud.count, encoding: null, scan: { units: 'm', up: ext === 'obj' || ext === 'ply' ? 'y' : 'z' } });
    } else {
      const size = await probeSize(env.ffmpeg!, file);
      let camera: Partial<TextureCamera> | null = null;
      if (['jpg', 'jpeg', 'tif', 'tiff'].includes(ext)) camera = cameraFromExif(parseExif(await headBytes(file, 256 * 1024)));
      if (camera) {
        const profile = findLensProfile(project.lensProfiles, { lens: camera.lens ?? '', focalMm: camera.focalMm ?? null });
        if (profile) camera = { ...camera, distortion: profile.distortion, lensProfileId: profile.id };
      }
      const linear = ext === 'exr' || ext === 'hdr';
      // Pixel aspect (addendum 17): a frame of the shot's own clip has the shot's; else what the file's header says.
      const aspect = referencePixelAspect(project, shotId, file, size);
      out.push({ ...base, kind, width: size.width, height: size.height, points: null, encoding: linear ? 'linear_rec709' : 'srgb', camera, ...aspect });
    }
    i += 1;
  }
  o.onProgress?.(sources.length, sources.length);
  return out;
}

/**
 * A picture's pixel aspect on ingest: the shot's when the file is in the
 * folder of the shot's source (a frame of its own clip, the same size), else
 * the file's own sample aspect, else square (a still).
 */
export function referencePixelAspect(project: Project, shotId: string, file: string, size: { width: number; height: number; sampleAspect?: number }): { pixelAspect: number | null; pixelAspectFrom: 'shot' | 'file' | null } {
  const shot = handoffShot(project, shotId);
  const source = shot ? resolveFromHandoff(project.handoffPath, shot.sourcePath) : null;
  const res = shot?.resolution ?? shotState(project, shotId)?.probe?.resolution ?? null;
  const sameFolder = source ? dirname(resolve(source)) === dirname(resolve(file)) || resolve(source) === resolve(file) : false;
  const sameSize = !res || (res.width === size.width && res.height === size.height);
  if (sameFolder && sameSize) {
    const a = pixelAspectOf(project, shotId);
    if (a !== 1) return { pixelAspect: a, pixelAspectFrom: 'shot' };
  }
  if (size.sampleAspect && Math.abs(size.sampleAspect - 1) > 1e-3) return { pixelAspect: size.sampleAspect, pixelAspectFrom: 'file' };
  return { pixelAspect: null, pixelAspectFrom: null };
}

/** The newest build of this task version and whether it used the settings as they are now. */
function lastRun(doc: TextureDocument, version: number) {
  const run = doc.runs.filter((r) => r.taskVersion === version).at(-1) ?? null;
  return { run, built: run ? (run.revision === doc.revision ? ('current' as const) : ('stale' as const)) : ('none' as const) };
}

const pictureCache = new Map<string, { width: number; height: number; rgb: Uint8ClampedArray }>();

export async function textureImage(project: Project, req: { shotId: string; projectKey: string; request: TextureImageRequest }, env: TextureEnv): Promise<TextureImageView> {
  const state = shotState(project, req.shotId);
  if (!state) throw new Error(`No shot ${req.shotId}`);
  const doc = docOf(project, req.shotId);
  const r = req.request;
  if (r.kind === 'reference') {
    const ref = doc.references.find((x) => x.id === r.id);
    if (!ref || ref.kind === 'scan' || !ref.width || !ref.height) throw new Error(`No picture ${r.id}`);
    const file = referenceFile(project, ref);
    if (!file || !existsSync(file)) throw new Error(`${ref.name} is not on the drive.`);
    if (!env.ffmpeg) throw new Error(noFfmpeg);
    const k = Math.min(1, r.maxWidth / ref.width);
    const size = { width: Math.max(16, Math.round(ref.width * k)), height: Math.max(16, Math.round(ref.height * k)) };
    const key = JSON.stringify([file, ref.encoding, size, ref.checksum?.value ?? null]);
    let pic = pictureCache.get(key);
    if (!pic) {
      const img = await readPicture(env.ffmpeg, env.caps, { file, kind: ref.kind, encoding: ref.encoding, width: ref.width, height: ref.height }, size);
      pic = srgb8(img, size.width);
      pictureCache.set(key, pic);
      while (pictureCache.size > 6) pictureCache.delete(pictureCache.keys().next().value!);
    }
    return { ...pic, mask: null, built: 'none', label: `${ref.name} · ${ref.encoding ?? 'srgb'} → sRGB, for viewing` };
  }
  const version = textureTaskVersion(state);
  const { run, built } = lastRun(doc, version);
  if (!run) throw new Error('Build the textures (step 3) to see them here.');
  const cached = await new TextureCache(env.cacheRoot, req.projectKey, req.shotId).getRegion(version, run.revision, r.regionId);
  if (!cached) throw new Error('This region has not been built yet: build again (step 3).');
  const pic = r.stage === 'tiled' ? (cached.tiled ?? cached.delit) : r.stage === 'delit' ? cached.delit : cached.original;
  const shown = shrinkRgb(pic, r.maxWidth);
  const maskFits = cached.maskWidth === shown.width && cached.maskHeight === shown.height;
  return { ...shown, mask: maskFits ? cached.mask : null, built, label: `${TEXTURE_SPACE.label} → sRGB (the texture view)` };
}

const scanCache = new Map<string, PointCloud>();

export async function textureScan(project: Project, req: { shotId: string; projectKey: string }, env: TextureEnv): Promise<TextureScanView | null> {
  const state = shotState(project, req.shotId);
  const doc = textureDoc(state);
  if (!state || !doc) return null;
  const scan = doc.references.find((r) => r.kind === 'scan');
  if (!scan?.scan) return null;
  const version = textureTaskVersion(state);
  const { run, built } = lastRun(doc, version);
  if (run) {
    const cached = await new TextureCache(env.cacheRoot, req.projectKey, req.shotId).getScan(version, run.revision);
    if (cached) return { ...cached, built };
  }
  const file = referenceFile(project, scan);
  if (!file || !existsSync(file)) return null;
  let cloud = scanCache.get(file);
  if (!cloud) {
    cloud = await readScan(file);
    scanCache.set(file, cloud);
    while (scanCache.size > 2) scanCache.delete(scanCache.keys().next().value!);
  }
  return { ...scanViewOf(cloud, { up: scan.scan.up, planes: [], threshold: 0.03 / TEXTURE_UNIT_METRES[scan.scan.units], panorama: null, patches: [] }), built: 'none' };
}

export async function textureBuild(
  project: Project,
  req: { shotId: string; projectKey: string },
  env: TextureEnv,
  o: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<TextureRunResult> {
  const state = shotState(project, req.shotId);
  if (!state) throw new Error(`No shot ${req.shotId}`);
  const doc = docOf(project, req.shotId);
  const problem = textureBuildProblem(doc);
  if (problem) throw new Error(problem);
  const out = await runTextureJob(
    {
      type: 'build',
      job: { io: textureIOJob(project, doc, env), references: doc.references, regions: doc.regions, placements: doc.placements, revision: doc.revision, workingWidth: doc.workingWidth, luma: TEXTURE_SPACE.luma, cache: new TextureCache(env.cacheRoot, req.projectKey, req.shotId).root, version: textureTaskVersion(state) },
    },
    { workerFile: env.workerFile, ...(o.signal ? { signal: o.signal } : {}), ...(o.onProgress ? { onProgress: o.onProgress } : {}) },
  );
  if (!out.result) throw new Error('The build produced nothing');
  return out.result;
}

export async function textureExport(
  project: Project,
  req: { shotId: string; projectKey: string; operator: string },
  outputRoot: string,
  env: TextureEnv,
  o: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void; now?: Date } = {},
): Promise<TextureExportOutcome> {
  // Never under the source paths (§19): the output root is checked against every camera file and every reference.
  const problem = outputRootProblem(outputRoot, [...sourceFiles(project), ...referenceFiles(project)]);
  if (problem) throw new Error(problem.replace('a source media folder', 'a source media or reference folder'));
  const state = shotState(project, req.shotId);
  const shot = handoffShot(project, req.shotId);
  if (!state || !shot) throw new Error(`No shot ${req.shotId}`);
  const doc = docOf(project, req.shotId);
  const buildProblem = textureBuildProblem(doc);
  if (buildProblem) throw new Error(buildProblem);
  const task = state.tasks.find((t) => t.kind === TEXTURE_TASK);
  if (!task) throw new Error('This shot has no Texture extraction task.');
  const version = task.version;
  const name = state.vfxShotId ?? shot.shotId;
  const base = join(shotFolder(project, req.shotId, outputRoot), '07_TEXTURES_REFERENCES');
  const folderName = textureNames.folder(name, version);
  const folder = join(base, folderName);
  const mappingName = textureNames.mapping(name, version);
  if (task.state === 'approved' && (await stat(join(folder, mappingName)).catch(() => null))) {
    throw new Error(`Textures ${versionTag(version)} are approved and already written; they are never rewritten. Reopen them to make a new version.`);
  }
  await mkdir(base, { recursive: true });
  const out = await runTextureJob(
    {
      type: 'export',
      job: { io: textureIOJob(project, doc, env), references: doc.references, regions: doc.regions, placements: doc.placements, revision: doc.revision, shot: name, version, approved: task.state === 'approved', folder, generator: env.generator, luma: TEXTURE_SPACE.luma },
    },
    { workerFile: env.workerFile, ...(o.signal ? { signal: o.signal } : {}), ...(o.onProgress ? { onProgress: o.onProgress } : {}) },
  );
  const exported = out.exported;
  if (!exported) throw new Error('The export produced nothing');
  const at = (o.now ?? new Date()).toISOString();
  const scan = doc.references.find((r) => r.kind === 'scan');
  // The mapping file describes the textures as written: the build's planes and placements are the ones the export used.
  const forMeta: Project = {
    ...project,
    shots: project.shots.map((s) => (s.shotId === req.shotId ? { ...s, texture: { ...doc, planes: exported.planes, records: exported.regions.map((r) => ({ regionId: r.id, confidence: r.confidence, metrics: r.metrics, status: doc.records.find((x) => x.regionId === r.id)?.status ?? 'processed', reason: doc.records.find((x) => x.regionId === r.id)?.reason ?? '', reviewed: doc.records.find((x) => x.regionId === r.id)?.reviewed ?? null, note: '' })) } } : s)),
  };
  const meta = textureMetadata(forMeta, req.shotId, {
    version,
    encoding: TEXTURE_SPACE.label,
    linear: true,
    format: 'exr',
    generator: env.generator,
    writtenAt: at,
    by: req.operator,
    regions: exported.regions.map((r) => ({ id: r.id, homography: r.homography, undistorted: r.undistorted, width: r.width, height: r.height, texelDensity: r.texelDensity, patch: r.patch, files: { map: r.map, exr: r.mapExr, original: r.original, tilePreview: r.tilePreview, mask: r.mask }, metrics: r.metrics, confidence: r.confidence })),
    obj: exported.obj,
    mtl: exported.mtl,
    scanFrame: scan?.scan ? { units: scan.scan.units, up: scan.scan.up } : null,
  });
  await writeFile(join(folder, mappingName), `${JSON.stringify(meta, null, 2)}\n`);
  await writeFile(join(folder, textureNames.readme()), readme(name, version, exported, task.state === 'approved'));
  const values = exported.regions.map((r) => r.confidence);
  const record: TextureExportInput = {
    version,
    folder: `07_TEXTURES_REFERENCES/${folderName}`,
    regions: exported.regions.map((r) => ({ id: r.id, name: r.name, map: r.map, mapExr: r.mapExr, original: r.original, tilePreview: r.tilePreview, mask: r.mask, width: r.width, height: r.height, planeId: r.planeId })),
    mapping: mappingName,
    obj: exported.obj,
    mtl: exported.mtl,
    format: 'exr',
    encoding: TEXTURE_SPACE.label,
    summary: {
      regions: exported.regions.length,
      mean: values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1000) / 1000 : 0,
      min: values.length ? Math.min(...values) : 0,
      low: exported.regions.filter((r) => r.confidence < 0.6).map((r) => r.id),
    },
    algorithm: `${doc.algorithm.id}@${doc.algorithm.version}`,
    revision: doc.revision,
    files: exported.files.length + 2,
  };
  return { record, folder, files: record.files };
}

function readme(shot: string, version: number, e: TextureExportResult, approved: boolean): string {
  const v = versionTag(version);
  return [
    `${shot} textures ${v} — VC VFX`,
    '',
    'What is here (per region)',
    '  <shot>_tex_<region>_vNNN.png        the texture, 16-bit sRGB: what a 3D package shows in its viewport.',
    '  <shot>_tex_<region>_vNNN.exr        the same texture, RGB half-float, scene-linear ACEScg. No look, no grade.',
    '  <shot>_tex_<region>_vNNN_orig.png   the region before the light was flattened (rectified, exposure matched).',
    '  <shot>_tex_<region>_vNNN_tile3x3.png  the tile repeated three by three (regions made to tile).',
    '  <shot>_tex_<region>_vNNN_mask.png   white where the texture came from inside the photo.',
    '',
    `  ${textureNames.mapping(shot, version)}   the mapping: each region's source photo and its corners, the homography`,
    '      photo → texture, the lens taken out, the real size and texel density, the scan plane it belongs on, the',
    '      panorama direction, the placement suggestions and the artist’s decisions, per-region confidence and its reasons.',
    e.obj ? `  ${e.obj} / ${e.mtl}   the planar patches with UVs, one object and material per region, in the scan's coordinates:` : null,
    e.obj ? '      import into Maya, Blender, Houdini or Unreal and the textures land on the scanned surfaces.' : null,
    '',
    'How it was made',
    '  Each region was undistorted (when the lens was known) and squared up from its four corners by a homography,',
    '  sampled bicubically; the large-scale light across it was divided out in linear light (fine detail kept);',
    '  regions of one surface were brought to one exposure; tiling regions were overlapped and joined along an optimal',
    '  seam with the light difference spread over the overlap. Placement: the panorama was projected onto the scan’s',
    '  planes and each region found there. The photos, the panorama and the scan were only read.',
    '',
    `${e.regions.length} texture${e.regions.length === 1 ? '' : 's'}: ${e.regions.map((r) => `${r.id} ${r.name} ${r.width}×${r.height}`).join(', ')}.`,
    approved ? `These textures (${v}) are approved.` : `These textures (${v}) are not approved yet: a prep deliverable for review.`,
    '',
  ]
    .filter((l) => l !== null)
    .join('\n');
}
