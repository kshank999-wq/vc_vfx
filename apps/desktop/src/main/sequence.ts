import { spawn } from 'node:child_process';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ENCODINGS,
  TRANSFERS,
  decodeCube,
  describeTransform,
  encodingLabel,
  framePattern,
  handoffShot,
  outputFor,
  planFor,
  plateColorFor,
  setProbedMedia,
  shotState,
  shotTiming,
  versionTag,
  type PlateRecordInput,
  type ProbedMediaInput,
  type Project,
} from '@vcvfx/domain';
import { FULL_CAPS, buildFfmpegArgs, parseFfmpegFrame, type DecodeHints, type FfmpegCaps, type SourceInput } from '../shared/ffmpeg-args';
import type { FfmpegInfo } from '../shared/bridge';
import { resolveTools, type ToolLocation } from './ffmpeg-tools';
import { cameraRawProblem, detectImageSequence } from './image-sequence';
import { isSampleHandoff, outputRootProblem, resolveFromHandoff } from './paths';
import { shotFolder, sourceFiles } from './package-shot';
import { FFPROBE_HELP, probeFile } from './probe';

/**
 * Image-sequence generation (master spec §4) by running ffmpeg.
 *
 * ffmpeg is the copy bundled with VC VFX unless Settings name another
 * (ffmpeg-tools.ts). The source is only ever an input. Plates land in the shot
 * package's `01_PLATES`, named by the task's version; the description of
 * their colour — and, for a conversion, the decode LUT ffmpeg ran — lands in
 * `09_PROJECT_DATA`, so the plates can be made again from source + settings
 * (§19). The caller moves the task to `needs_review`, never `approved`.
 */

export const FFMPEG_HELP =
  'VC VFX writes image sequences with ffmpeg, and none was found. The installer includes one; if it was removed, reinstall VC VFX, or install ffmpeg (macOS: `brew install ffmpeg`; Windows: `winget install Gyan.FFmpeg`) and set its full path in Settings.';

/** Kept for callers that only ask "is there an ffmpeg": resolves Settings → bundled → PATH. */
export async function detectFfmpeg(configured: string, loc?: ToolLocation): Promise<FfmpegInfo> {
  const location: ToolLocation = loc ?? { resourcesPath: '', appPath: process.cwd(), packaged: false, platform: process.platform, arch: process.arch };
  const tools = await resolveTools(configured, location);
  return tools.ffmpeg
    ? { found: true, path: tools.ffmpeg, version: tools.ffmpegVersion, source: tools.source, problem: null }
    : { found: false, path: null, version: null, source: null, problem: tools.problem };
}

export interface SequenceInput {
  project: Project;
  shotId: string;
  outputRoot: string;
  ffmpeg: string;
  /** Reads the clip when its frame range is unknown, and its pixel format for an exact YCbCr → RGB. */
  ffprobe?: string | null;
  caps?: FfmpegCaps;
  appVersion?: string;
  signal?: AbortSignal;
  onProgress?: (frames: number, total: number) => void;
}

export type SequenceResult =
  | { ok: true; folder: string; pattern: string; frames: number; notes: string[]; probed?: ProbedMediaInput; record: PlateRecordInput }
  | { ok: false; reason: string };

/** File-name-safe stem for the files that describe a plate version. */
const stem = (s: string) => s.replace(/[^A-Za-z0-9_.-]+/g, '_');

export function hintsFrom(media: Pick<ProbedMediaInput, 'pixelFormat' | 'colorSpace' | 'colorRange'> | null | undefined): DecodeHints {
  const pix = media?.pixelFormat ?? '';
  return { yuv: /^(yuv|nv|uyvy|yuyv|v210|ayuv|p0|p2)/.test(pix), colorSpace: media?.colorSpace, colorRange: media?.colorRange };
}

/** Resolve a shot's source to what ffmpeg reads: one clip, or an image sequence from the named first frame. */
export async function sourceInputFor(absolute: string, frameRate: number): Promise<{ ok: true; source: SourceInput; sequenceCount: number | null } | { ok: false; reason: string }> {
  const raw = cameraRawProblem(absolute);
  if (raw) return { ok: false, reason: raw };
  const sequence = await detectImageSequence(absolute);
  if (sequence) return { ok: true, source: { kind: 'sequence', pattern: sequence.pattern, startNumber: sequence.startNumber, frameRate }, sequenceCount: sequence.count };
  return { ok: true, source: { kind: 'clip', path: absolute }, sequenceCount: null };
}

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
  const raw = cameraRawProblem(source);
  if (raw) return { ok: false, reason: raw };
  if (!(await stat(source).catch(() => null))) return { ok: false, reason: `The source clip is not on the drive: ${source}` };

  const decision = plateColorFor(project, shotId);
  if (decision.blocked) return { ok: false, reason: decision.blocked };

  // No range in the handoff and none read yet: read the clip, and work on all of it.
  let probed: ProbedMediaInput | undefined;
  let media: ProbedMediaInput | null = state.probe;
  if (!shotTiming(project, shot)) {
    if (!input.ffprobe) return { ok: false, reason: `${shotId} has no frame range yet. ${FFPROBE_HELP}` };
    const read = await probeFile(input.ffprobe, source, shot.sourcePath, input.signal);
    if (!read.ok) return { ok: false, reason: `The clip could not be read to find its length: ${read.error}` };
    if (!read.media.frameCount) return { ok: false, reason: 'ffprobe could not tell how many frames the clip has, so no plates were written.' };
    const applied = setProbedMedia(project, shotId, read.media, 'ffprobe', new Date());
    if (!applied.ok) return { ok: false, reason: applied.reason };
    project = applied.project;
    probed = read.media;
    media = read.media;
  } else if (!media && input.ffprobe) {
    // Only for its pixel format and colour tags; not recorded.
    const read = await probeFile(input.ffprobe, source, shot.sourcePath, input.signal);
    if (read.ok) media = read.media;
  }
  const timing = shotTiming(project, shot)!;
  const plan = planFor(project, shot)!;
  const output = outputFor(project.handoff, shot);
  const name = state.vfxShotId ?? shot.shotId;
  const folder = shotFolder(project, shotId, input.outputRoot);
  const plates = join(folder, '01_PLATES');
  const data = join(folder, '09_PROJECT_DATA');
  await mkdir(plates, { recursive: true });
  await mkdir(data, { recursive: true });

  const resolved = await sourceInputFor(source, timing.frameRate);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };

  // This version is not approved, so an earlier attempt at it may be cleared:
  // only files of exactly this shot, element and version, in our own folders.
  const prefix = `${name}_plate_${versionTag(task.version)}.`;
  for (const f of await readdir(plates)) if (f.startsWith(prefix)) await rm(join(plates, f), { force: true });
  const dataStem = `${stem(name)}_plate_${versionTag(task.version)}`;
  for (const f of await readdir(data)) if (f.startsWith(`${dataStem}_colour.`) || f.startsWith(`${dataStem}_decode.`)) await rm(join(data, f), { force: true });

  const pattern = framePattern(name, 'plate', task.version, output.format);
  const decodeLut = `${dataStem}_decode.cube`;
  const colourFile = `${dataStem}_colour.json`;
  const transform = decision.transform;
  const caps = input.caps ?? FULL_CAPS;
  let command;
  try {
    command = buildFfmpegArgs({
      source: resolved.source,
      output: join(plates, pattern),
      plan,
      frameRate: timing.frameRate,
      frameIn: timing.frameIn,
      // A probed range is already clip-relative (0 … frameCount − 1); its timecode only labels it.
      timecodeIn: timing.from === 'handoff' ? timing.timecodeIn : undefined,
      compression: output.compression,
      color: transform ? { transform, decodeLut } : null,
      hints: hintsFrom(media),
      caps,
    });
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
  if (resolved.sequenceCount !== null && command.range.selectOut >= resolved.sequenceCount) {
    return { ok: false, reason: `The image sequence has ${resolved.sequenceCount} unbroken frames from ${shot.sourcePath}; the plan needs ${command.range.selectOut + 1}. Check for missing frames.` };
  }

  // What is applied, written down before it is applied.
  const files = [`09_PROJECT_DATA/${colourFile}`];
  if (transform && transform.decode !== 'linear') {
    await writeFile(join(data, decodeLut), decodeCube(transform));
    files.push(`09_PROJECT_DATA/${decodeLut}`);
  }
  const description = transform ? describeTransform(transform) : null;
  const colour = {
    format: 'vcvfx.plate-colour/1',
    generator: `VC VFX ${input.appVersion ?? ''}`.trim(),
    shot: name,
    plates: pattern,
    version: versionTag(task.version),
    policy: decision.policy,
    sourceEncoding: decision.sourceEncoding ? { id: decision.sourceEncoding, label: encodingLabel(decision.sourceEncoding), from: decision.sourceEncodingFrom } : null,
    plateEncoding: decision.plateEncoding ? { id: decision.plateEncoding, label: encodingLabel(decision.plateEncoding) } : null,
    summary: decision.summary,
    transform: transform
      ? {
          description,
          decode: { transfer: TRANSFERS[transform.decode].label, lut: transform.decode === 'linear' ? null : decodeLut, lutSize: 4096, domain: [0, 1] },
          matrix: { rows: [transform.matrix.slice(0, 3), transform.matrix.slice(3, 6), transform.matrix.slice(6)], from: ENCODINGS[transform.from].gamut, to: ENCODINGS[transform.to].gamut, adaptation: transform.adaptation },
          output: 'scene-linear, float',
        }
      : null,
    signal: 'The camera curve is applied to the RGB signal as ffmpeg decodes it (YCbCr expanded by its tagged range; RGB images as stored).',
    ffmpeg: {
      filter: command.filter,
      args: command.args.map((a) => (a === source || (resolved.source.kind === 'sequence' && a === resolved.source.pattern) ? '<source>' : a === join(plates, pattern) ? `../01_PLATES/${pattern}` : a)),
      workingDirectory: '09_PROJECT_DATA',
    },
    lookApplied: false,
    notes: command.notes,
  };
  await writeFile(join(data, colourFile), `${JSON.stringify(colour, null, 2)}\n`);

  const total = command.range.frameCount;
  const outcome = await new Promise<{ code: number | null; tail: string }>((resolvePromise) => {
    const child = spawn(input.ffmpeg, command.args, { cwd: data, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
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
  const record: PlateRecordInput = {
    version: task.version,
    pattern,
    format: output.format,
    bitDepth: output.bitDepth,
    frames: written,
    firstFrame: command.range.startNumber,
    lastFrame: command.range.startNumber + written - 1,
    color: {
      policy: decision.policy,
      sourceEncoding: decision.sourceEncoding,
      plateEncoding: decision.plateEncoding,
      summary: decision.summary,
      transform: description,
      filter: command.filter,
      files,
      lookApplied: false,
    },
    notes: [...decision.warnings, ...command.notes],
  };
  return { ok: true, folder: plates, pattern, frames: written, notes: record.notes, record, ...(probed ? { probed } : {}) };
}
