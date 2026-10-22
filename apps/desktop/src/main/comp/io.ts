import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { CompKind, CompSource, Track2d } from '@vcvfx/domain';
import type { FfmpegCaps } from '../../shared/ffmpeg-args';
import type { CompIO } from '../../shared/comp/evaluate';
import { fromLinear, type RGBA } from '../../shared/comp/image';
import type { WorkingSpace } from '../../shared/key/linear';
import { LinearFrameReader, planesOf, readBackgroundFile, runRaw, type KeyFrameSpec } from '../key/frames';
import { decodePng } from '../roto/png';

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

/** A grey PNG (8 or 16 bit) as a matte (m, m, m, m) at w × h, bilinear; null when it is not a grey PNG. */
export async function readGreyPng(file: string, width: number, height: number): Promise<RGBA | null> {
  let g: ReturnType<typeof decodePng>;
  try {
    g = decodePng(new Uint8Array(await readFile(file)));
  } catch {
    return null;
  }
  const max = g.bitDepth === 16 ? 65535 : 255;
  const src = Float32Array.from(g.data as ArrayLike<number>, (v) => v / max);
  const data = new Float32Array(width * height * 4);
  const sx = g.width / width;
  const sy = g.height / height;
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const fx = Math.max(0, Math.min(g.width - 1, (x + 0.5) * sx - 0.5));
      const fy = Math.max(0, Math.min(g.height - 1, (y + 0.5) * sy - 0.5));
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = Math.min(g.width - 1, x0 + 1);
      const y1 = Math.min(g.height - 1, y0 + 1);
      const tx = fx - x0;
      const ty = fy - y0;
      const v = (src[y0 * g.width + x0]! * (1 - tx) + src[y0 * g.width + x1]! * tx) * (1 - ty) + (src[y1 * g.width + x0]! * (1 - tx) + src[y1 * g.width + x1]! * tx) * ty;
      data.set([v, v, v, v], 4 * (y * width + x));
    }
  return { width, height, data };
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
      let img: RGBA | null = null;
      if (s.format === 'other') {
        // A reference image: as the Key tab reads its background (an EXR as linear, anything else as sRGB).
        const exr = extname(file).toLowerCase() === '.exr';
        const lin = await readBackgroundFile({ ffmpeg: job.ffmpeg, caps: job.caps, file, frame: null, encoding: exr ? job.space.encoding : 'srgb', label: '' }, { width, height }, job.space, signal);
        if (!lin) throw new Error(`Could not read ${file}`);
        img = fromLinear(lin);
      } else if (s.format === 'png' && s.kind === 'alpha' && (img = await readGreyPng(file, width, height))) {
        // The modules' mattes are grey PNGs, decoded here: ffmpeg's grey → planar float RGB conversion is not
        // reliable (6.1 sends grey through a YUV path with the wrong chroma offset).
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
