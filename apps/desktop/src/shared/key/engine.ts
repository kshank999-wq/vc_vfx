import { contactSheetFrames, type KeyDocument, type KeyMetrics, type KeyRunResult, type ScreenKind } from '@vcvfx/domain';
import { CancelledError } from '../roto/engine';
import { buildScreenModel, evalScreenModel, flatScreenModel, localScreen, modelSeen, screenGain, type ScreenModel } from './cleanplate';
import { keyerSettings, keyFrame, type KeyFrameOutput } from './keyer';
import type { LinearImage } from './linear';
import { backgroundNear } from './look';
import { resolveLinks, type ResolvedLink } from './mattes';
import { detectScreen, type ScreenEstimate } from './screen';

/**
 * Keying a shot (addendum 09 §4): detect the screen, build the clean plate,
 * key frame by frame. Frames, roto mattes and the background come and go
 * through `KeyIO`, so the same code runs in the desktop's worker thread and in
 * the browser preview; cancellation is checked between frames.
 */

export const KEY_ENGINE_VERSION = '1.1.0';

export interface KeyIO {
  /** A frame at the size the key works at, in linear working RGB. */
  frame(frame: number): Promise<LinearImage>;
  /** A roto part's matte (0…1) on a frame, at w × h, or null where it has none. */
  roto(partId: string, frame: number, width: number, height: number): Promise<Float32Array | null>;
  /** The background plate at w × h (linear working RGB), or null. */
  background(width: number, height: number): Promise<LinearImage | null>;
  signal?: AbortSignal;
  progress?(done: number, total: number, frame: number): void;
}

export type KeySettings = Pick<KeyDocument, 'screen' | 'params' | 'links' | 'despill' | 'lightWrap'>;

export const checkCancel = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new CancelledError();
};

/** Frames spread over the shot for detection and the clean plate. */
export function analysisFrames(first: number, last: number, count: number): number[] {
  if (last <= first) return [first];
  if (count <= 1) return [Math.round((first + last) / 2)];
  return contactSheetFrames(first, last, Math.max(0, count - 2)).slice(0, count);
}

export async function detectShotScreen(io: KeyIO, frames: readonly number[], kind: ScreenKind | null): Promise<ScreenEstimate & { frames: number[] }> {
  const images: LinearImage[] = [];
  for (const f of frames) {
    checkCancel(io.signal);
    images.push(await io.frame(f));
  }
  return { ...detectScreen(images, kind), frames: [...frames] };
}

/** The clean-plate model for a shot (or a flat screen when the clean plate is off). */
export async function shotScreenModel(io: KeyIO, settings: KeySettings, first: number, last: number): Promise<ScreenModel> {
  const screen = settings.screen;
  if (!screen) throw new Error('Pick the screen colour first (Auto key, or the eyedropper).');
  if (!settings.params.cleanPlate) return flatScreenModel(screen.rgb);
  const frames = analysisFrames(first, last, settings.params.cleanPlateFrames);
  const images: LinearImage[] = [];
  for (const f of frames) {
    checkCancel(io.signal);
    images.push(await io.frame(f));
  }
  return buildScreenModel(images, { kind: screen.kind, rgb: screen.rgb }, settings.params.cleanPlateGrid);
}

export interface KeyAtOptions {
  /** Plate pixels per key pixel. */
  pxScale: number;
  luma: readonly [number, number, number];
  /** Compute the despilled foreground (and light wrap, when enabled). */
  foreground: boolean;
  /** Compute the light-wrap layer even when its output is off (for the preview). */
  wrapPreview?: boolean;
}

/**
 * Keys frames of one shot with one set of settings, keeping what does not
 * change between frames (the screen model at this size, the blurred
 * background).
 */
export class ShotKeyer {
  private modelAt = new Map<string, Float32Array>();
  private seenAt = new Map<string, Uint8Array | null>();
  private bgAt = new Map<string, { bg: LinearImage | null; near: Float32Array | null }>();

  constructor(
    readonly settings: KeySettings,
    readonly model: ScreenModel,
  ) {
    if (!settings.screen) throw new Error('Pick the screen colour first (Auto key, or the eyedropper).');
  }

  /** The screen of this frame (model × gain, then detail), and the model × gain alone. */
  private screenFor(img: LinearImage): { screen: Float32Array; model: Float32Array } {
    const key = `${img.width}x${img.height}`;
    let base = this.modelAt.get(key);
    if (!base) {
      base = evalScreenModel(this.model, img.width, img.height);
      this.modelAt.set(key, base);
    }
    const screen = this.settings.screen!;
    let out = base;
    if (screen.track) {
      if (!this.seenAt.has(key)) this.seenAt.set(key, modelSeen(this.model, img.width, img.height));
      const gain = screenGain(img, base, { kind: screen.kind, rgb: screen.rgb }, this.seenAt.get(key)!);
      if (!gain.every((g) => Math.abs(g - 1) < 1e-3)) {
        out = new Float32Array(base.length);
        for (let i = 0; i < base.length; i += 3) {
          out[i] = base[i]! * gain[0];
          out[i + 1] = base[i + 1]! * gain[1];
          out[i + 2] = base[i + 2]! * gain[2];
        }
      }
    }
    return { screen: this.settings.params.screenDetail ? localScreen(img, out, screen.kind) : out, model: out };
  }

  private async background(io: KeyIO, w: number, h: number, pxScale: number) {
    const key = `${w}x${h}`;
    let hit = this.bgAt.get(key);
    if (!hit) {
      const bg = await io.background(w, h);
      hit = { bg, near: bg ? backgroundNear(bg, this.settings.despill.backgroundBlurPx / pxScale / 2) : null };
      this.bgAt.set(key, hit);
    }
    return hit;
  }

  async keyAt(io: KeyIO, frame: number, img: LinearImage, o: KeyAtOptions): Promise<KeyFrameOutput & { screen: Float32Array; background: LinearImage | null; links: ResolvedLink[] }> {
    const s = this.settings;
    const { screen, model } = this.screenFor(img);
    const links: ResolvedLink[] = [];
    const rotoCache = new Map<string, Float32Array | null>();
    for (const l of s.links) if (l.source.type === 'roto' && !rotoCache.has(l.source.partId)) rotoCache.set(l.source.partId, await io.roto(l.source.partId, frame, img.width, img.height));
    links.push(...resolveLinks(s.links, frame, { width: img.width, height: img.height, pxScale: o.pxScale, roto: (id) => rotoCache.get(id) ?? null }));
    const { bg, near } = o.foreground ? await this.background(io, img.width, img.height, o.pxScale) : { bg: null, near: null };
    const d = s.despill;
    const out = keyFrame({
      image: img,
      screen,
      model,
      settings: keyerSettings(s.screen!.kind, s.params, o.pxScale),
      links,
      matteOnly: !o.foreground,
      despill: o.foreground && d.enabled ? { kind: s.screen!.kind, limit: d.limit, weight: d.weight, strength: d.strength, restore: d.restore, restoreAmount: d.restoreAmount, protectSkin: d.protectSkin, protect: d.protect, luma: o.luma, bgNear: near } : null,
      background: bg,
      lightWrap: o.foreground && (s.lightWrap.output || o.wrapPreview) ? { width: s.lightWrap.widthPx / o.pxScale, intensity: s.lightWrap.intensity, lumaWeight: s.lightWrap.lumaWeight, luma: o.luma } : null,
    });
    return { ...out, screen, background: bg, links };
  }
}

/**
 * Key frames first…last (matte and measurements), handing each result to
 * `onFrame` (to cache the matte). Returns what `recordKeyRun` records.
 */
export async function runKey(
  io: KeyIO,
  keyer: ShotKeyer,
  range: { first: number; last: number },
  o: Omit<KeyAtOptions, 'foreground'> & { revision: number; foreground?: boolean },
  onFrame: (frame: number, out: KeyFrameOutput) => Promise<void> | void,
): Promise<KeyRunResult> {
  const frames: { frame: number; confidence: number; metrics: KeyMetrics }[] = [];
  const total = range.last - range.first + 1;
  for (let f = range.first; f <= range.last; f += 1) {
    checkCancel(io.signal);
    const img = await io.frame(f);
    const out = await keyer.keyAt(io, f, img, { ...o, foreground: o.foreground ?? false });
    await onFrame(f, out);
    frames.push({ frame: f, confidence: out.confidence, metrics: roundMetrics(out.metrics) });
    io.progress?.(frames.length, total, f);
  }
  return { first: range.first, last: range.last, frames, revision: o.revision, despill: keyer.settings.despill.enabled, algorithm: `vcvfx-cdk@${KEY_ENGINE_VERSION}` };
}

const r4 = (v: number) => Math.round(v * 10_000) / 10_000;
export const roundMetrics = (m: KeyMetrics): KeyMetrics => ({ screenCoverage: r4(m.screenCoverage), coreNoise: r4(m.coreNoise), edgeActivity: r4(m.edgeActivity), holes: r4(m.holes), residual: r4(m.residual) });
