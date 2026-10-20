/**
 * Image primitives for the roto engines (addendum 04). Pure TypeScript on
 * typed arrays: no Node, no DOM, so the same code runs in the desktop's
 * worker thread and in the browser preview.
 *
 * Conventions: RGB is 8-bit interleaved; a mask is 8-bit, 0 outside and 255
 * inside (soft values on the edge); float planes are row-major.
 */

export interface RGBImage {
  width: number;
  height: number;
  /** r, g, b per pixel. */
  data: Uint8Array | Uint8ClampedArray;
}

export interface Mask {
  width: number;
  height: number;
  data: Uint8Array;
}

export const emptyMask = (width: number, height: number): Mask => ({ width, height, data: new Uint8Array(width * height) });

/** Rec.709 luma of each pixel, 0…1. */
export function toGray(img: RGBImage): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  const d = img.data;
  for (let i = 0, j = 0; i < n; i += 1, j += 3) out[i] = (0.2126 * d[j]! + 0.7152 * d[j + 1]! + 0.0722 * d[j + 2]!) / 255;
  return out;
}

/** Resample an RGB image: area averaging when shrinking by 2× or more, bilinear otherwise. */
export function resizeRGB(img: RGBImage, width: number, height: number): RGBImage {
  if (width === img.width && height === img.height) return img;
  const out = new Uint8Array(width * height * 3);
  const sx = img.width / width;
  const sy = img.height / height;
  const src = img.data;
  if (sx >= 2 && sy >= 2) {
    for (let y = 0; y < height; y += 1) {
      const y0 = Math.floor(y * sy);
      const y1 = Math.min(img.height, Math.max(y0 + 1, Math.floor((y + 1) * sy)));
      for (let x = 0; x < width; x += 1) {
        const x0 = Math.floor(x * sx);
        const x1 = Math.min(img.width, Math.max(x0 + 1, Math.floor((x + 1) * sx)));
        let r = 0;
        let g = 0;
        let b = 0;
        for (let yy = y0; yy < y1; yy += 1) {
          let k = (yy * img.width + x0) * 3;
          for (let xx = x0; xx < x1; xx += 1, k += 3) {
            r += src[k]!;
            g += src[k + 1]!;
            b += src[k + 2]!;
          }
        }
        const count = (y1 - y0) * (x1 - x0);
        const o = (y * width + x) * 3;
        out[o] = Math.round(r / count);
        out[o + 1] = Math.round(g / count);
        out[o + 2] = Math.round(b / count);
      }
    }
    return { width, height, data: out };
  }
  for (let y = 0; y < height; y += 1) {
    const fy = Math.min(img.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(img.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < width; x += 1) {
      const fx = Math.min(img.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(img.width - 1, x0 + 1);
      const wx = fx - x0;
      const a = (y0 * img.width + x0) * 3;
      const b = (y0 * img.width + x1) * 3;
      const c = (y1 * img.width + x0) * 3;
      const e = (y1 * img.width + x1) * 3;
      const o = (y * width + x) * 3;
      for (let ch = 0; ch < 3; ch += 1) {
        const top = src[a + ch]! + (src[b + ch]! - src[a + ch]!) * wx;
        const bottom = src[c + ch]! + (src[e + ch]! - src[c + ch]!) * wx;
        out[o + ch] = Math.round(top + (bottom - top) * wy);
      }
    }
  }
  return { width, height, data: out };
}

/** Shrink a float plane by averaging the source pixels under each output pixel. */
export function areaDownscale(src: Float32Array, w: number, h: number, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  const sx = w / width;
  const sy = h / height;
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.min(h, Math.max(y0 + 1, Math.floor((y + 1) * sy)));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.min(w, Math.max(x0 + 1, Math.floor((x + 1) * sx)));
      let sum = 0;
      for (let yy = y0; yy < y1; yy += 1) {
        const row = yy * w;
        for (let xx = x0; xx < x1; xx += 1) sum += src[row + xx]!;
      }
      out[y * width + x] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

/** Bilinear resample of a float plane (pixel centres aligned). */
export function resizePlane(src: Float32Array, w: number, h: number, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  const sx = w / width;
  const sy = h / height;
  for (let y = 0; y < height; y += 1) {
    const fy = Math.min(h - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(h - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < width; x += 1) {
      const fx = Math.min(w - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(w - 1, x0 + 1);
      const wx = fx - x0;
      const top = src[y0 * w + x0]! + (src[y0 * w + x1]! - src[y0 * w + x0]!) * wx;
      const bottom = src[y1 * w + x0]! + (src[y1 * w + x1]! - src[y1 * w + x0]!) * wx;
      out[y * width + x] = top + (bottom - top) * wy;
    }
  }
  return out;
}

export function maskToPlane(m: Mask): Float32Array {
  const out = new Float32Array(m.data.length);
  for (let i = 0; i < out.length; i += 1) out[i] = m.data[i]! / 255;
  return out;
}

export function planeToMask(p: Float32Array, width: number, height: number): Mask {
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i += 1) {
    const v = p[i]!;
    data[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
  }
  return { width, height, data };
}

export function resizeMask(m: Mask, width: number, height: number): Mask {
  if (m.width === width && m.height === height) return m;
  return planeToMask(resizePlane(maskToPlane(m), m.width, m.height, width, height), width, height);
}

/** 1 where the mask is at least half on. */
export function binarize(m: Mask, threshold = 128): Uint8Array {
  const out = new Uint8Array(m.data.length);
  for (let i = 0; i < out.length; i += 1) out[i] = m.data[i]! >= threshold ? 1 : 0;
  return out;
}

export function fromBinary(b: Uint8Array, width: number, height: number): Mask {
  const data = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i += 1) data[i] = b[i] ? 255 : 0;
  return { width, height, data };
}

export function maskArea(m: Mask | Uint8Array, threshold = 128): number {
  const d = 'data' in m ? m.data : m;
  const t = 'data' in m ? threshold : 1;
  let n = 0;
  for (let i = 0; i < d.length; i += 1) if (d[i]! >= t) n += 1;
  return n;
}

/** Intersection over union of two masks (or 0/1 arrays), at half on. 1 when both are empty. */
export function iou(a: Mask | Uint8Array, b: Mask | Uint8Array): number {
  const da = 'data' in a ? a.data : a;
  const db = 'data' in b ? b.data : b;
  const ta = 'data' in a ? 128 : 1;
  const tb = 'data' in b ? 128 : 1;
  let inter = 0;
  let union = 0;
  for (let i = 0; i < da.length; i += 1) {
    const x = da[i]! >= ta;
    const y = db[i]! >= tb;
    if (x && y) inter += 1;
    if (x || y) union += 1;
  }
  return union === 0 ? 1 : inter / union;
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Bounding box of the on pixels (inclusive), or null when empty. */
export function bbox(b: Uint8Array, width: number, height: number): Box | null {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (!b[row + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

export const growBox = (b: Box, by: number, width: number, height: number): Box => ({
  x0: Math.max(0, Math.floor(b.x0 - by)),
  y0: Math.max(0, Math.floor(b.y0 - by)),
  x1: Math.min(width - 1, Math.ceil(b.x1 + by)),
  y1: Math.min(height - 1, Math.ceil(b.y1 + by)),
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/** Mean over a (2r+1)² window, edges clamped to the image (normalised by the pixels inside). O(n). */
export function boxFilter(src: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r <= 0) return src.slice();
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  // Horizontal running sums.
  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    let sum = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x += 1) sum += src[row + x]!;
    for (let x = 0; x < w; x += 1) {
      const lo = Math.max(0, x - r);
      const hi = Math.min(w - 1, x + r);
      tmp[row + x] = sum / (hi - lo + 1);
      const add = x + r + 1;
      const sub = x - r;
      if (add < w) sum += src[row + add]!;
      if (sub >= 0) sum -= src[row + sub]!;
    }
  }
  // Vertical running sums.
  for (let x = 0; x < w; x += 1) {
    let sum = 0;
    for (let y = 0; y <= Math.min(r, h - 1); y += 1) sum += tmp[y * w + x]!;
    for (let y = 0; y < h; y += 1) {
      const lo = Math.max(0, y - r);
      const hi = Math.min(h - 1, y + r);
      out[y * w + x] = sum / (hi - lo + 1);
      const add = y + r + 1;
      const sub = y - r;
      if (add < h) sum += tmp[add * w + x]!;
      if (sub >= 0) sum -= tmp[sub * w + x]!;
    }
  }
  return out;
}

/** Gaussian blur approximated by three box filters (σ in pixels). */
export function gaussianBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma <= 0.25) return src.slice();
  // Box radii for three passes (Kovesi's method).
  const n = 3;
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl -= 1;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  let out = src;
  for (let i = 0; i < n; i += 1) out = boxFilter(out, w, h, ((i < m ? wl : wu) - 1) / 2);
  return out;
}

/**
 * The guided filter (He, Sun & Tang 2013) with a grey guide: edge-preserving
 * smoothing of `src` that follows the guide's edges. Used to snap a matte's
 * edge to the picture. r in pixels, eps on the guide's 0…1 scale.
 */
export function guidedFilter(guide: Float32Array, src: Float32Array, w: number, h: number, r: number, eps: number): Float32Array {
  const n = w * h;
  const meanI = boxFilter(guide, w, h, r);
  const meanP = boxFilter(src, w, h, r);
  const ip = new Float32Array(n);
  const ii = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    ip[i] = guide[i]! * src[i]!;
    ii[i] = guide[i]! * guide[i]!;
  }
  const meanIp = boxFilter(ip, w, h, r);
  const meanII = boxFilter(ii, w, h, r);
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const cov = meanIp[i]! - meanI[i]! * meanP[i]!;
    const v = meanII[i]! - meanI[i]! * meanI[i]!;
    a[i] = cov / (v + eps);
    b[i] = meanP[i]! - a[i]! * meanI[i]!;
  }
  const meanA = boxFilter(a, w, h, r);
  const meanB = boxFilter(b, w, h, r);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = meanA[i]! * guide[i]! + meanB[i]!;
  return out;
}

// ---------------------------------------------------------------------------
// Distance transforms and morphology
// ---------------------------------------------------------------------------

const INF = 1e20;

/** 1D squared distance transform (Felzenszwalb & Huttenlocher). */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q += 1) {
    let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) {
      k -= 1;
      s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    }
    k += 1;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q += 1) {
    while (z[k + 1]! < q) k += 1;
    d[q] = (q - v[k]!) * (q - v[k]!) + f[v[k]!]!;
  }
}

/** Squared Euclidean distance from every pixel to the nearest pixel where `on` is set (0 on it). */
export function squaredDistance(on: Uint8Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const col = new Float64Array(w * h);
  for (let x = 0; x < w; x += 1) {
    for (let y = 0; y < h; y += 1) f[y] = on[y * w + x] ? 0 : INF;
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y += 1) col[y * w + x] = d[y]!;
  }
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) f[x] = col[y * w + x]!;
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x += 1) out[y * w + x] = Math.min(d[x]!, INF);
  }
  return out;
}

/**
 * Signed distance to the mask edge: negative inside, positive outside
 * (pixels). With `limit`, only distances up to `limit` are needed: the work is
 * cropped to the mask's bounding box grown by limit + 1, which is exact
 * there, and everything beyond reads as limit + 1 outside.
 */
export function signedDistance(b: Uint8Array, w: number, h: number, limit?: number): Float32Array {
  const box0 = bbox(b, w, h);
  const out = new Float32Array(b.length);
  if (!box0) return out.fill(limit !== undefined ? limit + 1 : 1e6);
  const box = limit !== undefined ? growBox(box0, Math.ceil(limit) + 2, w, h) : { x0: 0, y0: 0, x1: w - 1, y1: h - 1 };
  const bw = box.x1 - box.x0 + 1;
  const bh = box.y1 - box.y0 + 1;
  const on = new Uint8Array(bw * bh);
  const off = new Uint8Array(bw * bh);
  let anyOff = false;
  for (let y = 0; y < bh; y += 1) for (let x = 0; x < bw; x += 1) {
    const v = b[(y + box.y0) * w + x + box.x0] ? 1 : 0;
    on[y * bw + x] = v;
    off[y * bw + x] = 1 - v;
    if (!v) anyOff = true;
  }
  if (limit !== undefined) out.fill(limit + 1);
  if (!anyOff) {
    for (let y = 0; y < bh; y += 1) for (let x = 0; x < bw; x += 1) out[(y + box.y0) * w + x + box.x0] = -1e6;
    return out;
  }
  const toOn = squaredDistance(on, bw, bh);
  const toOff = squaredDistance(off, bw, bh);
  for (let y = 0; y < bh; y += 1) for (let x = 0; x < bw; x += 1) {
    const k = y * bw + x;
    out[(y + box.y0) * w + x + box.x0] = on[k] ? -Math.sqrt(toOff[k]!) + 0.5 : Math.sqrt(toOn[k]!) - 0.5;
  }
  return out;
}

/** Grow (r > 0) or shrink (r < 0) a binary mask by r pixels (Euclidean). */
export function morph(b: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r === 0) return b.slice();
  const sd = signedDistance(b, w, h, Math.abs(r) + 1);
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i += 1) out[i] = sd[i]! <= r ? 1 : 0;
  return out;
}

/** Pixels within `r` of the mask's edge, on either side. */
export function edgeBand(b: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const sd = signedDistance(b, w, h, r + 1);
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i += 1) out[i] = Math.abs(sd[i]!) <= r ? 1 : 0;
  return out;
}

// ---------------------------------------------------------------------------
// Connected components
// ---------------------------------------------------------------------------

/** 4-connected labels of the pixels where `value` matches; returns the labels (0 = none) and each component's size. */
export function components(b: Uint8Array, w: number, h: number, value = 1): { labels: Int32Array; sizes: number[] } {
  const labels = new Int32Array(w * h);
  const sizes: number[] = [0];
  const stack = new Int32Array(w * h);
  let next = 0;
  for (let i = 0; i < w * h; i += 1) {
    if (labels[i] || (b[i] ? 1 : 0) !== value) continue;
    next += 1;
    let top = 0;
    stack[top++] = i;
    labels[i] = next;
    let size = 0;
    while (top) {
      const p = stack[--top]!;
      size += 1;
      const x = p % w;
      const y = (p - x) / w;
      if (x > 0 && !labels[p - 1] && (b[p - 1] ? 1 : 0) === value) (labels[p - 1] = next), (stack[top++] = p - 1);
      if (x < w - 1 && !labels[p + 1] && (b[p + 1] ? 1 : 0) === value) (labels[p + 1] = next), (stack[top++] = p + 1);
      if (y > 0 && !labels[p - w] && (b[p - w] ? 1 : 0) === value) (labels[p - w] = next), (stack[top++] = p - w);
      if (y < h - 1 && !labels[p + w] && (b[p + w] ? 1 : 0) === value) (labels[p + w] = next), (stack[top++] = p + w);
    }
    sizes.push(size);
  }
  return { labels, sizes };
}

/**
 * Clean a segmentation: keep the foreground components that `keep` accepts
 * (by label, given their pixels' overlap with `anchor`), and fill holes —
 * background components that do not touch the image border — smaller than
 * `maxHole` pixels unless `protect` marks them (e.g. painted exclude).
 */
export function cleanSegmentation(b: Uint8Array, w: number, h: number, anchor: Uint8Array | null, options: { minKeepFraction?: number; maxHole: number; protect?: Uint8Array | null }): Uint8Array {
  const out = b.slice();
  const fg = components(out, w, h, 1);
  if (fg.sizes.length > 2) {
    const overlap = new Float64Array(fg.sizes.length);
    if (anchor) for (let i = 0; i < out.length; i += 1) if (fg.labels[i] && anchor[i]) overlap[fg.labels[i]!]! += 1;
    let best = 1;
    for (let k = 2; k < fg.sizes.length; k += 1) if ((anchor ? overlap[k]! : fg.sizes[k]!) > (anchor ? overlap[best]! : fg.sizes[best]!)) best = k;
    const largest = Math.max(...fg.sizes);
    const minKeep = (options.minKeepFraction ?? 0.02) * largest;
    for (let i = 0; i < out.length; i += 1) {
      const l = fg.labels[i]!;
      if (!l || l === best) continue;
      const anchored = anchor ? overlap[l]! > 0 : true;
      if (!anchored || fg.sizes[l]! < minKeep) out[i] = 0;
    }
  }
  const bg = components(out, w, h, 0);
  const touches = new Uint8Array(bg.sizes.length);
  const protectedHole = new Uint8Array(bg.sizes.length);
  for (let x = 0; x < w; x += 1) {
    touches[bg.labels[x]!] = 1;
    touches[bg.labels[(h - 1) * w + x]!] = 1;
  }
  for (let y = 0; y < h; y += 1) {
    touches[bg.labels[y * w]!] = 1;
    touches[bg.labels[y * w + w - 1]!] = 1;
  }
  if (options.protect) for (let i = 0; i < out.length; i += 1) if (options.protect[i] && bg.labels[i]) protectedHole[bg.labels[i]!] = 1;
  for (let i = 0; i < out.length; i += 1) {
    const l = bg.labels[i]!;
    if (l && !touches[l] && !protectedHole[l] && bg.sizes[l]! <= options.maxHole) out[i] = 1;
  }
  return out;
}

/** Sample a plane at fractional (x, y), clamped to the edges. */
export function sampleBilinear(p: Float32Array, w: number, h: number, x: number, y: number): number {
  const fx = Math.min(w - 1, Math.max(0, x));
  const fy = Math.min(h - 1, Math.max(0, y));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const wx = fx - x0;
  const wy = fy - y0;
  const top = p[y0 * w + x0]! + (p[y0 * w + x1]! - p[y0 * w + x0]!) * wx;
  const bottom = p[y1 * w + x0]! + (p[y1 * w + x1]! - p[y1 * w + x0]!) * wx;
  return top + (bottom - top) * wy;
}

/** Backward warp: out(q) = src(q + flow(q)). */
export function warpPlane(src: Float32Array, u: Float32Array, v: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const i = y * w + x;
    out[i] = sampleBilinear(src, w, h, x + u[i]!, y + v[i]!);
  }
  return out;
}

/** Deterministic pseudo-random numbers (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Crops: the engines work on the part of the frame around the subject
// ---------------------------------------------------------------------------

export function cropRGB(img: RGBImage, b: Box): RGBImage {
  const bw = b.x1 - b.x0 + 1;
  const bh = b.y1 - b.y0 + 1;
  const out = new Uint8Array(bw * bh * 3);
  for (let y = 0; y < bh; y += 1) out.set(img.data.subarray(((y + b.y0) * img.width + b.x0) * 3, ((y + b.y0) * img.width + b.x1 + 1) * 3), y * bw * 3);
  return { width: bw, height: bh, data: out };
}

export function cropU8(src: Uint8Array, w: number, b: Box): Uint8Array {
  const bw = b.x1 - b.x0 + 1;
  const bh = b.y1 - b.y0 + 1;
  const out = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y += 1) out.set(src.subarray((y + b.y0) * w + b.x0, (y + b.y0) * w + b.x1 + 1), y * bw);
  return out;
}

/** A full-size array, zero outside the box, `src` (box-sized) inside. */
export function pasteU8(src: Uint8Array, b: Box, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const bw = b.x1 - b.x0 + 1;
  for (let y = b.y0; y <= b.y1; y += 1) out.set(src.subarray((y - b.y0) * bw, (y - b.y0 + 1) * bw), y * w + b.x0);
  return out;
}

/** Bilinear sample of an 8-bit plane at fractional (x, y), 0…1, clamped to the edges. */
export function sampleU8(p: Uint8Array, w: number, h: number, x: number, y: number): number {
  const fx = Math.min(w - 1, Math.max(0, x));
  const fy = Math.min(h - 1, Math.max(0, y));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const wx = fx - x0;
  const wy = fy - y0;
  const top = p[y0 * w + x0]! + (p[y0 * w + x1]! - p[y0 * w + x0]!) * wx;
  const bottom = p[y1 * w + x0]! + (p[y1 * w + x1]! - p[y1 * w + x0]!) * wx;
  return (top + (bottom - top) * wy) / 255;
}
