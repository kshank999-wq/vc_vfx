import type { TextureRegion } from '@vcvfx/domain';
import type { Intrinsics } from '../camera/geometry';
import { homographyFromQuads } from '../camera/planar';
import { applyH } from '../camera/two-view';
import { inv3 } from '../camera/linalg';
import type { LinearImage } from '../key/linear';
import { distortPixel, undistortPixel } from './geometry';
import { sampleCubic } from './image';

/**
 * Perspective rectification of a photographed surface (master spec §12
 * "correct perspective … as needed for texture extraction"; addendum 12 §3.1).
 *
 * The four corners the artist dragged onto the photo are a rectangle on the
 * surface. They are first taken to the ideal pinhole picture when the lens is
 * known (Brown–Conrady, inverted by Newton steps — the camera tracker's lens
 * model); the homography from the texture's rectangle to that quadrilateral is
 * solved (normalised DLT); each texel is then the photo seen through it:
 * texture pixel → H → undistorted photo pixel → the lens → the photo pixel,
 * sampled bicubically (Keys, a = −½) and averaged over a supersampling grid
 * wherever the photo has more than one pixel per texel, so a texture smaller
 * than the photo is filtered rather than aliased.
 *
 * The texture's aspect comes, in this order, from the surface's real size,
 * its plane in the scan, the focal length (the rectangle's aspect from its
 * vanishing points: Zhang & He's whiteboard rectification), or the corners'
 * own edge lengths — all measured on de-squeezed corners for a non-square
 * picture (a frame of an anamorphic or DV plate; addendum 17). The
 * homography itself is found in stored pixels: a pixel-aspect scaling is a
 * homography, so the warp is the same either way and the photo is sampled as
 * stored.
 */

export type Corners = TextureRegion['corners'];
export type AspectSource = 'size' | 'plane' | 'focal' | 'corners';

/** Corners in the undistorted (pinhole) picture, or as they are without a lens. */
export function pinholeCorners(corners: Corners, intr: Intrinsics | null): [number, number][] {
  return corners.map((c) => (intr ? undistortPixel(intr, c[0], c[1]) : [c[0], c[1]])) as [number, number][];
}

/** Stored pixels → de-squeezed (physical) pixels: x × the pixel aspect (addendum 17). Shapes and angles are measured on these. */
export function desqueezeCorners(q: readonly (readonly [number, number])[], pixelAspect: number): [number, number][] {
  return q.map((p) => [p[0] * pixelAspect, p[1]] as [number, number]);
}

/** The rectangle's aspect (top edge / left edge) from the corners alone: their mean opposite edge lengths. */
export function cornerAspect(q: readonly (readonly [number, number])[]): number {
  const d = (a: readonly [number, number], b: readonly [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const w = (d(q[0]!, q[1]!) + d(q[3]!, q[2]!)) / 2;
  const h = (d(q[0]!, q[3]!) + d(q[1]!, q[2]!)) / 2;
  return h > 0 ? w / h : 1;
}

/**
 * The aspect of the rectangle a perspective quadrilateral images, from the
 * focal length (Zhang & He 2007, "Whiteboard scanning and image
 * enhancement"): pinhole corners TL, TR, BR, BL, the principal point at
 * (cx, cy). Null when the geometry is degenerate.
 */
export function focalAspect(q: readonly (readonly [number, number])[], f: number, cx: number, cy: number): number | null {
  const m = (p: readonly [number, number]) => [p[0] - cx, p[1] - cy, 1];
  const m1 = m(q[0]!);
  const m2 = m(q[1]!);
  const m4 = m(q[2]!);
  const m3 = m(q[3]!);
  const crossv = (a: number[], b: number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
  const dotv = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  const c14 = crossv(m1, m4);
  const k2 = dotv(c14, m3) / dotv(crossv(m2, m4), m3);
  const k3 = dotv(c14, m2) / dotv(crossv(m3, m4), m2);
  if (!Number.isFinite(k2) || !Number.isFinite(k3)) return null;
  const n2 = m2.map((v, i) => k2 * v - m1[i]!);
  const n3 = m3.map((v, i) => k3 * v - m1[i]!);
  const f2 = 1 / (f * f);
  const a = n2[0]! * n2[0]! * f2 + n2[1]! * n2[1]! * f2 + n2[2]! * n2[2]!;
  const b = n3[0]! * n3[0]! * f2 + n3[1]! * n3[1]! * f2 + n3[2]! * n3[2]!;
  if (!(a > 0 && b > 0)) return null;
  const r = Math.sqrt(a / b);
  return Number.isFinite(r) && r > 0.01 && r < 100 ? r : null;
}

/**
 * The focal length (pixels) at which a perspective quadrilateral is the image
 * of a rectangle, the principal point at (cx, cy) (Zhang & He 2007, eq. 11):
 * both vanishing points must be finite. Null when the quadrilateral is too
 * close to a parallelogram (one side's vanishing point at infinity) or the
 * answer is not a real focal length. Square-pixel coordinates: de-squeeze a
 * non-square picture's corners first (addendum 17) — the same corners read
 * squeezed give a different, wrong focal length.
 */
export function rectangleFocal(q: readonly (readonly [number, number])[], cx: number, cy: number): number | null {
  const m = (p: readonly [number, number]) => [p[0] - cx, p[1] - cy, 1];
  const m1 = m(q[0]!);
  const m2 = m(q[1]!);
  const m4 = m(q[2]!);
  const m3 = m(q[3]!);
  const crossv = (a: number[], b: number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
  const dotv = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  const c14 = crossv(m1, m4);
  const k2 = dotv(c14, m3) / dotv(crossv(m2, m4), m3);
  const k3 = dotv(c14, m2) / dotv(crossv(m3, m4), m2);
  if (!Number.isFinite(k2) || !Number.isFinite(k3)) return null;
  const n2 = m2.map((v, i) => k2 * v - m1[i]!);
  const n3 = m3.map((v, i) => k3 * v - m1[i]!);
  // Both vanishing points finite: neither n·z vanishes (relative to the side's length in pixels, over a generous focal range).
  const den = n2[2]! * n3[2]!;
  if (Math.abs(n2[2]!) * 1e5 < Math.hypot(n2[0]!, n2[1]!) * 1e-3 || Math.abs(n3[2]!) * 1e5 < Math.hypot(n3[0]!, n3[1]!) * 1e-3 || den === 0) return null;
  const f2 = -(n2[0]! * n3[0]! + n2[1]! * n3[1]!) / den;
  if (!(f2 > 0)) return null;
  const f = Math.sqrt(f2);
  return Number.isFinite(f) ? f : null;
}

export interface RectifyInput {
  /** The photo as read: possibly smaller than the file (corners and lens are at the file's size). */
  photo: LinearImage;
  fullWidth: number;
  fullHeight: number;
  corners: Corners;
  /** The lens at the file's size, when known (undistortion and the focal length). */
  intr: Intrinsics | null;
  undistort: boolean;
  rectify: boolean;
  width: number;
  height: number;
  /** Texels per metre, when the real size is known (for the photo's own density). */
  texelDensity: number | null;
  signal?: { aborted: boolean };
}

export interface RectifyOutput {
  image: LinearImage;
  /** 1 where the texel came from inside the photo. */
  mask: Uint8Array;
  /** Photo pixel (undistorted when `undistorted`, the file's size) → texture pixel, row-major 3×3. */
  H: number[];
  undistorted: boolean;
  coverage: number;
  /** Photo pixels per texel along the photo's sparsest direction (the file's size), over the texture. */
  minScale: number;
  /** Photo pixels per metre there; null without a real size. */
  nativeDensity: number | null;
}

/** Texture pixel → photo pixel (the file's size, undistorted when a lens is used). */
export function textureToPhoto(input: Pick<RectifyInput, 'corners' | 'intr' | 'undistort' | 'rectify' | 'width' | 'height'>): { H: number[]; undistorted: boolean } {
  const lens = input.undistort && input.intr ? input.intr : null;
  const q = pinholeCorners(input.corners, lens);
  const W = input.width;
  const Ht = input.height;
  const rect: [number, number][] = [
    [-0.5, -0.5],
    [W - 0.5, -0.5],
    [W - 0.5, Ht - 0.5],
    [-0.5, Ht - 0.5],
  ];
  if (!input.rectify) {
    // The corners' bounding box as it is (no perspective correction).
    const xs = q.map((p) => p[0]);
    const ys = q.map((p) => p[1]);
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    const sx = (Math.max(...xs) - x0) / W;
    const sy = (Math.max(...ys) - y0) / Ht;
    return { H: [sx, 0, x0 + 0.5 * sx, 0, sy, y0 + 0.5 * sy, 0, 0, 1], undistorted: Boolean(lens) };
  }
  const H = homographyFromQuads(rect, q);
  if (!H) throw new Error('The region’s corners do not make a usable rectangle');
  return { H, undistorted: Boolean(lens) };
}

/** Singular values of the Jacobian of H at (x, y): photo pixels per texel along the two principal directions. */
function jacobianScales(H: readonly number[], x: number, y: number): [number, number] {
  const w = H[6]! * x + H[7]! * y + H[8]!;
  const u = (H[0]! * x + H[1]! * y + H[2]!) / w;
  const v = (H[3]! * x + H[4]! * y + H[5]!) / w;
  const a = (H[0]! - u * H[6]!) / w;
  const b = (H[1]! - u * H[7]!) / w;
  const c = (H[3]! - v * H[6]!) / w;
  const d = (H[4]! - v * H[7]!) / w;
  const s1 = a * a + b * b + c * c + d * d;
  const det = Math.abs(a * d - b * c);
  const root = Math.sqrt(Math.max(0, s1 * s1 - 4 * det * det));
  return [Math.sqrt(Math.max(0, (s1 - root) / 2)), Math.sqrt((s1 + root) / 2)];
}

export function rectifyRegion(input: RectifyInput): RectifyOutput {
  const { photo, width: W, height: Ht } = input;
  const { H, undistorted } = textureToPhoto(input);
  const lens = undistorted ? input.intr : null;
  const k = photo.width / input.fullWidth;
  // How many photo pixels (as read) a texel spans: supersample where there are several.
  let minScale = Infinity;
  let maxScale = 0;
  for (let j = 0; j <= 4; j += 1)
    for (let i = 0; i <= 4; i += 1) {
      const [s0, s1] = jacobianScales(H, (i / 4) * (W - 1), (j / 4) * (Ht - 1));
      minScale = Math.min(minScale, s0);
      maxScale = Math.max(maxScale, s1);
    }
  const ss = Math.max(1, Math.min(4, Math.ceil(maxScale * k - 0.25)));
  const n = W * Ht;
  const out = new Float32Array(n * 3);
  const mask = new Uint8Array(n);
  const tmp = new Float32Array(3);
  let inside = 0;
  for (let y = 0; y < Ht; y += 1) {
    if (input.signal?.aborted) throw new Error('Cancelled');
    for (let x = 0; x < W; x += 1) {
      const o = 3 * (y * W + x);
      let r = 0;
      let g = 0;
      let b = 0;
      let got = 0;
      for (let sj = 0; sj < ss; sj += 1)
        for (let si = 0; si < ss; si += 1) {
          const tx = x + (si + 0.5) / ss - 0.5;
          const ty = y + (sj + 0.5) / ss - 0.5;
          let [u, v] = applyH(H, tx, ty);
          if (lens) [u, v] = distortPixel(lens, u, v);
          // File pixels → pixels of the picture as read.
          if (!sampleCubic(photo, (u + 0.5) * k - 0.5, (v + 0.5) * k - 0.5, tmp, 0)) continue;
          r += tmp[0]!;
          g += tmp[1]!;
          b += tmp[2]!;
          got += 1;
        }
      if (got) {
        out[o] = r / got;
        out[o + 1] = g / got;
        out[o + 2] = b / got;
        if (got === ss * ss) {
          mask[y * W + x] = 1;
          inside += 1;
        }
      }
    }
  }
  const Hinv = inv3(H);
  if (!Hinv) throw new Error('The region’s homography cannot be inverted');
  const s = Hinv[8]! || 1;
  return {
    image: { width: W, height: Ht, data: out },
    mask,
    H: Hinv.map((v) => v / s),
    undistorted,
    coverage: inside / n,
    minScale,
    nativeDensity: input.texelDensity !== null ? input.texelDensity * minScale : null,
  };
}
