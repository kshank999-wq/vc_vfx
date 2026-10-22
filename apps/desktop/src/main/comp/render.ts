import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compNames, versionTag, type CompEdge, type CompNode } from '@vcvfx/domain';
import { CompEvaluator } from '../../shared/comp/evaluate';
import { alphaOf, rgbOf } from '../../shared/comp/image';
import { toPlanar } from '../../shared/key/ffmpeg-key';
import { toDisplay } from '../../shared/key/linear';
import { ExrStream } from '../key/export';
import { encodePngRgb } from '../roto/png';
import { createCompIO, type CompIOJob } from './io';

/**
 * Rendering the comp and baking nodes Nuke has no class for (addendum 13
 * §5–6), in the comp worker. Made again from source + graph at plate
 * resolution, frame by frame; written as half-float EXR (ZIP16), linear,
 * premultiplied, no look — and, beside it, a review encode through the
 * viewer's Rec.709 (approx.) view, which is only ever a review file.
 * Versioned, never overwritten: an approved version on disk is refused; an
 * unapproved one has only its own files cleared and written again. Nothing
 * is written under the source paths (the caller checks the output root).
 */

export interface CompRenderJob {
  io: CompIOJob;
  nodes: CompNode[];
  edges: CompEdge[];
  write: string;
  first: number;
  last: number;
  /** Absolute `08_PREVIEWS/<shot>_comp_vNNN`. */
  folder: string;
  shot: string;
  version: number;
  approved: boolean;
  review: 'jpeg' | 'png' | 'none';
  channels: 'rgba' | 'rgb';
  fps: number;
}

export interface CompRenderResult {
  files: string[];
  width: number;
  height: number;
  seconds: number;
}

export interface CompBakeJob {
  io: CompIOJob;
  nodes: CompNode[];
  edges: CompEdge[];
  bake: { id: string; name: string }[];
  first: number;
  last: number;
  /** Absolute `09_PROJECT_DATA/<shot>_comp_vNNN`. */
  folder: string;
  shot: string;
  version: number;
  approved: boolean;
  fps: number;
}

/** Clear an unapproved version's own files in a folder; refuse an approved one that is on disk. */
export async function clearCompVersion(folder: string, shot: string, version: number, approved: boolean, extra: string[] = []): Promise<void> {
  const names = await readdir(folder).catch(() => null);
  if (!names) return;
  const tag = versionTag(version);
  const ours = names.filter((x) => (x.startsWith(compNames.prefix(shot)) && x.includes(`_${tag}`)) || x === compNames.readme() || extra.includes(x));
  if (!ours.length) return;
  if (approved) throw new Error(`${folder} already holds the approved comp ${tag}; it is never rewritten. Reopen the comp to make a new version.`);
  for (const x of ours) await rm(join(folder, x), { recursive: true, force: true });
}

/** A JPEG sequence from 8-bit RGB frames on stdin (`-n`: never overwrite). */
class JpegStream {
  private child: ChildProcessWithoutNullStreams;
  private done: Promise<void>;
  private err = '';
  constructor(ffmpeg: string, width: number, height: number, fps: number, start: number, output: string, signal?: AbortSignal) {
    const args = ['-hide_banner', '-nostdin', '-v', 'error', '-n', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`, '-framerate', String(fps), '-i', 'pipe:0', '-c:v', 'mjpeg', '-q:v', '2', '-pix_fmt', 'yuvj444p', '-start_number', String(start), '-f', 'image2', output];
    this.child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] }) as unknown as ChildProcessWithoutNullStreams;
    const abort = () => this.child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    this.child.stderr.on('data', (d: Buffer) => (this.err = (this.err + d.toString()).slice(-2000)));
    this.done = new Promise((resolvePromise, reject) => {
      this.child.on('error', reject);
      this.child.on('close', (code) => {
        signal?.removeEventListener('abort', abort);
        if (code === 0) resolvePromise();
        else reject(new Error(signal?.aborted ? 'Cancelled' : `ffmpeg could not write the review JPEGs: ${this.err.trim().split('\n').pop() ?? `exit ${code}`}`));
      });
    });
    this.done.catch(() => undefined);
  }
  async write(rgb: Uint8ClampedArray): Promise<void> {
    if (!this.child.stdin.write(Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength))) await new Promise<void>((r) => this.child.stdin.once('drain', () => r()));
  }
  async close(): Promise<void> {
    this.child.stdin.end();
    await this.done;
  }
}

const frameName = (pattern: string, f: number) => pattern.replace(/%0(\d+)d/, (_m, n: string) => String(f).padStart(Number(n), '0'));

export async function renderComp(job: CompRenderJob, o: { signal?: AbortSignal; onProgress?: (done: number, total: number, frame?: number) => void } = {}): Promise<CompRenderResult> {
  const started = Date.now();
  await clearCompVersion(job.folder, job.shot, job.version, job.approved);
  await mkdir(job.folder, { recursive: true });
  const io = createCompIO(job.io, o.signal);
  const ev = new CompEvaluator(io, 1024 * 1024 * 1024);
  const doc = { nodes: job.nodes, edges: job.edges };
  const { width, height } = io.plate;
  const n = width * height;
  const pattern = compNames.renderPattern(job.shot, job.version);
  const reviewPattern = job.review === 'none' ? null : compNames.reviewPattern(job.shot, job.version, job.review);
  const exr = new ExrStream(job.io.ffmpeg, job.channels, width, height, job.fps, job.first, join(job.folder, pattern), o.signal);
  const jpeg = job.review === 'jpeg' ? new JpegStream(job.io.ffmpeg, width, height, job.fps, job.first, join(job.folder, reviewPattern!), o.signal) : null;
  const files: string[] = [];
  const total = job.last - job.first + 1;
  try {
    for (let f = job.first; f <= job.last; f += 1) {
      if (o.signal?.aborted) throw new Error('Cancelled');
      const img = await ev.evaluate(doc, job.write, f, { scale: 1, ...(o.signal ? { signal: o.signal } : {}) });
      const rgb = rgbOf(img).data;
      await exr.write(toPlanar(job.channels, n, rgb, job.channels === 'rgba' ? alphaOf(img) : null));
      files.push(frameName(pattern, f));
      if (reviewPattern) {
        const display = toDisplay(rgb, n, job.io.space);
        if (jpeg) await jpeg.write(display);
        else await writeFile(join(job.folder, frameName(reviewPattern, f)), encodePngRgb(width, height, display));
        files.push(frameName(reviewPattern, f));
      }
      o.onProgress?.(f - job.first + 1, total, f);
    }
  } catch (error) {
    void exr.close().catch(() => undefined);
    void jpeg?.close().catch(() => undefined);
    throw error;
  }
  await exr.close();
  await jpeg?.close();
  return { files, width, height, seconds: (Date.now() - started) / 1000 };
}

/** Render each node Nuke has no class for (Despill, LightWrap) as its own EXR sequence, for the script to read. */
export async function bakeComp(job: CompBakeJob, o: { signal?: AbortSignal; onProgress?: (done: number, total: number, frame?: number) => void } = {}): Promise<{ files: string[] }> {
  await clearCompVersion(job.folder, job.shot, job.version, job.approved, ['baked']);
  await mkdir(join(job.folder, 'baked'), { recursive: true });
  const io = createCompIO(job.io, o.signal);
  const ev = new CompEvaluator(io, 1024 * 1024 * 1024);
  const doc = { nodes: job.nodes, edges: job.edges };
  const { width, height } = io.plate;
  const n = width * height;
  const files: string[] = [];
  const streams = job.bake.map((b) => ({ ...b, pattern: compNames.bakedPattern(job.shot, job.version, b.name), stream: new ExrStream(job.io.ffmpeg, 'rgba', width, height, job.fps, job.first, join(job.folder, compNames.bakedPattern(job.shot, job.version, b.name)), o.signal) }));
  const total = (job.last - job.first + 1) * Math.max(1, streams.length);
  let done = 0;
  try {
    for (let f = job.first; f <= job.last; f += 1)
      for (const s of streams) {
        if (o.signal?.aborted) throw new Error('Cancelled');
        const img = await ev.evaluate(doc, s.id, f, { scale: 1, ...(o.signal ? { signal: o.signal } : {}) });
        await s.stream.write(toPlanar('rgba', n, rgbOf(img).data, alphaOf(img)));
        files.push(frameName(s.pattern, f));
        o.onProgress?.(++done, total, f);
      }
  } catch (error) {
    for (const s of streams) void s.stream.close().catch(() => undefined);
    throw error;
  }
  for (const s of streams) await s.stream.close();
  return { files };
}
