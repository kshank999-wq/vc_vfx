import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanPlateNames, framePattern, versionTag, type CleanPlateMetrics } from '@vcvfx/domain';
import { ShotCleaner, checkCancel, scaleAnalysis, type CleanPlateSettings, type PlateOutput } from '../../shared/cleanplate/engine';
import { unresolvedOf } from '../../shared/cleanplate/fill';
import { toPlanar } from '../../shared/key/ffmpeg-key';
import { ExrStream } from '../key/export';
import { createKeyIO, type KeyIOJob } from '../key/io';
import { encodePng, encodePngRgb16 } from '../roto/png';

/**
 * Writing a clean plate into the shot package (master spec §8, §17; addendum
 * 10 §7):
 *
 *   04_CLEAN_PLATES/<shot>_cleanplate_vNNN/
 *     <shot>_cleanplate_still_vNNN.<ref>.exr          a still, in the reference frame's coordinates, or
 *     <shot>_cleanplate_vNNN.<frame>.exr              a plate per frame (RGB half, linear, no look)
 *     <shot>_cleanplate_conf_vNNN.<frame>.png         16-bit confidence (full = seen clean in agreeing frames)
 *     <shot>_cleanplate_unresolved_vNNN.<frame>.png   16-bit mask of what wants paint or a patch
 *     <shot>_cleanplate_vNNN.json, README.txt         written by the caller
 *
 * Made again at plate resolution from source + settings: the shot is aligned
 * at the working size (as the review build was), the alignment scaled to the
 * plate, and every plate reconstructed from full-resolution frames. A plate
 * whose encoding is unknown is written as 16-bit PNG of its code values.
 * Versioned, never overwritten: an approved version already on disk is
 * refused; an unapproved one has only its own files cleared and written again.
 * Nothing is ever written under the source paths (the caller checks the
 * output root).
 */

export interface CleanPlateExportJob {
  /** Frames at plate resolution. */
  io: KeyIOJob;
  /** Frames at the working size, for the alignment. */
  workingIO: KeyIOJob;
  settings: CleanPlateSettings;
  shot: string;
  version: number;
  approved: boolean;
  /** Absolute path of `04_CLEAN_PLATES/<shot>_cleanplate_vNNN`. */
  folder: string;
  first: number;
  last: number;
  format: 'exr' | 'png';
  generator: string;
  /** Frames a sequence may hold in memory at plate resolution. */
  maxResidentBytes: number;
}

export interface CleanPlateExportResult {
  files: string[];
  width: number;
  height: number;
  mode: 'still' | 'sequence';
  reference: number;
  alignment: 'static' | 'homography';
  frames: { frame: number; confidence: number; metrics: CleanPlateMetrics }[];
  /** Per frame: reference → frame homography in plate pixels, residual and motion (plate pixels), gain. */
  aligned: { frame: number; H: number[]; residualPx: number; motionPx: number; gain: number[] }[];
  /** The window and anchors the sequence used at plate resolution (cut to the memory budget). */
  budget: { window: number; anchors: number };
}

/** Clear an unapproved version's own files; refuse an approved one that is on disk. */
export async function clearCleanPlateVersion(folder: string, shot: string, version: number, approved: boolean): Promise<void> {
  const names = await readdir(folder).catch(() => null);
  if (!names) return;
  const tag = versionTag(version);
  const ours = names.filter((n) => (n.startsWith(`${shot}_cleanplate`) && n.includes(`_${tag}`)) || n === cleanPlateNames.readme());
  if (!ours.length) return;
  if (approved) throw new Error(`${folder} already holds the approved clean plate ${tag}; it is never rewritten. Reopen the clean plate to make a new version.`);
  for (const n of ours) await rm(join(folder, n), { force: true });
}

const to16 = (a: Float32Array) => Uint16Array.from(a, (v) => (v <= 0 ? 0 : v >= 1 ? 65535 : Math.round(v * 65535)));
const r3 = (v: number) => Math.round(v * 1000) / 1000;

export async function exportCleanPlate(job: CleanPlateExportJob, o: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}): Promise<CleanPlateExportResult> {
  const { shot, version, folder } = job;
  const { width, height } = job.io.frames.plate;
  if (job.io.size.width !== width || job.io.size.height !== height) throw new Error('A clean plate is exported at plate resolution');
  await clearCleanPlateVersion(folder, shot, version, job.approved);
  await mkdir(folder, { recursive: true });
  const range = { first: job.first, last: job.last };
  const n = job.last - job.first + 1;
  const total = 2 * n + n;
  // 1. Align at the working size, as the review build did.
  const ioW = { ...createKeyIO(job.workingIO, o.signal), signal: o.signal };
  const pxScale = width / job.workingIO.size.width;
  const working = new ShotCleaner(job.settings, range, { pxScale, luma: job.io.space.luma });
  const analysis = await working.analyse(ioW, (d) => o.onProgress?.(d, total));
  // 2. Rebuild at plate resolution with that alignment, scaled.
  const ioP = { ...createKeyIO(job.io, o.signal), signal: o.signal };
  const cleaner = new ShotCleaner(job.settings, range, { pxScale: 1, luma: job.io.space.luma, maxResidentBytes: job.maxResidentBytes }).useAnalysis(scaleAnalysis(analysis, pxScale));
  const still = analysis.mode === 'still';
  const exr = job.format === 'exr';
  const fps = job.io.frames.frameRate;
  const text = { Software: job.generator, Description: `${shot} clean plate ${versionTag(version)}` };
  const files: string[] = [];
  const frames: CleanPlateExportResult['frames'] = [];
  const plateName = (f: number) => (still ? cleanPlateNames.stillFile(shot, version, f, job.format) : cleanPlateNames.plateFile(shot, version, f, job.format));
  const stream = exr
    ? new ExrStream(job.io.frames.ffmpeg, 'rgb', width, height, fps, still ? analysis.reference : job.first, join(folder, still ? framePattern(shot, 'cleanplate_still', version, 'exr') : cleanPlateNames.platePattern(shot, version, 'exr')), o.signal)
    : null;
  const write = async (out: PlateOutput) => {
    if (stream) await stream.write(toPlanar('rgb', width * height, out.plate, null));
    else await writeFile(join(folder, plateName(out.frame)), encodePngRgb16(width, height, to16(out.plate), { text }));
    files.push(plateName(out.frame));
    await writeFile(join(folder, cleanPlateNames.confidenceFile(shot, version, out.frame)), encodePng({ width, height, bitDepth: 16, data: to16(out.confidence) }, { text }));
    files.push(cleanPlateNames.confidenceFile(shot, version, out.frame));
    await writeFile(join(folder, cleanPlateNames.unresolvedFile(shot, version, out.frame)), encodePng({ width, height, bitDepth: 16, data: Uint16Array.from(unresolvedOf(out), (v) => v * 65535) }, { text }));
    files.push(cleanPlateNames.unresolvedFile(shot, version, out.frame));
    frames.push({ frame: out.frame, confidence: out.confidenceValue, metrics: out.metrics });
  };
  try {
    if (still) {
      await write(await cleaner.plate(ioP, analysis.reference));
      o.onProgress?.(total, total);
    } else {
      for (let f = job.first; f <= job.last; f += 1) {
        checkCancel(o.signal);
        await write(await cleaner.plate(ioP, f, { keep: true }));
        o.onProgress?.(2 * n + frames.length, total);
      }
      cleaner.clear();
    }
  } catch (error) {
    if (stream) void stream.close().catch(() => undefined);
    throw error;
  }
  if (stream) await stream.close();
  const scaled = cleaner.analysis!.alignment;
  return {
    files,
    width,
    height,
    mode: analysis.mode,
    reference: analysis.reference,
    alignment: scaled.model,
    frames,
    aligned: [...scaled.frames.values()].sort((a, b) => a.frame - b.frame).map((a) => ({ frame: a.frame, H: a.H.map((v) => +v.toPrecision(10)), residualPx: r3(a.residual), motionPx: r3(a.motion), gain: a.gain.map(r3) })),
    budget: cleaner.budget(false),
  };
}
