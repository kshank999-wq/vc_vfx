import { pointInQuad } from '../camera/planar';
import type { LinearImage } from '../key/linear';
import { gaussianBlur } from '../roto/image';
import { luminanceOf, quantile } from './image';

/**
 * What can be wrong with a photographed surface (master spec §19 "show
 * confidence/problem areas"; addendum 12 §3.5), measured on the photo itself
 * where the region is (not on the resampled texture, which resampling would
 * soften or sharpen):
 *  - sharpness: fine detail against coarse detail — mean |g − G₁(g)| over
 *    mean |G₁(g) − G₂.₅(g)| on perceptual luminance inside the region —
 *    about 0.6 and more for a sharp
 *    photo, falling towards 0 as it blurs (focus, motion, too slow a shutter);
 *  - clipped highlights: texels with a channel at the picture's white
 *    (1 for a display-encoded photo; the plateau at the maximum of a linear one);
 *  - specular glints, on the delit texture: much brighter than their
 *    surroundings and nearly colourless.
 */

export interface PhotoProblems {
  sharpness: number;
  clipped: number;
}

/** The photo's white: 1 for a display-referred photo; for a linear one, its maximum when a plateau sits there (else ∞: nothing clipped). */
export function photoWhite(photo: LinearImage, displayReferred: boolean, decodedWhite: number): number {
  if (displayReferred) return decodedWhite;
  let max = 0;
  const d = photo.data;
  for (let i = 0; i < d.length; i += 1) if (d[i]! > max) max = d[i]!;
  let at = 0;
  for (let i = 0; i < d.length; i += 3) if (Math.max(d[i]!, d[i + 1]!, d[i + 2]!) >= max * 0.999) at += 1;
  return at / (d.length / 3) > 0.0005 ? max : Infinity;
}

export function photoProblems(photo: LinearImage, corners: readonly (readonly [number, number])[], fullWidth: number, luma: readonly [number, number, number], white: number): PhotoProblems {
  const k = photo.width / fullWidth;
  const q = corners.map((c) => [(c[0] + 0.5) * k - 0.5, (c[1] + 0.5) * k - 0.5] as [number, number]);
  const xs = q.map((p) => p[0]);
  const ys = q.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const x1 = Math.min(photo.width - 1, Math.ceil(Math.max(...xs)));
  const y1 = Math.min(photo.height - 1, Math.ceil(Math.max(...ys)));
  // Clipping over the whole region (every 1–4 pixels).
  const step = Math.max(1, Math.round(Math.sqrt(((x1 - x0 + 1) * (y1 - y0 + 1)) / 400_000)));
  let inside = 0;
  let clipped = 0;
  for (let y = y0; y <= y1; y += step)
    for (let x = x0; x <= x1; x += step) {
      if (!pointInQuad(q, x, y)) continue;
      inside += 1;
      const i = 3 * (y * photo.width + x);
      if (Math.max(photo.data[i]!, photo.data[i + 1]!, photo.data[i + 2]!) >= white * 0.995) clipped += 1;
    }
  // Sharpness over the region (its middle 1536 × 1536 at most), the border and a margin inside the corners left out.
  const cw = Math.min(1536, x1 - x0 + 1);
  const chh = Math.min(1536, y1 - y0 + 1);
  const ox = Math.round((x0 + x1 + 1 - cw) / 2);
  const oy = Math.round((y0 + y1 + 1 - chh) / 2);
  let r = 0.6;
  if (cw >= 16 && chh >= 16) {
    const g = new Float32Array(cw * chh);
    for (let y = 0; y < chh; y += 1)
      for (let x = 0; x < cw; x += 1) {
        const i = 3 * ((oy + y) * photo.width + ox + x);
        g[y * cw + x] = Math.sqrt(Math.max(0, Math.min(white, luma[0] * photo.data[i]! + luma[1] * photo.data[i + 1]! + luma[2] * photo.data[i + 2]!)));
      }
    const g1 = gaussianBlur(g, cw, chh, 1);
    const g2 = gaussianBlur(g, cw, chh, 2.5);
    // Shrink the quad by 6 px towards its centre: no blur from outside the region counts.
    const cx = q.reduce((a, p) => a + p[0], 0) / 4;
    const cy = q.reduce((a, p) => a + p[1], 0) / 4;
    const inner = q.map(([x, y]) => {
      const d = Math.hypot(x - cx, y - cy) || 1;
      const k = Math.max(0, 1 - 8 / d);
      return [cx + (x - cx) * k, cy + (y - cy) * k] as [number, number];
    });
    let e1 = 0;
    let e2 = 0;
    for (let y = 4; y < chh - 4; y += 1)
      for (let x = 4; x < cw - 4; x += 1) {
        if (!pointInQuad(inner, ox + x, oy + y)) continue;
        const i = y * cw + x;
        e1 += Math.abs(g[i]! - g1[i]!);
        e2 += Math.abs(g1[i]! - g2[i]!);
      }
    if (e2 > 1e-9) r = e1 / e2;
  }
  return { sharpness: Math.max(0, Math.min(1, r / 0.6)), clipped: inside ? clipped / inside : 0 };
}

/** Share of the delit texture that is specular glint: well over the local brightness and over the surface's own brightest material, and nearly colourless. */
export function specularShare(img: LinearImage, mask: Uint8Array | null, luma: readonly [number, number, number]): number {
  const { width: w, height: h, data } = img;
  const L = luminanceOf(img, luma);
  const med = quantile(L, mask, 0.5);
  // A glint outshines the surface's brightest material (mortar, grout, a fleck of paint) as well as its surroundings.
  const bright = quantile(L, mask, 0.97);
  // The surroundings' brightness with the glints themselves held down, so a large glint does not raise its own.
  const held = Float32Array.from(L, (v) => Math.min(v, 1.2 * bright));
  const local = gaussianBlur(held, w, h, Math.max(3, Math.min(w, h) / 30));
  let n = 0;
  let hits = 0;
  for (let i = 0; i < w * h; i += 1) {
    if (mask && !mask[i]) continue;
    n += 1;
    const l = L[i]!;
    if (l < 2.2 * Math.max(local[i]!, med * 0.5) || l < 1.6 * bright) continue;
    const r = data[3 * i]!;
    const g = data[3 * i + 1]!;
    const b = data[3 * i + 2]!;
    const mx = Math.max(r, g, b);
    if (mx > 0 && (mx - Math.min(r, g, b)) / mx < 0.25) hits += 1;
  }
  return n ? hits / n : 0;
}
