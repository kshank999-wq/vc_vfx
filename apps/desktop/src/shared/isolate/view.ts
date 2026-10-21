import type { IsolateMetrics } from '@vcvfx/domain';
import { resizeU8 } from '../cleanplate/view';
import { toDisplay, type LinearImage, type WorkingSpace } from '../key/linear';
import type { IsolateFrameView } from './bridge-types';
import type { MatteOutput, PlateOutput } from './engine';

/**
 * A built frame as the viewer shows it (addendum 11 §1): display-encoded
 * 8-bit pictures through the viewer's transform — for looking only; outputs
 * are written from the linear results — and 8-bit masks.
 */

/** What the review cache keeps of a frame's matte. */
export interface CachedMatte {
  width: number;
  height: number;
  matte: Uint8Array;
  /** Unpremultiplied foreground, display RGB. */
  foreground: Uint8ClampedArray;
  confidence: Uint8Array;
  band: Uint8Array;
  metrics: Omit<IsolateMetrics, 'unresolved'>;
}

/** What the review cache keeps of a frame's plate. */
export interface CachedPlate {
  width: number;
  height: number;
  plate: Uint8ClampedArray;
  unresolved: Uint8Array;
  share: number;
}

const u8 = (a: Float32Array) => Uint8Array.from(a, (v) => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255)));

export function cachedMatte(m: MatteOutput, space: WorkingSpace): CachedMatte {
  const n = m.width * m.height;
  const straight = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    const a = m.alpha[i]!;
    if (a > 0.004) for (let c = 0; c < 3; c += 1) straight[3 * i + c] = m.fg[3 * i + c]! / a;
  }
  return { width: m.width, height: m.height, matte: u8(m.alpha), foreground: toDisplay(straight, n, space), confidence: u8(m.confidence), band: Uint8Array.from(m.band, (v) => (v ? 255 : 0)), metrics: m.metrics };
}

export function cachedPlate(p: PlateOutput, space: WorkingSpace): CachedPlate {
  return { width: p.width, height: p.height, plate: toDisplay(p.plate, p.width * p.height, space), unresolved: Uint8Array.from(p.unresolved, (v) => (v ? 255 : 0)), share: p.share };
}

export function frameView(frame: number, img: LinearImage, m: CachedMatte | null, p: CachedPlate | null, space: WorkingSpace, o: { built: IsolateFrameView['built']; viewLabel: string }): IsolateFrameView {
  const { width: w, height: h } = img;
  const fitM = <T extends Uint8Array | Uint8ClampedArray>(a: T, ch: number) => (m ? resizeU8(a, m.width, m.height, w, h, ch) : a);
  const fitP = <T extends Uint8Array | Uint8ClampedArray>(a: T, ch: number) => (p ? resizeU8(a, p.width, p.height, w, h, ch) : a);
  return {
    frame,
    width: w,
    height: h,
    source: toDisplay(img.data, w * h, space),
    matte: m ? fitM(m.matte, 1) : null,
    foreground: m ? fitM(m.foreground, 3) : null,
    confidence: m ? fitM(m.confidence, 1) : null,
    band: m ? fitM(m.band, 1) : null,
    plate: p ? fitP(p.plate, 3) : null,
    unresolved: p ? fitP(p.unresolved, 1) : null,
    built: m ? o.built : 'none',
    metrics: m ? { ...m.metrics, unresolved: p?.share ?? 0 } : null,
    viewLabel: o.viewLabel,
  };
}
