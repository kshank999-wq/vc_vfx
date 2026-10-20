import { sampleBilinear, type Box } from './image';


/**
 * Optical flow for roto propagation (addendum 04): pyramidal Lucas–Kanade
 * (Bouguet's formulation) tracked on a regular grid, checked forward and
 * backward, cleaned with a median and spread into a dense field. Pure
 * TypeScript on Float32Arrays.
 *
 * The field is backward: for a pixel q of the *later* frame, q + (u, v) is
 * where it came from in the earlier one — what a mask needs to be warped
 * forward by sampling.
 */

export interface PyramidLevel {
  w: number;
  h: number;
  img: Float32Array;
  gx: Float32Array;
  gy: Float32Array;
}

function downsample(img: Float32Array, w: number, h: number): { img: Float32Array; w: number; h: number } {
  const nw = Math.max(1, Math.floor(w / 2));
  const nh = Math.max(1, Math.floor(h / 2));
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y += 1) {
    const y0 = Math.min(h - 1, 2 * y);
    const y1 = Math.min(h - 1, 2 * y + 1);
    for (let x = 0; x < nw; x += 1) {
      const x0 = Math.min(w - 1, 2 * x);
      const x1 = Math.min(w - 1, 2 * x + 1);
      out[y * nw + x] = (img[y0 * w + x0]! + img[y0 * w + x1]! + img[y1 * w + x0]! + img[y1 * w + x1]!) / 4;
    }
  }
  return { img: out, w: nw, h: nh };
}

/** Scharr derivatives (edges clamped). */
function gradients(img: Float32Array, w: number, h: number): { gx: Float32Array; gy: Float32Array } {
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const up = (y > 0 ? y - 1 : 0) * w;
    const mid = y * w;
    const dn = (y < h - 1 ? y + 1 : h - 1) * w;
    for (let x = 0; x < w; x += 1) {
      const l = x > 0 ? x - 1 : 0;
      const r = x < w - 1 ? x + 1 : w - 1;
      gx[mid + x] = (3 * (img[up + r]! - img[up + l]!) + 10 * (img[mid + r]! - img[mid + l]!) + 3 * (img[dn + r]! - img[dn + l]!)) / 32;
      gy[mid + x] = (3 * (img[dn + l]! - img[up + l]!) + 10 * (img[dn + x]! - img[up + x]!) + 3 * (img[dn + r]! - img[up + r]!)) / 32;
    }
  }
  return { gx, gy };
}

export function buildPyramid(gray: Float32Array, w: number, h: number, levels: number): PyramidLevel[] {
  const out: PyramidLevel[] = [];
  let img = gray;
  let cw = w;
  let ch = h;
  for (let l = 0; l < levels; l += 1) {
    const g = gradients(img, cw, ch);
    out.push({ w: cw, h: ch, img, gx: g.gx, gy: g.gy });
    if (cw < 16 || ch < 16) break;
    const d = downsample(img, cw, ch);
    img = d.img;
    cw = d.w;
    ch = d.h;
  }
  return out;
}

export interface TrackOptions {
  /** Initial displacement (level-0 pixels) applied to every point, e.g. from block matching. */
  guess?: [number, number];
  /** Window half-size in pixels at every level. */
  win?: number;
  iterations?: number;
  /** Minimum eigenvalue of the structure tensor (per window pixel) for a point to be trackable. */
  minEigen?: number;
}

export interface TrackResult {
  dx: Float32Array;
  dy: Float32Array;
  /** 1: tracked; 0: untrackable (flat window) or ran off the image. */
  ok: Uint8Array;
}

/**
 * Sample a (2·win+1)² window of `plane` centred on fractional (cx, cy) into
 * `out`. All window pixels share the same bilinear weights, so they are
 * computed once; the fast path skips clamping when the window is inside.
 */
function sampleWindow(plane: Float32Array, w: number, h: number, cx: number, cy: number, win: number, out: Float32Array): void {
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const ax = cx - x0;
  const ay = cy - y0;
  const w00 = (1 - ax) * (1 - ay);
  const w10 = ax * (1 - ay);
  const w01 = (1 - ax) * ay;
  const w11 = ax * ay;
  let m = 0;
  if (x0 - win >= 0 && y0 - win >= 0 && x0 + win + 1 < w && y0 + win + 1 < h) {
    for (let j = -win; j <= win; j += 1) {
      let i0 = (y0 + j) * w + x0 - win;
      for (let i = -win; i <= win; i += 1, i0 += 1) out[m++] = w00 * plane[i0]! + w10 * plane[i0 + 1]! + w01 * plane[i0 + w]! + w11 * plane[i0 + w + 1]!;
    }
    return;
  }
  for (let j = -win; j <= win; j += 1) {
    const ya = Math.min(h - 1, Math.max(0, y0 + j));
    const yb = Math.min(h - 1, Math.max(0, y0 + j + 1));
    for (let i = -win; i <= win; i += 1) {
      const xa = Math.min(w - 1, Math.max(0, x0 + i));
      const xb = Math.min(w - 1, Math.max(0, x0 + i + 1));
      out[m++] = w00 * plane[ya * w + xa]! + w10 * plane[ya * w + xb]! + w01 * plane[yb * w + xa]! + w11 * plane[yb * w + xb]!;
    }
  }
}

/** Track points (x, y pairs, level-0 pixels) from image A into image B. */
export function trackPoints(a: PyramidLevel[], b: PyramidLevel[], points: Float32Array, options: TrackOptions = {}): TrackResult {
  const win = options.win ?? 4;
  const iterations = options.iterations ?? 8;
  const minEigen = options.minEigen ?? 1e-4;
  const n = points.length / 2;
  const dx = new Float32Array(n);
  const dy = new Float32Array(n);
  const ok = new Uint8Array(n);
  const side = 2 * win + 1;
  const area = side * side;
  const ia = new Float32Array(area);
  const ix = new Float32Array(area);
  const iy = new Float32Array(area);
  const ib = new Float32Array(area);
  const levels = Math.min(a.length, b.length);
  const top = 1 << (levels - 1);
  for (let k = 0; k < n; k += 1) {
    let gxs = (options.guess?.[0] ?? 0) / top;
    let gys = (options.guess?.[1] ?? 0) / top;
    let trackable = true;
    for (let l = levels - 1; l >= 0; l -= 1) {
      const A = a[l]!;
      const B = b[l]!;
      const scale = 1 / (1 << l);
      const px = points[2 * k]! * scale;
      const py = points[2 * k + 1]! * scale;
      sampleWindow(A.img, A.w, A.h, px, py, win, ia);
      sampleWindow(A.gx, A.w, A.h, px, py, win, ix);
      sampleWindow(A.gy, A.w, A.h, px, py, win, iy);
      let g11 = 0;
      let g12 = 0;
      let g22 = 0;
      for (let m = 0; m < area; m += 1) {
        g11 += ix[m]! * ix[m]!;
        g12 += ix[m]! * iy[m]!;
        g22 += iy[m]! * iy[m]!;
      }
      const det = g11 * g22 - g12 * g12;
      const tr = g11 + g22;
      const minEig = (tr - Math.sqrt(Math.max(0, tr * tr - 4 * det))) / 2 / area;
      if (minEig < minEigen || Math.abs(det) < 1e-12) {
        if (l === 0) trackable = false;
        // Keep the guess from coarser levels.
        if (l > 0) {
          gxs *= 2;
          gys *= 2;
        }
        continue;
      }
      let nx = 0;
      let ny = 0;
      for (let it = 0; it < iterations; it += 1) {
        sampleWindow(B.img, B.w, B.h, px + gxs + nx, py + gys + ny, win, ib);
        let b1 = 0;
        let b2 = 0;
        for (let m = 0; m < area; m += 1) {
          const diff = ia[m]! - ib[m]!;
          b1 += diff * ix[m]!;
          b2 += diff * iy[m]!;
        }
        const ex = (g22 * b1 - g12 * b2) / det;
        const ey = (g11 * b2 - g12 * b1) / det;
        nx += ex;
        ny += ey;
        if (ex * ex + ey * ey < 1e-4) break;
      }
      if (l > 0) {
        gxs = 2 * (gxs + nx);
        gys = 2 * (gys + ny);
      } else {
        gxs += nx;
        gys += ny;
      }
    }
    dx[k] = gxs;
    dy[k] = gys;
    const ex = points[2 * k]! + gxs;
    const ey = points[2 * k + 1]! + gys;
    ok[k] = trackable && Number.isFinite(gxs) && Number.isFinite(gys) && ex >= -win && ey >= -win && ex <= a[0]!.w + win && ey <= a[0]!.h + win ? 1 : 0;
  }
  return { dx, dy, ok };
}

export interface FlowField {
  width: number;
  height: number;
  u: Float32Array;
  v: Float32Array;
  /** Grid points with enough texture to track. */
  trackable: number;
  /** Of those, the share that came back to where they started (forward–backward within 1 px). */
  consistency: number;
  /** Median forward–backward error of the trackable points, pixels. */
  fbError: number;
  /** Median displacement of the consistent points, pixels. */
  median: { u: number; v: number };
}

export interface FlowOptions extends TrackOptions {
  /** Block-matching search radius for the subject's shift, pixels. */
  search?: number;
  /** Grid spacing, pixels. */
  step?: number;
  levels?: number;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Dense backward flow from `later` to `earlier` (both grey 0…1, same size),
 * measured on a grid over `region` (the whole frame when null).
 */
export function estimateFlow(
  later: Float32Array | PyramidLevel[],
  earlier: Float32Array | PyramidLevel[],
  w: number,
  h: number,
  region: Box | null,
  options: FlowOptions = {},
): FlowField {
  const levels = options.levels ?? 4;
  const step = Math.max(2, Math.round(options.step ?? 8));
  const A = Array.isArray(later) ? later : buildPyramid(later, w, h, levels);
  const B = Array.isArray(earlier) ? earlier : buildPyramid(earlier, w, h, levels);
  const box = region ?? { x0: 0, y0: 0, x1: w - 1, y1: h - 1 };
  const gx0 = Math.floor(box.x0 / step);
  const gy0 = Math.floor(box.y0 / step);
  const gx1 = Math.ceil(box.x1 / step);
  const gy1 = Math.ceil(box.y1 / step);
  const gw = gx1 - gx0 + 1;
  const gh = gy1 - gy0 + 1;
  const pts = new Float32Array(gw * gh * 2);
  for (let j = 0; j < gh; j += 1) for (let i = 0; i < gw; i += 1) {
    const k = j * gw + i;
    pts[2 * k] = Math.min(w - 1, (gx0 + i) * step);
    pts[2 * k + 1] = Math.min(h - 1, (gy0 + j) * step);
  }
  const fwd = trackPoints(A, B, pts, options);
  // Back from where they landed: a good track returns to its start.
  const landed = new Float32Array(pts.length);
  for (let k = 0; k < gw * gh; k += 1) {
    landed[2 * k] = pts[2 * k]! + fwd.dx[k]!;
    landed[2 * k + 1] = pts[2 * k + 1]! + fwd.dy[k]!;
  }
  const back = trackPoints(B, A, landed, options);
  const gu = new Float32Array(gw * gh);
  const gv = new Float32Array(gw * gh);
  const valid = new Uint8Array(gw * gh);
  const errors: number[] = [];
  const us: number[] = [];
  const vs: number[] = [];
  let trackable = 0;
  let consistent = 0;
  for (let k = 0; k < gw * gh; k += 1) {
    if (!fwd.ok[k]) continue;
    trackable += 1;
    const err = back.ok[k] ? Math.hypot(fwd.dx[k]! + back.dx[k]!, fwd.dy[k]! + back.dy[k]!) : Infinity;
    errors.push(Math.min(err, 1e3));
    if (err <= 1) {
      consistent += 1;
      valid[k] = 1;
      gu[k] = fwd.dx[k]!;
      gv[k] = fwd.dy[k]!;
      us.push(gu[k]!);
      vs.push(gv[k]!);
    }
  }
  const med = { u: median(us), v: median(vs) };
  // Fill untracked grid points from their tracked neighbours, then from the median.
  let pending = valid.slice();
  for (let pass = 0; pass < Math.max(gw, gh); pass += 1) {
    let changed = false;
    const next = pending.slice();
    for (let j = 0; j < gh; j += 1) for (let i = 0; i < gw; i += 1) {
      const k = j * gw + i;
      if (pending[k]) continue;
      let su = 0;
      let sv = 0;
      let c = 0;
      for (let dj = -1; dj <= 1; dj += 1) for (let di = -1; di <= 1; di += 1) {
        const ii = i + di;
        const jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= gw || jj >= gh) continue;
        const q = jj * gw + ii;
        if (!pending[q]) continue;
        su += gu[q]!;
        sv += gv[q]!;
        c += 1;
      }
      if (c) {
        gu[k] = su / c;
        gv[k] = sv / c;
        next[k] = 1;
        changed = true;
      }
    }
    pending = next;
    if (!changed) break;
  }
  for (let k = 0; k < gw * gh; k += 1) if (!pending[k]) {
    gu[k] = med.u;
    gv[k] = med.v;
  }
  // 3×3 median on the grid: one bad track does not bend the field.
  const mu = new Float32Array(gw * gh);
  const mv = new Float32Array(gw * gh);
  const bu: number[] = [];
  const bv: number[] = [];
  for (let j = 0; j < gh; j += 1) for (let i = 0; i < gw; i += 1) {
    bu.length = 0;
    bv.length = 0;
    for (let dj = -1; dj <= 1; dj += 1) for (let di = -1; di <= 1; di += 1) {
      const ii = Math.min(gw - 1, Math.max(0, i + di));
      const jj = Math.min(gh - 1, Math.max(0, j + dj));
      bu.push(gu[jj * gw + ii]!);
      bv.push(gv[jj * gw + ii]!);
    }
    mu[j * gw + i] = median(bu);
    mv[j * gw + i] = median(bv);
  }
  // Dense, by bilinear interpolation of the grid (clamped beyond it).
  const u = new Float32Array(w * h);
  const v = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const fy = Math.min(gh - 1, Math.max(0, y / step - gy0));
    for (let x = 0; x < w; x += 1) {
      const fx = Math.min(gw - 1, Math.max(0, x / step - gx0));
      u[y * w + x] = sampleBilinear(mu, gw, gh, fx, fy);
      v[y * w + x] = sampleBilinear(mv, gw, gh, fx, fy);
    }
  }
  return { width: w, height: h, u, v, trackable, consistency: trackable ? consistent / trackable : 0, fbError: median(errors), median: med };
}

// ---------------------------------------------------------------------------
// Object motion: how the matte's subject moved, ignoring the background
// ---------------------------------------------------------------------------

export interface ObjectMotion {
  /** Affine x' = a0·x + a1·y + a2, y' = a3·x + a4·y + a5 (flow-resolution pixels). */
  affine: [number, number, number, number, number, number];
  /** Forward displacement at (x, y): where the subject's point at (x, y) went. */
  forward(x: number, y: number): [number, number];
  /** Backward displacement at q: where the point now at q came from (q + result). */
  backward(x: number, y: number): [number, number];
  /** Grid points on the subject with enough texture to track. */
  trackable: number;
  /** Of those, the share that came back to where they started. */
  consistency: number;
  /** Median distance of the consistent tracks from the affine, pixels. */
  fitError: number;
  /** The subject's shift by block matching. */
  translation: [number, number];
  /** Consistent tracks used. */
  tracks: number;
  /** Mean squared grey difference over the subject after the shift (0…1 scale): how well its appearance matched. */
  matchCost: number;
}

/**
 * The subject's translation by block matching: the sum of squared
 * differences over the matte's pixels, searched exhaustively at a coarse
 * level and refined level by level, with a parabolic sub-pixel step. Robust
 * where Lucas–Kanade is blind — a flat-coloured subject whose only texture is
 * its outline.
 */
export function maskedTranslation(earlier: PyramidLevel[], later: PyramidLevel[], mask: Uint8Array, search: number): { dx: number; dy: number; cost: number } {
  const levels = Math.min(earlier.length, later.length);
  const w0 = earlier[0]!.w;
  const pixels: number[][] = [];
  // Matte pixels per level (a pixel is in when any of its source pixels is), strided to at most ~3000.
  for (let l = 0; l < levels; l += 1) {
    const L = earlier[l]!;
    const f = 1 << l;
    const on = new Uint8Array(L.w * L.h);
    for (let i = 0; i < mask.length; i += 1) if (mask[i]) {
      const x = Math.min(L.w - 1, Math.floor((i % w0) / f));
      const y = Math.min(L.h - 1, Math.floor(Math.floor(i / w0) / f));
      on[y * L.w + x] = 1;
    }
    const list: number[] = [];
    for (let i = 0; i < on.length; i += 1) if (on[i]) list.push(i);
    const stride = Math.max(1, Math.floor(list.length / 3000));
    pixels.push(stride > 1 ? list.filter((_, k) => k % stride === 0) : list);
  }
  const costAt = (l: number, dx: number, dy: number): number => {
    const A = earlier[l]!;
    const B = later[l]!;
    let sum = 0;
    let n = 0;
    for (const i of pixels[l]!) {
      const x = (i % A.w) + dx;
      const y = Math.floor(i / A.w) + dy;
      if (x < 0 || y < 0 || x >= B.w || y >= B.h) {
        sum += 0.25;
        n += 1;
        continue;
      }
      const d = A.img[i]! - B.img[y * B.w + x]!;
      sum += d * d;
      n += 1;
    }
    return n ? sum / n : Infinity;
  };
  let top = levels - 1;
  while (top > 0 && pixels[top]!.length < 24) top -= 1;
  let bx = 0;
  let by = 0;
  const range = Math.max(2, Math.ceil(search / (1 << top)));
  let best = Infinity;
  for (let dy = -range; dy <= range; dy += 1) for (let dx = -range; dx <= range; dx += 1) {
    const c = costAt(top, dx, dy);
    if (c < best) {
      best = c;
      bx = dx;
      by = dy;
    }
  }
  for (let l = top - 1; l >= 0; l -= 1) {
    bx *= 2;
    by *= 2;
    let cx = bx;
    let cy = by;
    best = Infinity;
    for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
      const c = costAt(l, bx + dx, by + dy);
      if (c < best) {
        best = c;
        cx = bx + dx;
        cy = by + dy;
      }
    }
    bx = cx;
    by = cy;
  }
  const parabola = (m: number, c: number, p: number) => {
    const den = m - 2 * c + p;
    return den > 1e-12 ? Math.max(-0.5, Math.min(0.5, (m - p) / (2 * den))) : 0;
  };
  const sx = parabola(costAt(0, bx - 1, by), best, costAt(0, bx + 1, by));
  const sy = parabola(costAt(0, bx, by - 1), best, costAt(0, bx, by + 1));
  return { dx: bx + sx, dy: by + sy, cost: best };
}

/** Robust affine fit (iteratively reweighted least squares, Tukey biweight). */
export function fitAffine(src: Float32Array, dst: Float32Array, count: number): { a: [number, number, number, number, number, number]; residuals: Float32Array } {
  const weights = new Float64Array(count).fill(1);
  let a: [number, number, number, number, number, number] = [1, 0, 0, 0, 1, 0];
  const residuals = new Float32Array(count);
  const solve3 = (m: number[], b: number[]): number[] | null => {
    const [a11, a12, a13, a21, a22, a23, a31, a32, a33] = m as [number, number, number, number, number, number, number, number, number];
    const det = a11 * (a22 * a33 - a23 * a32) - a12 * (a21 * a33 - a23 * a31) + a13 * (a21 * a32 - a22 * a31);
    if (Math.abs(det) < 1e-9) return null;
    const inv = [
      a22 * a33 - a23 * a32, a13 * a32 - a12 * a33, a12 * a23 - a13 * a22,
      a23 * a31 - a21 * a33, a11 * a33 - a13 * a31, a13 * a21 - a11 * a23,
      a21 * a32 - a22 * a31, a12 * a31 - a11 * a32, a11 * a22 - a12 * a21,
    ];
    return [0, 1, 2].map((r) => (inv[3 * r]! * b[0]! + inv[3 * r + 1]! * b[1]! + inv[3 * r + 2]! * b[2]!) / det);
  };
  for (let it = 0; it < 8; it += 1) {
    // Normal equations: [Σwxx Σwxy Σwx; …] for each output coordinate.
    let sxx = 0, sxy = 0, sx = 0, syy = 0, sy = 0, s1 = 0;
    let bx0 = 0, bx1 = 0, bx2 = 0, by0 = 0, by1 = 0, by2 = 0;
    for (let i = 0; i < count; i += 1) {
      const w = weights[i]!;
      if (w <= 0) continue;
      const x = src[2 * i]!;
      const y = src[2 * i + 1]!;
      const X = dst[2 * i]!;
      const Y = dst[2 * i + 1]!;
      sxx += w * x * x; sxy += w * x * y; sx += w * x; syy += w * y * y; sy += w * y; s1 += w;
      bx0 += w * x * X; bx1 += w * y * X; bx2 += w * X;
      by0 += w * x * Y; by1 += w * y * Y; by2 += w * Y;
    }
    const m = [sxx, sxy, sx, sxy, syy, sy, sx, sy, s1];
    const px = solve3(m, [bx0, bx1, bx2]);
    const py = solve3(m, [by0, by1, by2]);
    if (!px || !py) {
      // Degenerate spread (a line, a point): translation only.
      let tx = 0, ty = 0, n = 0;
      for (let i = 0; i < count; i += 1) if (weights[i]! > 0) {
        tx += dst[2 * i]! - src[2 * i]!;
        ty += dst[2 * i + 1]! - src[2 * i + 1]!;
        n += 1;
      }
      a = [1, 0, n ? tx / n : 0, 0, 1, n ? ty / n : 0];
    } else a = [px[0]!, px[1]!, px[2]!, py[0]!, py[1]!, py[2]!];
    for (let i = 0; i < count; i += 1) {
      const x = src[2 * i]!;
      const y = src[2 * i + 1]!;
      residuals[i] = Math.hypot(a[0] * x + a[1] * y + a[2] - dst[2 * i]!, a[3] * x + a[4] * y + a[5] - dst[2 * i + 1]!);
    }
    const scale = Math.max(0.5, 1.4826 * median(Array.from(residuals)) * 4.685);
    for (let i = 0; i < count; i += 1) {
      const u = residuals[i]! / scale;
      weights[i] = u >= 1 ? 0 : (1 - u * u) ** 2;
    }
  }
  return { a, residuals };
}

/**
 * The subject's motion from `earlier` to `later` (pyramids at the same, flow,
 * resolution): grid points on and around the matte (`mask`, 0/1 at that
 * resolution) are tracked forward and checked backward; a robust affine
 * carries the whole subject and a smoothed residual field the parts that move
 * on their own (an arm). Background points are never used.
 */
export function estimateObjectMotion(earlier: PyramidLevel[], later: PyramidLevel[], mask: Uint8Array, options: FlowOptions = {}): ObjectMotion {
  const w = earlier[0]!.w;
  const h = earlier[0]!.h;
  const step = Math.max(2, Math.round(options.step ?? 6));
  const win = options.win ?? 4;
  // Points whose window touches the subject.
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) if (mask[y * w + x]) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const identity: ObjectMotion = { affine: [1, 0, 0, 0, 1, 0], forward: () => [0, 0], backward: () => [0, 0], trackable: 0, consistency: 0, fitError: 0, translation: [0, 0], tracks: 0, matchCost: 1 };
  if (x1 < 0) return identity;
  // Near the subject: within `win` of it (a cheap box test per grid point).
  const near = (x: number, y: number) => {
    for (let dy = -win; dy <= win; dy += Math.max(1, win)) for (let dx = -win; dx <= win; dx += Math.max(1, win)) {
      const xx = Math.min(w - 1, Math.max(0, Math.round(x + dx)));
      const yy = Math.min(h - 1, Math.max(0, Math.round(y + dy)));
      if (mask[yy * w + xx]) return true;
    }
    return false;
  };
  const gx0 = Math.max(0, Math.floor((x0 - win) / step));
  const gy0 = Math.max(0, Math.floor((y0 - win) / step));
  const gx1 = Math.min(Math.floor((w - 1) / step), Math.ceil((x1 + win) / step));
  const gy1 = Math.min(Math.floor((h - 1) / step), Math.ceil((y1 + win) / step));
  const gw = gx1 - gx0 + 1;
  const gh = gy1 - gy0 + 1;
  const onSubject = new Uint8Array(gw * gh);
  const list: number[] = [];
  for (let j = 0; j < gh; j += 1) for (let i = 0; i < gw; i += 1) {
    const x = (gx0 + i) * step;
    const y = (gy0 + j) * step;
    if (near(x, y)) {
      onSubject[j * gw + i] = 1;
      list.push(j * gw + i);
    }
  }
  const pts = new Float32Array(list.length * 2);
  list.forEach((k, n) => {
    pts[2 * n] = (gx0 + (k % gw)) * step;
    pts[2 * n + 1] = (gy0 + Math.floor(k / gw)) * step;
  });
  // The whole subject's shift first; Lucas–Kanade starts from it.
  const shift = maskedTranslation(earlier, later, mask, options.search ?? Math.max(16, 0.1 * Math.max(w, h)));
  const fwd = trackPoints(earlier, later, pts, { ...options, guess: [shift.dx, shift.dy] });
  const landed = new Float32Array(pts.length);
  for (let n = 0; n < list.length; n += 1) {
    landed[2 * n] = pts[2 * n]! + fwd.dx[n]!;
    landed[2 * n + 1] = pts[2 * n + 1]! + fwd.dy[n]!;
  }
  const back = trackPoints(later, earlier, landed, { ...options, guess: [-shift.dx, -shift.dy] });
  const src: number[] = [];
  const dst: number[] = [];
  const which: number[] = [];
  let trackable = 0;
  for (let n = 0; n < list.length; n += 1) {
    if (!fwd.ok[n]) continue;
    trackable += 1;
    if (!back.ok[n] || Math.hypot(fwd.dx[n]! + back.dx[n]!, fwd.dy[n]! + back.dy[n]!) > 1) continue;
    src.push(pts[2 * n]!, pts[2 * n + 1]!);
    dst.push(landed[2 * n]!, landed[2 * n + 1]!);
    which.push(list[n]!);
  }
  const count = which.length;
  const translation: [number, number, number, number, number, number] = [1, 0, shift.dx, 0, 1, shift.dy];
  // An affine needs enough tracks, spread over the subject, and must stay plausible (no collapse or blow-up).
  let a = translation;
  let residuals: Float32Array = new Float32Array(count);
  if (count >= 12) {
    let sx0 = Infinity, sx1 = -Infinity, sy0 = Infinity, sy1 = -Infinity;
    for (let n = 0; n < count; n += 1) {
      sx0 = Math.min(sx0, src[2 * n]!);
      sx1 = Math.max(sx1, src[2 * n]!);
      sy0 = Math.min(sy0, src[2 * n + 1]!);
      sy1 = Math.max(sy1, src[2 * n + 1]!);
    }
    const spread = Math.min(sx1 - sx0, sy1 - sy0) >= 0.3 * Math.min(x1 - x0 + 1, y1 - y0 + 1);
    const fit = fitAffine(Float32Array.from(src), Float32Array.from(dst), count);
    const det = fit.a[0] * fit.a[4] - fit.a[1] * fit.a[3];
    const plausible = det > 0.7 && det < 1.4 && Math.abs(fit.a[1]) < 0.3 && Math.abs(fit.a[3]) < 0.3;
    if (spread && plausible) {
      a = fit.a;
      residuals = fit.residuals;
    }
  }
  if (a === translation) for (let n = 0; n < count; n += 1) residuals[n] = Math.hypot(dst[2 * n]! - src[2 * n]! - shift.dx, dst[2 * n + 1]! - src[2 * n + 1]! - shift.dy);
  const fit = { residuals };
  // Residual field on the grid: tracked points that fit the subject's motion within reason, spread to the rest.
  const ru = new Float32Array(gw * gh);
  const rv = new Float32Array(gw * gh);
  let have = new Uint8Array(gw * gh);
  // Local motion only on top of a trusted affine; with the shift alone, a few aperture-limited tracks would bend it.
  const limit = Math.min(6, Math.max(1.5, 2.5 * median(Array.from(fit.residuals))));
  for (let n = 0; n < count; n += 1) {
    if (a === translation || fit.residuals[n]! > limit) continue;
    const k = which[n]!;
    const x = src[2 * n]!;
    const y = src[2 * n + 1]!;
    ru[k] = dst[2 * n]! - (a[0] * x + a[1] * y + a[2]);
    rv[k] = dst[2 * n + 1]! - (a[3] * x + a[4] * y + a[5]);
    have[k] = 1;
  }
  for (let pass = 0; pass < gw + gh; pass += 1) {
    let changed = false;
    const next = have.slice();
    for (let j = 0; j < gh; j += 1) for (let i = 0; i < gw; i += 1) {
      const k = j * gw + i;
      if (have[k]) continue;
      let su = 0, sv = 0, c = 0;
      for (let dj = -1; dj <= 1; dj += 1) for (let di = -1; di <= 1; di += 1) {
        const ii = i + di;
        const jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= gw || jj >= gh) continue;
        const q = jj * gw + ii;
        if (!have[q]) continue;
        su += ru[q]!;
        sv += rv[q]!;
        c += 1;
      }
      if (c) {
        ru[k] = su / c;
        rv[k] = sv / c;
        next[k] = 1;
        changed = true;
      }
    }
    have = next;
    if (!changed) break;
  }
  // Smooth: 3×3 mean twice, so the residual bends the warp gently.
  let su = ru;
  let sv = rv;
  for (let pass = 0; pass < 2; pass += 1) {
    const nu = new Float32Array(gw * gh);
    const nv = new Float32Array(gw * gh);
    for (let j = 0; j < gh; j += 1) for (let i = 0; i < gw; i += 1) {
      let tu = 0, tv = 0, c = 0;
      for (let dj = -1; dj <= 1; dj += 1) for (let di = -1; di <= 1; di += 1) {
        const ii = Math.min(gw - 1, Math.max(0, i + di));
        const jj = Math.min(gh - 1, Math.max(0, j + dj));
        tu += su[jj * gw + ii]!;
        tv += sv[jj * gw + ii]!;
        c += 1;
      }
      nu[j * gw + i] = tu / c;
      nv[j * gw + i] = tv / c;
    }
    su = nu;
    sv = nv;
  }
  const forward = (x: number, y: number): [number, number] => {
    const fx = Math.min(gw - 1, Math.max(0, x / step - gx0));
    const fy = Math.min(gh - 1, Math.max(0, y / step - gy0));
    return [a[0] * x + a[1] * y + a[2] - x + sampleBilinear(su, gw, gh, fx, fy), a[3] * x + a[4] * y + a[5] - y + sampleBilinear(sv, gw, gh, fx, fy)];
  };
  const backward = (x: number, y: number): [number, number] => {
    // Fixed point of b = −f(q + b).
    let [bx, by] = forward(x, y);
    bx = -bx;
    by = -by;
    for (let it = 0; it < 4; it += 1) {
      const f = forward(x + bx, y + by);
      bx = -f[0];
      by = -f[1];
    }
    return [bx, by];
  };
  return { affine: a, forward, backward, trackable, consistency: trackable ? count / trackable : 0, fitError: count ? median(Array.from(fit.residuals)) : 0, translation: [shift.dx, shift.dy], tracks: count, matchCost: shift.cost };
}
