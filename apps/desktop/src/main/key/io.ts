import { combineAlpha16, type RotoPart } from '@vcvfx/domain';
import type { KeyIO } from '../../shared/key/engine';
import { luminance, type LinearImage, type WorkingSpace } from '../../shared/key/linear';
import { maskToPlane, resizePlane, type Mask } from '../../shared/roto/image';
import { upscaleAlpha } from '../../shared/roto/refine';
import { MaskStore } from '../roto/store';
import { LinearFrameReader, readBackgroundFile, type BackgroundSpec, type KeyFrameSpec } from './frames';

/**
 * The keyer's IO in the main process and its worker (addendum 09 §4): frames
 * from ffmpeg in linear light, roto mattes from the roto cache (a part with
 * its children, as roto combines them; scaled up with the edge snapped to the
 * frame at plate resolution), the background reference.
 */

export interface RotoSource {
  /** The roto cache folder of this shot (MaskStore root). */
  store: string;
  version: number;
  parts: Pick<RotoPart, 'id' | 'parentId' | 'combine' | 'refine' | 'frames'>[];
}

/** The Auto subject segmentation's masks (key cache, part `subject`) and their per-frame confidence. */
export interface SubjectSource {
  store: string;
  version: number;
  /** Frame → engine confidence. A frame not listed has no segmentation. */
  confidence: Record<string, number>;
  /** False when Track made it: it then only makes the core solid (subject.ts `removes`). */
  removes?: boolean;
}

export interface KeyIOJob {
  frames: KeyFrameSpec;
  size: { width: number; height: number };
  space: WorkingSpace;
  roto: RotoSource | null;
  background: BackgroundSpec | null;
  subject?: SubjectSource | null;
}

export const SUBJECT_PART = 'subject';

export function createKeyIO(job: KeyIOJob, signal?: AbortSignal): KeyIO & { reader: LinearFrameReader } {
  const reader = new LinearFrameReader(job.frames, job.size, signal ? { signal } : {});
  const store = job.roto ? MaskStore.at(job.roto.store) : null;
  let bgCache: { key: string; img: LinearImage | null } | null = null;
  const plate = job.frames.plate;
  const subjectStore = job.subject ? MaskStore.at(job.subject.store) : null;
  const guideAt = (frame: number, width: number, height: number) => {
    const lum = luminance(reader.peek(frame) ?? { width, height, data: new Float32Array(width * height * 3) }, job.space.luma);
    for (let i = 0; i < lum.length; i += 1) lum[i] = Math.sqrt(Math.max(0, Math.min(1, lum[i]!)));
    return lum;
  };
  return {
    reader,
    signal,
    frame: (f) => reader.frame(f),
    async subject(frame, width, height) {
      if (!job.subject || !subjectStore) return null;
      const confidence = job.subject.confidence[String(frame)];
      if (confidence === undefined) return null;
      const m = await subjectStore.get(SUBJECT_PART, job.subject.version, frame);
      if (!m) return null;
      const full = width === plate.width && height === plate.height && (m.width !== width || m.height !== height);
      // At plate resolution the segmentation's edge is snapped to the frame, as roto's mattes are.
      const matte = full ? upscaleAlpha(m, width, height, guideAt(frame, width, height), { featherPx: 0, shrinkGrowPx: 0, temporalSmoothing: 0, edgeSnap: true }).data : m.width === width && m.height === height ? maskToPlane(m) : resizePlane(maskToPlane(m), m.width, m.height, width, height);
      return { matte, confidence, removes: job.subject.removes ?? true };
    },
    async roto(partId, frame, width, height) {
      if (!job.roto || !store) return null;
      const doc = { formatVersion: 1 as const, parts: job.roto.parts.map((p) => ({ ...p, name: p.id, color: '#000000', visible: true, keyFrames: [], engine: { id: 'track' as const, version: '', settings: {} } })), runs: [], exports: [], workingWidth: 1920, seq: 0 };
      const masks = new Map<string, Mask>();
      for (const p of job.roto.parts) {
        if (!p.frames.some((r) => r.frame === frame)) continue;
        const m = await store.get(p.id, job.roto.version, frame);
        if (m) masks.set(p.id, m);
      }
      if (!masks.size) return null;
      const full = width === plate.width && height === plate.height;
      // At plate resolution, mattes are scaled up with their edges snapped to the frame (as roto exports them).
      const guide = full ? (() => {
        const lum = luminance(reader.peek(frame) ?? { width, height, data: new Float32Array(width * height * 3) }, job.space.luma);
        for (let i = 0; i < lum.length; i += 1) lum[i] = Math.sqrt(Math.max(0, Math.min(1, lum[i]!)));
        return lum;
      })() : null;
      const own = new Map<string, Float32Array>();
      for (const p of job.roto.parts) {
        const m = masks.get(p.id);
        if (!m) continue;
        own.set(p.id, full ? upscaleAlpha(m, width, height, guide, p.refine).data : m.width === width && m.height === height ? maskToPlane(m) : resizePlane(maskToPlane(m), m.width, m.height, width, height));
      }
      if (!job.roto.parts.some((p) => p.id === partId)) return null;
      // The part with its children, combined as roto combines them, in 16 bits.
      const to16 = (a: Float32Array) => Uint16Array.from(a, (v) => Math.round(Math.max(0, Math.min(1, v)) * 65535));
      const own16 = new Map([...own].map(([k, v]) => [k, to16(v)]));
      const combined = combineAlpha16(doc, width * height, (id) => own16.get(id) ?? null, partId);
      return Float32Array.from(combined, (v) => v / 65535);
    },
    async background(width, height) {
      if (!job.background) return null;
      const key = `${width}x${height}`;
      if (bgCache?.key === key) return bgCache.img;
      let img: LinearImage | null = null;
      if (job.background.file) img = await readBackgroundFile(job.background, { width, height }, job.space, signal);
      else if (job.background.frame !== null) {
        const r = new LinearFrameReader(job.frames, { width, height }, { chunk: 1, ...(signal ? { signal } : {}) });
        img = await r.frame(Math.max(job.frames.first, Math.min(job.frames.last, job.background.frame)));
      }
      bgCache = { key, img };
      return img;
    },
  };
}

