import { toDisplay, type WorkingSpace } from '../key/linear';
import type { RGBA } from './image';

/**
 * A comp picture for the viewer (addendum 13 §7): its colour through the
 * viewer's Rec.709 (approx.) view — premultiplied, over black, as Nuke's
 * viewer shows it — and its alpha, 8-bit. For viewing only: nothing written
 * goes through this (the review encode excepted, which says so).
 */

export interface CompPicture {
  /** Display RGB, three bytes a pixel. */
  rgb: Uint8ClampedArray;
  /** Alpha 0…255. */
  alpha: Uint8Array;
}

export function compPicture(img: RGBA, space: WorkingSpace): CompPicture {
  const n = img.width * img.height;
  const rgb = new Float32Array(n * 3);
  const alpha = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    rgb[3 * i] = img.data[4 * i]!;
    rgb[3 * i + 1] = img.data[4 * i + 1]!;
    rgb[3 * i + 2] = img.data[4 * i + 2]!;
    const a = img.data[4 * i + 3]!;
    alpha[i] = a <= 0 ? 0 : a >= 1 ? 255 : Math.round(a * 255);
  }
  return { rgb: toDisplay(rgb, n, space), alpha };
}
