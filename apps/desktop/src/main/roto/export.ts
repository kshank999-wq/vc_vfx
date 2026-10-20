import { spawn } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { combineAlpha16, rotoNames, type RotoPart, type RotoRefine } from '@vcvfx/domain';
import { toGray, type RGBImage } from '../../shared/roto/image';
import { refinersUsed, to16, upscaleAlpha } from '../../shared/roto/refine';
import { readFrames, type RotoFrameSpec } from './frames';
import { encodePng } from './png';
import type { MaskStore } from './store';

/**
 * Writing the mattes into the shot package (master spec §5.2 final bullet,
 * §17; addendum 04):
 *
 *   02_MATTES_ROTO/<shot>_matte_vNNN/<shot>_matte_vNNN.<frame>.png        the subject matte
 *   02_MATTES_ROTO/<shot>_roto_<part>_vNNN/<shot>_roto_<part>_vNNN.<frame>.png   each part
 *   02_MATTES_ROTO/<shot>_roto_vNNN.json                                  metadata (written by the caller)
 *
 * 16-bit greyscale PNG at plate resolution, straight alpha, every frame of the
 * shot (zero where a part has no matte). The working mattes are scaled up,
 * their edges snapped to the full-resolution frame, refined per part, and
 * combined by the part hierarchy. Optionally the same as half-float EXR
 * (single Y channel) beside each PNG.
 *
 * Versioned, never overwritten: an approved version that is already on disk
 * is refused; an unapproved one is cleared (only its own files) and written
 * again.
 */

export interface ExportJob {
  frames: RotoFrameSpec;
  shot: string;
  version: number;
  approved: boolean;
  /** Absolute path of the shot package's 02_MATTES_ROTO. */
  folder: string;
  first: number;
  last: number;
  parts: Pick<RotoPart, 'id' | 'name' | 'parentId' | 'combine' | 'refine'>[];
  exr: boolean;
  ffmpeg: string;
  generator: string;
}

export interface ExportResult {
  folder: string;
  files: string[];
  width: number;
  height: number;
  refiners: Record<string, string[]>;
}

async function clearVersion(dir: string, prefix: string, approved: boolean): Promise<void> {
  const names = await readdir(dir).catch(() => null);
  if (!names) return;
  const ours = names.filter((n) => n.startsWith(prefix));
  if (!ours.length) return;
  if (approved) throw new Error(`${dir} already holds the approved mattes of this version; they are never rewritten. Reopen roto to make a new version.`);
  for (const n of ours) await rm(join(dir, n), { force: true });
}

function runFfmpeg(ffmpeg: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const abort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
    child.on('error', reject);
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (code === 0) resolvePromise();
      else reject(new Error(`ffmpeg could not write the EXR mattes: ${err.trim().split('\n').pop() ?? `exit ${code}`}`));
    });
  });
}

export async function exportMattes(job: ExportJob, store: MaskStore, options: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}): Promise<ExportResult> {
  const { shot, version } = job;
  const width = job.frames.plate.width;
  const height = job.frames.plate.height;
  const matteDir = join(job.folder, rotoNames.matteFolder(shot, version));
  const partDirs = new Map(job.parts.map((p) => [p.id, join(job.folder, rotoNames.partFolder(shot, p.id, version))]));
  await clearVersion(matteDir, `${shot}_matte_v${String(version).padStart(3, '0')}.`, job.approved);
  for (const p of job.parts) await clearVersion(partDirs.get(p.id)!, `${shot}_roto_${p.id}_v${String(version).padStart(3, '0')}.`, job.approved);
  await mkdir(matteDir, { recursive: true });
  for (const dir of partDirs.values()) await mkdir(dir, { recursive: true });

  const files: string[] = [];
  const refiners: Record<string, string[]> = {};
  const doc = { formatVersion: 1 as const, parts: job.parts.map((p) => ({ ...p, color: '#000000', visible: true, keyFrames: [], engine: { id: 'track' as const, version: '', settings: {} }, frames: [] })), runs: [], exports: [], workingWidth: 1920, seq: 0 };
  const total = job.last - job.first + 1;
  const text = { Software: job.generator, Description: `${shot} roto v${String(version).padStart(3, '0')}, straight alpha` };
  const chunk = 6;
  let done = 0;
  for (let start = job.first; start <= job.last; start += chunk) {
    if (options.signal?.aborted) throw new Error('Cancelled');
    const count = Math.min(chunk, job.last - start + 1);
    const frames = new Map<number, RGBImage>();
    await readFrames(job.frames, start, count, { width, height }, (f, img) => frames.set(f, img), options.signal);
    for (let f = start; f < start + count; f += 1) {
      const img = frames.get(f)!;
      const guide = toGray(img);
      const own = new Map<string, Uint16Array>();
      for (const p of job.parts) {
        const working = await store.get(p.id, version, f);
        if (!working) continue;
        const refine: RotoRefine = p.refine;
        refiners[p.id] ??= refinersUsed(refine, { pxScale: 1, guide, upscaled: working.width !== width });
        own.set(p.id, to16(upscaleAlpha(working, width, height, guide, refine)));
      }
      const zero = new Uint16Array(width * height);
      for (const p of job.parts) {
        const data = own.get(p.id) ?? zero;
        const name = rotoNames.partFile(shot, p.id, version, f);
        await writeFile(join(partDirs.get(p.id)!, name), encodePng({ width, height, bitDepth: 16, data }, { text }));
        files.push(`${rotoNames.partFolder(shot, p.id, version)}/${name}`);
      }
      const combined = combineAlpha16(doc, width * height, (id) => own.get(id) ?? null);
      const name = rotoNames.matteFile(shot, version, f);
      await writeFile(join(matteDir, name), encodePng({ width, height, bitDepth: 16, data: combined }, { text }));
      files.push(`${rotoNames.matteFolder(shot, version)}/${name}`);
      done += 1;
      options.onProgress?.(done, total + (job.exr ? 1 : 0));
    }
  }

  if (job.exr) {
    // Half-float EXR, one Y (alpha) channel, ZIP compressed, beside each PNG.
    const sets = [
      { dir: matteDir, stem: `${shot}_matte_v${String(version).padStart(3, '0')}`, folder: rotoNames.matteFolder(shot, version) },
      ...job.parts.map((p) => ({ dir: partDirs.get(p.id)!, stem: `${shot}_roto_${p.id}_v${String(version).padStart(3, '0')}`, folder: rotoNames.partFolder(shot, p.id, version) })),
    ];
    for (const s of sets) {
      await runFfmpeg(
        job.ffmpeg,
        ['-hide_banner', '-nostdin', '-v', 'error', '-n', '-f', 'image2', '-framerate', String(job.frames.frameRate), '-start_number', String(job.first), '-i', join(s.dir, `${s.stem}.%04d.png`), '-frames:v', String(total), '-vf', 'format=grayf32le', '-c:v', 'exr', '-compression', 'zip16', '-format', 'half', '-start_number', String(job.first), join(s.dir, `${s.stem}.%04d.exr`)],
        options.signal,
      );
      for (let f = job.first; f <= job.last; f += 1) files.push(`${s.folder}/${s.stem}.${String(f).padStart(4, '0')}.exr`);
    }
    options.onProgress?.(total + 1, total + 1);
  }
  return { folder: job.folder, files, width, height, refiners };
}
