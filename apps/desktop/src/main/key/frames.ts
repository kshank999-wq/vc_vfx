import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { FORMAT_EXTENSIONS, handoffShot, plateColorFor, shotState, versionTag, type ColorEncodingId, type Project } from '@vcvfx/domain';
import type { DecodeHints, FfmpegCaps, SourceInput } from '../../shared/ffmpeg-args';
import { buildLinearFramesArgs } from '../../shared/key/ffmpeg-key';
import { convertLinear, decodePlanar, workingSpace, type LinearImage, type WorkingSpace } from '../../shared/key/linear';
import { viewerTimeline } from '../../shared/viewer';
import { shotFolder } from '../package-shot';
import { isSampleHandoff, resolveFromHandoff } from '../paths';
import { probeSize } from '../roto/frames';
import { hintsFrom, sourceInputFor } from '../sequence';
import { platesInFolder } from '../viewer';

/**
 * Where the keyer reads its frames, and reading them in linear light
 * (addendum 09 §4).
 *
 * The shot's newest plates when there are any (the key goes with them),
 * otherwise the source clip. Frames come out of ffmpeg as float code values
 * and are decoded to linear here (shared/key/linear.ts) — EXR ACEScg plates
 * as they are, camera log through its published curve and matrix to ACEScg.
 * Nothing is written anywhere by reading.
 */

export interface KeyFrameSpec {
  ffmpeg: string;
  source: SourceInput;
  /** The ffmpeg frame argument of delivered frame `first`; consecutive frames follow. */
  firstArg: number;
  first: number;
  last: number;
  frameRate: number;
  hints: DecodeHints;
  caps: FfmpegCaps;
  plate: { width: number; height: number };
  /** The encoding of the frames' code values (null: unknown). */
  encoding: ColorEncodingId | null;
  label: string;
}

export type KeySourceResult = { ok: true; spec: KeyFrameSpec; plates: number | null; space: WorkingSpace } | { ok: false; reason: string };

export async function keyFrameSource(project: Project, shotId: string, outputRoot: string | null, tools: { ffmpeg: string; caps: FfmpegCaps }): Promise<KeySourceResult> {
  const shot = handoffShot(project, shotId);
  const state = shotState(project, shotId);
  if (!shot || !state) return { ok: false, reason: `No shot ${shotId}` };
  if (isSampleHandoff(project.handoffPath)) return { ok: false, reason: 'The sample project has no media on disk. Open a real handoff to key its frames.' };
  const timeline = viewerTimeline(project, shotId);
  if (!timeline) return { ok: false, reason: 'The frame range is unknown. Read it from the clip first (Sequence plan › Read from clip).' };
  const decision = plateColorFor(project, shotId);
  const name = state.vfxShotId ?? shot.shotId;
  const size = shot.resolution ?? state.probe?.resolution ?? null;
  if (outputRoot) {
    const dir = join(shotFolder(project, shotId, outputRoot), '01_PLATES');
    const found = platesInFolder(await readdir(dir).catch(() => [] as string[]), name);
    const latest = found[found.length - 1];
    if (latest) {
      const record = state.plates.find((r) => r.version === latest.version);
      const encoding = record ? record.color.plateEncoding : decision.plateEncoding;
      const pattern = join(dir, `${name}_plate_${versionTag(latest.version)}.%04d.${FORMAT_EXTENSIONS[latest.format]}`);
      const spec: KeyFrameSpec = {
        ffmpeg: tools.ffmpeg,
        source: { kind: 'sequence', pattern, startNumber: latest.first, frameRate: timeline.frameRate },
        firstArg: latest.first,
        first: latest.first,
        last: latest.last,
        frameRate: timeline.frameRate,
        hints: { yuv: false },
        caps: tools.caps,
        plate: size ?? (await probeSize(tools.ffmpeg, pattern.replace('%04d', String(latest.first).padStart(4, '0')))),
        encoding,
        label: `plates ${versionTag(latest.version)}`,
      };
      return { ok: true, plates: latest.version, spec, space: workingSpace(encoding) };
    }
  }
  const abs = resolveFromHandoff(project.handoffPath, shot.sourcePath)!;
  const resolved = await sourceInputFor(abs, timeline.frameRate);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const index = timeline.clipIndex(timeline.first);
  const spec: KeyFrameSpec = {
    ffmpeg: tools.ffmpeg,
    source: resolved.source,
    firstArg: resolved.source.kind === 'sequence' ? resolved.source.startNumber + index : index,
    first: timeline.first,
    last: timeline.last,
    frameRate: timeline.frameRate,
    // A movie file not yet read by ffprobe is taken as YCbCr (Rec.709, video range), as the plates take an untagged one.
    hints: state.probe ? hintsFrom(state.probe) : resolved.source.kind === 'clip' ? { yuv: true } : { yuv: false },
    caps: tools.caps,
    plate:
      size ??
      (await probeSize(tools.ffmpeg, resolved.source.kind === 'clip' ? resolved.source.path : resolved.source.pattern.replace(/%0(\d+)d/, (_m, n: string) => String(resolved.source.kind === 'sequence' ? resolved.source.startNumber : 0).padStart(Number(n), '0')))),
    encoding: decision.sourceEncoding,
    label: 'source',
  };
  return { ok: true, plates: null, spec, space: workingSpace(decision.sourceEncoding) };
}

/** The size the keyer works at for a longest edge of `workingWidth` (never more than the plate). */
export function keyWorkingSize(plate: { width: number; height: number }, workingWidth: number): { width: number; height: number } {
  const width = Math.min(plate.width, Math.max(256, Math.round(workingWidth)));
  const height = Math.max(16, Math.round((plate.height * width) / plate.width));
  return { width: width - (width % 2), height: height - (height % 2) };
}

function runRaw(ffmpeg: string, args: string[], frameBytes: number, count: number, onFrame: (index: number, buf: Buffer) => void, signal?: AbortSignal): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const abort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    let pending: Buffer[] = [];
    let have = 0;
    let index = 0;
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => {
      pending.push(chunk);
      have += chunk.length;
      while (have >= frameBytes && index < count) {
        const all = pending.length === 1 ? pending[0]! : Buffer.concat(pending);
        const frame = Buffer.from(all.subarray(0, frameBytes));
        const rest = all.subarray(frameBytes);
        pending = rest.length ? [rest] : [];
        have = rest.length;
        onFrame(index, frame);
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
      if (index < count && code !== 0) return reject(new Error(`ffmpeg gave ${index} of ${count} frames${err ? `: ${err.trim().split('\n').pop()}` : ` (exit ${code})`}`));
      resolvePromise(index);
    });
  });
}

const planesOf = (buf: Buffer) => new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

/** Read `count` consecutive frames from delivered frame `from`, at `size`, decoded to linear. */
export async function readLinearFrames(spec: KeyFrameSpec, from: number, count: number, size: { width: number; height: number }, onFrame: (frame: number, img: LinearImage) => void, signal?: AbortSignal): Promise<void> {
  const first = Math.max(spec.first, Math.min(spec.last, from));
  const n = Math.max(1, Math.min(count, spec.last - first + 1));
  const args = buildLinearFramesArgs({ source: spec.source, frame: spec.firstArg + (first - spec.first), frameRate: spec.frameRate, count: n, width: size.width, height: size.height, native: size.width === spec.plate.width && size.height === spec.plate.height, hints: spec.hints, caps: spec.caps });
  const bytes = size.width * size.height * 3 * 4;
  const got = await runRaw(spec.ffmpeg, args, bytes, n, (i, buf) => onFrame(first + i, decodePlanar(planesOf(buf), size.width, size.height, spec.encoding)), signal);
  if (got < n) throw new Error(`ffmpeg gave ${got} of ${n} frames from ${first}`);
}

/** Frames on demand, read ahead in the direction of travel, a few kept. */
export class LinearFrameReader {
  private cache = new Map<number, LinearImage>();
  private last: number | null = null;

  constructor(
    private readonly spec: KeyFrameSpec,
    readonly size: { width: number; height: number },
    private readonly options: { chunk?: number; keep?: number; signal?: AbortSignal } = {},
  ) {}

  /** A frame already read, or null. */
  peek(f: number): LinearImage | null {
    return this.cache.get(f) ?? null;
  }

  async frame(f: number): Promise<LinearImage> {
    const hit = this.cache.get(f);
    const direction = this.last === null ? 1 : f >= this.last ? 1 : -1;
    this.last = f;
    if (hit) return hit;
    const chunk = Math.max(1, this.options.chunk ?? 6);
    const start = direction > 0 ? f : Math.max(this.spec.first, f - chunk + 1);
    const count = direction > 0 ? Math.min(chunk, this.spec.last - f + 1) : f - start + 1;
    await readLinearFrames(this.spec, start, count, this.size, (n, img) => this.cache.set(n, img), this.options.signal);
    const keep = this.options.keep ?? 2 * chunk;
    if (this.cache.size > keep) {
      const order = [...this.cache.keys()].sort((a, b) => Math.abs(b - f) - Math.abs(a - f));
      for (const k of order.slice(0, this.cache.size - keep)) this.cache.delete(k);
    }
    const got = this.cache.get(f);
    if (!got) throw new Error(`Frame ${f} could not be read`);
    return got;
  }
}

export interface BackgroundSpec {
  ffmpeg: string;
  caps: FfmpegCaps;
  /** An image file, or the shot's own frames. */
  file: string | null;
  frame: number | null;
  /** How the file's values are read: an EXR as linear in the working encoding; anything else as sRGB. */
  encoding: ColorEncodingId | null;
  label: string;
}

/**
 * The background reference, as a spec a worker can read: the handoff's
 * background plate, a chosen file, or a frame of this shot (null: none, or
 * not on disk). An EXR is read as linear in the working encoding; other
 * image files as sRGB.
 */
export function backgroundSpec(project: Project, shotId: string, tools: { ffmpeg: string; caps: FfmpegCaps }, space: WorkingSpace): { spec: BackgroundSpec | null; reason: string | null } {
  const doc = shotState(project, shotId)?.key;
  const bg = doc?.despill.background;
  if (!bg || bg.kind === 'none') return { spec: null, reason: null };
  if (bg.kind === 'frame') return { spec: { ffmpeg: tools.ffmpeg, caps: tools.caps, file: null, frame: bg.frame, encoding: null, label: bg.label || `frame ${bg.frame}` }, reason: null };
  const file = bg.kind === 'reference' ? resolveFromHandoff(project.handoffPath, bg.path ?? '') : bg.path;
  if (!file || !existsSync(file)) return { spec: null, reason: `The background ${bg.path ?? ''} is not on the drive.` };
  const exr = extname(file).toLowerCase() === '.exr';
  return { spec: { ffmpeg: tools.ffmpeg, caps: tools.caps, file, frame: null, encoding: exr ? space.encoding : 'srgb', label: bg.label || file.split(/[\\/]/).pop() || file }, reason: null };
}

/** Read the background at `size` in linear working RGB (an image file; frames of the shot are read by the caller). */
export async function readBackgroundFile(spec: BackgroundSpec, size: { width: number; height: number }, space: WorkingSpace, signal?: AbortSignal): Promise<LinearImage | null> {
  if (!spec.file) return null;
  const args = buildLinearFramesArgs({ source: { kind: 'clip', path: spec.file }, frame: 0, frameRate: 24, count: 1, width: size.width, height: size.height, native: false, caps: spec.caps });
  let out: LinearImage | null = null;
  await runRaw(spec.ffmpeg, args, size.width * size.height * 12, 1, (_i, buf) => {
    const raw = spec.encoding === space.encoding ? null : spec.encoding;
    let img = decodePlanar(planesOf(buf), size.width, size.height, raw);
    // Display files decode to ACEScg; bring them to a linear plate's own encoding.
    if (raw && space.encoding && space.encoding !== 'acescg') img = convertLinear(img, 'acescg', space.encoding);
    out = img;
  }, signal);
  return out;
}
