import { describe, expect, it } from 'vitest';
import { applyH } from '../camera/two-view';
import { homographyFromQuads, trackPlanar, trackPoint, blendRuns, type Quad } from '../camera/planar';
import { textureAt } from '../camera/render';
import type { GrayFrame } from '../camera/klt';

/**
 * Planar and point tracking (addendum 06 §7) on a synthetic shot: a textured
 * "screen" warped onto a textured background by known homographies (moving,
 * turning in perspective, scaling), rendered with 3×3 supersampling. The bar:
 * every corner within 0.5 px of the truth.
 */

const W = 480;
const H = 270;
const N = 30;

function cornersAt(t: number): Quad {
  // A quad that slides, scales and turns in perspective.
  const cx = 200 + 60 * t;
  const cy = 130 + 20 * Math.sin(2 * t);
  const sx = 90 + 25 * t;
  const sy = 55 + 10 * t;
  const k = 18 * Math.sin(1.5 * t); // perspective: one side taller than the other
  return [
    [cx - sx, cy - sy - k * 0.5],
    [cx + sx, cy - sy + k],
    [cx + sx + 5 * t, cy + sy - k],
    [cx - sx, cy + sy + k * 0.5],
  ];
}

function render(t: number, occluder?: { x: number; y: number; r: number }): GrayFrame {
  const q = cornersAt(t);
  const unit: Quad = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  const toUnit = homographyFromQuads(q, unit)!;
  const data = new Float32Array(W * H);
  const ss = 3;
  for (let y = 0; y < H; y += 1)
    for (let x = 0; x < W; x += 1) {
      let s = 0;
      for (let j = 0; j < ss; j += 1)
        for (let i = 0; i < ss; i += 1) {
          const px = x + (i + 0.5) / ss - 0.5;
          const py = y + (j + 0.5) / ss - 0.5;
          if (occluder && Math.hypot(px - occluder.x, py - occluder.y) < occluder.r) {
            s += 0.95;
            continue;
          }
          const [u, v] = applyH(toUnit, px, py);
          if (u >= 0 && u <= 1 && v >= 0 && v <= 1) s += textureAt({ kind: 'tiles', cells: 9, seed: 5, tint: [1, 1, 1] }, u, v, 0.6)[0];
          else s += 0.25 + 0.5 * textureAt({ kind: 'tiles', cells: 40, seed: 9, tint: [1, 1, 1] }, px / W, py / H, H / W)[0];
        }
      data[y * W + x] = s / (ss * ss);
    }
  return { width: W, height: H, data };
}

const frames = Array.from({ length: N }, (_, i) => render(i / (N - 1)));
const io = { frame: async (f: number) => frames[f]! };

describe('planar tracking', () => {
  it('follows a surface through translation, scale and perspective to under 0.5 px at every corner', async () => {
    const steps = await trackPlanar(io, { frame: 0, corners: cornersAt(0) }, Array.from({ length: N - 1 }, (_, i) => i + 1));
    expect(steps).toHaveLength(N - 1);
    let worst = 0;
    for (const s of steps) {
      expect(s.status).toBe('tracked');
      const truth = cornersAt(s.frame / (N - 1));
      s.corners.forEach((c, i) => (worst = Math.max(worst, Math.hypot(c[0] - truth[i]![0], c[1] - truth[i]![1]))));
      expect(s.confidence).toBeGreaterThan(0.6);
    }
    expect(worst).toBeLessThan(0.5);
  }, 30_000);

  it('tracks backward from a later key, and ignores an occluder given its matte', async () => {
    const occ = { x: 260, y: 140, r: 40 };
    const occFrames = Array.from({ length: N }, (_, i) => (i >= 10 && i <= 20 ? render(i / (N - 1), occ) : frames[i]!));
    const mask = new Uint8Array(W * H);
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) if (Math.hypot(x - occ.x, y - occ.y) < occ.r + 2) mask[y * W + x] = 1;
    const occIo = { frame: async (f: number) => occFrames[f]!, occlusion: async (f: number) => (f >= 10 && f <= 20 ? mask : null) };
    const back = await trackPlanar(occIo, { frame: N - 1, corners: cornersAt(1) }, Array.from({ length: N - 1 }, (_, i) => N - 2 - i));
    let worst = 0;
    for (const s of back) {
      const truth = cornersAt(s.frame / (N - 1));
      s.corners.forEach((c, i) => (worst = Math.max(worst, Math.hypot(c[0] - truth[i]![0], c[1] - truth[i]![1]))));
    }
    expect(worst).toBeLessThan(0.5);
  }, 30_000);

  it('blends two runs between keys linearly', () => {
    const a = [{ frame: 1, points: [[0, 0]] as [number, number][], confidence: 1, status: 'tracked' as const }];
    const b = [{ frame: 1, points: [[4, 8]] as [number, number][], confidence: 0.5, status: 'tracked' as const }];
    expect(blendRuns(a, b, 0, 4)[0]!.points[0]).toEqual([1, 2]);
  });
});

describe('point tracking', () => {
  it('follows a point to a fraction of a pixel', async () => {
    const H0 = homographyFromQuads(cornersAt(0), [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ])!;
    // A tile corner inside the surface: (2/9, 3/9) in unit coordinates of the quad.
    const unitPt: [number, number] = [2 / 9, 4 / 9];
    const at = (t: number) => {
      const toImg = homographyFromQuads(
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
        cornersAt(t),
      )!;
      return applyH(toImg, unitPt[0], unitPt[1]);
    };
    void H0;
    const steps = await trackPoint(io, { frame: 0, point: at(0) }, Array.from({ length: N - 1 }, (_, i) => i + 1), { pattern: 8, search: 24 });
    let worst = 0;
    for (const s of steps) {
      const truth = at(s.frame / (N - 1));
      worst = Math.max(worst, Math.hypot(s.point[0] - truth[0], s.point[1] - truth[1]));
      expect(s.status).toBe('tracked');
    }
    // The pattern deforms (scale, perspective); the affine refinement follows it.
    expect(worst).toBeLessThan(0.5);
  }, 30_000);
});
