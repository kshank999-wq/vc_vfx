import { spawn } from 'node:child_process';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { framePattern, handoffShot, outputFor, planFor, setProbedMedia, shotState, shotTiming, versionTag, type ProbedMediaInput, type Project } from '@vcvfx/domain';
import { buildFfmpegArgs, parseFfmpegFrame } from '../shared/ffmpeg-args';
import type { FfmpegInfo } from '../shared/bridge';
import { isSampleHandoff, outputRootProblem, resolveFromHandoff } from './paths';
import { shotFolder, sourceFiles } from './package-shot';
import { FFPROBE_HELP, probeFile } from './probe';

/**
 * Image-sequence generation (master spec §4) by running ffmpeg.
 *
 * ffmpeg is the operator's own install — on PATH or a binary named in
 * Settings — and is never bundled. The source is only ever an `-i` input.
 * Output lands in the shot package's `01_PLATES`, named by the task's
 * version; the caller moves the task to `needs_review`, never `approved`.
 */

export const FFMPEG_HELP =
  'VC VFX uses ffmpeg to write image sequences, and it was not found. Install it — macOS: `brew install ffmpeg`; Windows: `winget install Gyan.FFmpeg` (or download from ffmpeg.org) — then restart VC VFX, or set its full path in Settings.';

export async function detectFfmpeg(configured: string): Promise<FfmpegInfo> {
  const candidates = configured.trim() ? [configured.trim()] : ['ffmpeg'];
  for (const command of candidates) {
    const version = await new Promise<string | null>((resolvePromise) => {
      try {
        const child = spawn(command, ['-hide_banner', '-version'], { windowsHide: true });
        let out = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString()));
        child.on('error', () => resolvePromise(null));
        child.on('close', (code) => resolvePromise(code === 0 ? (out.split('\n')[0] ?? '').trim() : null));
      } catch {
        resolvePromise(null);
      }
    });
    if (version) return { found: true, path: command, version };
  }
  return { found: false, path: null, version: null };
}

export interface SequenceInput {
  project: Project;
  shotId: string;
  outputRoot: string;
  ffmpeg: string;
  /** Used when the shot's frame range is unknown (a VCDIT handoff), to read the clip first. */
  ffprobe?: string | null;
  signal?: AbortSignal;
  onProgress?: (frames: number, total: number) => void;
}

export type SequenceResult =
  | { ok: true; folder: string; pattern: string; frames: number; notes: string[]; probed?: ProbedMediaInput }
  | { ok: false; reason: string };

export async function generateSequence(input: SequenceInput): Promise<SequenceResult> {
  const { shotId } = input;
  let project = input.project;
  const shot = handoffShot(project, shotId);
  const state = shotState(project, shotId);
  if (!shot || !state) return { ok: false, reason: `No shot ${shotId}` };
  const task = state.tasks.find((t) => t.kind === 'sequence_conversion');
  if (!task) return { ok: false, reason: `${shotId} has no image-sequence task` };
  if (task.state === 'approved') return { ok: false, reason: 'These plates are approved. Mark the task as needing correction first; that makes a new version.' };
  if (isSampleHandoff(project.handoffPath)) return { ok: false, reason: 'The sample project has no media on disk to convert.' };

  const problem = outputRootProblem(input.outputRoot, sourceFiles(project));
  if (problem) return { ok: false, reason: problem };

  const source = resolveFromHandoff(project.handoffPath, shot.sourcePath)!;
  if (!(await stat(source).catch(() => null))) return { ok: false, reason: `The source clip is not on the drive: ${source}` };

  // No range in the handoff and none read yet: read the clip, and work on all of it.
  let probed: ProbedMediaInput | undefined;
  if (!shotTiming(project, shot)) {
    if (!input.ffprobe) return { ok: false, reason: `${shotId} has no frame range yet. ${FFPROBE_HELP}` };
    const read = await probeFile(input.ffprobe, source, shot.sourcePath, input.signal);
    if (!read.ok) return { ok: false, reason: `The clip could not be read to find its length: ${read.error}` };
    if (!read.media.frameCount) return { ok: false, reason: 'ffprobe could not tell how many frames the clip has, so no plates were written.' };
    const applied = setProbedMedia(project, shotId, read.media, 'ffprobe', new Date());
    if (!applied.ok) return { ok: false, reason: applied.reason };
    project = applied.project;
    probed = read.media;
  }
  const timing = shotTiming(project, shot)!;
  const plan = planFor(project, shot)!;
  const output = outputFor(project.handoff, shot);
  const name = state.vfxShotId ?? shot.shotId;
  const plates = join(shotFolder(project, shotId, input.outputRoot), '01_PLATES');
  await mkdir(plates, { recursive: true });

  // This version is not approved, so an earlier attempt at it may be cleared:
  // only files of exactly this shot, element and version, in our own folder.
  const prefix = `${name}_plate_${versionTag(task.version)}.`;
  for (const name of await readdir(plates)) if (name.startsWith(prefix)) await rm(join(plates, name), { force: true });

  const pattern = framePattern(name, 'plate', task.version, output.format);
  let command;
  try {
    command = buildFfmpegArgs({
      input: source,
      output: join(plates, pattern),
      plan,
      frameRate: timing.frameRate,
      frameIn: timing.frameIn,
      // A probed range is already clip-relative (0 … frameCount − 1); its timecode only labels it.
      timecodeIn: timing.from === 'handoff' ? timing.timecodeIn : undefined,
      compression: output.compression,
    });
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }

  const total = command.range.frameCount;
  const outcome = await new Promise<{ code: number | null; tail: string }>((resolvePromise) => {
    const child = spawn(input.ffmpeg, command.args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let tail = '';
    const abort = () => child.kill('SIGTERM');
    input.signal?.addEventListener('abort', abort, { once: true });
    child.stderr.on('data', (d: Buffer) => {
      const text = d.toString();
      tail = (tail + text).slice(-4000);
      const frame = parseFfmpegFrame(text);
      if (frame !== null) input.onProgress?.(frame, total);
    });
    child.on('error', (error) => resolvePromise({ code: -1, tail: error.message }));
    child.on('close', (code) => {
      input.signal?.removeEventListener('abort', abort);
      resolvePromise({ code, tail });
    });
  });

  if (input.signal?.aborted) return { ok: false, reason: 'Cancelled. Partial frames of this unapproved version were left in 01_PLATES and are replaced on the next run.' };
  if (outcome.code !== 0) {
    const lastLines = outcome.tail.trim().split('\n').slice(-4).join('\n');
    return { ok: false, reason: `ffmpeg stopped with an error:\n${lastLines}` };
  }
  const written = (await readdir(plates)).filter((n) => n.startsWith(prefix)).length;
  if (written !== total) {
    return { ok: false, reason: `ffmpeg wrote ${written} of ${total} frames. The clip may be shorter than the handoff's range; check frameIn/frameOut and timecodeIn.` };
  }
  input.onProgress?.(total, total);
  return { ok: true, folder: plates, pattern, frames: written, notes: command.notes, ...(probed ? { probed } : {}) };
}
