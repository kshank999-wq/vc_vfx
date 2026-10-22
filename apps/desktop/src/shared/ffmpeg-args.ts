import { isIdentity3, timecodeToFrames, type ColorTransform, type Matrix3, type SequenceFormat, type SequencePlan, type ViewPipeline } from '@vcvfx/domain';

/**
 * Building ffmpeg commands: plates (master spec §4) and viewer frames (§5.2).
 *
 * Pure, so it is tested without ffmpeg. The main process runs what this
 * returns; it never assembles arguments itself.
 *
 * Rules this enforces:
 *  - **Frame-accurate.** A clip's frames are chosen with the `select` filter
 *    on the decoded frame index `n` rather than a time seek; an image
 *    sequence's by `-start_number`. `-frames:v` stops ffmpeg as soon as the
 *    last wanted frame is written.
 *  - **Colour is explicit.** Nothing is applied to a plate unless the plate
 *    colour policy says so (addendum 03). "As shot" changes only the pixel
 *    format the target needs (for a YCbCr source, the YCbCr→RGB matrix —
 *    unavoidable for an RGB format). "Convert" is the domain's exact
 *    transform: a 1D decode LUT and a 3×3 matrix, in 32-bit float, into
 *    float EXR. A display transform or look is never part of a plate.
 *  - **Precise conversions.** Where the ffmpeg has zimg (`zscale`, in every
 *    bundled build), integer → float and YCbCr → RGB go through it: swscale's
 *    integer → float path is off by up to ~5e-4.
 *  - **Renumbered from the plan.** `-start_number` on the output is the
 *    delivered first frame (conventionally 1001).
 *  - **Never overwrite silently.** `-n` makes ffmpeg refuse to replace an
 *    existing plate; the caller clears its own unapproved frames of the same
 *    version first, and a new version gets a new file name.
 *  - **No paths inside filter graphs.** LUT files are referenced by a bare,
 *    safe file name and ffmpeg runs with its working directory set to their
 *    folder, so no drive letter, quote or colon needs escaping.
 */

/** What ffmpeg reads: a movie file, or a numbered image sequence (VCDIT's DPX/EXR/TIFF). */
export type SourceInput = { kind: 'clip'; path: string } | { kind: 'sequence'; pattern: string; startNumber: number; frameRate: number };

/** What the probe said about the source's pixels; used to read YCbCr correctly. */
export interface DecodeHints {
  yuv: boolean;
  /** ffprobe's color_space, e.g. "bt709"; absent when untagged. */
  colorSpace?: string | undefined;
  /** ffprobe's color_range, "tv" or "pc"; absent when untagged. */
  colorRange?: string | undefined;
}

/** Filters the ffmpeg in use has (detected once with `ffmpeg -filters`). */
export interface FfmpegCaps {
  zscale: boolean;
  lut1d: boolean;
  colorchannelmixer: boolean;
}

export const FULL_CAPS: FfmpegCaps = { zscale: true, lut1d: true, colorchannelmixer: true };

export interface FfmpegJob {
  source: SourceInput;
  /** Absolute output path with the printf pattern, e.g. `/…/01_PLATES/010_020_plate_v001.%04d.dpx`. */
  output: string;
  plan: SequencePlan;
  frameRate: number;
  /** The shot's own frameIn (editorial in, before handles). */
  frameIn: number;
  timecodeIn?: string | undefined;
  /**
   * The frame number of the clip's first frame, when no timecodeIn places it:
   * an image sequence whose file numbers are the handoff's frame numbers
   * (`sourceInputFor`). Absent: 0.
   */
  clipStart?: number | undefined;
  /** The handoff's compression wish, honoured where the encoder supports it. */
  compression?: string | undefined;
  /** The conversion to apply, and the bare name of its decode LUT in ffmpeg's working directory. Null/absent: as shot. */
  color?: { transform: ColorTransform; decodeLut: string } | null;
  hints?: DecodeHints;
  caps?: FfmpegCaps;
}

export interface ClipRange {
  /** Clip-relative index of the first and last decoded frame to keep. */
  selectIn: number;
  selectOut: number;
  /** Delivered number given to the first written frame. */
  startNumber: number;
  frameCount: number;
  /** Head frames the plan asked for that the clip does not have. */
  missingHead: number;
}

/**
 * Where the plan's source range falls inside the clip file.
 *
 * ASSUMPTION (documented, deliberately simple): VCDIT's frame numbers may be
 * absolute — a frame count derived from timecode — rather than an index into
 * the clip. When the shot carries `timecodeIn`, it is taken as the timecode of
 * the clip file's first frame, so the clip-relative in-point is
 * `frameIn − timecodeToFrames(timecodeIn, fps)`. Without `timecodeIn`,
 * `frameIn` is taken to be clip-relative already — unless `clipStart` says
 * which frame number the clip starts at (an image sequence numbered in the
 * handoff's frames, e.g. `A001C002_0086400.dpx` for frameIn 86400). Handles extend that range
 * by the plan's own (already clamped) amounts. If the head handle would reach
 * before the clip's first frame, the range starts at frame 0 and the delivered
 * numbering is shifted up by the missing frames, so editorial frames keep the
 * numbers the plan and shot list promised.
 */
export function clipRange(job: Pick<FfmpegJob, 'plan' | 'frameRate' | 'frameIn' | 'timecodeIn' | 'clipStart'>): ClipRange {
  const { plan } = job;
  const clipStartAbsolute = job.timecodeIn ? timecodeToFrames(job.timecodeIn, job.frameRate) : (job.clipStart ?? 0);
  const relativeIn = job.frameIn - clipStartAbsolute;
  const headHandles = job.frameIn - plan.sourceIn;
  const tailFrames = plan.sourceOut - job.frameIn;
  const wantedIn = relativeIn - headHandles;
  const selectIn = Math.max(0, wantedIn);
  const missingHead = selectIn - wantedIn;
  const selectOut = relativeIn + tailFrames;
  if (selectOut < selectIn) throw new Error('The shot lies entirely before the start of its clip; check frameIn and timecodeIn');
  return {
    selectIn,
    selectOut,
    startNumber: plan.deliveredIn + missingHead,
    frameCount: selectOut - selectIn + 1,
    missingHead,
  };
}

/** Pixel format the encoder is given for a delivery format and bit depth. */
export function outputPixelFormat(format: SequenceFormat, bitDepth: number): string {
  switch (format) {
    case 'dpx':
      return bitDepth <= 8 ? 'rgb24' : bitDepth === 10 ? 'gbrp10le' : bitDepth === 12 ? 'gbrp12le' : 'rgb48le';
    case 'tiff':
      return bitDepth <= 8 ? 'rgb24' : 'rgb48le';
    case 'exr':
      return 'gbrpf32le';
    case 'png':
      return bitDepth <= 8 ? 'rgb24' : 'rgb48be';
    case 'jpeg':
      return 'yuvj444p';
  }
}

/** Encoder and pixel format for a delivery format and bit depth. */
export function encoderArgs(format: SequenceFormat, bitDepth: number, compression?: string): string[] {
  const pix = outputPixelFormat(format, bitDepth);
  switch (format) {
    case 'dpx':
      return ['-c:v', 'dpx', '-pix_fmt', pix];
    case 'tiff':
      return ['-c:v', 'tiff', '-pix_fmt', pix, '-compression_algo', 'raw'];
    case 'exr': {
      // ffmpeg's EXR encoder writes float RGB; 16-bit means half float.
      const exrCompression = ['none', 'rle', 'zip1', 'zip16'].includes((compression ?? '').toLowerCase())
        ? (compression ?? '').toLowerCase()
        : 'zip16';
      return ['-c:v', 'exr', '-pix_fmt', pix, '-format', bitDepth >= 32 ? 'float' : 'half', '-compression', exrCompression];
    }
    case 'png':
      return ['-c:v', 'png', '-pix_fmt', pix];
    case 'jpeg':
      return ['-c:v', 'mjpeg', '-pix_fmt', pix, '-q:v', '1'];
  }
}

/** Notes the operator should see about how the request was honoured. */
export function encoderNotes(format: SequenceFormat, bitDepth: number, compression?: string): string[] {
  const notes: string[] = [];
  if (format === 'exr' && compression && !['none', 'rle', 'zip1', 'zip16'].includes(compression.toLowerCase())) {
    notes.push(`ffmpeg cannot write ${compression} EXR compression; ZIP16 was used instead.`);
  }
  if (format === 'tiff' && bitDepth !== 8 && bitDepth !== 16) notes.push(`TIFF is written at 16 bits (asked for ${bitDepth}).`);
  if (format === 'png' && bitDepth !== 8 && bitDepth !== 16) notes.push(`PNG is written at 16 bits (asked for ${bitDepth}).`);
  if (format === 'jpeg' && bitDepth !== 8) notes.push('JPEG is always 8 bits.');
  return notes;
}

/** ffprobe colour-space names → zimg's. */
const ZIMG_MATRIX: Record<string, string> = { bt709: '709', bt470bg: '470bg', smpte170m: '170m', bt2020nc: '2020_ncl', bt2020c: '2020_cl', fcc: 'fcc', smpte240m: '240m' };

/**
 * zscale reading the source exactly. For untagged YCbCr, Rec.709 and video
 * range are stated rather than left to swscale's BT.601 default.
 */
export function zscaleIn(hints: DecodeHints | undefined, notes: string[]): string {
  const opts = ['filter=point', 'dither=none'];
  if (hints?.yuv) {
    const matrix = hints.colorSpace ? ZIMG_MATRIX[hints.colorSpace] : undefined;
    if (!matrix) {
      opts.push('matrixin=709');
      notes.push(`The source is YCbCr ${hints.colorSpace ? `tagged ${hints.colorSpace}` : 'with no matrix tag'}; read with the Rec.709 matrix.`);
    }
    if (hints.colorRange !== 'pc' && hints.colorRange !== 'tv') opts.push('rangein=limited');
  }
  return `zscale=${opts.join(':')}`;
}

const coef = (v: number) => {
  const s = v.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
};

/**
 * A 3×3 matrix as ffmpeg `colorchannelmixer` filters. Each coefficient is
 * limited to ±2 there, so a larger matrix is applied as M/s followed by a
 * uniform gain s (itself split into steps of at most 2). Float in, float out,
 * nothing clamped.
 */
export function matrixFilters(m: Matrix3): string[] {
  const max = Math.max(...m.map(Math.abs));
  let scale = 1;
  while (max / scale > 2) scale *= 2;
  const names = ['rr', 'rg', 'rb', 'gr', 'gg', 'gb', 'br', 'bg', 'bb'];
  const filters = [`colorchannelmixer=${names.map((n, i) => `${n}=${coef(m[i]! / scale)}`).join(':')}`];
  for (let s = scale; s > 1; s /= 2) filters.push('colorchannelmixer=rr=2:gg=2:bb=2');
  return filters;
}

/** The plate's colour filters for a conversion: decode LUT, then the matrix. Linear out. */
export function conversionFilters(transform: ColorTransform, decodeLut: string): string[] {
  if (transform.encode !== 'linear') throw new Error('Plates are converted to scene-linear only');
  if (!/^[A-Za-z0-9_.-]+$/.test(decodeLut)) throw new Error(`Unsafe LUT file name: ${decodeLut}`);
  const filters: string[] = [];
  if (transform.decode !== 'linear') filters.push(`lut1d=file=${decodeLut}:interp=linear`);
  if (!isIdentity3(transform.matrix, 1e-9)) filters.push(...matrixFilters(transform.matrix));
  return filters;
}

/** The planar format zimg can write that the encoder's format is a lossless repack of. */
const planarFor = (pix: string): string => (pix === 'rgb24' ? 'gbrp' : pix.startsWith('rgb48') ? 'gbrp16le' : pix);

function inputArgs(source: SourceInput): string[] {
  return source.kind === 'clip'
    ? ['-i', source.path]
    : ['-f', 'image2', '-framerate', String(source.frameRate), '-start_number', String(source.startNumber), '-i', source.pattern];
}

export interface FfmpegCommand {
  args: string[];
  range: ClipRange;
  notes: string[];
  /** The `-vf` graph, verbatim, for the plate record. */
  filter: string;
}

export function buildFfmpegArgs(job: FfmpegJob): FfmpegCommand {
  const range = clipRange(job);
  const notes = encoderNotes(job.plan.format, job.plan.bitDepth, job.compression);
  const caps = job.caps ?? FULL_CAPS;
  if (range.missingHead > 0) {
    notes.push(`The clip has ${range.missingHead} fewer head-handle frames than planned; numbering starts at ${range.startNumber}.`);
  }
  const pix = outputPixelFormat(job.plan.format, job.plan.bitDepth);
  const float = job.plan.format === 'exr';
  if (job.color && !float) throw new Error('A colour conversion needs a float format (EXR)');
  if (job.color && (!caps.lut1d || !caps.colorchannelmixer)) throw new Error('This ffmpeg lacks the lut1d/colorchannelmixer filters needed to convert colour. Use the bundled ffmpeg (clear the path in Settings).');

  const filters: string[] = [];
  // An image sequence is entered at the right file; a clip is decoded from its head and selected.
  const source: SourceInput = job.source.kind === 'sequence' ? { ...job.source, startNumber: job.source.startNumber + range.selectIn } : job.source;
  if (job.source.kind === 'clip') filters.push(`select='between(n\\,${range.selectIn}\\,${range.selectOut})'`);

  if (float) {
    if (caps.zscale) filters.push(zscaleIn(job.hints, notes), 'format=gbrpf32le');
    else {
      filters.push('format=gbrpf32le');
      notes.push('This ffmpeg has no zscale; the conversion to float used swscale, which can be off by up to 0.05%.');
    }
    if (job.color) filters.push(...conversionFilters(job.color.transform, job.color.decodeLut));
  } else if (job.hints?.yuv && caps.zscale && job.plan.format !== 'jpeg') {
    filters.push(zscaleIn(job.hints, notes), `format=${planarFor(pix)}`);
  }

  const filter = filters.join(',');
  const args = [
    '-hide_banner',
    '-nostdin',
    '-n',
    ...inputArgs(source),
    '-map',
    '0:v:0',
    '-an',
    '-sn',
    '-dn',
    ...(filter ? ['-vf', filter] : []),
    '-fps_mode',
    'passthrough',
    '-frames:v',
    String(range.frameCount),
    ...encoderArgs(job.plan.format, job.plan.bitDepth, job.compression),
    '-start_number',
    String(range.startNumber),
    '-f',
    'image2',
    job.output,
  ];
  return { args, range, notes, filter };
}

/** The frame count from an ffmpeg progress line (`frame=  123 fps=…`), or null. */
export function parseFfmpegFrame(chunk: string): number | null {
  const matches = [...chunk.matchAll(/frame=\s*(\d+)/g)];
  const last = matches[matches.length - 1];
  return last ? Number(last[1]) : null;
}

// ---------------------------------------------------------------------------
// Viewer frames
// ---------------------------------------------------------------------------

export interface FrameJob {
  source: SourceInput;
  /** For a clip: the clip-relative frame index. For a sequence: the file's own frame number. */
  frame: number;
  frameRate: number;
  view: ViewPipeline;
  /** Bare file names of the view LUTs, in ffmpeg's working directory. */
  luts: { decode?: string; tone?: string };
  hints?: DecodeHints;
  caps?: FfmpegCaps;
  maxWidth: number;
  /** Absolute path of the JPEG to write. */
  output: string;
}

/**
 * One frame, scaled to at most `maxWidth`, through the view transform, as a
 * JPEG for the viewer. A clip is entered with an input seek half a frame
 * before the wanted frame's timestamp (ffmpeg then decodes from the previous
 * keyframe and drops everything earlier, so the first frame out is exact).
 */
/** The view transform as filters (after scaling): decode LUT, matrix, tone LUT, in float. */
function viewChain(job: Pick<FrameJob, 'view' | 'luts' | 'hints' | 'caps'>): string[] {
  const caps = job.caps ?? FULL_CAPS;
  const notes: string[] = [];
  const filters: string[] = [];
  const v = job.view;
  if (v.decode || v.matrix || v.tone) {
    if (!caps.lut1d || !caps.colorchannelmixer) throw new Error('This ffmpeg lacks the lut1d/colorchannelmixer filters the viewer needs.');
    filters.push(...(caps.zscale ? [zscaleIn(job.hints, notes), 'format=gbrpf32le'] : ['format=gbrpf32le']));
    for (const name of [job.luts.decode, job.luts.tone]) if (name && !/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error(`Unsafe LUT file name: ${name}`);
    if (v.decode) {
      if (!job.luts.decode) throw new Error('The view needs its decode LUT');
      filters.push(`lut1d=file=${job.luts.decode}:interp=linear`);
    }
    if (v.matrix) filters.push(...matrixFilters(v.matrix));
    if (v.tone) {
      if (!job.luts.tone) throw new Error('The view needs its tone LUT');
      filters.push(`lut1d=file=${job.luts.tone}:interp=linear`);
    }
  }
  return filters;
}

function frameInput(source: SourceInput, frame: number, frameRate: number): string[] {
  return source.kind === 'clip'
    ? ['-ss', Math.max(0, (frame - 0.5) / frameRate).toFixed(6), '-i', source.path]
    : ['-f', 'image2', '-framerate', String(source.frameRate), '-start_number', String(frame), '-i', source.pattern];
}

export function buildFrameArgs(job: FrameJob): string[] {
  const width = Math.max(64, Math.min(4096, Math.round(job.maxWidth)));
  const filters = [`scale=w=min(${width}\\,iw):h=-2:flags=bicubic`, ...viewChain(job), 'format=yuvj444p'];
  return ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...frameInput(job.source, job.frame, job.frameRate), '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', filters.join(','), '-frames:v', '1', '-c:v', 'mjpeg', '-q:v', '3', '-f', 'image2', '-update', '1', job.output];
}

export interface RawFramesJob extends Omit<FrameJob, 'maxWidth' | 'output'> {
  /** How many consecutive frames from `frame`. */
  count: number;
  /** Exact output size. */
  width: number;
  height: number;
}

/**
 * Consecutive frames as raw 8-bit RGB on stdout, at an exact size, through the
 * view transform — what the roto engines analyse (addendum 04). The view is
 * for analysis only: nothing read this way is ever written as a plate.
 */
export function buildRawFramesArgs(job: RawFramesJob): string[] {
  const w = Math.max(16, Math.min(8192, Math.round(job.width)));
  const h = Math.max(16, Math.min(8192, Math.round(job.height)));
  const count = Math.max(1, Math.min(10_000, Math.round(job.count)));
  const filters = [`scale=w=${w}:h=${h}:flags=area`, ...viewChain(job), 'format=rgb24'];
  return ['-hide_banner', '-nostdin', '-v', 'error', ...frameInput(job.source, job.frame, job.frameRate), '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', filters.join(','), '-frames:v', String(count), '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'];
}
