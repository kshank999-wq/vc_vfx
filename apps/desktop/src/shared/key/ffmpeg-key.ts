import { zscaleIn, FULL_CAPS, type DecodeHints, type FfmpegCaps, type SourceInput } from '../ffmpeg-args';

/**
 * ffmpeg commands for the keyer (addendum 09 §4). Pure, so they are tested
 * without ffmpeg; the main process runs what these return.
 *
 *  - Frames are read as **float code values** (planar gbrpf32le), never
 *    through a display view: the keyer decodes them to linear itself with the
 *    colour module (shared/key/linear.ts). A linear EXR plate arrives as its
 *    linear values. Resizing (working size) happens in float, in zimg when the
 *    ffmpeg has it.
 *  - The despilled foreground and the light-wrap layer are written as
 *    half-float EXR (RGBA premultiplied / RGB), ZIP16, from raw float frames
 *    on stdin; the alpha as single-channel EXR when asked. `-n`: never
 *    overwrite.
 */

function frameInput(source: SourceInput, frame: number, frameRate: number): string[] {
  return source.kind === 'clip'
    ? ['-ss', Math.max(0, (frame - 0.5) / frameRate).toFixed(6), '-i', source.path]
    : ['-f', 'image2', '-framerate', String(source.frameRate), '-start_number', String(frame), '-i', source.pattern];
}

export interface LinearFramesJob {
  source: SourceInput;
  /** For a clip: the clip-relative frame index. For a sequence: the file's own frame number. */
  frame: number;
  frameRate: number;
  count: number;
  width: number;
  height: number;
  /** Whether the source is already this size (no resize). */
  native: boolean;
  hints?: DecodeHints;
  caps?: FfmpegCaps;
}

/** Consecutive frames as raw planar float (G, B, R planes) on stdout, at an exact size. */
export function buildLinearFramesArgs(job: LinearFramesJob): string[] {
  const caps = job.caps ?? FULL_CAPS;
  const w = Math.max(16, Math.min(16384, Math.round(job.width)));
  const h = Math.max(16, Math.min(16384, Math.round(job.height)));
  const count = Math.max(1, Math.min(100_000, Math.round(job.count)));
  const notes: string[] = [];
  const filters: string[] = [];
  if (caps.zscale) {
    const z = zscaleIn(job.hints, notes);
    filters.push(job.native ? z : z.replace('filter=point', `w=${w}:h=${h}:filter=bilinear`), 'format=gbrpf32le');
  } else {
    filters.push(...(job.native ? [] : [`scale=w=${w}:h=${h}:flags=area`]), 'format=gbrpf32le');
  }
  return ['-hide_banner', '-nostdin', '-v', 'error', ...frameInput(job.source, job.frame, job.frameRate), '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', filters.join(','), '-frames:v', String(count), '-f', 'rawvideo', '-pix_fmt', 'gbrpf32le', 'pipe:1'];
}

export type ExrLayout = 'rgba' | 'rgb' | 'y';

const PIX: Record<ExrLayout, string> = { rgba: 'gbrapf32le', rgb: 'gbrpf32le', y: 'grayf32le' };

/** Planes per pixel of a raw layout. */
export const exrPlanes = (layout: ExrLayout) => (layout === 'rgba' ? 4 : layout === 'rgb' ? 3 : 1);

/** An EXR sequence (half float, ZIP16) from raw float frames on stdin. */
export function buildExrWriteArgs(job: { layout: ExrLayout; width: number; height: number; frameRate: number; startNumber: number; output: string }): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-v',
    'error',
    '-n',
    '-f',
    'rawvideo',
    '-pix_fmt',
    PIX[job.layout],
    '-s',
    `${job.width}x${job.height}`,
    '-framerate',
    String(job.frameRate),
    '-i',
    'pipe:0',
    '-c:v',
    'exr',
    '-compression',
    'zip16',
    '-format',
    'half',
    '-start_number',
    String(job.startNumber),
    '-f',
    'image2',
    job.output,
  ];
}

/**
 * One frame of a raw planar layout from interleaved RGB (and alpha): ffmpeg's
 * planar float formats are ordered G, B, R (, A).
 */
export function toPlanar(layout: ExrLayout, n: number, rgb: Float32Array | null, alpha: Float32Array | null): Float32Array {
  if (layout === 'y') return Float32Array.from(alpha ?? new Float32Array(n));
  const planes = exrPlanes(layout);
  const out = new Float32Array(n * planes);
  if (rgb)
    for (let i = 0; i < n; i += 1) {
      out[i] = rgb[3 * i + 1]!;
      out[n + i] = rgb[3 * i + 2]!;
      out[2 * n + i] = rgb[3 * i]!;
    }
  if (layout === 'rgba' && alpha) out.set(alpha, 3 * n);
  return out;
}
