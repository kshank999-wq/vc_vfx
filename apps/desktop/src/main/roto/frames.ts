import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { FORMAT_EXTENSIONS, handoffShot, plateColorFor, shotState, versionTag, viewTransform, type Project, type ViewPipeline } from '@vcvfx/domain';
import { buildRawFramesArgs, type DecodeHints, type FfmpegCaps, type SourceInput } from '../../shared/ffmpeg-args';
import type { RGBImage } from '../../shared/roto/image';
import { viewerTimeline } from '../../shared/viewer';
import { shotFolder } from '../package-shot';
import { isSampleHandoff, resolveFromHandoff } from '../paths';
import { hintsFrom, sourceInputFor } from '../sequence';
import { platesInFolder, viewLuts } from '../viewer';

/**
 * Where roto reads its frames, and reading them (addendum 04).
 *
 * The shot's newest plates when there are any (they are what the mattes go
 * with), otherwise the source clip, read the way the viewer reads it. Frames
 * are decoded by ffmpeg through the viewer's Rec.709 (approx.) view — for the
 * engines to look at, never written anywhere — at the working size, as raw
 * RGB, several at a time.
 */

export interface RotoFrameSpec {
  ffmpeg: string;
  source: SourceInput;
  /** The ffmpeg frame argument of delivered frame `first`; consecutive frames follow. */
  firstArg: number;
  first: number;
  last: number;
  frameRate: number;
  view: ViewPipeline;
  luts: { decode?: string; tone?: string };
  /** ffmpeg's working directory: where the view LUTs are. */
  lutDir: string;
  hints: DecodeHints;
  caps: FfmpegCaps;
  plate: { width: number; height: number };
  label: string;
}

export type FrameSourceResult = { ok: true; spec: RotoFrameSpec; plates: number | null } | { ok: false; reason: string };

/** The plate size for working-size arithmetic: the handoff's or probe's resolution, else the plates' own. */
export function workingSize(plate: { width: number; height: number }, workingWidth: number): { width: number; height: number } {
  const width = Math.min(plate.width, Math.max(256, Math.round(workingWidth)));
  const height = Math.max(16, Math.round((plate.height * width) / plate.width));
  return { width: width - (width % 2), height: height - (height % 2) };
}

export async function rotoFrameSource(
  project: Project,
  shotId: string,
  outputRoot: string | null,
  tools: { ffmpeg: string; caps: FfmpegCaps; cacheDir: string },
): Promise<FrameSourceResult> {
  const shot = handoffShot(project, shotId);
  const state = shotState(project, shotId);
  if (!shot || !state) return { ok: false, reason: `No shot ${shotId}` };
  if (isSampleHandoff(project.handoffPath)) return { ok: false, reason: 'The sample project has no media on disk. Open a real handoff to paint roto on its frames.' };
  const timeline = viewerTimeline(project, shotId);
  if (!timeline) return { ok: false, reason: 'The frame range is unknown. Read it from the clip first (Sequence plan › Read from clip).' };
  const decision = plateColorFor(project, shotId);
  const name = state.vfxShotId ?? shot.shotId;

  // Plates first: the newest version on disk.
  if (outputRoot) {
    const dir = join(shotFolder(project, shotId, outputRoot), '01_PLATES');
    const found = platesInFolder(await readdir(dir).catch(() => [] as string[]), name);
    const latest = found[found.length - 1];
    if (latest) {
      const record = state.plates.find((r) => r.version === latest.version);
      const view = viewTransform(record ? record.color.plateEncoding : decision.plateEncoding, 'rec709');
      const luts = await viewLuts(tools.cacheDir, view);
      const size = shot.resolution ?? state.probe?.resolution ?? null;
      return {
        ok: true,
        plates: latest.version,
        spec: {
          ffmpeg: tools.ffmpeg,
          source: { kind: 'sequence', pattern: join(dir, `${name}_plate_${versionTag(latest.version)}.%04d.${FORMAT_EXTENSIONS[latest.format]}`), startNumber: latest.first, frameRate: timeline.frameRate },
          firstArg: latest.first,
          first: latest.first,
          last: latest.last,
          frameRate: timeline.frameRate,
          view,
          luts: { ...(luts.decode ? { decode: luts.decode } : {}), ...(luts.tone ? { tone: luts.tone } : {}) },
          lutDir: luts.dir,
          hints: { yuv: false },
          caps: tools.caps,
          plate: size ?? (await probeSize(tools.ffmpeg, join(dir, `${name}_plate_${versionTag(latest.version)}.${String(latest.first).padStart(4, '0')}.${FORMAT_EXTENSIONS[latest.format]}`))),
          label: `plates ${versionTag(latest.version)}`,
        },
      };
    }
  }

  const abs = resolveFromHandoff(project.handoffPath, shot.sourcePath)!;
  const resolved = await sourceInputFor(abs, timeline.frameRate);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const view = viewTransform(decision.sourceEncoding, 'rec709');
  const luts = await viewLuts(tools.cacheDir, view);
  const index = timeline.clipIndex(timeline.first);
  const size = shot.resolution ?? state.probe?.resolution ?? null;
  return {
    ok: true,
    plates: null,
    spec: {
      ffmpeg: tools.ffmpeg,
      source: resolved.source,
      firstArg: resolved.source.kind === 'sequence' ? resolved.source.startNumber + index : index,
      first: timeline.first,
      last: timeline.last,
      frameRate: timeline.frameRate,
      view,
      luts: { ...(luts.decode ? { decode: luts.decode } : {}), ...(luts.tone ? { tone: luts.tone } : {}) },
      lutDir: luts.dir,
      hints: hintsFrom(state.probe),
      caps: tools.caps,
      plate: size ?? (await probeSize(tools.ffmpeg, resolved.source.kind === 'clip' ? resolved.source.path : resolved.source.pattern.replace(/%0(\d+)d/, (_m, n: string) => String(resolved.source.kind === 'sequence' ? resolved.source.startNumber : 0).padStart(Number(n), '0')))),
      label: 'source',
    },
  };
}

/** A file's frame size, from ffmpeg's own banner (ffprobe may not be beside a Settings ffmpeg). */
export async function probeSize(ffmpeg: string, file: string): Promise<{ width: number; height: number }> {
  const text = await new Promise<string>((resolvePromise) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-i', file], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', () => resolvePromise(''));
    child.on('close', () => resolvePromise(err));
  });
  const m = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(text);
  if (!m) throw new Error(`Could not read the frame size of ${file}`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

/**
 * Read `count` consecutive frames from delivered frame `from`, at `size`.
 * Calls `onFrame` for each as it arrives.
 */
export function readFrames(spec: RotoFrameSpec, from: number, count: number, size: { width: number; height: number }, onFrame: (frame: number, img: RGBImage) => void, signal?: AbortSignal): Promise<void> {
  const first = Math.max(spec.first, Math.min(spec.last, from));
  const n = Math.max(1, Math.min(count, spec.last - first + 1));
  const args = buildRawFramesArgs({
    source: spec.source,
    frame: spec.firstArg + (first - spec.first),
    frameRate: spec.frameRate,
    view: spec.view,
    luts: spec.luts,
    hints: spec.hints,
    caps: spec.caps,
    count: n,
    width: size.width,
    height: size.height,
  });
  const bytes = size.width * size.height * 3;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(spec.ffmpeg, args, { cwd: spec.lutDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const abort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    let pending: Buffer[] = [];
    let have = 0;
    let index = 0;
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => {
      pending.push(chunk);
      have += chunk.length;
      while (have >= bytes && index < n) {
        const all = Buffer.concat(pending);
        const frame = new Uint8Array(all.subarray(0, bytes));
        const rest = all.subarray(bytes);
        pending = rest.length ? [rest] : [];
        have = rest.length;
        onFrame(first + index, { width: size.width, height: size.height, data: frame });
        index += 1;
      }
    });
    child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
    child.on('error', (e) => {
      signal?.removeEventListener('abort', abort);
      reject(e);
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return reject(new Error('Cancelled'));
      if (index < n) return reject(new Error(`ffmpeg gave ${index} of ${n} frames from ${first}${err ? `: ${err.trim().split('\n').pop()}` : ` (exit ${code})`}`));
      resolvePromise();
    });
  });
}

/**
 * Frames on demand, read ahead in the direction of travel and kept in a small
 * cache — propagation walks frame by frame, forward or backward.
 */
export class FrameReader {
  private cache = new Map<number, RGBImage>();
  private last: number | null = null;

  constructor(
    private readonly spec: RotoFrameSpec,
    private readonly size: { width: number; height: number },
    private readonly options: { chunk?: number; keep?: number; signal?: AbortSignal } = {},
  ) {}

  async frame(f: number): Promise<RGBImage> {
    const hit = this.cache.get(f);
    const direction = this.last === null ? 1 : f >= this.last ? 1 : -1;
    this.last = f;
    if (hit) return hit;
    const chunk = Math.max(1, this.options.chunk ?? 12);
    const start = direction > 0 ? f : Math.max(this.spec.first, f - chunk + 1);
    const count = direction > 0 ? Math.min(chunk, this.spec.last - f + 1) : f - start + 1;
    await readFrames(this.spec, start, count, this.size, (n, img) => this.cache.set(n, img), this.options.signal);
    const keep = this.options.keep ?? 3 * chunk;
    if (this.cache.size > keep) {
      // Drop the frames furthest from where we are.
      const order = [...this.cache.keys()].sort((a, b) => Math.abs(b - f) - Math.abs(a - f));
      for (const k of order.slice(0, this.cache.size - keep)) this.cache.delete(k);
    }
    const got = this.cache.get(f);
    if (!got) throw new Error(`Frame ${f} could not be read`);
    return got;
  }
}
