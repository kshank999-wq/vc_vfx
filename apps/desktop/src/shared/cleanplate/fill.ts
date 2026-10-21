import { pullPush } from '../key/cleanplate';
import type { LinearImage } from '../key/linear';
import { gaussianBlur, morph } from '../roto/image';

/**
 * Reconstructing what the subject hides (master spec §8 bullets 1, 3, 5;
 * addendum 10 §3.2–3.4).
 *
 * For every pixel of the plate inside the removal matte, each aligned frame
 * that sees that spot clean (its own matte does not cover it there) offers a
 * candidate: its pixel, warped by the homography and brought to the plate's
 * exposure by the frame's gain. Candidates are weighted — nearer frames and
 * the artist's preferred frames more, badly aligned frames less — and voted
 * on robustly: the weighted median luminance is found, the candidates within
 * the tolerance of it agree, and the plate takes their weighted mean. A pixel
 * seen clean in several agreeing frames is confident; one seen once, or where
 * the frames disagree (a second moving thing, a light change the gain did not
 * follow), is not. Patches ("take region R from frame F") override the vote.
 * What no frame ever saw is filled spatially (pull–push diffusion from the
 * surrounding plate) and has confidence 0: it is the artist's to paint.
 *
 * Accumulating one candidate frame at a time keeps only the plate's own
 * buffers in memory, so a still can be made from any number of frames read
 * one by one.
 */

export interface Candidate {
  image: LinearImage;
  /** 1 = the subject on that frame (not borrowed from). */
  hole: Uint8Array | null;
  /** Plate pixel → candidate pixel. */
  H: readonly number[];
  /** Multiplies the candidate's pixels to the plate's exposure. */
  gain: readonly [number, number, number];
  /** Vote weight (nearness, preference). */
  weight: number;
  /** 0 … 1: how well the frame aligned (scales the confidence it gives). */
  quality: number;
}

export interface FillOptions {
  /** Most candidates kept per pixel (the heaviest win). */
  maxCandidates?: number;
  /** Relative luminance difference within which candidates agree. */
  tolerance: number;
  luma: readonly [number, number, number];
  /** Pixels round the hole that are also reconstructed and blended into the original. */
  featherPx: number;
}

export interface FillResult {
  width: number;
  height: number;
  /** The clean plate (linear RGB). */
  plate: Float32Array;
  /** Per pixel, 0 … 1: 1 outside the removed area. */
  confidence: Float32Array;
  /** 1 where the pixel was removed (the dilated matte). */
  hole: Uint8Array;
  /** 1 where the removed pixel was filled spatially (never seen clean). */
  inpainted: Uint8Array;
  /** 1 where the removed pixel came from a patch. */
  patched: Uint8Array;
  /** Agreeing candidates per removed pixel (0 for spatial fill). */
  support: Uint8Array;
}

/**
 * Grow a binary mask by `r` pixels, working only on its bounding box (plus
 * the margin): a matte covers a small part of the frame, so this is much
 * cheaper than a whole-frame distance transform, and gives the same result.
 */
export function grow(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask.slice();
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    for (let x = 0; x < w; x += 1)
      if (mask[row + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  }
  const out = new Uint8Array(w * h);
  if (x1 < 0) return out;
  const m = Math.ceil(r) + 1;
  x0 = Math.max(0, x0 - m);
  y0 = Math.max(0, y0 - m);
  x1 = Math.min(w - 1, x1 + m);
  y1 = Math.min(h - 1, y1 + m);
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  const crop = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y += 1) crop.set(mask.subarray((y + y0) * w + x0, (y + y0) * w + x0 + cw), y * cw);
  const grown = morph(crop, cw, ch, r);
  for (let y = 0; y < ch; y += 1) out.set(grown.subarray(y * cw, (y + 1) * cw), (y + y0) * w + x0);
  return out;
}

/** Pixel confidence below which a removed pixel is unresolved (shown red; written to the unresolved mask). */
export const PIXEL_LOW_CONFIDENCE = 0.5;

export class HoleFill {
  readonly width: number;
  readonly height: number;
  /** Indices of the pixels reconstructed (hole and feather ring). */
  readonly index: Int32Array;
  private readonly K: number;
  private readonly val: Float32Array;
  private readonly wt: Float32Array;
  private readonly q: Float32Array;
  private readonly count: Uint8Array;
  private readonly ring: Float32Array;
  private readonly holeMask: Uint8Array;
  private readonly patchVal: Float32Array;
  private readonly patchW: Float32Array;

  constructor(
    readonly target: LinearImage,
    hole: Uint8Array,
    readonly o: FillOptions,
  ) {
    const { width: w, height: h } = target;
    this.width = w;
    this.height = h;
    this.holeMask = hole;
    const r = Math.ceil(o.featherPx);
    const outer = r > 0 ? grow(hole, w, h, r) : hole;
    // Blend weight of the ring: 1 at the hole, falling to 0 at its outer edge.
    this.ring = new Float32Array(w * h);
    if (r > 0) {
      const soft = gaussianBlur(Float32Array.from(hole), w, h, Math.max(0.5, o.featherPx / 2));
      for (let i = 0; i < w * h; i += 1) if (outer[i] && !hole[i]) this.ring[i] = Math.min(1, 2 * soft[i]!);
    }
    const idx: number[] = [];
    for (let i = 0; i < w * h; i += 1) if (outer[i]) idx.push(i);
    this.index = Int32Array.from(idx);
    this.K = Math.max(1, Math.min(32, o.maxCandidates ?? 16));
    const n = this.index.length;
    this.val = new Float32Array(n * this.K * 3);
    this.wt = new Float32Array(n * this.K);
    this.q = new Float32Array(n * this.K);
    this.count = new Uint8Array(n);
    this.patchVal = new Float32Array(n * 3);
    this.patchW = new Float32Array(n);
  }

  /** Sample a candidate where it sees the spot clean. Returns how many pixels it offered. */
  add(c: Candidate): number {
    const { width: w } = this;
    const { width: cw, height: ch, data } = c.image;
    const H = c.H;
    const K = this.K;
    let offered = 0;
    for (let j = 0; j < this.index.length; j += 1) {
      const i = this.index[j]!;
      const x = i % w;
      const y = (i - x) / w;
      const d = H[6]! * x + H[7]! * y + H[8]!;
      const u = (H[0]! * x + H[1]! * y + H[2]!) / d;
      const v = (H[3]! * x + H[4]! * y + H[5]!) / d;
      if (!(u >= 0 && v >= 0 && u <= cw - 1 && v <= ch - 1)) continue;
      const x0 = Math.floor(u);
      const y0 = Math.floor(v);
      const x1 = Math.min(cw - 1, x0 + 1);
      const y1 = Math.min(ch - 1, y0 + 1);
      if (c.hole && (c.hole[y0 * cw + x0] || c.hole[y0 * cw + x1] || c.hole[y1 * cw + x0] || c.hole[y1 * cw + x1])) continue;
      const tx = u - x0;
      const ty = v - y0;
      const a = 3 * (y0 * cw + x0);
      const b = 3 * (y0 * cw + x1);
      const e = 3 * (y1 * cw + x0);
      const f = 3 * (y1 * cw + x1);
      // Where it goes: an empty slot, or the lightest one when this candidate is heavier.
      let slot = this.count[j]!;
      if (slot >= K) {
        let min = Infinity;
        let at = -1;
        for (let k = 0; k < K; k += 1) if (this.wt[j * K + k]! < min) (min = this.wt[j * K + k]!), (at = k);
        if (min >= c.weight) continue;
        slot = at;
      } else this.count[j] = slot + 1;
      const o = (j * K + slot) * 3;
      for (let ch3 = 0; ch3 < 3; ch3 += 1) {
        const top = data[a + ch3]! + (data[b + ch3]! - data[a + ch3]!) * tx;
        const bot = data[e + ch3]! + (data[f + ch3]! - data[e + ch3]!) * tx;
        this.val[o + ch3] = (top + (bot - top) * ty) * c.gain[ch3]!;
      }
      this.wt[j * K + slot] = c.weight;
      this.q[j * K + slot] = c.quality;
      offered += 1;
    }
    return offered;
  }

  /**
   * A patch: inside `region` (soft, plate pixels; 0 … 1), the source frame's
   * aligned pixels replace the vote where that frame sees the spot clean.
   */
  patch(c: Candidate, region: Float32Array): void {
    const { width: w } = this;
    const { width: cw, height: ch, data } = c.image;
    const H = c.H;
    for (let j = 0; j < this.index.length; j += 1) {
      const i = this.index[j]!;
      const r = region[i]!;
      if (r <= 0) continue;
      const x = i % w;
      const y = (i - x) / w;
      const d = H[6]! * x + H[7]! * y + H[8]!;
      const u = (H[0]! * x + H[1]! * y + H[2]!) / d;
      const v = (H[3]! * x + H[4]! * y + H[5]!) / d;
      if (!(u >= 0 && v >= 0 && u <= cw - 1 && v <= ch - 1)) continue;
      const xi = Math.round(u);
      const yi = Math.round(v);
      if (c.hole && c.hole[yi * cw + xi]) continue;
      const x0 = Math.floor(u);
      const y0 = Math.floor(v);
      const x1 = Math.min(cw - 1, x0 + 1);
      const y1 = Math.min(ch - 1, y0 + 1);
      const tx = u - x0;
      const ty = v - y0;
      for (let k = 0; k < 3; k += 1) {
        const top = data[3 * (y0 * cw + x0) + k]! + (data[3 * (y0 * cw + x1) + k]! - data[3 * (y0 * cw + x0) + k]!) * tx;
        const bot = data[3 * (y1 * cw + x0) + k]! + (data[3 * (y1 * cw + x1) + k]! - data[3 * (y1 * cw + x0) + k]!) * tx;
        this.patchVal[3 * j + k] = (top + (bot - top) * ty) * c.gain[k]!;
      }
      this.patchW[j] = Math.max(this.patchW[j]!, r);
    }
  }

  /** Vote, apply patches, fill what was never seen, and blend the ring. */
  resolve(): FillResult {
    const { width: w, height: h, K } = this;
    const n = w * h;
    const { tolerance, luma } = this.o;
    const plate = Float32Array.from(this.target.data);
    const confidence = new Float32Array(n).fill(1);
    const inpainted = new Uint8Array(n);
    const patched = new Uint8Array(n);
    const support = new Uint8Array(n);
    const unknown = new Uint8Array(n);
    const ys = new Float32Array(K);
    const order = new Int32Array(K);
    for (let j = 0; j < this.index.length; j += 1) {
      const i = this.index[j]!;
      const inHole = this.holeMask[i] === 1;
      const m = this.count[j]!;
      let r = 0;
      let g = 0;
      let b = 0;
      let conf = 0;
      let ok = false;
      if (m > 0) {
        let total = 0;
        for (let k = 0; k < m; k += 1) {
          const o = (j * K + k) * 3;
          ys[k] = luma[0] * this.val[o]! + luma[1] * this.val[o + 1]! + luma[2] * this.val[o + 2]!;
          order[k] = k;
          total += this.wt[j * K + k]!;
        }
        // Weighted median luminance.
        for (let a2 = 1; a2 < m; a2 += 1) {
          const v = order[a2]!;
          let b2 = a2 - 1;
          while (b2 >= 0 && ys[order[b2]!]! > ys[v]!) {
            order[b2 + 1] = order[b2]!;
            b2 -= 1;
          }
          order[b2 + 1] = v;
        }
        let acc = 0;
        let med = ys[order[0]!]!;
        for (let a2 = 0; a2 < m; a2 += 1) {
          const k = order[a2]!;
          acc += this.wt[j * K + k]!;
          if (acc >= total / 2) {
            med = ys[k]!;
            break;
          }
        }
        const tol = tolerance * Math.max(Math.abs(med), 0.02) + 0.002;
        let wsum = 0;
        let agree = 0;
        let qsum = 0;
        for (let k = 0; k < m; k += 1) {
          if (Math.abs(ys[k]! - med) > tol) continue;
          const wk = this.wt[j * K + k]!;
          const o = (j * K + k) * 3;
          r += wk * this.val[o]!;
          g += wk * this.val[o + 1]!;
          b += wk * this.val[o + 2]!;
          wsum += wk;
          qsum += wk * this.q[j * K + k]!;
          agree += 1;
        }
        if (wsum > 0) {
          r /= wsum;
          g /= wsum;
          b /= wsum;
          ok = true;
          support[i] = Math.min(255, agree);
          // Seen clean in three or more agreeing frames is confident; disagreement and bad alignment lower it.
          conf = Math.min(1, agree / 3) * Math.sqrt(wsum / total) * (qsum / wsum);
        }
      }
      const pw = this.patchW[j]!;
      if (pw > 0) {
        r = ok ? r + (this.patchVal[3 * j]! - r) * pw : this.patchVal[3 * j]!;
        g = ok ? g + (this.patchVal[3 * j + 1]! - g) * pw : this.patchVal[3 * j + 1]!;
        b = ok ? b + (this.patchVal[3 * j + 2]! - b) * pw : this.patchVal[3 * j + 2]!;
        conf = ok ? conf + (0.9 - conf) * pw : 0.9 * pw;
        ok = true;
        if (inHole) patched[i] = 1;
      }
      if (!inHole) {
        // The feather ring: blend the reconstruction into the frame's own pixels; it stays confident.
        if (!ok) continue;
        const a = pw > 0 ? Math.max(pw, this.ring[i]!) : this.ring[i]!;
        plate[3 * i] = plate[3 * i]! + (r - plate[3 * i]!) * a;
        plate[3 * i + 1] = plate[3 * i + 1]! + (g - plate[3 * i + 1]!) * a;
        plate[3 * i + 2] = plate[3 * i + 2]! + (b - plate[3 * i + 2]!) * a;
        continue;
      }
      if (!ok) {
        unknown[i] = 1;
        confidence[i] = 0;
        continue;
      }
      plate[3 * i] = r;
      plate[3 * i + 1] = g;
      plate[3 * i + 2] = b;
      confidence[i] = Math.max(0, Math.min(1, conf));
    }
    // Never seen clean: spatial fill from the plate around it (pull–push diffusion), confidence 0.
    let unknownCount = 0;
    for (let i = 0; i < n; i += 1) unknownCount += unknown[i]!;
    if (unknownCount) {
      // On a crop round what is unknown (with a margin of known plate to diffuse from), not the whole frame.
      let x0 = w;
      let y0 = h;
      let x1 = -1;
      let y1 = -1;
      for (let i = 0; i < n; i += 1)
        if (unknown[i]) {
          const x = i % w;
          const y = (i - x) / w;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      const margin = Math.max(16, Math.round(0.25 * Math.max(x1 - x0, y1 - y0)));
      x0 = Math.max(0, x0 - margin);
      y0 = Math.max(0, y0 - margin);
      x1 = Math.min(w - 1, x1 + margin);
      y1 = Math.min(h - 1, y1 + margin);
      const cw = x1 - x0 + 1;
      const chh = y1 - y0 + 1;
      const vals = new Float32Array(cw * chh * 3);
      const weights = new Float32Array(cw * chh);
      for (let y = 0; y < chh; y += 1)
        for (let x = 0; x < cw; x += 1) {
          const i = (y + y0) * w + x + x0;
          const j = y * cw + x;
          weights[j] = unknown[i] ? 0 : 1;
          vals[3 * j] = plate[3 * i]!;
          vals[3 * j + 1] = plate[3 * i + 1]!;
          vals[3 * j + 2] = plate[3 * i + 2]!;
        }
      const filled = pullPush(vals, weights, cw, chh, 3);
      for (let y = 0; y < chh; y += 1)
        for (let x = 0; x < cw; x += 1) {
          const i = (y + y0) * w + x + x0;
          if (!unknown[i]) continue;
          const j = y * cw + x;
          plate[3 * i] = filled[3 * j]!;
          plate[3 * i + 1] = filled[3 * j + 1]!;
          plate[3 * i + 2] = filled[3 * j + 2]!;
          inpainted[i] = 1;
        }
    }
    return { width: w, height: h, plate, confidence, hole: this.holeMask, inpainted, patched, support };
  }
}

/** The unresolved mask: removed pixels whose confidence is below `PIXEL_LOW_CONFIDENCE`. */
export function unresolvedOf(r: Pick<FillResult, 'hole' | 'confidence'>): Uint8Array {
  const out = new Uint8Array(r.hole.length);
  for (let i = 0; i < out.length; i += 1) if (r.hole[i] && r.confidence[i]! < PIXEL_LOW_CONFIDENCE) out[i] = 1;
  return out;
}

/** The frame's measurements over its removed area (before the alignment terms the caller adds). */
export function fillStats(r: FillResult): { hole: number; coverage: number; low: number; meanHole: number } {
  let holes = 0;
  let seen = 0;
  let low = 0;
  let sum = 0;
  for (let i = 0; i < r.hole.length; i += 1) {
    if (!r.hole[i]) continue;
    holes += 1;
    if (!r.inpainted[i]) seen += 1;
    if (r.confidence[i]! < PIXEL_LOW_CONFIDENCE) low += 1;
    sum += r.confidence[i]!;
  }
  if (!holes) return { hole: 0, coverage: 1, low: 0, meanHole: 1 };
  return { hole: holes / r.hole.length, coverage: seen / holes, low: low / holes, meanHole: sum / holes };
}
