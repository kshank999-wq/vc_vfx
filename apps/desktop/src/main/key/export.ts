import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { keyNames, versionTag } from '@vcvfx/domain';
import { buildExrWriteArgs, toPlanar, type ExrLayout } from '../../shared/key/ffmpeg-key';
import { ShotKeyer, checkCancel, shotScreenModel, type KeySettings } from '../../shared/key/engine';
import type { ScreenModel } from '../../shared/key/cleanplate';
import { to16 } from '../../shared/roto/refine';
import { encodePng } from '../roto/png';
import { createKeyIO, type KeyIOJob } from './io';

/**
 * Writing a key into the shot package (master spec §6, §7 "prep-only
 * output", §17; addendum 09 §7):
 *
 *   03_KEYS/<shot>_key_vNNN/
 *     <shot>_key_alpha_vNNN.<frame>.png       16-bit straight alpha (and .exr, one Y channel, when asked)
 *     <shot>_key_fg_vNNN.<frame>.exr          despilled foreground, RGBA half, premultiplied, linear, no look
 *     <shot>_key_core_vNNN / _edge_vNNN       core and edge mattes, 16-bit PNG, when asked
 *     <shot>_key_lightwrap_vNNN.<frame>.exr   the light-wrap layer, RGB half, additive, when asked
 *     <shot>_key_vNNN.json, README.txt        written by the caller
 *
 * Keyed again at plate resolution from source + settings (not scaled-up
 * review mattes), every frame of the shot, the same frame numbers as the
 * plates. Versioned, never overwritten: an approved version already on disk
 * is refused; an unapproved one has only its own files cleared and written
 * again.
 */

export interface KeyExportOptions {
  foreground: boolean;
  core: boolean;
  edge: boolean;
  alphaExr: boolean;
  lightWrap: boolean;
}

export interface KeyExportJob {
  io: KeyIOJob;
  settings: KeySettings;
  /** The clean-plate model; null: built in the worker from `modelIO` (working size) first. */
  model: { gw: number; gh: number; grid: number[]; observed: number; support?: number[] } | null;
  modelIO?: KeyIOJob;
  shot: string;
  version: number;
  approved: boolean;
  /** Absolute path of `03_KEYS/<shot>_key_vNNN`. */
  folder: string;
  first: number;
  last: number;
  options: KeyExportOptions;
  generator: string;
}

export interface KeyExportResult {
  files: string[];
  width: number;
  height: number;
  frames: { frame: number; confidence: number }[];
}

export const modelToJson = (m: ScreenModel) => ({ gw: m.gw, gh: m.gh, grid: Array.from(m.grid), observed: m.observed, ...(m.support ? { support: Array.from(m.support) } : {}) });
export const modelFromJson = (m: NonNullable<KeyExportJob['model']>): ScreenModel => ({ gw: m.gw, gh: m.gh, grid: Float32Array.from(m.grid), observed: m.observed, ...(m.support ? { support: Float32Array.from(m.support) } : {}) });

/** Clear an unapproved version's own files; refuse an approved one that is on disk. */
export async function clearKeyVersion(folder: string, shot: string, version: number, approved: boolean): Promise<void> {
  const names = await readdir(folder).catch(() => null);
  if (!names) return;
  const tag = versionTag(version);
  const ours = names.filter((n) => (n.startsWith(`${shot}_key_`) && n.includes(`_${tag}`)) || n === keyNames.readme());
  if (!ours.length) return;
  if (approved) throw new Error(`${folder} already holds the approved key ${tag}; it is never rewritten. Reopen the key to make a new version.`);
  for (const n of ours) await rm(join(folder, n), { force: true });
}

export class ExrStream {
  private child: ChildProcessWithoutNullStreams;
  private done: Promise<void>;
  private err = '';

  constructor(ffmpeg: string, readonly layout: ExrLayout, width: number, height: number, frameRate: number, startNumber: number, output: string, signal?: AbortSignal) {
    this.child = spawn(ffmpeg, buildExrWriteArgs({ layout, width, height, frameRate, startNumber, output }), { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] }) as unknown as ChildProcessWithoutNullStreams;
    const abort = () => this.child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    this.child.stderr.on('data', (d: Buffer) => (this.err = (this.err + d.toString()).slice(-2000)));
    this.done = new Promise((resolvePromise, reject) => {
      this.child.on('error', reject);
      this.child.on('close', (code) => {
        signal?.removeEventListener('abort', abort);
        if (code === 0) resolvePromise();
        else reject(new Error(signal?.aborted ? 'Cancelled' : `ffmpeg could not write the EXR ${layout} sequence: ${this.err.trim().split('\n').pop() ?? `exit ${code}`}`));
      });
    });
    this.done.catch(() => undefined);
  }

  async write(planes: Float32Array): Promise<void> {
    const buf = Buffer.from(planes.buffer, planes.byteOffset, planes.byteLength);
    if (!this.child.stdin.write(buf)) await new Promise<void>((r) => this.child.stdin.once('drain', () => r()));
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    await this.done;
  }
}

export async function exportKey(job: KeyExportJob, o: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}): Promise<KeyExportResult> {
  const { shot, version, folder, options } = job;
  const { width, height } = job.io.frames.plate;
  if (job.io.size.width !== width || job.io.size.height !== height) throw new Error('A key is exported at plate resolution');
  await clearKeyVersion(folder, shot, version, job.approved);
  await mkdir(folder, { recursive: true });
  const io = createKeyIO(job.io, o.signal);
  const ffmpeg = job.io.frames.ffmpeg;
  const fps = job.io.frames.frameRate;
  const pattern = (p: string) => join(folder, p);
  const fg = options.foreground ? new ExrStream(ffmpeg, 'rgba', width, height, fps, job.first, pattern(keyNames.foregroundPattern(shot, version)), o.signal) : null;
  const wrapOn = options.lightWrap && job.io.background !== null;
  const wrap = wrapOn ? new ExrStream(ffmpeg, 'rgb', width, height, fps, job.first, pattern(keyNames.lightWrapPattern(shot, version)), o.signal) : null;
  const alphaExr = options.alphaExr ? new ExrStream(ffmpeg, 'y', width, height, fps, job.first, pattern(keyNames.alphaExrPattern(shot, version)), o.signal) : null;
  const streams = [fg, wrap, alphaExr].filter((s): s is ExrStream => s !== null);
  const files: string[] = [];
  const frames: { frame: number; confidence: number }[] = [];
  const total = job.last - job.first + 1;
  const n = width * height;
  const text = { Software: job.generator, Description: `${shot} key ${versionTag(version)}, straight alpha` };
  const settings = { ...job.settings, lightWrap: { ...job.settings.lightWrap, output: wrapOn } };
  let model: ScreenModel;
  if (job.model) model = modelFromJson(job.model);
  else {
    if (!job.modelIO) throw new Error('The export needs a clean-plate model or the frames to build it from');
    model = await shotScreenModel(createKeyIO(job.modelIO, o.signal), job.settings, job.first, job.last);
  }
  const keyer = new ShotKeyer(settings, model);
  try {
    for (let f = job.first; f <= job.last; f += 1) {
      checkCancel(o.signal);
      const img = await io.frame(f);
      const out = await keyer.keyAt(io, f, img, { pxScale: 1, luma: job.io.space.luma, foreground: options.foreground || wrapOn });
      const alpha16 = to16({ width, height, data: out.alpha });
      await writeFile(join(folder, keyNames.alphaFile(shot, version, f)), encodePng({ width, height, bitDepth: 16, data: alpha16 }, { text }));
      files.push(keyNames.alphaFile(shot, version, f));
      if (options.core) {
        const core = Uint16Array.from(out.core, (v) => (v ? 65535 : 0));
        await writeFile(join(folder, keyNames.coreFile(shot, version, f)), encodePng({ width, height, bitDepth: 16, data: core }, { text }));
        files.push(keyNames.coreFile(shot, version, f));
      }
      if (options.edge) {
        await writeFile(join(folder, keyNames.edgeFile(shot, version, f)), encodePng({ width, height, bitDepth: 16, data: to16({ width, height, data: out.edge }) }, { text }));
        files.push(keyNames.edgeFile(shot, version, f));
      }
      if (fg) {
        await fg.write(toPlanar('rgba', n, out.fg, out.alpha));
        files.push(keyNames.foregroundFile(shot, version, f));
      }
      if (wrap) {
        await wrap.write(toPlanar('rgb', n, out.wrap ?? new Float32Array(n * 3), null));
        files.push(keyNames.lightWrapFile(shot, version, f));
      }
      if (alphaExr) {
        await alphaExr.write(toPlanar('y', n, null, out.alpha));
        files.push(keyNames.alphaFile(shot, version, f).replace(/\.png$/, '.exr'));
      }
      frames.push({ frame: f, confidence: out.confidence });
      o.onProgress?.(frames.length, total);
    }
  } catch (error) {
    for (const s of streams) void s.close().catch(() => undefined);
    throw error;
  }
  for (const s of streams) await s.close();
  return { files, width, height, frames };
}
