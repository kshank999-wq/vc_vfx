import { readdir } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

/**
 * Sources that are not one movie file (addendum 03).
 *
 * Camera raw (R3D, BRAW, ARRIRAW, Canon RAW, CinemaDNG, N-RAW) is refused:
 * ffmpeg either cannot decode it or cannot debayer it with the vendor's
 * colour science, and a plate made any other way would not match what
 * editorial and the grade see. VCDIT, or the vendor's tool, transcodes it to
 * ProRes 4444 XQ or EXR first; VC VFX reads the result.
 *
 * Image sequences (DPX, EXR, TIFF… as VCDIT mirrors them) are read with
 * ffmpeg's image2 demuxer: the handoff names the first frame, and the
 * sequence is the unbroken run of numbered files from it.
 */

export const CAMERA_RAW_EXTENSIONS = ['r3d', 'braw', 'ari', 'arx', 'crm', 'dng', 'nev'] as const;
export const CAMERA_RAW_MESSAGE = 'Camera raw — transcode to ProRes 4444 XQ or EXR in VCDIT (or the camera vendor’s tool) first; VC VFX reads the result.';

export const IMAGE_SEQUENCE_EXTENSIONS = ['dpx', 'exr', 'tif', 'tiff', 'png', 'jpg', 'jpeg', 'cin'] as const;

const ext = (path: string) => extname(path).slice(1).toLowerCase();

export function isCameraRaw(path: string): boolean {
  return (CAMERA_RAW_EXTENSIONS as readonly string[]).includes(ext(path));
}

/** The refusal for camera raw, or null. */
export function cameraRawProblem(path: string): string | null {
  return isCameraRaw(path) ? CAMERA_RAW_MESSAGE : null;
}

export function isImageSequenceFile(path: string): boolean {
  return (IMAGE_SEQUENCE_EXTENSIONS as readonly string[]).includes(ext(path));
}

export interface FrameName {
  prefix: string;
  number: number;
  padding: number;
  suffix: string;
}

/** `A001C002_0086400.dpx` → prefix `A001C002_`, 86400, padding 7, suffix `.dpx`. Null when it has no frame number. */
export function parseFrameName(name: string): FrameName | null {
  const m = /^(.*?)(\d+)(\.[A-Za-z0-9]+)$/.exec(name);
  if (!m) return null;
  const digits = m[2]!;
  return { prefix: m[1]!, number: Number(digits), padding: digits.length, suffix: m[3]! };
}

/** The printf pattern ffmpeg's image2 demuxer takes. A `%` in the name is doubled. */
export function printfPattern(f: Pick<FrameName, 'prefix' | 'padding' | 'suffix'>): string {
  const esc = (s: string) => s.replace(/%/g, '%%');
  return `${esc(f.prefix)}%0${f.padding}d${esc(f.suffix)}`;
}

export interface ImageSequence {
  /** Absolute printf pattern. */
  pattern: string;
  /** The frame number of the named (first) file. */
  startNumber: number;
  /** Unbroken files from startNumber on. */
  count: number;
  padding: number;
  /** The first missing number after the run, when files continue past a gap. */
  gapAt: number | null;
}

/** Same-named numbered files around `file`, as an image sequence; null when `file` is not part of one. */
export function sequenceFromNames(file: string, names: readonly string[]): Omit<ImageSequence, 'pattern'> & { patternName: string } | null {
  const own = parseFrameName(basename(file));
  if (!own) return null;
  const numbers = new Set<number>();
  for (const name of names) {
    const f = parseFrameName(name);
    if (f && f.prefix === own.prefix && f.suffix.toLowerCase() === own.suffix.toLowerCase() && f.padding === own.padding) numbers.add(f.number);
  }
  if (!numbers.has(own.number)) numbers.add(own.number);
  let count = 0;
  while (numbers.has(own.number + count)) count += 1;
  const later = [...numbers].filter((n) => n > own.number + count);
  return { patternName: printfPattern(own), startNumber: own.number, count, padding: own.padding, gapAt: later.length ? own.number + count : null };
}

/** Read the folder of an image-sequence frame. Null for a movie file or a lone image without a number. */
export async function detectImageSequence(file: string): Promise<ImageSequence | null> {
  if (!isImageSequenceFile(file)) return null;
  const names = await readdir(dirname(file)).catch(() => [] as string[]);
  const s = sequenceFromNames(file, names);
  if (!s) return null;
  const { patternName, ...rest } = s;
  return { ...rest, pattern: join(dirname(file), patternName) };
}
