import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isolateConfidence, isolateNames, versionTag, type IsolateMetrics, type IsolateTarget } from '@vcvfx/domain';
import { scaleHomography } from '../../shared/cleanplate/align';
import { ShotIsolator, checkCancel, type IsolateSettings } from '../../shared/isolate/engine';
import { toPlanar } from '../../shared/key/ffmpeg-key';
import { resizeLinear } from '../../shared/key/linear';
import { resizePlane } from '../../shared/roto/image';
import { ExrStream } from '../key/export';
import { createKeyIO, type KeyIOJob } from '../key/io';
import { segmentationEngine, type Sam2Files } from '../roto/engines';
import { decodePng, encodePng, encodePngRgb16 } from '../roto/png';

/**
 * Writing a sky isolation or a background removal into the shot package
 * (master spec §11 "export matte, isolated foreground, background/sky plate
 * and sequence manifests separately", §17; addendum 11 §6):
 *
 *   02_MATTES_ROTO/<shot>_sky_vNNN/                  (<shot>_bg_vNNN for background removal)
 *     <shot>_sky_matte_vNNN.<frame>.png              16-bit straight alpha of the foreground (and .exr, one channel)
 *     <shot>_sky_fg_vNNN.<frame>.exr                 the foreground, RGBA half, premultiplied, spill unmixed, linear, no look
 *     <shot>_sky_plate_vNNN.<frame>.exr              the sky (background) alone, RGB half
 *     <shot>_sky_conf_vNNN.<frame>.png               16-bit confidence of the matte
 *     <shot>_sky_plateconf_vNNN.<frame>.png          16-bit confidence of the plate (black: never seen)
 *     <shot>_sky_vNNN.json, README.txt               written by the caller
 *
 * Made again from source + settings: analysed at the working size (as the
 * review build was), the mattes refined at plate resolution, the background
 * plate rebuilt at plate resolution; the sky plate is rebuilt at the working
 * size and laid under the plate's own sky pixels (the sky is smooth; what is
 * seen is kept at full resolution). Versioned, never overwritten: an approved
 * version on disk is refused; an unapproved one has only its own files
 * cleared and written again. Nothing is written under the source paths (the
 * caller checks the output root).
 */

export interface IsolateExportJob {
  /** Frames at plate resolution. */
  io: KeyIOJob;
  /** Frames at the working size (the analysis, the sky plate). */
  workingIO: KeyIOJob;
  settings: IsolateSettings;
  target: IsolateTarget;
  shot: string;
  version: number;
  approved: boolean;
  /** Absolute path of `02_MATTES_ROTO/<shot>_sky_vNNN`. */
  folder: string;
  first: number;
  last: number;
  format: 'exr' | 'png';
  generator: string;
  sam2?: Sam2Files;
  maxResidentBytes: number;
}

export interface IsolateExportResult {
  files: string[];
  width: number;
  height: number;
  engine: string;
  frames: { frame: number; confidence: number; metrics: IsolateMetrics }[];
  alignment: { model: 'static' | 'homography'; reference: number; frames: { frame: number; H: number[]; residualPx: number; motionPx: number }[] };
}

/** Clear an unapproved version's own files; refuse an approved one that is on disk. */
export async function clearIsolateVersion(folder: string, shot: string, target: IsolateTarget, version: number, approved: boolean): Promise<void> {
  const names = await readdir(folder).catch(() => null);
  if (!names) return;
  const tag = versionTag(version);
  const n = isolateNames(target);
  const ours = names.filter((x) => (x.startsWith(n.prefix(shot)) && x.includes(`_${tag}`)) || x === n.readme());
  if (!ours.length) return;
  if (approved) throw new Error(`${folder} already holds the approved ${target === 'sky' ? 'sky isolation' : 'background removal'} ${tag}; it is never rewritten. Reopen it to make a new version.`);
  for (const x of ours) await rm(join(folder, x), { force: true });
}

const to16 = (a: Float32Array) => Uint16Array.from(a, (v) => (v <= 0 ? 0 : v >= 1 ? 65535 : Math.round(v * 65535)));
const r3 = (v: number) => Math.round(v * 1000) / 1000;

export async function exportIsolate(job: IsolateExportJob, o: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}): Promise<IsolateExportResult> {
  const { shot, version, folder, target } = job;
  const names = isolateNames(target);
  const { width, height } = job.io.frames.plate;
  if (job.io.size.width !== width || job.io.size.height !== height) throw new Error('An isolation is exported at plate resolution');
  await clearIsolateVersion(folder, shot, target, version, job.approved);
  await mkdir(folder, { recursive: true });
  const range = { first: job.first, last: job.last };
  const n = width * height;
  const ioW = { ...createKeyIO(job.workingIO, o.signal), signal: o.signal };
  const ioP = { ...createKeyIO(job.io, o.signal), signal: o.signal };
  const pxScale = width / job.workingIO.size.width;
  const isolator = new ShotIsolator(job.settings, range, {
    pxScale,
    space: job.io.space,
    maxResidentBytes: job.maxResidentBytes,
    ...(target === 'background' ? { engine: () => segmentationEngine(job.settings.engine === 'sam2' && job.sam2 ? 'sam2' : 'track', job.sam2) } : {}),
  });
  const total = isolator.steps();
  let done = 0;
  // 1. Analyse at the working size, as the review build did.
  const analysis = await isolator.analyse(ioW, (d) => o.onProgress?.((done = d), total));
  const exr = job.format === 'exr';
  const fps = job.io.frames.frameRate;
  const text = { Software: job.generator, Description: `${shot} ${target === 'sky' ? 'sky isolation' : 'background removal'} ${versionTag(version)}` };
  const files: string[] = [];
  const at = (p: string) => join(folder, p);
  const fgStream = exr ? new ExrStream(job.io.frames.ffmpeg, 'rgba', width, height, fps, job.first, at(names.foregroundPattern(shot, version, 'exr')), o.signal) : null;
  const matteExr = exr ? new ExrStream(job.io.frames.ffmpeg, 'y', width, height, fps, job.first, at(names.matteExrPattern(shot, version)), o.signal) : null;
  const plateStream = exr ? new ExrStream(job.io.frames.ffmpeg, 'rgb', width, height, fps, job.first, at(names.platePattern(shot, version, 'exr')), o.signal) : null;
  const streams = [fgStream, matteExr, plateStream].filter((s): s is ExrStream => s !== null);
  const metrics = new Map<number, Omit<IsolateMetrics, 'unresolved'>>();
  const unresolved = new Map<number, number>();
  const step = () => o.onProgress?.(++done, total);
  try {
    await isolator.outputs(
      ioP,
      { pxScale: 1, plateIO: target === 'sky' ? ioW : ioP, platePxScale: target === 'sky' ? pxScale : 1, progress: step },
      async (m) => {
        checkCancel(o.signal);
        metrics.set(m.frame, m.metrics);
        await writeFile(at(names.matteFile(shot, version, m.frame)), encodePng({ width, height, bitDepth: 16, data: to16(m.alpha) }, { text }));
        files.push(names.matteFile(shot, version, m.frame));
        await writeFile(at(names.confidenceFile(shot, version, m.frame)), encodePng({ width, height, bitDepth: 16, data: to16(m.confidence) }, { text }));
        files.push(names.confidenceFile(shot, version, m.frame));
        if (fgStream && matteExr) {
          await fgStream.write(toPlanar('rgba', n, m.fg, m.alpha));
          await matteExr.write(toPlanar('y', n, null, m.alpha));
          files.push(names.foregroundFile(shot, version, m.frame, 'exr'), names.matteFile(shot, version, m.frame).replace(/\.png$/, '.exr'));
        } else {
          await writeFile(at(names.foregroundFile(shot, version, m.frame, 'png')), encodePngRgb16(width, height, to16(m.fg), { text }));
          files.push(names.foregroundFile(shot, version, m.frame, 'png'));
        }
      },
      async (p) => {
        checkCancel(o.signal);
        unresolved.set(p.frame, p.share);
        let plate = p.plate;
        let conf = p.confidence;
        if (p.width !== width || p.height !== height) {
          // The sky plate, made at the working size: under the plate's own pixels wherever the sky is seen.
          plate = resizeLinear({ width: p.width, height: p.height, data: p.plate }, width, height).data;
          conf = resizePlane(p.confidence, p.width, p.height, width, height);
          const frame = (await ioP.frame(p.frame)).data;
          const matte = decodePng(await readFile(at(names.matteFile(shot, version, p.frame))));
          for (let i = 0; i < n; i += 1) {
            const s = Math.min(1, matte.data[i]! / 65535 / 0.05);
            if (s >= 1) continue;
            for (let c = 0; c < 3; c += 1) plate[3 * i + c] = frame[3 * i + c]! * (1 - s) + plate[3 * i + c]! * s;
            conf[i] = 1 - s + s * conf[i]!;
          }
        }
        if (plateStream) await plateStream.write(toPlanar('rgb', n, plate, null));
        else await writeFile(at(names.plateFile(shot, version, p.frame, 'png')), encodePngRgb16(width, height, to16(plate), { text }));
        files.push(names.plateFile(shot, version, p.frame, job.format));
        await writeFile(at(names.plateConfidenceFile(shot, version, p.frame)), encodePng({ width, height, bitDepth: 16, data: to16(conf) }, { text }));
        files.push(names.plateConfidenceFile(shot, version, p.frame));
      },
    );
  } catch (error) {
    for (const s of streams) void s.close().catch(() => undefined);
    throw error;
  }
  for (const s of streams) await s.close();
  const frames = isolator.frames.map((f) => {
    const m: IsolateMetrics = { ...metrics.get(f)!, unresolved: unresolved.get(f) ?? 0 };
    return { frame: f, confidence: isolateConfidence(m), metrics: m };
  });
  const a = analysis.alignment;
  return {
    files,
    width,
    height,
    engine: analysis.engine,
    frames,
    alignment: {
      model: a.model,
      reference: analysis.reference,
      frames: [...a.frames.values()].sort((x, y) => x.frame - y.frame).map((x) => ({ frame: x.frame, H: (a.static ? x.H : scaleHomography(x.H, pxScale)).map((v) => +v.toPrecision(10)), residualPx: r3(x.residual * pxScale), motionPx: r3(x.motion * pxScale) })),
    },
  };
}
