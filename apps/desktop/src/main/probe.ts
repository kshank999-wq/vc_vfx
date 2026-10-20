import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { TimecodeSchema, handoffShot, shotState, shotTiming, type ProbedMediaInput, type Project } from '@vcvfx/domain';
import type { ProbeResult } from '../shared/bridge';
import { isSampleHandoff, resolveFromHandoff } from './paths';

/**
 * Reading a source clip with ffprobe: frame count, start timecode, frame
 * rate, resolution and codec. VCDIT's handoff carries none of these, so a
 * project made from one is probed when it is created, and plate generation
 * probes a clip whose range is still unknown.
 *
 * ffprobe ships beside ffmpeg in every ffmpeg build; VC VFX looks for it next
 * to the ffmpeg named in Settings (or on PATH). Read only: the clip is an
 * input and nothing is written. Parsing is pure and tested without ffprobe.
 */

export const FFPROBE_HELP =
  'ffprobe (part of ffmpeg) was not found, so clip lengths, timecode and resolution could not be read and frame ranges stay unknown (“—”). Install ffmpeg — macOS: `brew install ffmpeg`; Windows: `winget install Gyan.FFmpeg` — or set its path in Settings; ffprobe is looked for beside it.';

/** ffprobe beside the configured ffmpeg: "/opt/ff/ffmpeg" → "/opt/ff/ffprobe", "C:\\ff\\ffmpeg.exe" → "C:\\ff\\ffprobe.exe". */
export function ffprobePathFor(ffmpeg: string): string {
  const configured = ffmpeg.trim();
  if (!configured) return 'ffprobe';
  const cut = Math.max(configured.lastIndexOf('/'), configured.lastIndexOf('\\'));
  const dir = configured.slice(0, cut + 1);
  const name = configured.slice(cut + 1);
  const exe = /\.exe$/i.test(name) ? name.slice(name.length - 4) : '';
  return `${dir}ffprobe${exe}`;
}

/** "24000/1001" → 23.976; null for 0/0 or nonsense. */
export function parseRational(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/.exec(value.trim());
  if (!m) return null;
  const rate = Number(m[1]) / (m[2] ? Number(m[2]) : 1);
  return Number.isFinite(rate) && rate > 0 ? Math.round(rate * 1000) / 1000 : null;
}

const asNumber = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** "01:00:00:00" or "01:00:00;00" kept; "01:00:00.00" normalised; anything else null. */
export function normaliseTimecode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const tc = value.trim().replace(/^(\d{2}:\d{2}:\d{2})\.(\d{2})$/, '$1:$2');
  return TimecodeSchema.safeParse(tc).success ? tc : undefined;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  nb_frames?: string;
  nb_read_frames?: string;
  duration?: string;
  disposition?: { attached_pic?: number };
  tags?: Record<string, string>;
}

/**
 * What VC VFX keeps from `ffprobe -print_format json -show_format -show_streams`.
 * The first real video stream (not cover art) is the picture. Frame count is
 * the container's own (`nb_frames`), else duration × rate. Timecode is the
 * video stream's, else a timecode (tmcd) stream's, else the container's.
 * Null when there is no picture at all.
 */
export function parseFfprobe(json: unknown, file: string): ProbedMediaInput | null {
  if (typeof json !== 'object' || json === null) return null;
  const doc = json as { streams?: FfprobeStream[]; format?: { duration?: string; tags?: Record<string, string> } };
  const streams = Array.isArray(doc.streams) ? doc.streams : [];
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  if (!video) return null;
  const frameRate = parseRational(video.avg_frame_rate) ?? parseRational(video.r_frame_rate);
  const counted = asNumber(video.nb_frames) ?? asNumber(video.nb_read_frames);
  const duration = asNumber(video.duration) ?? asNumber(doc.format?.duration);
  const frameCount = counted && counted > 0 ? Math.round(counted) : duration && frameRate ? Math.round(duration * frameRate) : null;
  const tag = (tags: Record<string, string> | undefined) => (tags ? (tags['timecode'] ?? tags['TIMECODE']) : undefined);
  const timecodeIn =
    normaliseTimecode(tag(video.tags)) ?? normaliseTimecode(streams.map((s) => tag(s.tags)).find(Boolean)) ?? normaliseTimecode(tag(doc.format?.tags));
  const width = asNumber(video.width);
  const height = asNumber(video.height);
  return {
    file,
    ...(frameCount && frameCount > 0 ? { frameCount } : {}),
    ...(timecodeIn ? { timecodeIn } : {}),
    ...(frameRate ? { frameRate } : {}),
    ...(width && height && width > 0 && height > 0 ? { resolution: { width: Math.round(width), height: Math.round(height) } } : {}),
    ...(video.codec_name ? { codec: video.codec_name } : {}),
  };
}

const MAX_OUTPUT = 8 * 1024 * 1024;

/** Run a command and collect its output; null when it could not start. */
function run(command: string, args: string[], signal?: AbortSignal): Promise<{ code: number | null; out: string; err: string } | null> {
  return new Promise((resolvePromise) => {
    try {
      const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const abort = () => child.kill('SIGTERM');
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (d: Buffer) => {
        if (out.length < MAX_OUTPUT) out += d.toString();
      });
      child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
      child.on('error', () => resolvePromise(null));
      child.on('close', (code) => {
        signal?.removeEventListener('abort', abort);
        resolvePromise({ code, out, err });
      });
    } catch {
      resolvePromise(null);
    }
  });
}

/** ffprobe's path if it runs, else null. */
export async function detectFfprobe(ffmpegSetting: string): Promise<string | null> {
  const command = ffprobePathFor(ffmpegSetting);
  const r = await run(command, ['-hide_banner', '-version']);
  return r && r.code === 0 ? command : null;
}

export type ProbeFileResult = { ok: true; media: ProbedMediaInput } | { ok: false; error: string };

/** Probe one file. `relative` is the handoff-relative path recorded with the result. */
export async function probeFile(ffprobe: string, absolute: string, relative: string, signal?: AbortSignal): Promise<ProbeFileResult> {
  const r = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', absolute], signal);
  if (!r) return { ok: false, error: 'ffprobe could not be started' };
  if (r.code !== 0) return { ok: false, error: r.err.trim().split('\n').pop() || `ffprobe exited with ${r.code}` };
  let json: unknown;
  try {
    json = JSON.parse(r.out);
  } catch {
    return { ok: false, error: 'ffprobe gave no readable answer' };
  }
  const media = parseFfprobe(json, relative);
  if (!media) return { ok: false, error: 'No picture stream in this file' };
  return { ok: true, media };
}

/** Shots worth probing: in prep, with no range from the handoff and none probed yet (or all, when asked). */
export function shotsToProbe(project: Project, all = false): string[] {
  return project.handoff.shots
    .filter((s) => shotState(project, s.shotId)?.stage === 'prep')
    .filter((s) => all || shotTiming(project, s) === null)
    .map((s) => s.shotId);
}

/** Probe the given shots' source clips (default: those whose range is unknown). */
export async function probeProject(
  project: Project,
  ffprobe: string,
  options: { shotIds?: string[]; signal?: AbortSignal; onProgress?: (done: number, total: number, shotId: string) => void } = {},
): Promise<ProbeResult[]> {
  if (isSampleHandoff(project.handoffPath)) return [];
  const ids = options.shotIds ?? shotsToProbe(project);
  const results: ProbeResult[] = [];
  for (const [i, shotId] of ids.entries()) {
    if (options.signal?.aborted) throw new Error('Cancelled');
    options.onProgress?.(i, ids.length, shotId);
    const shot = handoffShot(project, shotId);
    if (!shot) continue;
    const absolute = resolveFromHandoff(project.handoffPath, shot.sourcePath)!;
    if (!(await stat(absolute).catch(() => null))) {
      results.push({ shotId, error: `The source clip is not on the drive: ${shot.sourcePath}` });
      continue;
    }
    const r = await probeFile(ffprobe, absolute, shot.sourcePath, options.signal);
    results.push(r.ok ? { shotId, media: r.media } : { shotId, error: r.error });
  }
  options.onProgress?.(ids.length, ids.length, '');
  return results;
}
