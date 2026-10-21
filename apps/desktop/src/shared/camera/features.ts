/**
 * Corner detection for camera tracking (addendum 06): Shi–Tomasi (the smaller
 * eigenvalue of the structure tensor over a window), non-maximum suppression,
 * a relative quality threshold, a minimum distance between features, and
 * bucketing so features spread over the frame instead of piling up in the
 * busiest texture. Pure TypeScript on grey Float32Arrays (0 … 1).
 */

export interface DetectOptions {
  maxFeatures: number;
  /** Minimum distance between features, pixels. */
  minDistance?: number;
  /** Keep corners whose response is at least this share of the strongest. */
  quality?: number;
  /** Structure tensor window half-size. */
  blockRadius?: number;
  /** Pixels to stay away from the frame edge. */
  border?: number;
  /** 1 = features allowed here (include region minus exclusions). */
  mask?: Uint8Array | null;
  /** Existing features (x, y pairs) new ones keep their distance from. */
  existing?: ArrayLike<number> | null;
  /** Grid of buckets (columns × rows) for even spread. */
  buckets?: [number, number];
  /** Restrict to a rectangle. */
  region?: { x0: number; y0: number; x1: number; y1: number } | null;
}

export interface Corner {
  x: number;
  y: number;
  score: number;
}

/** The min-eigenvalue response map (per pixel, normalised by the window area). */
export function minEigenMap(gray: Float32Array, w: number, h: number, r = 2): Float32Array {
  const n = w * h;
  const gxx = new Float32Array(n);
  const gxy = new Float32Array(n);
  const gyy = new Float32Array(n);
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      // Sobel / 8
      const gx = (gray[i - w + 1]! + 2 * gray[i + 1]! + gray[i + w + 1]! - gray[i - w - 1]! - 2 * gray[i - 1]! - gray[i + w - 1]!) / 8;
      const gy = (gray[i + w - 1]! + 2 * gray[i + w]! + gray[i + w + 1]! - gray[i - w - 1]! - 2 * gray[i - w]! - gray[i - w + 1]!) / 8;
      gxx[i] = gx * gx;
      gxy[i] = gx * gy;
      gyy[i] = gy * gy;
    }
  }
  const sxx = boxSum(gxx, w, h, r);
  const sxy = boxSum(gxy, w, h, r);
  const syy = boxSum(gyy, w, h, r);
  const out = new Float32Array(n);
  const area = (2 * r + 1) ** 2;
  for (let i = 0; i < n; i += 1) {
    const a = sxx[i]!;
    const b = sxy[i]!;
    const c = syy[i]!;
    const tr = a + c;
    const d = Math.sqrt(Math.max(0, (a - c) * (a - c) + 4 * b * b));
    out[i] = (tr - d) / 2 / area;
  }
  return out;
}

/** Box sum over (2r+1)² by separable running sums (edges clamped). */
function boxSum(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    let s = 0;
    for (let x = -r; x <= r; x += 1) s += src[row + Math.min(w - 1, Math.max(0, x))]!;
    for (let x = 0; x < w; x += 1) {
      tmp[row + x] = s;
      s += src[row + Math.min(w - 1, x + r + 1)]! - src[row + Math.max(0, x - r)]!;
    }
  }
  for (let x = 0; x < w; x += 1) {
    let s = 0;
    for (let y = -r; y <= r; y += 1) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]!;
    for (let y = 0; y < h; y += 1) {
      out[y * w + x] = s;
      s += tmp[Math.min(h - 1, y + r + 1) * w + x]! - tmp[Math.max(0, y - r) * w + x]!;
    }
  }
  return out;
}

/** Detect corners. */
export function detectCorners(gray: Float32Array, w: number, h: number, options: DetectOptions): Corner[] {
  const r = options.blockRadius ?? 2;
  const border = Math.max(options.border ?? 8, r + 2);
  const minD = options.minDistance ?? Math.max(6, Math.round(Math.min(w, h) / 60));
  const quality = options.quality ?? 0.01;
  const resp = minEigenMap(gray, w, h, r);
  const reg = options.region;
  const x0 = Math.max(border, reg ? Math.floor(reg.x0) : 0);
  const y0 = Math.max(border, reg ? Math.floor(reg.y0) : 0);
  const x1 = Math.min(w - 1 - border, reg ? Math.ceil(reg.x1) : w);
  const y1 = Math.min(h - 1 - border, reg ? Math.ceil(reg.y1) : h);
  let max = 0;
  for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) max = Math.max(max, resp[y * w + x]!);
  if (max <= 0) return [];
  const th = Math.max(quality * max, 1e-7);
  const cand: Corner[] = [];
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const i = y * w + x;
      const v = resp[i]!;
      if (v < th) continue;
      if (options.mask && !options.mask[i]) continue;
      // 3×3 non-maximum suppression.
      if (v < resp[i - 1]! || v < resp[i + 1]! || v < resp[i - w]! || v < resp[i + w]! || v < resp[i - w - 1]! || v < resp[i - w + 1]! || v < resp[i + w - 1]! || v < resp[i + w + 1]!) continue;
      // Sub-pixel peak by parabola fits.
      const dx = parabola(resp[i - 1]!, v, resp[i + 1]!);
      const dy = parabola(resp[i - w]!, v, resp[i + w]!);
      cand.push({ x: x + dx, y: y + dy, score: v });
    }
  }
  cand.sort((a, b) => b.score - a.score);
  // Minimum distance via an occupancy grid; existing features occupy it first.
  const cell = minD;
  const gw = Math.ceil(w / cell) + 1;
  const gh = Math.ceil(h / cell) + 1;
  const grid: number[][] = Array.from({ length: gw * gh }, () => []);
  const placed: number[] = [];
  const occupy = (x: number, y: number) => {
    const gx = Math.floor(x / cell);
    const gy = Math.floor(y / cell);
    if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) return;
    grid[gy * gw + gx]!.push(placed.length);
    placed.push(x, y);
  };
  const free = (x: number, y: number) => {
    const gx = Math.floor(x / cell);
    const gy = Math.floor(y / cell);
    for (let yy = Math.max(0, gy - 1); yy <= Math.min(gh - 1, gy + 1); yy += 1)
      for (let xx = Math.max(0, gx - 1); xx <= Math.min(gw - 1, gx + 1); xx += 1)
        for (const k of grid[yy * gw + xx]!) if ((placed[k]! - x) ** 2 + (placed[k + 1]! - y) ** 2 < minD * minD) return false;
    return true;
  };
  const ex = options.existing;
  if (ex) for (let i = 0; i + 1 < ex.length; i += 2) occupy(ex[i]!, ex[i + 1]!);
  const [bc, br] = options.buckets ?? [8, 5];
  const perBucket = Math.max(1, Math.ceil((options.maxFeatures / (bc * br)) * 2));
  const bucketCount = new Int32Array(bc * br);
  const out: Corner[] = [];
  for (const c of cand) {
    if (out.length >= options.maxFeatures) break;
    const b = Math.min(br - 1, Math.floor((c.y / h) * br)) * bc + Math.min(bc - 1, Math.floor((c.x / w) * bc));
    if (bucketCount[b]! >= perBucket) continue;
    if (!free(c.x, c.y)) continue;
    occupy(c.x, c.y);
    bucketCount[b]! += 1;
    out.push(c);
  }
  return out;
}

function parabola(a: number, b: number, c: number): number {
  const d = a - 2 * b + c;
  if (d >= 0) return 0;
  const o = (0.5 * (a - c)) / d;
  return Math.max(-0.5, Math.min(0.5, o));
}
