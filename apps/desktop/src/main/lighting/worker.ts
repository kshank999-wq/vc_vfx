import { parentPort } from 'node:worker_threads';
import type { CompSource, LightingAnalysisInput, LightingSubjectSource } from '@vcvfx/domain';
import { analyseLighting, type CameraPriors } from '../../shared/lighting/analyse';
import { skyFeatures } from '../../shared/isolate/sky';
import { workingSpace, type LinearImage } from '../../shared/key/linear';
import { createLightingIO, readReferencePicture, type LightingIOJob, type LightingPictureSpec } from './io';
import { exportLighting, type LightingExportJob, type LightingExportResult } from './export';

/**
 * The lighting worker thread (addendum 14 §4): analyses and exports run here,
 * off the main process's event loop, one job per worker, as the other
 * modules' do. Messages in: one job, then optionally `cancel`. Messages out:
 * `progress`, then `done` or `error`.
 */

export interface LightingRefJob {
  id: string;
  /** The ball's circle in the pixels of the picture it is in (the plate, or the still). */
  circle: { cx: number; cy: number; r: number };
  /** A plate frame (a ball held up in the take), or a still. */
  frame: number | null;
  spec: LightingPictureSpec | null;
}

export interface LightingAnalyseJob {
  io: LightingIOJob;
  frames: number[];
  plate: { width: number; height: number };
  width: number;
  height: number;
  subject: LightingSubjectSource;
  useSky: boolean;
  references: { chrome: LightingRefJob[]; grey: LightingRefJob[]; hdri: { id: string; spec: LightingPictureSpec; headingDeg: number | null } | null };
  priors: CameraPriors;
  ground: { heightM: number; source: 'solve' | 'assumed' } | null;
  whiteBalance: { kelvin: number | null; source: 'artist' | 'metadata' | 'assumed' };
  revision: number;
}

export type LightingWorkerIn = { type: 'analyse'; job: LightingAnalyseJob } | { type: 'export'; job: LightingExportJob } | { type: 'cancel' };

export type LightingWorkerOut =
  | { type: 'progress'; done: number; total: number }
  | { type: 'done'; analysis?: LightingAnalysisInput; exported?: LightingExportResult }
  | { type: 'error'; message: string; cancelled: boolean };

const ORDER: Record<Exclude<LightingSubjectSource, 'auto' | 'none'>, CompSource> = { roto: 'roto', bg_matte: 'bg_matte', key_alpha: 'key_alpha' };

/** The sky by the isolation's cues, kept only when it looks like a sky shot (sky along the top). */
export function detectSky(img: LinearImage, encoding: Parameters<typeof workingSpace>[0]): Float32Array | null {
  const f = skyFeatures(img, workingSpace(encoding));
  const n = img.width * img.height;
  const sky = new Float32Array(n);
  let count = 0;
  let top = 0;
  const topRows = Math.max(1, Math.round(0.12 * img.height));
  for (let i = 0; i < n; i += 1) {
    sky[i] = f.fg[i]! < 0.35 ? 1 : 0;
    count += sky[i]!;
    if (i < topRows * img.width) top += sky[i]!;
  }
  const blue = f.reference.chroma[2] > f.reference.chroma[0];
  return count > 0.03 * n && top > 0.5 * topRows * img.width && blue ? sky : null;
}

export async function runAnalyse(job: LightingAnalyseJob, signal: AbortSignal, progress: (done: number, total: number) => void): Promise<LightingAnalysisInput> {
  const io = createLightingIO(job.io, signal);
  const { width: W, height: H } = job;
  const frame = job.frames[0]!;
  progress(0, 10);
  const img = await io.frame(frame, W, H);
  // The subject: the preferred matte, else the first the shot has.
  const prefer = job.subject === 'auto' ? job.io.subject.map((s) => s.source) : job.subject === 'none' ? [] : [ORDER[job.subject]];
  let subject: { matte: Float32Array; source: 'roto' | 'bg_matte' | 'key_alpha' } | null = null;
  for (const s of prefer) {
    const m = await io.matte(s, frame, W, H);
    if (m && m.some((v) => v > 0.5)) {
      subject = { matte: m, source: s as 'roto' | 'bg_matte' | 'key_alpha' };
      break;
    }
  }
  let sky: { matte: Float32Array; source: 'sky_matte' | 'detected' } | null = null;
  if (job.useSky) {
    const m = job.io.sky ? await io.matte('sky_matte', frame, W, H) : null;
    if (m && m.some((v) => v > 0.5)) sky = { matte: m, source: 'sky_matte' };
    else {
      const d = detectSky(img, job.io.comp.space.encoding);
      if (d) sky = { matte: d, source: 'detected' };
    }
  }
  const extra: { image: LinearImage; matte: Float32Array | null }[] = [];
  for (const f of job.frames.slice(1)) {
    if (signal.aborted) throw new Error('Cancelled');
    const e = await io.frame(f, W, H);
    extra.push({ image: e, matte: subject ? await io.matte(subject.source, f, W, H) : null });
  }
  progress(2, 10);
  const enc = job.io.comp.space.encoding;
  const k = W / job.plate.width;
  const ref = async (r: LightingRefJob) => {
    if (r.frame !== null) return { id: r.id, image: await io.frame(r.frame, W, H), circle: { cx: r.circle.cx * k, cy: r.circle.cy * k, r: r.circle.r * k }, inPlate: true };
    const pic = await readReferencePicture(job.io.comp.ffmpeg, job.io.comp.caps, r.spec!, enc, 1024, signal);
    const s = pic.width / r.spec!.width;
    return { id: r.id, image: pic, circle: { cx: r.circle.cx * s, cy: r.circle.cy * s, r: r.circle.r * s }, inPlate: false };
  };
  const chrome = await Promise.all(job.references.chrome.map(ref));
  const grey = await Promise.all(job.references.grey.map(ref));
  const hdri = job.references.hdri ? { id: job.references.hdri.id, image: await readReferencePicture(job.io.comp.ffmpeg, job.io.comp.caps, job.references.hdri.spec, enc, 1024, signal), headingDeg: job.references.hdri.headingDeg } : null;
  progress(3, 10);
  const space = job.io.comp.space;
  const out = await analyseLighting({
    frame: img,
    frameNumber: frame,
    frames: job.frames,
    luma: space.luma,
    gamut: space.encoding === 'linear_rec709' ? 'rec709' : space.encoding === 'aces2065_1' ? 'ap0' : 'ap1',
    subject,
    sky,
    extra,
    camera: job.priors,
    ground: job.ground,
    whiteBalance: job.whiteBalance,
    references: { chrome, grey, hdri },
    revision: job.revision,
    signal,
    progress: (d, t) => progress(3 + Math.round((d / t) * 7), 10),
  });
  if (!space.linear) out.analysis.warnings.unshift('The source encoding is unknown: the analysis works on code values, not linear light, so intensities and colours are rough. Set the source encoding in Plates.');
  return out.analysis;
}

export async function handleLighting(message: Exclude<LightingWorkerIn, { type: 'cancel' }>, signal: AbortSignal, post: (m: LightingWorkerOut) => void): Promise<void> {
  try {
    const progress = (done: number, total: number) => post({ type: 'progress', done, total });
    if (message.type === 'analyse') post({ type: 'done', analysis: await runAnalyse(message.job, signal, progress) });
    else post({ type: 'done', exported: await exportLighting(message.job, { signal, onProgress: progress }) });
  } catch (error) {
    const cancelled = signal.aborted || (error as Error).message === 'Cancelled';
    post({ type: 'error', message: cancelled ? 'Cancelled' : (error as Error).message, cancelled });
  }
}

if (parentPort) {
  const port = parentPort;
  const controller = new AbortController();
  port.on('message', (m: LightingWorkerIn) => {
    if (m.type === 'cancel') controller.abort();
    else void handleLighting(m, controller.signal, (out) => port.postMessage(out)).finally(() => port.close());
  });
}
