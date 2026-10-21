import type { CleanPlateMetrics } from '@vcvfx/domain';
import type { CleanPlateFrameView } from './bridge-types';
import { toDisplay, type LinearImage, type WorkingSpace } from '../key/linear';
import type { FillResult } from './fill';
import { unresolvedOf } from './fill';

/**
 * A clean plate as the viewer shows it (addendum 10 §8): display-encoded
 * 8-bit pictures through the viewer's transform — for looking only; outputs
 * are written from the linear plate — and 8-bit masks.
 */

/** What the review cache keeps of a built frame. */
export interface CachedPlate {
  width: number;
  height: number;
  /** Display RGB. */
  plate: Uint8ClampedArray;
  confidence: Uint8Array;
  unresolved: Uint8Array;
  metrics: CleanPlateMetrics;
}

function u8(a: Float32Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i += 1) {
    const v = a[i]!;
    out[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
  }
  return out;
}

export function cachedPlate(out: FillResult & { metrics: CleanPlateMetrics }, space: WorkingSpace): CachedPlate {
  const n = out.width * out.height;
  const unresolved = unresolvedOf(out);
  for (let i = 0; i < n; i += 1) unresolved[i] = unresolved[i]! ? 255 : 0;
  return { width: out.width, height: out.height, plate: toDisplay(out.plate, n, space), confidence: u8(out.confidence), unresolved, metrics: out.metrics };
}

/** Nearest-neighbour resample of an 8-bit image (masks and display pictures) to another size. */
export function resizeU8<T extends Uint8Array | Uint8ClampedArray>(src: T, w: number, h: number, nw: number, nh: number, channels: number): T {
  if (w === nw && h === nh) return src;
  const out = new (src.constructor as { new (n: number): T })(nw * nh * channels);
  for (let y = 0; y < nh; y += 1) {
    const sy = Math.min(h - 1, Math.floor(((y + 0.5) * h) / nh));
    for (let x = 0; x < nw; x += 1) {
      const sx = Math.min(w - 1, Math.floor(((x + 0.5) * w) / nw));
      for (let c = 0; c < channels; c += 1) out[(y * nw + x) * channels + c] = src[(sy * w + sx) * channels + c]!;
    }
  }
  return out;
}

export function frameView(
  frame: number,
  img: LinearImage,
  hole: Uint8Array | null,
  cached: CachedPlate | null,
  space: WorkingSpace,
  o: { built: CleanPlateFrameView['built']; stillFrame: number | null; viewLabel: string },
): CleanPlateFrameView {
  const { width: w, height: h } = img;
  const fit = <T extends Uint8Array | Uint8ClampedArray>(a: T, ch: number) => (cached ? resizeU8(a, cached.width, cached.height, w, h, ch) : a);
  return {
    frame,
    width: w,
    height: h,
    source: toDisplay(img.data, w * h, space),
    hole: hole ? Uint8Array.from(hole, (v) => (v ? 255 : 0)) : null,
    plate: cached ? fit(cached.plate, 3) : null,
    confidence: cached ? fit(cached.confidence, 1) : null,
    unresolved: cached ? fit(cached.unresolved, 1) : null,
    stillFrame: o.stillFrame,
    built: cached ? o.built : 'none',
    metrics: cached?.metrics ?? null,
    viewLabel: o.viewLabel,
  };
}
