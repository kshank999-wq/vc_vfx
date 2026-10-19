import { timecodeToFrames, type SequenceFormat, type SequencePlan } from '@vcvfx/domain';

/**
 * Building the ffmpeg command for image-sequence generation (master spec §4).
 *
 * Pure, so it is tested without ffmpeg. The main process runs what this
 * returns; it never assembles arguments itself.
 *
 * Rules this enforces:
 *  - **Frame-accurate.** Frames are chosen with the `select` filter on the
 *    decoded frame index `n` rather than a time seek, which can land a frame
 *    early or late depending on the container. `-frames:v` stops ffmpeg as
 *    soon as the last wanted frame is written, so it does not decode the rest
 *    of a long clip.
 *  - **No colour transform.** No LUT, no `colorspace`/`zscale`/`lut3d` filter,
 *    no tone mapping: display looks are never baked into plates. The only
 *    conversion is the pixel-format change the target format needs (for a
 *    YUV source, swscale's YUV→RGB matrix — unavoidable for an RGB format).
 *  - **Renumbered from the plan.** `-start_number` is the delivered first
 *    frame (conventionally 1001).
 *  - **Never overwrite silently.** `-n` makes ffmpeg refuse to replace an
 *    existing file; the caller clears its own unapproved frames of the same
 *    version first, and a new version gets a new file name.
 */

export interface FfmpegJob {
  /** Absolute path of the source clip. Read only. */
  input: string;
  /** Absolute output path with the printf pattern, e.g. `/…/01_PLATES/010_020_plate_v001.%04d.dpx`. */
  output: string;
  plan: SequencePlan;
  frameRate: number;
  /** The shot's own frameIn (editorial in, before handles). */
  frameIn: number;
  timecodeIn?: string | undefined;
  /** The handoff's compression wish, honoured where the encoder supports it. */
  compression?: string | undefined;
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
 * `frameIn` is taken to be clip-relative already. Handles extend that range
 * by the plan's own (already clamped) amounts. If the head handle would reach
 * before the clip's first frame, the range starts at frame 0 and the delivered
 * numbering is shifted up by the missing frames, so editorial frames keep the
 * numbers the plan and shot list promised.
 */
export function clipRange(job: Pick<FfmpegJob, 'plan' | 'frameRate' | 'frameIn' | 'timecodeIn'>): ClipRange {
  const { plan } = job;
  const clipStartAbsolute = job.timecodeIn ? timecodeToFrames(job.timecodeIn, job.frameRate) : 0;
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

/** Encoder and pixel format for a delivery format and bit depth. */
export function encoderArgs(format: SequenceFormat, bitDepth: number, compression?: string): string[] {
  switch (format) {
    case 'dpx': {
      const pix = bitDepth <= 8 ? 'rgb24' : bitDepth === 10 ? 'gbrp10le' : bitDepth === 12 ? 'gbrp12le' : 'rgb48le';
      return ['-c:v', 'dpx', '-pix_fmt', pix];
    }
    case 'tiff':
      return ['-c:v', 'tiff', '-pix_fmt', bitDepth <= 8 ? 'rgb24' : 'rgb48le', '-compression_algo', 'raw'];
    case 'exr': {
      // ffmpeg's EXR encoder writes float RGB; 16-bit means half float.
      const exrCompression = ['none', 'rle', 'zip1', 'zip16'].includes((compression ?? '').toLowerCase())
        ? (compression ?? '').toLowerCase()
        : 'zip16';
      return ['-c:v', 'exr', '-pix_fmt', 'gbrpf32le', '-format', bitDepth >= 32 ? 'float' : 'half', '-compression', exrCompression];
    }
    case 'png':
      return ['-c:v', 'png', '-pix_fmt', bitDepth <= 8 ? 'rgb24' : 'rgb48be'];
    case 'jpeg':
      return ['-c:v', 'mjpeg', '-pix_fmt', 'yuvj444p', '-q:v', '1'];
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

export interface FfmpegCommand {
  args: string[];
  range: ClipRange;
  notes: string[];
}

export function buildFfmpegArgs(job: FfmpegJob): FfmpegCommand {
  const range = clipRange(job);
  const notes = encoderNotes(job.plan.format, job.plan.bitDepth, job.compression);
  if (range.missingHead > 0) {
    notes.push(`The clip has ${range.missingHead} fewer head-handle frames than planned; numbering starts at ${range.startNumber}.`);
  }
  const args = [
    '-hide_banner',
    '-nostdin',
    '-n',
    '-i',
    job.input,
    '-map',
    '0:v:0',
    '-an',
    '-sn',
    '-dn',
    '-vf',
    `select='between(n\\,${range.selectIn}\\,${range.selectOut})'`,
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
  return { args, range, notes };
}

/** The frame count from an ffmpeg progress line (`frame=  123 fps=…`), or null. */
export function parseFfmpegFrame(chunk: string): number | null {
  const matches = [...chunk.matchAll(/frame=\s*(\d+)/g)];
  const last = matches[matches.length - 1];
  return last ? Number(last[1]) : null;
}
