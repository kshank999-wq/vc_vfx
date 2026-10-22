import { framesToTimecode, handoffShot, planFor, shotTiming, timecodeToFrames, type Project } from '@vcvfx/domain';
import { clipRange } from './ffmpeg-args';

/**
 * The viewer's frame numbering (master spec §5.2): delivered numbers — the
 * ones the plates carry — mapped back to the clip, and labelled with the
 * clip's timecode. Shared by the renderer (scrub bar) and main (which frame
 * to decode), so they cannot disagree. Uses the same `clipRange` the plates
 * are made with: plate 1009 is the frame the viewer calls 1009.
 */
export interface ViewerTimeline {
  /** Delivered numbers of the first and last frame (handles included). */
  first: number;
  last: number;
  editorialIn: number;
  editorialOut: number;
  frameRate: number;
  /** Clip-relative index (0 = the clip's first frame) of a delivered frame. */
  clipIndex(delivered: number): number;
  /** The clip timecode of a delivered frame, when the clip's start timecode is known. */
  timecode(delivered: number): string | null;
}

/** `clipStart`: as `clipRange`'s — the frame number of an image sequence's first file, from `sourceInputFor` (main only). */
export function viewerTimeline(project: Project, shotId: string, clipStart?: number): ViewerTimeline | null {
  const shot = handoffShot(project, shotId);
  if (!shot) return null;
  const timing = shotTiming(project, shot);
  const plan = planFor(project, shot);
  if (!timing || !plan) return null;
  let range;
  try {
    range = clipRange({ plan, frameRate: timing.frameRate, frameIn: timing.frameIn, timecodeIn: timing.from === 'handoff' ? timing.timecodeIn : undefined, clipStart });
  } catch {
    return null;
  }
  const first = range.startNumber;
  const last = first + range.frameCount - 1;
  let tcStart: number | null = null;
  if (timing.timecodeIn) {
    try {
      tcStart = timecodeToFrames(timing.timecodeIn, timing.frameRate);
    } catch {
      tcStart = null;
    }
  }
  const clipIndex = (d: number) => range.selectIn + (Math.min(last, Math.max(first, Math.round(d))) - first);
  return {
    first,
    last,
    editorialIn: Math.max(first, plan.editorialIn),
    editorialOut: Math.min(last, plan.editorialOut),
    frameRate: timing.frameRate,
    clipIndex,
    timecode: (d) => (tcStart === null ? null : framesToTimecode(tcStart + clipIndex(d), timing.frameRate)),
  };
}

/** A delivered frame kept inside the timeline. */
export function clampFrame(t: Pick<ViewerTimeline, 'first' | 'last'>, frame: number): number {
  return Math.min(t.last, Math.max(t.first, Math.round(frame)));
}
