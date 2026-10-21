import type { TrackViewData } from '../bridge';

/**
 * Marks drawn into a frame image for the AI assistant (addendum 07 §3,
 * `get_frame_image` with an overlay): a small cross per track on that frame,
 * in one colour ("tracks") or by solve error ("errors": green < 0.5 px,
 * amber ≈ 1 px, red > 2 px). Pixels are 4 bytes in the given channel order;
 * coordinates are scaled from plate pixels to the image.
 */

export function errorRgb(e: number): [number, number, number] {
  if (!Number.isFinite(e) || e <= 0) return [127, 166, 204];
  if (e < 0.5) return [58, 208, 122];
  if (e < 1.0) return [200, 210, 60];
  if (e < 2.0) return [255, 165, 40];
  return [255, 70, 60];
}

export function drawTrackOverlay(
  pixels: Uint8Array,
  image: { width: number; height: number; order: 'rgba' | 'bgra' },
  view: TrackViewData,
  frame: number,
  plate: { width: number; height: number },
  mode: 'tracks' | 'errors',
): number {
  const t = view.tracks;
  if (!t) return 0;
  const kx = image.width / plate.width;
  const ky = image.height / plate.height;
  const rms = new Map<number, number>();
  if (view.solve) view.solve.trackIds.forEach((id, k) => rms.set(id, view.solve!.trackRms[k]!));
  const [ri, bi] = image.order === 'rgba' ? [0, 2] : [2, 0];
  const put = (x: number, y: number, c: [number, number, number]) => {
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
    const o = (y * image.width + x) * 4;
    pixels[o + ri] = c[0];
    pixels[o + 1] = c[1];
    pixels[o + bi] = c[2];
    pixels[o + 3] = 255;
  };
  let drawn = 0;
  for (let i = 0; i < t.ids.length; i += 1) {
    const s = t.start[i]!;
    if (frame < s || frame >= s + t.length[i]!) continue;
    const o = (t.offset[i]! + frame - s) * 2;
    const x = Math.round((t.xy[o]! + 0.5) * kx - 0.5);
    const y = Math.round((t.xy[o + 1]! + 0.5) * ky - 0.5);
    const c: [number, number, number] = mode === 'errors' ? errorRgb(rms.get(t.ids[i]!) ?? NaN) : [255, 214, 10];
    for (let d = -3; d <= 3; d += 1) {
      put(x + d, y, c);
      put(x, y + d, c);
    }
    drawn += 1;
  }
  return drawn;
}
