import type { LinearImage } from '../key/linear';
import { DEG, azElOf, cameraToLevel, norm, percentile, rayOf, type PinholeCamera, type V3 } from './geometry';
import type { NormalField } from './shading';

/**
 * Light probes (addendum 14 §3.3–3.5): a chrome ball, a grey ball, an
 * equirectangular HDRI, and the practicals seen in the frame.
 *
 * Chrome ball (orthographic mirror sphere): a highlight at image offset
 * (nx, ny) from the centre, in units of the radius, has the normal
 * n = (nx, ny, √(1 − nx² − ny²)); the light is in the reflected direction
 * R = 2(n·v)n − v with v towards the camera. An image area dA maps to the
 * reflected solid angle 4·dA/r² everywhere on the ball, so a highlight's area
 * gives its source's size, and its radiance × solid angle its share of the
 * light (relative between sources: the ball's reflectance cancels).
 *
 * Grey ball: exact normals inside its circle, fitted like the subject.
 *
 * HDRI: bright regions of the panorama (wrapping round), each a source with
 * its direction (weighted by radiance and solid angle), size, irradiance at
 * normal incidence and colour; the rest an even dome. The strongest evidence
 * there is: it is the light itself, measured.
 *
 * Practicals: small, bright, often saturated blobs in the frame, off the
 * subject: a lamp, a sconce, a screen.
 */

export interface ProbeSource {
  /** Level-frame direction towards the source (degrees). */
  az: number;
  el: number;
  /** Uncertainty half-width of the direction, degrees. */
  dirHalf: number;
  /** Angular diameter, degrees. */
  sizeDeg: number;
  /** Irradiance at normal incidence (relative units, comparable between a probe's sources). */
  E: number;
  rgb: [number, number, number];
  /** Pixels at the clip level: E is then a lower bound. */
  clipped: boolean;
  /** Where on the probe image (pixels). */
  x: number;
  y: number;
}

export interface ProbeResult {
  sources: ProbeSource[];
  /** The even rest: irradiance of a uniform dome of the median radiance (relative units) and its colour. */
  dome: { E: number; rgb: [number, number, number] };
}

const lumaOf = (luma: readonly [number, number, number], d: Float32Array, i: number) => luma[0] * d[3 * i]! + luma[1] * d[3 * i + 1]! + luma[2] * d[3 * i + 2]!;
const nrm = (v: readonly number[]): [number, number, number] => {
  const k = Math.max(v[0]!, v[1]!, v[2]!, 1e-12);
  return [Math.max(0, v[0]! / k), Math.max(0, v[1]! / k), Math.max(0, v[2]! / k)];
};

/** Connected components (8-connected) of `on`, optionally wrapping horizontally. */
function components(on: Uint8Array, w: number, h: number, wrapX = false): number[][] {
  const seen = new Uint8Array(w * h);
  const out: number[][] = [];
  for (let i = 0; i < w * h; i += 1) {
    if (!on[i] || seen[i]) continue;
    const comp: number[] = [];
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop()!;
      comp.push(j);
      const x = j % w;
      const y = (j - x) / w;
      for (let dy = -1; dy <= 1; dy += 1)
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!dx && !dy) continue;
          let xx = x + dx;
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          if (xx < 0 || xx >= w) {
            if (!wrapX) continue;
            xx = (xx + w) % w;
          }
          const k = yy * w + xx;
          if (on[k] && !seen[k]) (seen[k] = 1), stack.push(k);
        }
    }
    out.push(comp);
  }
  return out;
}

/** The light sources reflected in a chrome ball (a circle in `img`), directions in the level frame of `cam`. */
export function chromeBall(img: LinearImage, circle: { cx: number; cy: number; r: number }, luma: readonly [number, number, number], cam: Pick<PinholeCamera, 'pitchDeg' | 'rollDeg'>): ProbeResult {
  const { width: w, height: h, data } = img;
  const inside = new Uint8Array(w * h);
  const L = new Float32Array(w * h);
  const vals: number[] = [];
  let peak = 0;
  for (let y = Math.max(0, Math.floor(circle.cy - circle.r)); y < Math.min(h, Math.ceil(circle.cy + circle.r)); y += 1)
    for (let x = Math.max(0, Math.floor(circle.cx - circle.r)); x < Math.min(w, Math.ceil(circle.cx + circle.r)); x += 1) {
      const dx = (x + 0.5 - circle.cx) / circle.r;
      const dy = (y + 0.5 - circle.cy) / circle.r;
      if (dx * dx + dy * dy > 0.97 * 0.97) continue;
      const i = y * w + x;
      inside[i] = 1;
      L[i] = lumaOf(luma, data, i);
      vals.push(L[i]!);
      peak = Math.max(peak, L[i]!);
    }
  const med = percentile(vals, 0.5);
  const thr = Math.max(6 * med, 0.2 * peak);
  const on = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i += 1) on[i] = inside[i] && L[i]! > thr ? 1 : 0;
  const dirOfPixel = (x: number, y: number): V3 => {
    const nx = (x - circle.cx) / circle.r;
    const ny = -(y - circle.cy) / circle.r;
    const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
    return cameraToLevel(cam, [2 * nz * nx, 2 * nz * ny, 2 * nz * nz - 1]);
  };
  const sources: ProbeSource[] = [];
  const pxArea = 4 / (circle.r * circle.r);
  for (const comp of components(on, w, h)) {
    if (comp.length < 2) continue;
    let sx = 0;
    let sy = 0;
    let sw = 0;
    const acc: V3 = [0, 0, 0];
    const rgb = [0, 0, 0];
    let clip = 0;
    for (const i of comp) {
      const x = (i % w) + 0.5;
      const y = (i - (i % w)) / w + 0.5;
      const l = L[i]!;
      sx += l * x;
      sy += l * y;
      sw += l;
      const d = dirOfPixel(x, y);
      for (let k = 0; k < 3; k += 1) {
        acc[k]! += l * d[k]!;
        rgb[k]! += data[3 * i + k]! * pxArea;
      }
      if (l >= 0.98 * peak) clip += 1;
    }
    const d = azElOf(norm(acc));
    const omega = comp.length * pxArea;
    const sizeDeg = (2 * Math.acos(Math.max(-1, 1 - omega / (2 * Math.PI)))) / DEG;
    // Radiance × solid angle above the environment's level: the source's irradiance at normal incidence
    // (radiance in value units carries π: a dome of value L gives E = L).
    const E = comp.reduce((a, i) => a + Math.max(0, L[i]! - med) * pxArea, 0) / Math.PI;
    sources.push({ az: d.az, el: d.el, dirHalf: 3 + sizeDeg / 2, sizeDeg, E, rgb: nrm(rgb), clipped: clip > Math.max(2, 0.3 * comp.length) && peak > 0, x: sx / sw, y: sy / sw });
  }
  sources.sort((a, b) => b.E - a.E);
  const envRgb = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < w * h; i += 1)
    if (inside[i] && !on[i]) {
      for (let k = 0; k < 3; k += 1) envRgb[k]! += data[3 * i + k]!;
      n += 1;
    }
  // A uniform dome of radiance L gives E = π·L (radiance in value units already folds in π: E = L).
  return { sources, dome: { E: med, rgb: nrm(envRgb.map((v) => v / Math.max(1, n))) } };
}

/** A grey ball's exact normals as a field the shading fit reads. */
export function greyBallField(img: LinearImage, circle: { cx: number; cy: number; r: number }): NormalField {
  const { width: w, height: h } = img;
  const normals = new Float32Array(w * h * 3).fill(NaN);
  const mask = new Uint8Array(w * h);
  const cover = new Float32Array(w * h);
  let count = 0;
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      const nx = (x + 0.5 - circle.cx) / circle.r;
      const ny = -(y + 0.5 - circle.cy) / circle.r;
      const q = nx * nx + ny * ny;
      if (q > 0.96 * 0.96) continue;
      const i = y * w + x;
      normals.set([nx, ny, Math.sqrt(1 - q)], 3 * i);
      mask[i] = 1;
      cover[i] = 1;
      count += 1;
    }
  return { width: w, height: h, normals, mask, dist: new Float32Array(w * h), radius: circle.r, roundness: 1, cover, count, box: { x0: Math.floor(circle.cx - circle.r), y0: Math.floor(circle.cy - circle.r), x1: Math.ceil(circle.cx + circle.r), y1: Math.ceil(circle.cy + circle.r) } };
}

/**
 * The sources in an equirectangular HDRI. `headingDeg` is the panorama yaw
 * the camera looked along (yaw positive to the right of the centre column).
 * Directions come out in the camera's level frame.
 */
export function hdriSources(img: LinearImage, headingDeg: number, luma: readonly [number, number, number], o: { max?: number } = {}): ProbeResult {
  const { width: W, height: H, data } = img;
  const L = new Float32Array(W * H);
  const omega = new Float32Array(H);
  for (let v = 0; v < H; v += 1) {
    const pitch = (0.5 - (v + 0.5) / H) * Math.PI;
    omega[v] = ((2 * Math.PI) / W) * (Math.PI / H) * Math.cos(pitch);
  }
  const vals: number[] = [];
  let peak = 0;
  for (let i = 0; i < W * H; i += 1) {
    L[i] = lumaOf(luma, data, i);
    if (i % 3 === 0) vals.push(L[i]!);
    peak = Math.max(peak, L[i]!);
  }
  const med = percentile(vals, 0.5);
  // Bright against the panorama's typical radiance, and not negligible against its brightest.
  const thr = Math.max(8 * med, 0.006 * peak);
  const on = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i += 1) on[i] = L[i]! > thr ? 1 : 0;
  const dirOf = (u: number, v: number): V3 => {
    const yaw = ((u / W - 0.5) * 360 - headingDeg) * DEG;
    const pitch = (0.5 - v / H) * Math.PI;
    return [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
  };
  const sources: ProbeSource[] = [];
  for (const comp of components(on, W, H, true)) {
    const acc: V3 = [0, 0, 0];
    const rgb = [0, 0, 0];
    let E = 0;
    let Om = 0;
    let clip = 0;
    let su = 0;
    let sv = 0;
    let sw = 0;
    for (const i of comp) {
      const u = i % W;
      const v = (i - u) / W;
      const dOm = omega[v]!;
      const l = L[i]! - med;
      const d = dirOf(u + 0.5, v + 0.5);
      for (let k = 0; k < 3; k += 1) {
        acc[k]! += l * dOm * d[k]!;
        rgb[k]! += Math.max(0, data[3 * i + k]! - med) * dOm;
      }
      E += (Math.max(0, l) * dOm) / Math.PI;
      Om += dOm;
      if (L[i]! >= 0.98 * peak) clip += 1;
      su += u;
      sv += v;
      sw += 1;
    }
    if (E <= 0) continue;
    const d = azElOf(norm(acc));
    const sizeDeg = (2 * Math.acos(Math.max(-1, 1 - Om / (2 * Math.PI)))) / DEG;
    sources.push({ az: d.az, el: d.el, dirHalf: 1.5 + (360 / W) * 2 + sizeDeg / 4, sizeDeg, E, rgb: nrm(rgb), clipped: clip > 3 && clip > 0.3 * comp.length, x: su / sw, y: sv / sw });
  }
  sources.sort((a, b) => b.E - a.E);
  const top = sources[0]?.E ?? 0;
  const kept = sources.filter((s) => s.E >= 0.03 * top).slice(0, o.max ?? 6);
  // The dome: the panorama's remaining (non-source) radiance, as the even light it gives a surface.
  const domeRgb = [0, 0, 0];
  let domeE = 0;
  for (let i = 0; i < W * H; i += 1) {
    if (on[i]) continue;
    const v = (i - (i % W)) / W;
    const pitch = (0.5 - (v + 0.5) / H) * Math.PI;
    if (pitch < 0) continue;
    // Upper hemisphere, cosine-weighted towards up: what a face turned up receives (value units).
    const w = omega[v]! * Math.sin(pitch);
    domeE += (L[i]! * w) / Math.PI;
    for (let k = 0; k < 3; k += 1) domeRgb[k]! += data[3 * i + k]! * w;
  }
  return { sources: kept, dome: { E: domeE, rgb: nrm(domeRgb) } };
}

export interface Practical {
  /** Image position (pixels) and radius (pixels) at the analysis size. */
  x: number;
  y: number;
  radius: number;
  /** Mean colour (working RGB) and peak luminance; clipped when it reaches the frame's maximum plateau. */
  rgb: [number, number, number];
  meanLuminance: number;
  peakLuminance: number;
  clipped: boolean;
  /** Its ray in the level frame. */
  ray: V3;
}

/** Small bright blobs off the subject: likely practicals (positions, colour, how bright). */
export function findPracticals(img: LinearImage, luma: readonly [number, number, number], cam: PinholeCamera, o: { exclude?: Uint8Array | null; max?: number } = {}): Practical[] {
  const { width: w, height: h, data } = img;
  const L = new Float32Array(w * h);
  const vals: number[] = [];
  let peak = 0;
  for (let i = 0; i < w * h; i += 1) {
    L[i] = lumaOf(luma, data, i);
    if (!o.exclude?.[i]) {
      vals.push(L[i]!);
      peak = Math.max(peak, L[i]!);
    }
  }
  const med = percentile(vals, 0.5);
  const thr = Math.max(10 * med, percentile(vals, 0.998));
  const on = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i += 1) on[i] = !o.exclude?.[i] && L[i]! > thr ? 1 : 0;
  const out: Practical[] = [];
  for (const comp of components(on, w, h)) {
    if (comp.length < 2 || comp.length > 0.01 * w * h) continue;
    let sx = 0;
    let sy = 0;
    let sw = 0;
    let pk = 0;
    const rgb = [0, 0, 0];
    let x0 = w;
    let x1 = 0;
    let y0 = h;
    let y1 = 0;
    for (const i of comp) {
      const x = i % w;
      const y = (i - x) / w;
      const l = L[i]!;
      sx += l * (x + 0.5);
      sy += l * (y + 0.5);
      sw += l;
      pk = Math.max(pk, l);
      for (let k = 0; k < 3; k += 1) rgb[k]! += data[3 * i + k]!;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
    // A blob, not a long bright edge (a window frame, a horizon): roughly round.
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    if (Math.max(bw, bh) > 4 * Math.min(bw, bh) + 2) continue;
    // Brighter than its surround by a wide margin.
    const cx = sx / sw;
    const cy = sy / sw;
    const radius = Math.sqrt(comp.length / Math.PI);
    let ring = 0;
    let rn = 0;
    for (let a = 0; a < 16; a += 1) {
      const xx = Math.round(cx + Math.cos((a / 16) * 2 * Math.PI) * (radius * 2.5 + 3));
      const yy = Math.round(cy + Math.sin((a / 16) * 2 * Math.PI) * (radius * 2.5 + 3));
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      ring += L[yy * w + xx]!;
      rn += 1;
    }
    if (rn && pk < 4 * (ring / rn)) continue;
    const plateau = comp.filter((i) => L[i]! >= 0.98 * pk).length;
    out.push({ x: cx, y: cy, radius, rgb: nrm(rgb), meanLuminance: sw / comp.length, peakLuminance: pk, clipped: plateau >= Math.max(3, 0.25 * comp.length) && pk >= 0.98 * peak, ray: cameraToLevel(cam, rayOf(cam, cx, cy)) });
  }
  out.sort((a, b) => b.meanLuminance * b.radius * b.radius - a.meanLuminance * a.radius * a.radius);
  return out.slice(0, o.max ?? 4);
}
