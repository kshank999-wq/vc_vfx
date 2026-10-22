import { readFile } from 'node:fs/promises';
import { ENCODINGS, type ColorEncodingId, type TextureReferenceKind } from '@vcvfx/domain';
import type { FfmpegCaps } from '../../shared/ffmpeg-args';
import { buildLinearFramesArgs } from '../../shared/key/ffmpeg-key';
import { convertLinear, decodePlanar, type LinearImage } from '../../shared/key/linear';
import { formatFromName, parsePointFile, type PointCloud } from '../../shared/camera/lidar';
import type { TextureIO } from '../../shared/texture/engine';
import { planesOf, runRaw } from '../key/frames';

/**
 * Reading texture references in the main process and its worker (addendum 12
 * §4): photos and panoramas through ffmpeg as float code values, decoded to
 * linear ACEScg with the colour module (a display-encoded still through its
 * curve and matrix, a linear EXR converted from its primaries); scans parsed
 * by the camera tracker's readers (PLY, E57, LAS, OBJ, XYZ, CSV). Every file
 * is opened read-only; nothing is ever written beside it.
 */

export interface TextureFileSpec {
  file: string;
  kind: TextureReferenceKind;
  encoding: ColorEncodingId | null;
  width: number | null;
  height: number | null;
}

export interface TextureIOJob {
  ffmpeg: string;
  caps: FfmpegCaps;
  /** By reference id. */
  files: Record<string, TextureFileSpec>;
}

/** A picture at `size` in linear ACEScg. */
export async function readPicture(ffmpeg: string, caps: FfmpegCaps, spec: TextureFileSpec, size: { width: number; height: number }, signal?: AbortSignal): Promise<LinearImage> {
  const native = size.width === spec.width && size.height === spec.height;
  // A still has one frame: no seek (a seek to 0 can skip a still's only frame).
  const args = buildLinearFramesArgs({ source: { kind: 'clip', path: spec.file }, frame: 0, frameRate: 24, count: 1, width: size.width, height: size.height, native, caps });
  const ss = args.indexOf('-ss');
  if (ss >= 0) args.splice(ss, 2);
  let img: LinearImage | null = null;
  // An unknown encoding is read as sRGB: a still's most likely one (the reference says so, and can be changed).
  const enc: ColorEncodingId = spec.encoding ?? 'srgb';
  await runRaw(ffmpeg, args, size.width * size.height * 12, 1, (_i, buf) => {
    let out = decodePlanar(planesOf(buf), size.width, size.height, enc);
    // A linear file in other primaries (a Rec.709 HDRI) is brought to ACEScg; display encodings already are.
    if (ENCODINGS[enc].kind === 'linear' && enc !== 'acescg') out = convertLinear(out, enc, 'acescg');
    img = out;
  }, signal);
  if (!img) throw new Error(`ffmpeg could not read ${spec.file}`);
  return img;
}

export async function readScan(file: string): Promise<PointCloud> {
  const format = formatFromName(file);
  if (!format) throw new Error(`${file}: not a scan VC VFX reads (PLY, E57, LAS, OBJ, XYZ, PTS or a survey CSV)`);
  return parsePointFile(new Uint8Array(await readFile(file)), format);
}

/** The engine's IO over the files of a job; the last few pictures read are kept. */
export function createTextureIO(job: TextureIOJob, signal?: AbortSignal): TextureIO {
  const pictures = new Map<string, LinearImage>();
  const scans = new Map<string, PointCloud>();
  return {
    signal,
    async picture(id, maxLong) {
      const spec = job.files[id];
      if (!spec || spec.kind === 'scan') throw new Error(`No picture ${id}`);
      if (!spec.width || !spec.height) throw new Error(`${spec.file}: its size is not known`);
      const k = maxLong && Math.max(spec.width, spec.height) > maxLong ? maxLong / Math.max(spec.width, spec.height) : 1;
      const size = { width: Math.max(16, Math.round(spec.width * k)), height: Math.max(16, Math.round(spec.height * k)) };
      const key = `${id}|${size.width}x${size.height}`;
      const hit = pictures.get(key);
      if (hit) return hit;
      const img = await readPicture(job.ffmpeg, job.caps, spec, size, signal);
      pictures.set(key, img);
      while (pictures.size > 3) pictures.delete(pictures.keys().next().value!);
      return img;
    },
    async scan(id) {
      const spec = job.files[id];
      if (!spec || spec.kind !== 'scan') throw new Error(`No scan ${id}`);
      let c = scans.get(id);
      if (!c) scans.set(id, (c = await readScan(spec.file)));
      return c;
    },
  };
}
