import type { LinearImage } from '../key/linear';
import { luminanceOf } from './image';

/**
 * Seamless tiling (master spec §12 "generate seamless/tileable texture
 * regions"; addendum 12 §3.3).
 *
 * To tile across x, the texture's two ends are overlapped by `overlap` of its
 * width and joined where they agree best:
 *  1. the overlap's right end (R) and left end (L) are compared texel by
 *     texel (perceptual luminance-weighted colour difference);
 *  2. the seam is the minimum-cost connected path through that difference
 *     from the top row to the bottom — an optimal cut (dynamic programming,
 *     the graph cut of image quilting for a monotone seam), kept away from
 *     the overlap's edges; for a texture that also tiles in y the path is
 *     made periodic (it ends beside where it starts), so the seam itself
 *     wraps;
 *  3. left of the seam the texels come from R, right of it from L, feathered
 *     over a few texels (about one photo pixel: an upsampled texture has no
 *     sharp steps of its own); the tile is the texture minus the overlap, so
 *     its right edge runs straight on into its left edge (they were
 *     neighbours in the photo);
 *  4. in the gradient domain, the two ends' low-frequency difference along
 *     the seam (light that changed between them) is not switched at the cut
 *     but spread over the whole overlap: the 1-D Poisson solution between the
 *     overlap's two edges (a ramp, zero change at both), smoothed along the
 *     seam.
 * For x and y: x first, then the same down the columns of the result.
 *
 * Measured: the seam visibility — the step across the cut (over the feather)
 * and across the tile's wrap in the result, each against the texture's own
 * steps over the same distance (1 ≈ invisible), the worse of the two.
 */

export interface TileResult {
  image: LinearImage;
  /** The seam column per row (x), and per column (y), inside the overlap; null for an axis not tiled. */
  seamX: Int32Array | null;
  seamY: Int32Array | null;
  /** Seam visibility of the result (see above). */
  score: number;
  /** The same for the texture repeated as it was (no seam work), for comparison. */
  scoreBefore: number;
  /** Overlap widths used, texels. */
  overlapX: number;
  overlapY: number;
}

const perceptual = (img: LinearImage, luma: readonly [number, number, number]) => {
  const L = luminanceOf(img, luma);
  for (let i = 0; i < L.length; i += 1) L[i] = Math.sqrt(Math.max(0, L[i]!));
  return L;
};

function transpose(img: LinearImage): LinearImage {
  const { width: w, height: h, data } = img;
  const out = new Float32Array(data.length);
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      const s = 3 * (y * w + x);
      const d = 3 * (x * h + y);
      out[d] = data[s]!;
      out[d + 1] = data[s + 1]!;
      out[d + 2] = data[s + 2]!;
    }
  return { width: h, height: w, data: out };
}

/** Mean perceptual step across the wrap (last column → first) against the mean step between neighbouring columns. */
export function wrapRatio(img: LinearImage, luma: readonly [number, number, number]): number {
  const { width: w, height: h } = img;
  const P = perceptual(img, luma);
  let wrap = 0;
  let all = 0;
  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    wrap += Math.abs(P[row]! - P[row + w - 1]!);
    for (let x = 0; x < w - 1; x += 1) all += Math.abs(P[row + x + 1]! - P[row + x]!);
  }
  const typical = all / Math.max(1, h * (w - 1));
  return typical > 1e-9 ? wrap / h / typical : 1;
}

interface CutResult {
  image: LinearImage;
  seam: Int32Array;
  /** The step across the cut in the result against the texture's mean step. */
  mismatch: number;
  overlap: number;
}

/** Make a texture tile across x (the overlap and the cut as above). */
function tileX(img: LinearImage, overlapFrac: number, periodic: boolean, luma: readonly [number, number, number], feather: number): CutResult {
  const { width: W, height: H, data } = img;
  const o = Math.max(4, Math.min(Math.floor(W / 2) - 1, Math.round(overlapFrac * W)));
  const Wt = W - o;
  const P = perceptual(img, luma);
  // Cost of cutting at overlap column x on row y: how much R and L differ there.
  const cost = new Float64Array(H * o);
  const margin = Math.max(1, Math.round(o * 0.15));
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < o; x += 1) {
      const l = y * W + x;
      const r = y * W + Wt + x;
      let c = 0;
      for (let k = 0; k < 3; k += 1) {
        const d = Math.sqrt(Math.max(0, data[3 * r + k]!)) - Math.sqrt(Math.max(0, data[3 * l + k]!));
        c += d * d;
      }
      // Agreeing neighbours matter too: a cut between agreeing texels hides best.
      const dl = x > 0 ? Math.abs(P[r]! - P[r - 1]! - (P[l]! - P[l - 1]!)) : 0;
      cost[y * o + x] = c + 0.5 * dl * dl + (x < margin || x >= o - margin ? 1e3 : 0);
    }
  }
  const dp = (start: number | null): { seam: Int32Array; total: number } => {
    const E = new Float64Array(H * o);
    const from = new Int8Array(H * o);
    for (let x = 0; x < o; x += 1) E[x] = start === null || x === start ? cost[x]! : Infinity;
    for (let y = 1; y < H; y += 1)
      for (let x = 0; x < o; x += 1) {
        let best = E[(y - 1) * o + x]!;
        let d = 0;
        if (x > 0 && E[(y - 1) * o + x - 1]! < best) {
          best = E[(y - 1) * o + x - 1]!;
          d = -1;
        }
        if (x < o - 1 && E[(y - 1) * o + x + 1]! < best) {
          best = E[(y - 1) * o + x + 1]!;
          d = 1;
        }
        E[y * o + x] = best + cost[y * o + x]!;
        from[y * o + x] = d;
      }
    let end = -1;
    let total = Infinity;
    for (let x = 0; x < o; x += 1) {
      if (start !== null && Math.abs(x - start) > 1) continue;
      if (E[(H - 1) * o + x]! < total) {
        total = E[(H - 1) * o + x]!;
        end = x;
      }
    }
    const seam = new Int32Array(H);
    let x = Math.max(0, end);
    for (let y = H - 1; y >= 0; y -= 1) {
      seam[y] = x;
      x += from[y * o + x]!;
    }
    return { seam, total };
  };
  let { seam } = dp(null);
  if (periodic) seam = dp(seam[H - 1]!).seam;
  // The low-frequency difference between the two ends along the seam (L − R), smoothed along it.
  const D = new Float64Array(H * 3);
  for (let y = 0; y < H; y += 1) {
    const s = seam[y]!;
    for (let k = 0; k < 3; k += 1) {
      let acc = 0;
      let n = 0;
      for (let x = Math.max(0, s - 2); x <= Math.min(o - 1, s + 2); x += 1) {
        acc += data[3 * (y * W + x) + k]! - data[3 * (y * W + Wt + x) + k]!;
        n += 1;
      }
      D[3 * y + k] = acc / n;
    }
  }
  const sigma = Math.max(1, o / 4);
  const rad = Math.ceil(2.5 * sigma);
  const Ds = new Float64Array(H * 3);
  for (let y = 0; y < H; y += 1) {
    let wsum = 0;
    for (let d = -rad; d <= rad; d += 1) {
      let yy = y + d;
      if (periodic) yy = ((yy % H) + H) % H;
      else if (yy < 0 || yy >= H) continue;
      const wgt = Math.exp((-d * d) / (2 * sigma * sigma));
      wsum += wgt;
      for (let k = 0; k < 3; k += 1) Ds[3 * y + k]! += wgt * D[3 * yy + k]!;
    }
    for (let k = 0; k < 3; k += 1) Ds[3 * y + k]! /= wsum;
  }
  // Composite: R left of the seam and L right of it (feathered over ±f texels), the rest of the texture
  // after the overlap; the low-frequency difference D is not switched at the seam but spread as a ramp
  // over the whole overlap (the 1-D Poisson solution between the overlap's two edges).
  const f = Math.max(1, Math.min(Math.floor(o / 6), Math.round(feather)));
  const out = new Float32Array(Wt * H * 3);
  for (let y = 0; y < H; y += 1) {
    const s = seam[y]!;
    for (let x = 0; x < Wt; x += 1) {
      const b = 3 * (y * Wt + x);
      if (x >= o) {
        const a = 3 * (y * W + x);
        out[b] = data[a]!;
        out[b + 1] = data[a + 1]!;
        out[b + 2] = data[a + 2]!;
        continue;
      }
      const alpha = Math.max(0, Math.min(1, (x - s + f + 0.5) / (2 * f + 1)));
      const beta = (x + 1) / (o + 1);
      const l = 3 * (y * W + x);
      const r = 3 * (y * W + Wt + x);
      for (let k = 0; k < 3; k += 1) {
        const R = data[r + k]!;
        const L = data[l + k]!;
        const d = Ds[3 * y + k]!;
        out[b + k] = Math.max(0, R + alpha * (L - R - d) + beta * d);
      }
    }
  }
  // What shows: the step across the seam (over the feather) in the result, against the texture's own steps over that distance.
  const span = 2 * f + 1;
  let across = 0;
  let typicalSpan = 0;
  const Pout = new Float32Array(Wt * H);
  for (let i = 0; i < Wt * H; i += 1) Pout[i] = Math.sqrt(Math.max(0, luma[0] * out[3 * i]! + luma[1] * out[3 * i + 1]! + luma[2] * out[3 * i + 2]!));
  for (let y = 0; y < H; y += 1) {
    const s = seam[y]!;
    across += Math.abs(Pout[y * Wt + Math.min(Wt - 1, s + f)]! - Pout[y * Wt + Math.max(0, s - f - 1)]!);
    for (let x = 0; x + span < W; x += 1) typicalSpan += Math.abs(P[y * W + x + span]! - P[y * W + x]!);
  }
  typicalSpan /= Math.max(1, H * (W - span));
  return { image: { width: Wt, height: H, data: out }, seam, mismatch: typicalSpan > 1e-9 ? across / H / typicalSpan : 0, overlap: o };
}

/** Make a texture tile across x, or across x and y. */
export function makeTileable(img: LinearImage, mode: 'x' | 'xy', overlap: number, luma: readonly [number, number, number], feather = 1): TileResult {
  const before = mode === 'xy' ? Math.max(wrapRatio(img, luma), wrapRatio(transpose(img), luma)) : wrapRatio(img, luma);
  const x = tileX(img, overlap, mode === 'xy', luma, feather);
  if (mode === 'x') {
    const score = Math.max(x.mismatch, wrapRatio(x.image, luma));
    return { image: x.image, seamX: x.seam, seamY: null, score, scoreBefore: before, overlapX: x.overlap, overlapY: 0 };
  }
  const y = tileX(transpose(x.image), overlap, true, luma, feather);
  const image = transpose(y.image);
  const score = Math.max(x.mismatch, y.mismatch, wrapRatio(image, luma), wrapRatio(transpose(image), luma));
  return { image, seamX: x.seam, seamY: y.seam, score, scoreBefore: before, overlapX: x.overlap, overlapY: y.overlap };
}

/** Seam visibility of a texture repeated as it is (for a region that is not made to tile, or to compare). */
export function repeatScore(img: LinearImage, mode: 'x' | 'xy', luma: readonly [number, number, number]): number {
  return mode === 'xy' ? Math.max(wrapRatio(img, luma), wrapRatio(transpose(img), luma)) : wrapRatio(img, luma);
}
