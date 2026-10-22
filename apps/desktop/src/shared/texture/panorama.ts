import type { Intrinsics } from '../camera/geometry';
import type { PointCloud } from '../camera/lidar';
import type { LinearImage } from '../key/linear';
import { boxFilter } from '../roto/image';
import { cameraRotation, dirOf, distortPixel, equirectDir, equirectPixel, fromCanonical, rotT, sub, toCanonical, unit, wrapDeg, yawPitchOf, type V3 } from './geometry';
import { luminanceOf, sampleLinear } from './image';

/**
 * Where a photograph was looking, from the panorama (master spec §12 "use
 * panorama/spatial context to suggest where source photographs belong";
 * addendum 12 §3.4).
 *
 * The panorama is re-projected into perspective views — a camera at its
 * centre turned to (yaw, pitch, roll) with the photo's field of view (or a
 * few, when the lens is unknown) — and each view is compared with the photo
 * by normalised cross-correlation of their detail (luminance minus its local
 * mean, so exposure and white balance do not matter): a coarse search over
 * the whole sphere at low resolution, then finer steps round the best, roll
 * and field of view included. The best match is the suggested direction; its
 * correlation, and how far it stands above the best match elsewhere, the
 * confidence. A photo taken away from where the panorama was is still
 * matched (near things shift with the parallax), with a lower score.
 *
 * The panorama's heading in the scan, when not given, comes from a coloured
 * scan: its points splatted into an equirectangular picture seen from the
 * panorama's position and correlated with the panorama over every heading.
 */

export interface PanoramaGrey {
  width: number;
  height: number;
  /** Perceptual luminance (√ of linear), the panorama's own frame. */
  data: Float32Array;
}

export function panoramaGrey(pano: LinearImage, luma: readonly [number, number, number], width = 1024): PanoramaGrey {
  const w = Math.min(width, pano.width);
  const h = Math.round(w / 2);
  const out = new Float32Array(w * h);
  const tmp = new Float32Array(3);
  // Area average where the panorama is larger than the grey (a few samples per pixel).
  const k = Math.max(1, Math.round(pano.width / w));
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      let s = 0;
      for (let j = 0; j < k; j += 1)
        for (let i = 0; i < k; i += 1) {
          sampleLinear(pano, ((x + (i + 0.5) / k) / w) * pano.width - 0.5, ((y + (j + 0.5) / k) / h) * pano.height - 0.5, tmp, 0, true);
          s += luma[0] * tmp[0]! + luma[1] * tmp[1]! + luma[2] * tmp[2]!;
        }
      out[y * w + x] = Math.sqrt(Math.max(0, s / (k * k)));
    }
  return { width: w, height: h, data: out };
}

function sampleGrey(g: PanoramaGrey, u: number, v: number): number {
  const w = g.width;
  const h = g.height;
  const fx = ((u % w) + w) % w;
  const fy = Math.min(h - 1, Math.max(0, v));
  const x0 = Math.floor(fx);
  const x1 = (x0 + 1) % w;
  const y0 = Math.floor(fy);
  const y1 = Math.min(h - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const a = g.data[y0 * w + x0]!;
  const b = g.data[y0 * w + x1]!;
  const c = g.data[y1 * w + x0]!;
  const d = g.data[y1 * w + x1]!;
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

/** Halve a grey panorama (2 × 2 means, wrapping in x). */
function halve(g: PanoramaGrey): PanoramaGrey {
  const w = Math.max(8, g.width >> 1);
  const h = Math.max(4, g.height >> 1);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      const y0 = Math.min(g.height - 1, 2 * y);
      const y1 = Math.min(g.height - 1, 2 * y + 1);
      const x0 = (2 * x) % g.width;
      const x1 = (2 * x + 1) % g.width;
      out[y * w + x] = 0.25 * (g.data[y0 * g.width + x0]! + g.data[y0 * g.width + x1]! + g.data[y1 * g.width + x0]! + g.data[y1 * g.width + x1]!);
    }
  return { width: w, height: h, data: out };
}

const pyramids = new WeakMap<PanoramaGrey, PanoramaGrey[]>();

/** The level of the panorama whose pixels are about as wide as a view pixel (so a small view is not aliased). */
function levelFor(g: PanoramaGrey, degPerPixel: number): PanoramaGrey {
  let levels = pyramids.get(g);
  if (!levels) {
    levels = [g];
    while (levels.at(-1)!.width > 64) levels.push(halve(levels.at(-1)!));
    pyramids.set(g, levels);
  }
  let best = levels[0]!;
  for (const l of levels) if (360 / l.width <= degPerPixel * 1.2) best = l;
  return best;
}

const rayTables = new Map<string, Float32Array>();

/** Unit camera rays of a pinhole view, cached per field of view and size. */
function rayTable(fov: number, width: number, height: number): Float32Array {
  const key = `${fov.toFixed(4)}|${width}|${height}`;
  let t = rayTables.get(key);
  if (t) return t;
  const f = width / 2 / Math.tan((fov * Math.PI) / 360);
  t = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const a = (x - (width - 1) / 2) / f;
      const b = (y - (height - 1) / 2) / f;
      const l = Math.hypot(a, b, 1);
      const i = 3 * (y * width + x);
      t[i] = a / l;
      t[i + 1] = b / l;
      t[i + 2] = 1 / l;
    }
  if (rayTables.size > 64) rayTables.delete(rayTables.keys().next().value!);
  rayTables.set(key, t);
  return t;
}

/** A perspective view of the panorama (grey): a pinhole camera at its centre. */
export function panoramaView(full: PanoramaGrey, view: { yaw: number; pitch: number; roll: number; fov: number }, width: number, height: number): Float32Array {
  const g = levelFor(full, view.fov / width);
  const R = cameraRotation(view.yaw, view.pitch, view.roll);
  const rays = rayTable(view.fov, width, height);
  const out = new Float32Array(width * height);
  const kx = g.width / (2 * Math.PI);
  const ky = g.height / Math.PI;
  for (let i = 0; i < width * height; i += 1) {
    const x = rays[3 * i]!;
    const y = rays[3 * i + 1]!;
    const z = rays[3 * i + 2]!;
    // R ᵀ · ray, then the equirectangular pixel (yaw = atan2(−dx, dz), pitch = asin(dy)).
    const dx = R[0]! * x + R[3]! * y + R[6]! * z;
    const dy = R[1]! * x + R[4]! * y + R[7]! * z;
    const dz = R[2]! * x + R[5]! * y + R[8]! * z;
    const u = (Math.atan2(-dx, dz) + Math.PI) * kx - 0.5;
    const v = (Math.PI / 2 - Math.asin(dy < -1 ? -1 : dy > 1 ? 1 : dy)) * ky - 0.5;
    out[i] = sampleGrey(g, u, v);
  }
  return out;
}

/** A colour perspective view of the panorama (for the viewer). */
export function panoramaViewRgb(pano: LinearImage, view: { yaw: number; pitch: number; roll: number; fov: number }, width: number, height: number): LinearImage {
  const R = cameraRotation(view.yaw, view.pitch, view.roll);
  const f = width / 2 / Math.tan((view.fov * Math.PI) / 360);
  const out = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const d = rotT(R, [(x - (width - 1) / 2) / f, (y - (height - 1) / 2) / f, 1]);
      const [u, v] = equirectPixel(d, pano.width, pano.height);
      sampleLinear(pano, u, v, out, 3 * (y * width + x), true);
    }
  return { width, height, data: out };
}

/** The photo as a small grey picture, undistorted when its lens is known (the matcher's input). */
export function photoGrey(photo: LinearImage, luma: readonly [number, number, number], width: number, intr: Intrinsics | null, fullWidth: number, pixelAspect = intr?.a ?? 1): { data: Float32Array; width: number; height: number } {
  // De-squeezed (addendum 17): the grey picture has the shape the camera saw.
  const height = Math.max(8, Math.round((photo.height / (photo.width * pixelAspect)) * width));
  const out = new Float32Array(width * height);
  const tmp = new Float32Array(3);
  const kRead = photo.width / fullWidth;
  const kOut = fullWidth / width;
  const fullHeight = (photo.height / photo.width) * fullWidth;
  const ss = Math.max(1, Math.min(6, Math.round(photo.width / width)));
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      let s = 0;
      for (let j = 0; j < ss; j += 1)
        for (let i = 0; i < ss; i += 1) {
          // The undistorted picture's pixel, at the file's size …
          let u = (x + (i + 0.5) / ss) * kOut - 0.5;
          let v = (y + (j + 0.5) / ss) * (fullHeight / height) - 0.5;
          // … found in the distorted photo.
          if (intr) [u, v] = distortPixel(intr, u, v);
          sampleLinear(photo, (u + 0.5) * kRead - 0.5, (v + 0.5) * kRead - 0.5, tmp, 0);
          s += luma[0] * tmp[0]! + luma[1] * tmp[1]! + luma[2] * tmp[2]!;
        }
      out[y * width + x] = Math.sqrt(Math.max(0, s / (ss * ss)));
    }
  return { data: out, width, height };
}

/** Detail: the picture minus its local mean, normalised (zero mean, unit variance). */
function detail(src: Float32Array, w: number, h: number): Float32Array {
  const r = Math.max(1, Math.round(Math.min(w, h) / 10));
  const m = boxFilter(src, w, h, r);
  const out = new Float32Array(src.length);
  let mean = 0;
  for (let i = 0; i < src.length; i += 1) {
    out[i] = src[i]! - m[i]!;
    mean += out[i]!;
  }
  mean /= src.length;
  let v = 0;
  for (let i = 0; i < out.length; i += 1) {
    out[i]! -= mean;
    v += out[i]! * out[i]!;
  }
  const s = Math.sqrt(v / out.length) || 1;
  for (let i = 0; i < out.length; i += 1) out[i]! /= s;
  return out;
}

/** Zero mean, unit variance. */
function normalise(src: Float32Array): Float32Array {
  let m = 0;
  for (let i = 0; i < src.length; i += 1) m += src[i]!;
  m /= src.length;
  let v = 0;
  for (let i = 0; i < src.length; i += 1) v += (src[i]! - m) ** 2;
  const s = Math.sqrt(v / src.length) || 1;
  return Float32Array.from(src, (x) => (x - m) / s);
}

const ncc = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i]! * b[i]!;
  return s / a.length;
};

export interface PanoramaMatch {
  yaw: number;
  pitch: number;
  roll: number;
  fov: number;
  /** NCC of the best view. */
  score: number;
  /** NCC of the best view more than 20° away. */
  runnerUp: number;
  confidence: number;
}

/**
 * Match a photo against the panorama. `fov`: the photo's horizontal field of
 * view when its lens is known (null: searched).
 */
export function matchToPanorama(g: PanoramaGrey, photo: { data: Float32Array; width: number; height: number }, fov: number | null, o: { signal?: { aborted: boolean } } = {}): PanoramaMatch {
  const aspect = photo.height / photo.width;
  // Coarse: small views over the whole sphere, compared on normalised luminance (the room's
  // layout and light: walls, corners, lamps — what survives a low resolution and parallax).
  const cw = 32;
  const ch = Math.max(8, Math.round(cw * aspect));
  const P = normalise(resample(photo, cw, ch));
  const fovs = fov ? [fov] : [35, 50, 65, 80, 95];
  type Cand = { yaw: number; pitch: number; roll: number; fov: number; score: number };
  const cands: Cand[] = [];
  for (const fv of fovs) {
    const stepDeg = Math.max(2, Math.min(6, (1.5 * fv) / cw));
    for (let pitch = -78; pitch <= 78; pitch += stepDeg)
      for (let yaw = -180; yaw < 180; yaw += stepDeg) {
        if (o.signal?.aborted) throw new Error('Cancelled');
        const v = normalise(panoramaView(g, { yaw, pitch, roll: 0, fov: fv }, cw, ch));
        cands.push({ yaw, pitch, roll: 0, fov: fv, score: ncc(P, v) });
      }
  }
  cands.sort((a, b) => b.score - a.score);
  // Refine the best few (they may be different places) on luminance and detail together, keep the best.
  const fineW = 80;
  const fineH = Math.max(12, Math.round(fineW * aspect));
  const fineP = resample(photo, fineW, fineH);
  const PfL = normalise(fineP);
  const PfD = detail(fineP, fineW, fineH);
  const scoreAt = (c: Omit<Cand, 'score'>) => {
    const v = panoramaView(g, c, fineW, fineH);
    return 0.5 * ncc(PfL, normalise(v)) + 0.5 * ncc(PfD, detail(v, fineW, fineH));
  };
  const refine = (c: Cand): Cand => {
    let best = { ...c, score: scoreAt(c) };
    for (const step of [3, 1.5, 0.6, 0.25]) {
      let improved = true;
      for (let guard = 0; improved && guard < 8; guard += 1) {
        improved = false;
        const tries: Omit<Cand, 'score'>[] = [
          { ...best, yaw: best.yaw + step },
          { ...best, yaw: best.yaw - step },
          { ...best, pitch: Math.min(89, best.pitch + step) },
          { ...best, pitch: Math.max(-89, best.pitch - step) },
          { ...best, roll: best.roll + step },
          { ...best, roll: best.roll - step },
          ...(fov ? [] : [{ ...best, fov: Math.min(150, best.fov * (1 + step / 30)) }, { ...best, fov: Math.max(10, best.fov / (1 + step / 30)) }]),
        ];
        for (const t of tries) {
          const s = scoreAt(t);
          if (s > best.score + 1e-5) {
            best = { ...t, score: s };
            improved = true;
          }
        }
      }
    }
    return best;
  };
  const seeds: Cand[] = [];
  for (const c of cands) {
    if (seeds.length >= 4) break;
    if (seeds.every((s) => Math.abs(wrapDeg(s.yaw - c.yaw)) > 15 || Math.abs(s.pitch - c.pitch) > 15)) seeds.push(c);
  }
  const refined = seeds.map(refine).sort((a, b) => b.score - a.score);
  const best = refined[0]!;
  // The best elsewhere: the coarse candidates more than 20° from it, at the refined resolution.
  const far = cands.filter((c) => Math.abs(wrapDeg(c.yaw - best.yaw)) > 20 || Math.abs(c.pitch - best.pitch) > 20).slice(0, 6);
  const runnerUp = Math.max(-1, ...far.map((c) => scoreAt(c)), ...refined.slice(1).filter((c) => Math.abs(wrapDeg(c.yaw - best.yaw)) > 20 || Math.abs(c.pitch - best.pitch) > 20).map((c) => c.score));
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const confidence = clamp01((best.score - 0.15) / 0.45) * clamp01((best.score - runnerUp) / 0.2);
  return { yaw: wrapDeg(best.yaw), pitch: best.pitch, roll: wrapDeg(best.roll), fov: best.fov, score: best.score, runnerUp, confidence: Math.round(confidence * 1000) / 1000 };
}

function resample(img: { data: Float32Array; width: number; height: number }, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  const sx = img.width / w;
  const sy = img.height / h;
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      // Box average of the source pixels under the target pixel.
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      const y0 = Math.floor(y * sy);
      const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      let s = 0;
      let n = 0;
      for (let yy = y0; yy < Math.min(img.height, y1); yy += 1)
        for (let xx = x0; xx < Math.min(img.width, x1); xx += 1) {
          s += img.data[yy * img.width + xx]!;
          n += 1;
        }
      out[y * w + x] = n ? s / n : 0;
    }
  return out;
}

/**
 * The panorama's heading in the scan from a coloured scan: its points seen
 * from the panorama's position, splatted into an equirectangular grey, and
 * correlated with the panorama over every heading (1.4° steps, refined to a
 * parabola's peak). Null without colours or enough points.
 */
export function estimateHeading(g: PanoramaGrey, cloud: PointCloud, up: 'y' | 'z', position: ArrayLike<number>, o: { width?: number; stride?: number; heading?: number | null; near?: { heading: number; degrees: number } } = {}): { heading: number; score: number; confidence: number } | null {
  if (!cloud.colors || cloud.count < 500) return null;
  const W = o.width ?? 256;
  const H = W / 2;
  const stride = Math.max(1, o.stride ?? 1);
  const sum = new Float32Array(W * H);
  const depth = new Float32Array(W * H).fill(Infinity);
  const pos = toCanonical(position, up);
  // Scan colours are display-encoded; ~linearised before the √ the panorama grey uses.
  const lin = (q: number) => Math.pow(q / 255, 2.2);
  // The points' spacing (scans are surfaces), as the voxel downsample estimates it, times the stride.
  const ext = [0, 1, 2].map((k) => cloud.bbox.max[k]! - cloud.bbox.min[k]!);
  const spacing = Math.sqrt((ext[0]! * ext[1]! + ext[1]! * ext[2]! + ext[0]! * ext[2]!) / Math.max(1, cloud.count / stride)) * 0.8;
  const pxAngle = (2 * Math.PI) / W;
  for (let i = 0; i < cloud.count; i += stride) {
    const p = toCanonical([cloud.positions[3 * i]! + cloud.origin[0], cloud.positions[3 * i + 1]! + cloud.origin[1], cloud.positions[3 * i + 2]! + cloud.origin[2]], up);
    const d = sub(p, pos);
    const r = Math.hypot(...d);
    if (r < 1e-6) continue;
    // Canonical direction → equirect at heading 0; each point covers its own footprint (no holes between points).
    const [u, v] = equirectPixel(d, W, H);
    const c = cloud.colors;
    const value = Math.sqrt(0.2126 * lin(c[3 * i]!) + 0.7152 * lin(c[3 * i + 1]!) + 0.0722 * lin(c[3 * i + 2]!));
    const rad = Math.min(3, Math.floor((0.5 * spacing) / (r * pxAngle)));
    const x0 = Math.round(u);
    const y0 = Math.round(v);
    for (let dy = -rad; dy <= rad; dy += 1) {
      const y = y0 + dy;
      if (y < 0 || y >= H) continue;
      for (let dx = -rad; dx <= rad; dx += 1) {
        const k = y * W + (((x0 + dx) % W) + W) % W;
        if (r >= depth[k]!) continue;
        depth[k] = r;
        sum[k] = value;
      }
    }
  }
  const filled = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i += 1) if (depth[i]! < Infinity) filled[i] = 1;
  // The panorama at the same size.
  const pg = greyAt(g, W);
  const norm = (a: Float32Array) => {
    let m = 0;
    let n = 0;
    for (let i = 0; i < a.length; i += 1) if (filled[i]) (m += a[i]!), (n += 1);
    m /= Math.max(1, n);
    let v = 0;
    for (let i = 0; i < a.length; i += 1) if (filled[i]) v += (a[i]! - m) ** 2;
    const s = Math.sqrt(v / Math.max(1, n)) || 1;
    return Float32Array.from(a, (q) => (q - m) / s);
  };
  if (filled.reduce((a, b) => a + b, 0) < 0.2 * W * H) return null;
  const S = norm(sum);
  // Panorama shifted by `shift` columns: a scan direction at heading h sits at panorama yaw −h.
  const scores = new Float64Array(W).fill(-Infinity);
  // A heading that is known is only checked (its column), not searched.
  const fixed = o.heading !== null && o.heading !== undefined ? ((Math.round((o.heading / 360) * W) % W) + W) % W : null;
  const nearAt = o.near ? Math.round((o.near.heading / 360) * W) : 0;
  const nearPx = o.near ? Math.max(1, Math.ceil((o.near.degrees / 360) * W)) : W;
  for (let shift = 0; shift < W; shift += 1) {
    if (fixed !== null && shift !== fixed) continue;
    if (o.near && Math.min(((shift - nearAt) % W + W) % W, ((nearAt - shift) % W + W) % W) > nearPx) continue;
    let s = 0;
    let n = 0;
    let m = 0;
    let mm = 0;
    for (let y = 0; y < H; y += 1)
      for (let x = 0; x < W; x += 1) {
        const i = y * W + x;
        if (!filled[i]) continue;
        const p = pg[y * W + ((x - shift) % W + W) % W]!;
        m += p;
        mm += p * p;
        s += S[i]! * p;
        n += 1;
      }
    const mean = m / n;
    const sd = Math.sqrt(Math.max(1e-12, mm / n - mean * mean));
    scores[shift] = s / n / sd;
  }
  let best = 0;
  for (let i = 1; i < W; i += 1) if (scores[i]! > scores[best]!) best = i;
  if (fixed !== null) return { heading: o.heading!, score: scores[fixed]!, confidence: 1 };
  if (o.near) {
    const a0 = scores[(best - 1 + W) % W]!;
    const c0 = scores[(best + 1) % W]!;
    const b0 = scores[best]!;
    const off0 = Number.isFinite(a0) && Number.isFinite(c0) && a0 - 2 * b0 + c0 < 0 ? (0.5 * (a0 - c0)) / (a0 - 2 * b0 + c0) : 0;
    return { heading: wrapDeg(((best + off0) / W) * 360), score: b0, confidence: 1 };
  }
  const a = scores[(best - 1 + W) % W]!;
  const b = scores[best]!;
  const c = scores[(best + 1) % W]!;
  const off = a - 2 * b + c < 0 ? (0.5 * (a - c)) / (a - 2 * b + c) : 0;
  // Runner-up away from the peak.
  let second = -1;
  for (let i = 0; i < W; i += 1) {
    const d = Math.min(Math.abs(i - best), W - Math.abs(i - best));
    if (d > W / 16) second = Math.max(second, scores[i]!);
  }
  const heading = wrapDeg(((best + off) / W) * 360);
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  return { heading, score: b, confidence: clamp01((b - 0.15) / 0.4) * clamp01((b - second) / 0.15) };
}

const greys = new WeakMap<PanoramaGrey, Map<number, Float32Array>>();

/** The panorama grey resampled to W × W/2 (cached). */
function greyAt(g: PanoramaGrey, W: number): Float32Array {
  let m = greys.get(g);
  if (!m) greys.set(g, (m = new Map()));
  let pg = m.get(W);
  if (pg) return pg;
  const H = W / 2;
  const src = levelFor(g, 360 / W);
  pg = new Float32Array(W * H);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) pg[y * W + x] = sampleGrey(src, ((x + 0.5) / W) * src.width - 0.5, ((y + 0.5) / H) * src.height - 0.5);
  m.set(W, pg);
  return pg;
}

/**
 * Where the panorama was taken, and its heading, from a coloured scan: the
 * position that makes the scan, seen from there, look most like the panorama
 * — a grid over the room at camera heights (1.2–1.8 m above the scan's
 * floor), then finer steps round the best, the heading searched at each
 * (`estimateHeading`). A known heading is kept. Null without colours.
 */
export function estimatePanoramaPose(g: PanoramaGrey, cloud: PointCloud, up: 'y' | 'z', o: { unitMetres: number; heading?: number | null; floor?: number | null; signal?: { aborted: boolean } }): { position: [number, number, number]; heading: number; score: number; confidence: number } | null {
  if (!cloud.colors || cloud.count < 500) return null;
  const lo = toCanonical(cloud.bbox.min, up);
  const hi = toCanonical(cloud.bbox.max, up);
  const min = [Math.min(lo[0], hi[0]), Math.min(lo[1], hi[1]), Math.min(lo[2], hi[2])];
  const max = [Math.max(lo[0], hi[0]), Math.max(lo[1], hi[1]), Math.max(lo[2], hi[2])];
  const m = 1 / o.unitMetres;
  const floor = o.floor ?? min[1]!;
  const stride = Math.max(1, Math.round(cloud.count / 15_000));
  const toScan = (c: number[]) => fromCanonical(c, up);
  const score = (c: number[], W: number, s: number) => estimateHeading(g, cloud, up, toScan(c), { width: W, stride: s, heading: o.heading ?? null });
  // Coarse: every 0.6 m (at most 8 × 8) across the room, at three heights.
  const nx = Math.min(8, Math.max(2, Math.round((max[0]! - min[0]!) / (0.6 * m))));
  const nz = Math.min(8, Math.max(2, Math.round((max[2]! - min[2]!) / (0.6 * m))));
  let best: { c: number[]; score: number; heading: number } | null = null;
  for (const h of [1.2, 1.5, 1.8])
    for (let i = 0; i < nx; i += 1)
      for (let k = 0; k < nz; k += 1) {
        if (o.signal?.aborted) throw new Error('Cancelled');
        const c = [min[0]! + ((i + 0.5) / nx) * (max[0]! - min[0]!), floor + h * m, min[2]! + ((k + 0.5) / nz) * (max[2]! - min[2]!)];
        if (c[1]! >= max[1]!) continue;
        const r = score(c, 128, stride * 2);
        if (r && (!best || r.score > best.score)) best = { c, score: r.score, heading: r.heading };
      }
  if (!best) return null;
  // Finer: coordinate steps round the best, at a higher resolution.
  let step = 0.25 * m;
  let cur = { ...best, ...(() => {
    const r = score(best.c, 256, stride)!;
    return { score: r.score, heading: r.heading };
  })() };
  while (step > 0.04 * m) {
    let moved = false;
    for (const axis of [0, 2, 1])
      for (const dir of [-1, 1]) {
        const c = [...cur.c];
        c[axis]! += dir * step;
        const r = o.heading !== null && o.heading !== undefined ? score(c, 256, stride) : estimateHeading(g, cloud, up, toScan(c), { width: 256, stride, near: { heading: cur.heading, degrees: 8 } });
        if (r && r.score > cur.score + 1e-4) {
          cur = { c, score: r.score, heading: r.heading };
          moved = true;
        }
      }
    if (!moved) step /= 2;
  }
  // Finest: at four times the resolution, every scan point, the heading searched only near where it is.
  const fine = (c: number[]) => (o.heading !== null && o.heading !== undefined ? estimateHeading(g, cloud, up, toScan(c), { width: 1024, stride: Math.max(1, Math.round(stride / 2)), heading: o.heading }) : estimateHeading(g, cloud, up, toScan(c), { width: 1024, stride: Math.max(1, Math.round(stride / 2)), near: { heading: cur.heading, degrees: 2 } }));
  const f0 = fine(cur.c);
  if (f0) cur = { c: cur.c, score: f0.score, heading: f0.heading };
  step = 0.04 * m;
  while (step > 0.008 * m) {
    let moved = false;
    for (const axis of [0, 2, 1])
      for (const dir of [-1, 1]) {
        const c = [...cur.c];
        c[axis]! += dir * step;
        const r = fine(c);
        if (r && r.score > cur.score + 1e-5) {
          cur = { c, score: r.score, heading: r.heading };
          moved = true;
        }
      }
    if (!moved) step /= 2;
  }
  // The confidence: how far the heading stands out from the others, seen from there.
  const final = estimateHeading(g, cloud, up, toScan(cur.c), { heading: o.heading ?? null });
  if (!final) return null;
  const p = toScan(cur.c);
  return { position: [p[0], p[1], p[2]], heading: o.heading ?? cur.heading, score: cur.score, confidence: final.confidence };
}

/** A panorama direction (yaw, pitch) in the scan's canonical frame. */
export function panoramaToCanonical(yaw: number, pitch: number, heading: number): V3 {
  return dirOf(yaw + heading, pitch);
}

/** The panorama's yaw and pitch of a canonical direction. */
export function canonicalToPanorama(d: ArrayLike<number>, heading: number): { yaw: number; pitch: number } {
  const { yaw, pitch } = yawPitchOf(unit(d));
  return { yaw: wrapDeg(yaw - heading), pitch };
}

export { equirectDir };
