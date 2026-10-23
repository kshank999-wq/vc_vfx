import { describe, expect, it } from 'vitest';
import { alignShot } from '../cleanplate/align';
import { cleanPlateScene, inv3, mul3 } from '../cleanplate/synthetic';
import { applyH } from '../camera/two-view';
import type { LinearImage } from '../key/linear';

/**
 * Alignment of a non-square plate (addendum 17). The clean-plate, sky and
 * background-removal engines relate frames by homographies found in the
 * plate's stored pixels. A pixel-aspect scaling S is itself a homography, so
 * the camera's homography in stored pixels is S⁻¹·H·S of the physical one —
 * exactly, with no error from working squeezed — and every output stays at
 * the plate's native resolution. This checks it on a panning shot stored 2×
 * squeezed: the homographies found match the conjugated truth.
 */

const A = 2;

function squeeze(img: LinearImage, a: number): LinearImage {
  const w = Math.round(img.width / a);
  const out = new Float32Array(w * img.height * 3);
  for (let y = 0; y < img.height; y += 1)
    for (let x = 0; x < w; x += 1)
      for (let c = 0; c < 3; c += 1) {
        let s = 0;
        for (let k = 0; k < a; k += 1) s += img.data[(y * img.width + x * a + k) * 3 + c]!;
        out[(y * w + x) * 3 + c] = s / a;
      }
  return { width: w, height: img.height, data: out };
}

function squeezeMask(m: Float32Array, w: number, h: number, a: number): Uint8Array {
  const ws = Math.round(w / a);
  const out = new Uint8Array(ws * h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) if (m[y * w + x]! > 0.02) out[y * ws + Math.floor(x / a)] = 1;
  return out;
}

describe('homography alignment on a 2× squeezed plate', () => {
  it('finds S⁻¹·H·S of the physical camera motion, sub-pixel, at the stored size', async () => {
    const scene = cleanPlateScene({ width: 480, height: 270, frames: 24, camera: 'pan', pan: 60, noise: 0.002, stand: false, seed: 4 });
    const frames = Array.from({ length: scene.frames }, (_, i) => i);
    const ref = 12;
    const shot = await alignShot(frames, ref, async (f) => ({ image: squeeze(scene.render(f), A), hole: squeezeMask(scene.crew(f), scene.width, scene.height, A) }), { luma: [0.2722, 0.6741, 0.0537], model: 'homography', maxWidth: 480 });
    // Stored pixel x_s ↔ physical x_p = a·(x_s + ½) − ½.
    const S = [A, 0, (A - 1) / 2, 0, 1, 0, 0, 0, 1];
    const Si = inv3(S);
    let worst = 0;
    for (const f of [0, 5, 18, 23]) {
      const truth = mul3(Si, mul3(scene.homography(ref, f), S));
      const H = shot.frames.get(f)!.H;
      for (const [x, y] of [[20, 20], [200, 30], [40, 250], [220, 240], [120, 135]] as const) {
        const p = applyH(H, x, y);
        const q = applyH(truth, x, y);
        worst = Math.max(worst, Math.hypot(p[0] - q[0], p[1] - q[1]));
      }
    }
    console.log(`2× squeezed pan: worst mapping error ${worst.toFixed(3)} stored px against S⁻¹HS; shot residual ${shot.residual.toFixed(3)} px; motion ${shot.motion.toFixed(1)} px`);
    expect(worst).toBeLessThan(0.5);
    expect(shot.residual).toBeLessThan(0.5);
  }, 120_000);
});
