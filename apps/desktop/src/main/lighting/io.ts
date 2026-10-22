import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveCompSource, shotState, type ColorEncodingId, type CompSource, type Project } from '@vcvfx/domain';
import type { FfmpegCaps } from '../../shared/ffmpeg-args';
import { convertLinear, workingSpace, type LinearImage } from '../../shared/key/linear';
import { keyFrameSource, type KeySourceResult } from '../key/frames';
import { shotFolder } from '../package-shot';
import { isSampleHandoff, resolveFromHandoff } from '../paths';
import { createCompIO, sourceKey, type CompFileSource, type CompIOJob } from '../comp/io';
import { readPicture } from '../texture/io';

/**
 * Where the lighting analysis reads from (addendum 14 §4): the plate as the
 * other modules read it, and the mattes the modules exported — the roto
 * matte, the background removal's matte, the key's alpha (the subject), the
 * sky's matte — through the compositor's reader (the same files a vendor
 * receives). References (balls in stills, the HDRI) through the texture
 * reader, decoded to the plate's linear working space. Everything is only
 * read. Plain data, so the worker can rebuild it.
 */

export const LIGHTING_SUBJECT_SOURCES: readonly CompSource[] = ['roto', 'bg_matte', 'key_alpha'];

export interface LightingIOJob {
  comp: CompIOJob;
  /** Which matte sources resolved (in order of preference), and the sky matte. */
  subject: { source: CompSource; label: string }[];
  sky: { source: CompSource; label: string } | null;
}

export async function plateSource(project: Project, shotId: string, outputRoot: string | null, tools: { ffmpeg: string | null; caps: FfmpegCaps }): Promise<KeySourceResult> {
  if (isSampleHandoff(project.handoffPath)) return { ok: false, reason: 'The sample project has no media on disk. Open a real handoff to analyse its lighting.' };
  if (!tools.ffmpeg) return { ok: false, reason: 'The lighting analysis reads frames with ffmpeg, and none was found. Reinstall VC VFX or set ffmpeg in Settings.' };
  return keyFrameSource(project, shotId, outputRoot, { ffmpeg: tools.ffmpeg, caps: tools.caps });
}

/** The plate and every matte the shot has exported, ready for the reader. */
export async function lightingIOJob(project: Project, shotId: string, outputRoot: string | null, tools: { ffmpeg: string; caps: FfmpegCaps }, src: Extract<KeySourceResult, { ok: true }>): Promise<LightingIOJob> {
  const state = shotState(project, shotId)!;
  const shotDir = outputRoot ? shotFolder(project, shotId, outputRoot) : null;
  const sources: Record<string, CompFileSource> = {};
  const found: { source: CompSource; label: string }[] = [];
  let sky: { source: CompSource; label: string } | null = null;
  for (const source of [...LIGHTING_SUBJECT_SOURCES, 'sky_matte' as const]) {
    const r = resolveCompSource(project, shotId, source, '');
    if (!r.ok || r.folder === null || !shotDir) continue;
    const abs = join(shotDir, ...r.folder.split('/'), r.file);
    const probe = r.still ? abs : abs.replace(/%0(\d+)d/, (_m, d: string) => String(r.first ?? src.spec.first).padStart(Number(d), '0'));
    const st = await stat(probe).catch(() => null);
    if (!st) continue;
    sources[sourceKey(source, '')] = { file: abs, still: r.still, kind: r.kind, first: r.first, last: r.last, format: r.format, version: `${r.version ?? ''}|${st.mtimeMs}` };
    if (source === 'sky_matte') sky = { source, label: r.label };
    else found.push({ source, label: r.label });
  }
  return { comp: { ffmpeg: tools.ffmpeg, caps: tools.caps, plate: src.spec, space: src.space, sources, tracks: state.track2d?.tracks ?? [] }, subject: found, sky };
}

/** The analysis' reader: a plate frame (linear working RGB) and a matte (0 … 1) at a size. */
export function createLightingIO(job: LightingIOJob, signal?: AbortSignal) {
  const io = createCompIO(job.comp, signal);
  return {
    async frame(f: number, width: number, height: number): Promise<LinearImage> {
      const rgba = await io.source('plate', '', f, width, height);
      const data = new Float32Array(width * height * 3);
      for (let i = 0; i < width * height; i += 1) {
        data[3 * i] = rgba.data[4 * i]!;
        data[3 * i + 1] = rgba.data[4 * i + 1]!;
        data[3 * i + 2] = rgba.data[4 * i + 2]!;
      }
      return { width, height, data };
    },
    async matte(source: CompSource, f: number, width: number, height: number): Promise<Float32Array | null> {
      if (!job.comp.sources[sourceKey(source, '')]) return null;
      try {
        const rgba = await io.source(source, '', f, width, height);
        const out = new Float32Array(width * height);
        for (let i = 0; i < width * height; i += 1) out[i] = Math.max(0, Math.min(1, rgba.data[4 * i + 3]!));
        return out;
      } catch {
        return null;
      }
    },
  };
}

export interface LightingPictureSpec {
  file: string;
  encoding: ColorEncodingId | null;
  width: number;
  height: number;
}

/** A reference picture (a still with a ball, an HDRI) in the plate's linear working space, at most `maxLong` on its long edge. */
export async function readReferencePicture(ffmpeg: string, caps: FfmpegCaps, spec: LightingPictureSpec, plateEncoding: ColorEncodingId | null, maxLong: number | null, signal?: AbortSignal): Promise<LinearImage> {
  const k = maxLong && Math.max(spec.width, spec.height) > maxLong ? maxLong / Math.max(spec.width, spec.height) : 1;
  const size = { width: Math.max(16, Math.round(spec.width * k)), height: Math.max(8, Math.round(spec.height * k)) };
  // The texture reader decodes to ACEScg; bring it to the plate's working space when that is another linear space.
  const img = await readPicture(ffmpeg, caps, { file: spec.file, kind: 'photo', encoding: spec.encoding, width: spec.width, height: spec.height }, size, signal);
  const target = workingSpace(plateEncoding).encoding;
  return target && target !== 'acescg' ? convertLinear(img, 'acescg', target) : img;
}

export function referenceFile(project: Project, ref: { path: string; from: string }): string | null {
  if (ref.from === 'sample' || ref.from === 'plate') return null;
  if (ref.from === 'handoff') return resolveFromHandoff(project.handoffPath, ref.path);
  if (ref.from === 'texture') return null;
  return ref.path;
}
