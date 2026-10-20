import type { OutputSpec, SequenceFormat } from './handoff.js';

/**
 * Frame arithmetic for image-sequence generation (master spec §4).
 *
 * Source frames are the camera clip's own numbering. Delivered frames are
 * renumbered so the first frame of the head handle is `startFrame`
 * (conventionally 1001) and the editorial range follows the handles.
 */

export interface SequencePlan {
  /** First and last source frame read, handles included. */
  sourceIn: number;
  sourceOut: number;
  /** Delivered numbering, handles included. */
  deliveredIn: number;
  deliveredOut: number;
  /** Delivered numbering of the editorial (cut) range. */
  editorialIn: number;
  editorialOut: number;
  handles: number;
  frameCount: number;
  format: SequenceFormat;
  bitDepth: number;
}

/** A known range: the handoff's own, or the probed clip's (see `shotTiming` in project.ts). */
export interface FrameRange {
  frameIn: number;
  frameOut: number;
  handles: number;
}

export function sequencePlan(shot: FrameRange, output: OutputSpec): SequencePlan {
  // A head handle cannot reach before frame 0 of the source; whatever is
  // available is used and the delivered numbering still starts at startFrame.
  const headHandles = Math.min(shot.handles, shot.frameIn);
  const sourceIn = shot.frameIn - headHandles;
  const sourceOut = shot.frameOut + shot.handles;
  const frameCount = sourceOut - sourceIn + 1;
  const deliveredIn = output.startFrame;
  return {
    sourceIn,
    sourceOut,
    deliveredIn,
    deliveredOut: deliveredIn + frameCount - 1,
    editorialIn: deliveredIn + headHandles,
    editorialOut: deliveredIn + headHandles + (shot.frameOut - shot.frameIn),
    handles: shot.handles,
    frameCount,
    format: output.format,
    bitDepth: output.bitDepth,
  };
}

/** Map a source frame to its delivered number. */
export function deliveredFrame(plan: SequencePlan, sourceFrame: number): number {
  return plan.deliveredIn + (sourceFrame - plan.sourceIn);
}

export const FORMAT_EXTENSIONS: Record<SequenceFormat, string> = {
  dpx: 'dpx',
  tiff: 'tif',
  exr: 'exr',
  png: 'png',
  jpeg: 'jpg',
};

export function padFrame(frame: number, padding = 4): string {
  return String(frame).padStart(padding, '0');
}

/** `010_020_plate_v001.1001.exr` */
export function frameFileName(shotId: string, element: string, version: number, frame: number, format: SequenceFormat, padding = 4): string {
  return `${shotId}_${element}_${versionTag(version)}.${padFrame(frame, padding)}.${FORMAT_EXTENSIONS[format]}`;
}

/** The printf-style pattern image tools expect: `010_020_plate_v001.%04d.exr` */
export function framePattern(shotId: string, element: string, version: number, format: SequenceFormat, padding = 4): string {
  return `${shotId}_${element}_${versionTag(version)}.%0${padding}d.${FORMAT_EXTENSIONS[format]}`;
}

/** `v001` — outputs are versioned, never silently overwritten (§19). */
export function versionTag(version: number): string {
  return `v${String(version).padStart(3, '0')}`;
}

/** Frames per second as the timecode counts them (23.976 counts 24). */
function timecodeBase(fps: number): number {
  return Math.round(fps);
}

/**
 * Non-drop-frame timecode to a frame count. Drop-frame timecode (`;`) is
 * counted the same way at its nominal rate, which is exact for 23.976/24/25
 * and an approximation only at 29.97 and 59.94 DF.
 */
export function timecodeToFrames(tc: string, fps: number): number {
  const m = /^(\d{2}):(\d{2}):(\d{2})[:;](\d{2})$/.exec(tc);
  if (!m) throw new Error(`Not a timecode: ${tc}`);
  const base = timecodeBase(fps);
  const [h, mi, s, f] = m.slice(1).map(Number) as [number, number, number, number];
  if (f >= base) throw new Error(`Frame ${f} out of range at ${fps} fps`);
  return ((h * 60 + mi) * 60 + s) * base + f;
}

export function framesToTimecode(frames: number, fps: number): string {
  const base = timecodeBase(fps);
  const f = frames % base;
  const totalSeconds = Math.floor(frames / base);
  const s = totalSeconds % 60;
  const mi = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600) % 24;
  return [h, mi, s, f].map((n) => String(n).padStart(2, '0')).join(':');
}

/** `1001–1128` */
export function formatRange(a: number, b: number): string {
  return `${a}–${b}`;
}
