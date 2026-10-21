import type { ScreenKind } from '@vcvfx/domain';
import { boxFilter } from '../roto/image';
import type { LinearImage } from './linear';

/**
 * Screen colour (master spec §6 bullet 1; addendum 09 §3.1).
 *
 * Detection works on chromaticity — each pixel's r, g, b divided by their sum
 * — which a brighter or darker patch of the same screen does not change, so a
 * screen lit unevenly (a hot spot, a dark corner) is still one cluster. The
 * dominant saturated green (or blue) cluster is found as the peak of a 2D
 * chromaticity histogram of the pixels where that channel clearly leads,
 * refined by mean shift; its members' median colour is the screen. Which
 * screen it is, when not given, is whichever of green and blue has more
 * clearly-dominant pixels.
 */

export interface ScreenEstimate {
  kind: ScreenKind;
  /** Linear RGB: the median of the screen cluster. */
  rgb: [number, number, number];
  /** Chromaticity of the screen (r, g, b summing to 1). */
  chroma: [number, number, number];
  /** Share of the looked-at pixels that are screen. */
  coverage: number;
  /** Mean chromaticity distance of the cluster's members to its centre. */
  spread: number;
}

const BINS = 64;
const DOMINANCE = 0.06;

/** How far `kind` leads the other two channels, on chromaticity. */
export function dominance(kind: ScreenKind, r: number, g: number, b: number): number {
  const s = r + g + b;
  if (!(s > 1e-6)) return -1;
  return kind === 'green' ? (g - Math.max(r, b)) / s : (b - Math.max(r, g)) / s;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function detectScreen(images: readonly LinearImage[], kind: ScreenKind | null = null, options: { maxSamples?: number } = {}): ScreenEstimate {
  const total = images.reduce((n, im) => n + im.width * im.height, 0);
  const stride = Math.max(1, Math.floor(total / (options.maxSamples ?? 250_000)));
  // Gather samples: chromaticity and colour.
  const cr: number[] = [];
  const cb: number[] = [];
  const rgb: number[] = [];
  let looked = 0;
  let votesG = 0;
  let votesB = 0;
  for (const im of images) {
    const n = im.width * im.height;
    for (let i = 0; i < n; i += stride) {
      const r = im.data[3 * i]!;
      const g = im.data[3 * i + 1]!;
      const b = im.data[3 * i + 2]!;
      const s = r + g + b;
      looked += 1;
      if (!(s > 1e-5) || r < 0 || g < 0 || b < 0) continue;
      const dg = (g - Math.max(r, b)) / s;
      const db = (b - Math.max(r, g)) / s;
      if (dg > 2 * DOMINANCE) votesG += 1;
      if (db > 2 * DOMINANCE) votesB += 1;
      cr.push(r / s);
      cb.push(b / s);
      rgb.push(r, g, b);
    }
  }
  const k: ScreenKind = kind ?? (votesB > votesG ? 'blue' : 'green');
  // Histogram of the candidates' chromaticity (r, b) — g follows from them.
  const hist = new Float32Array(BINS * BINS);
  const cand: number[] = [];
  for (let j = 0; j < cr.length; j += 1) {
    const r = cr[j]!;
    const b = cb[j]!;
    const g = 1 - r - b;
    const d = k === 'green' ? g - Math.max(r, b) : b - Math.max(r, g);
    if (d <= DOMINANCE) continue;
    cand.push(j);
    hist[Math.min(BINS - 1, Math.floor(r * BINS)) * BINS + Math.min(BINS - 1, Math.floor(b * BINS))]! += 1;
  }
  if (!cand.length) {
    const fallback: [number, number, number] = k === 'green' ? [0.08, 0.45, 0.1] : [0.06, 0.12, 0.5];
    const s = fallback[0] + fallback[1] + fallback[2];
    return { kind: k, rgb: fallback, chroma: [fallback[0] / s, fallback[1] / s, fallback[2] / s], coverage: 0, spread: 1 };
  }
  const smooth = boxFilter(hist, BINS, BINS, 1);
  let peak = 0;
  for (let i = 1; i < smooth.length; i += 1) if (smooth[i]! > smooth[peak]!) peak = i;
  let mr = (Math.floor(peak / BINS) + 0.5) / BINS;
  let mb = ((peak % BINS) + 0.5) / BINS;
  // Mean shift on the candidates, narrowing.
  for (const radius of [0.08, 0.05, 0.035, 0.035]) {
    let sr = 0;
    let sb = 0;
    let n = 0;
    for (const j of cand) {
      const dr = cr[j]! - mr;
      const db = cb[j]! - mb;
      if (dr * dr + db * db <= radius * radius) {
        sr += cr[j]!;
        sb += cb[j]!;
        n += 1;
      }
    }
    if (!n) break;
    mr = sr / n;
    mb = sb / n;
  }
  const members: number[] = [];
  let spread = 0;
  const R = 0.05;
  for (const j of cand) {
    const d = Math.hypot(cr[j]! - mr, cb[j]! - mb);
    if (d <= R) {
      members.push(j);
      spread += d;
    }
  }
  const pick = (c: 0 | 1 | 2) => median(members.map((j) => rgb[3 * j + c]!));
  const out: [number, number, number] = [pick(0), pick(1), pick(2)];
  return { kind: k, rgb: out, chroma: [mr, 1 - mr - mb, mb], coverage: members.length / Math.max(1, looked), spread: members.length ? spread / members.length : 1 };
}

/** The mean linear colour within `radius` pixels of (x, y), in the image's own pixels. */
export function sampleColour(img: LinearImage, x: number, y: number, radius: number): [number, number, number] {
  const r = Math.max(0, Math.round(radius));
  const cx = Math.round(x);
  const cy = Math.round(y);
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let n = 0;
  for (let yy = Math.max(0, cy - r); yy <= Math.min(img.height - 1, cy + r); yy += 1) {
    for (let xx = Math.max(0, cx - r); xx <= Math.min(img.width - 1, cx + r); xx += 1) {
      if ((xx - cx) ** 2 + (yy - cy) ** 2 > r * r + 0.5) continue;
      const i = (yy * img.width + xx) * 3;
      sr += img.data[i]!;
      sg += img.data[i + 1]!;
      sb += img.data[i + 2]!;
      n += 1;
    }
  }
  return n ? [sr / n, sg / n, sb / n] : [0, 0, 0];
}
