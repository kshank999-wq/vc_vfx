import { existsSync } from 'node:fs';
import { extname } from 'node:path';
import type { CompKind, CompSource, Track2d } from '@vcvfx/domain';
import type { FfmpegCaps } from '../../shared/ffmpeg-args';
import type { CompIO } from '../../shared/comp/evaluate';
import { fromLinear, type RGBA } from '../../shared/comp/image';
import type { WorkingSpace } from '../../shared/key/linear';
import { LinearFrameReader, planesOf, readBackgroundFile, runRaw, type KeyFrameSpec } from '../key/frames';

/**
 * Where the compositor's sources come from on the desktop (addendum 13 §4):
 * the plate as the other modules read it (the newest plates, else the
 * source, decoded to linear by the colour module); every module output from
 * its export in the shot package (EXR read as the linear values it holds; a
 * PNG matte's grey as alpha); the background reference as the Key tab reads
 * it. Everything is only read. Plain data, so a worker thread can rebuild it.
 */

export interface CompFileSource {
  /** Absolute printf pattern, or a still's absolute path. */
  file: string;
  still: boolean;
  kind: CompKind;
  first: number | null;
  last: number | null;
  /** EXR (linear, as written), PNG (a matte's grey, or code values), other (an image through the background reader). */
  format: 'exr' | 'png' | 'other';
  /** Changes with the files (export version and time). */
  version: string;
}

export interface CompIOJob {
  ffmpeg: string;
  caps: FfmpegCaps;
  plate: KeyFrameSpec;
  space: WorkingSpace;
  /** By `${source}|${part}`. */
  sources: Record<string, CompFileSource>;
  tracks: Track2d[];
}

export const sourceKey = (source: CompSource, part: string) => `${source}|${part}`;

/**
 * One picture file → planar float at w × h: G, B, R (and A) planes. RGB files
 * are read as gbrpf32le and RGBA as gbrapf32le, never converted between the
 * two: ffmpeg's conversion from RGB to RGBA float clips values above 1.
 */
export async function readRgbaFile(ffmpeg: string, file: string, width: number, height: number, signal?: AbortSignal, withAlpha = true): Promise<Float32Array> {
  const fmt = withAlpha ? 'gbrapf32le' : 'gbrpf32le';
  const args = ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-frames:v', '1', '-vf', `scale=w=${width}:h=${height}:flags=bilinear,format=${fmt}`, '-f', 'rawvideo', '-pix_fmt', fmt, 'pipe:1'];
  let planes: Float32Array | null = null;
  await runRaw(ffmpeg, args, width * height * (withAlpha ? 16 : 12), 1, (_i, buf) => (planes = planesOf(buf)), signal);
  if (!planes) throw new Error(`Could not read ${file}`);
  return planes;
}

const frameFile = (pattern: string, frame: number) => pattern.replace(/%0(\d+)d/, (_m, n: string) => String(frame).padStart(Number(n), '0'));

export function createCompIO(job: CompIOJob, signal?: AbortSignal): CompIO {
  const readers = new Map<string, LinearFrameReader>();
  const stills = new Map<string, RGBA>();
  const n = (w: number, h: number) => w * h;
  return {
    plate: job.plate.plate,
    tracks: new Map(job.tracks.map((t) => [t.id, t])),
    sourceVersion: (source, part) => (source === 'plate' ? job.plate.label : (job.sources[sourceKey(source, part)]?.version ?? 'missing')),
    sourceStill: (source, part) => job.sources[sourceKey(source, part)]?.still ?? false,
    async source(source, part, frame, width, height) {
      if (source === 'plate') {
        const key = `${width}x${height}`;
        let r = readers.get(key);
        if (!r) {
          r = new LinearFrameReader(job.plate, { width, height }, { chunk: 4, keep: 8, ...(signal ? { signal } : {}) });
          readers.set(key, r);
        }
        return fromLinear(await r.frame(Math.max(job.plate.first, Math.min(job.plate.last, frame))));
      }
      const s = job.sources[sourceKey(source, part)];
      if (!s) throw new Error('its source is not available');
      const f = s.still ? null : Math.max(s.first ?? frame, Math.min(s.last ?? frame, frame));
      const file = f === null ? s.file : frameFile(s.file, f);
      const cacheKey = `${file}|${width}x${height}`;
      if (s.still && stills.has(cacheKey)) return stills.get(cacheKey)!;
      if (!existsSync(file)) throw new Error(`${file.split(/[\\/]/).pop()} is not on the drive (was the export moved?)`);
      let img: RGBA;
      if (s.format === 'other') {
        // A reference image: as the Key tab reads its background (an EXR as linear, anything else as sRGB).
        const exr = extname(file).toLowerCase() === '.exr';
        const lin = await readBackgroundFile({ ffmpeg: job.ffmpeg, caps: job.caps, file, frame: null, encoding: exr ? job.space.encoding : 'srgb', label: '' }, { width, height }, job.space, signal);
        if (!lin) throw new Error(`Could not read ${file}`);
        img = fromLinear(lin);
      } else {
        const withAlpha = s.kind === 'rgba';
        const planes = await readRgbaFile(job.ffmpeg, file, width, height, signal, withAlpha);
        const count = n(width, height);
        const data = new Float32Array(count * 4);
        const g = planes.subarray(0, count);
        const b = planes.subarray(count, 2 * count);
        const r = planes.subarray(2 * count, 3 * count);
        const a = withAlpha ? planes.subarray(3 * count, 4 * count) : null;
        if (s.kind === 'alpha') {
          for (let i = 0; i < count; i += 1) data.set([r[i]!, r[i]!, r[i]!, r[i]!], 4 * i);
        } else {
          for (let i = 0; i < count; i += 1) data.set([r[i]!, g[i]!, b[i]!, a ? a[i]! : 1], 4 * i);
        }
        img = { width, height, data };
      }
      if (s.still) {
        stills.set(cacheKey, img);
        if (stills.size > 8) stills.delete(stills.keys().next().value!);
      }
      return img;
    },
  };
}
