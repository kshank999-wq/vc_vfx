import { Mat, mul3, nullVector, solveSPD, t3, cross, normalize3 } from './linalg';
import { distort, rodrigues, logRotation, nearestRotation, type Intrinsics } from './geometry';
import { dltHomography, applyH } from './two-view';
import { gaussianBlur } from '../roto/image';

/**
 * Lens calibration from a printed checkerboard (master spec §10.1;
 * addendum 06 §4).
 *
 *  - Target: a plain checkerboard with a chosen square size, as an exact-size
 *    vector PDF (print at 100 %) and a 300 dpi PNG.
 *  - Detection: saddle points (the Hessian determinant is strongly negative
 *    at an X-junction) refined to sub-pixel accuracy (gradient-orthogonality,
 *    as OpenCV's cornerSubPix), then ordered into the board's grid by growing
 *    from a seed along the two local lattice directions.
 *  - Calibration: Zhang's method — a homography per view, the closed form for
 *    B = K⁻ᵀK⁻¹, the views' poses from their homographies — then
 *    Levenberg–Marquardt over fx, fy, cx, cy, k1, k2, (k3), p1, p2 and every
 *    view's pose on the reprojection error, with the RMS reported.
 */

// ---------------------------------------------------------------------------
// The printable target
// ---------------------------------------------------------------------------

export interface TargetSpec {
  /** Squares across and down (the inner-corner grid is (cols − 1) × (rows − 1)). */
  cols: number;
  rows: number;
  squareMm: number;
  marginMm: number;
}

/** A one-page PDF of the board at exact size (1 mm = 72/25.4 pt). */
export function checkerboardPdf(t: TargetSpec): Uint8Array {
  const pt = 72 / 25.4;
  const W = (t.cols * t.squareMm + 2 * t.marginMm) * pt;
  const H = (t.rows * t.squareMm + 2 * t.marginMm + 12) * pt;
  const ops: string[] = ['0 g'];
  for (let r = 0; r < t.rows; r += 1)
    for (let c = 0; c < t.cols; c += 1) {
      if ((r + c) % 2) continue;
      const x = (t.marginMm + c * t.squareMm) * pt;
      // PDF y is up: row 0 at the top.
      const y = H - (t.marginMm + (r + 1) * t.squareMm) * pt;
      ops.push(`${x.toFixed(3)} ${y.toFixed(3)} ${(t.squareMm * pt).toFixed(3)} ${(t.squareMm * pt).toFixed(3)} re f`);
    }
  const label = `VC VFX calibration board ${t.cols} x ${t.rows} squares of ${t.squareMm} mm (${t.cols - 1} x ${t.rows - 1} inner corners). Print at 100 %, check one square with a ruler.`;
  ops.push('BT', '/F1 8 Tf', `${(t.marginMm * pt).toFixed(2)} ${(4 * pt).toFixed(2)} Td`, `(${label.replace(/[()\\]/g, '')}) Tj`, 'ET');
  const content = ops.join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W.toFixed(3)} ${H.toFixed(3)}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

/** The board as 8-bit grey pixels at `dpi` (white margin). */
export function checkerboardPixels(t: TargetSpec, dpi = 300): { width: number; height: number; data: Uint8Array } {
  const pxPerMm = dpi / 25.4;
  const width = Math.round((t.cols * t.squareMm + 2 * t.marginMm) * pxPerMm);
  const height = Math.round((t.rows * t.squareMm + 2 * t.marginMm) * pxPerMm);
  const data = new Uint8Array(width * height).fill(255);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const mx = x / pxPerMm - t.marginMm;
      const my = y / pxPerMm - t.marginMm;
      if (mx < 0 || my < 0 || mx >= t.cols * t.squareMm || my >= t.rows * t.squareMm) continue;
      if ((Math.floor(mx / t.squareMm) + Math.floor(my / t.squareMm)) % 2 === 0) data[y * width + x] = 0;
    }
  return { width, height, data };
}

/** The board's inner corners in board millimetres (z = 0), row-major from the top-left. */
export function boardPoints(t: Pick<TargetSpec, 'cols' | 'rows' | 'squareMm'>): [number, number][] {
  const out: [number, number][] = [];
  for (let r = 1; r < t.rows; r += 1) for (let c = 1; c < t.cols; c += 1) out.push([c * t.squareMm, r * t.squareMm]);
  return out;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface Detection {
  /** Inner corners in image pixels, row-major (cols − 1 per row), or null when the board was not found. */
  corners: [number, number][] | null;
  reason: string | null;
}

/** Saddle response: −det(Hessian) of the smoothed image (positive at X-junctions). */
function saddleMap(g: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y += 1)
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      const dxx = g[i - 1]! - 2 * g[i]! + g[i + 1]!;
      const dyy = g[i - w]! - 2 * g[i]! + g[i + w]!;
      const dxy = (g[i - w - 1]! + g[i + w + 1]! - g[i - w + 1]! - g[i + w - 1]!) / 4;
      out[i] = dxy * dxy - dxx * dyy;
    }
  return out;
}

/** An X-junction: on a circle around it the intensity alternates dark/bright four times, with contrast. */
function isXJunction(g: Float32Array, w: number, h: number, x: number, y: number): boolean {
  for (const rad of [4, 6]) {
    const n = 24;
    const vals: number[] = [];
    for (let k = 0; k < n; k += 1) {
      const a = (2 * Math.PI * k) / n;
      const px = Math.round(x + rad * Math.cos(a));
      const py = Math.round(y + rad * Math.sin(a));
      if (px < 0 || py < 0 || px >= w || py >= h) return false;
      vals.push(g[py * w + px]!);
    }
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    if (hi - lo < 0.15) return false;
    const mid = (lo + hi) / 2;
    let changes = 0;
    for (let k = 0; k < n; k += 1) if (vals[k]! > mid !== vals[(k + 1) % n]! > mid) changes += 1;
    if (changes !== 4) return false;
  }
  return true;
}

/** OpenCV-style sub-pixel corner: q minimising Σ (∇I(p)·(q − p))² over a window. */
function refineCorner(g: Float32Array, w: number, h: number, x: number, y: number, win: number): [number, number] {
  let qx = x;
  let qy = y;
  for (let it = 0; it < 20; it += 1) {
    let a = 0;
    let b = 0;
    let c = 0;
    let bx = 0;
    let by = 0;
    const cx = Math.round(qx);
    const cy = Math.round(qy);
    for (let j = -win; j <= win; j += 1)
      for (let i = -win; i <= win; i += 1) {
        const px = cx + i;
        const py = cy + j;
        if (px < 1 || py < 1 || px >= w - 1 || py >= h - 1) continue;
        const k = py * w + px;
        const gx = (g[k + 1]! - g[k - 1]!) / 2;
        const gy = (g[k + w]! - g[k - w]!) / 2;
        const wgt = Math.exp(-(i * i + j * j) / (2 * (win / 2) ** 2));
        a += wgt * gx * gx;
        b += wgt * gx * gy;
        c += wgt * gy * gy;
        bx += wgt * (gx * gx * px + gx * gy * py);
        by += wgt * (gx * gy * px + gy * gy * py);
      }
    const det = a * c - b * b;
    if (Math.abs(det) < 1e-12) break;
    const nx = (c * bx - b * by) / det;
    const ny = (a * by - b * bx) / det;
    const d = Math.hypot(nx - qx, ny - qy);
    qx = nx;
    qy = ny;
    if (d < 1e-3 || d > win) break;
  }
  return [qx, qy];
}

/** Find the board's inner corners (a grid of (cols − 1) × (rows − 1)) in a grey image (0 … 1). */
export function detectCheckerboard(gray: Float32Array, w: number, h: number, t: Pick<TargetSpec, 'cols' | 'rows'>): Detection {
  const nx = t.cols - 1;
  const ny = t.rows - 1;
  const g = gaussianBlur(gray, w, h, 1.5);
  const s = saddleMap(g, w, h);
  let max = 0;
  for (let i = 0; i < s.length; i += 1) max = Math.max(max, s[i]!);
  if (max <= 0) return { corners: null, reason: 'No corners in the image' };
  // Candidates: local maxima above a share of the strongest.
  const cand: { x: number; y: number; v: number }[] = [];
  const r = 3;
  for (let y = r; y < h - r; y += 1)
    for (let x = r; x < w - r; x += 1) {
      const v = s[y * w + x]!;
      if (v < 0.08 * max) continue;
      let isMax = true;
      for (let j = -r; j <= r && isMax; j += 1) for (let i = -r; i <= r; i += 1) if ((i || j) && s[(y + j) * w + x + i]! > v) {
        isMax = false;
        break;
      }
      if (isMax && isXJunction(g, w, h, x, y)) cand.push({ x, y, v });
    }
  if (cand.length < nx * ny) return { corners: null, reason: `Found ${cand.length} corner candidates; the board has ${nx * ny}` };
  cand.sort((a, b) => b.v - a.v);
  // Refine on a light blur: the heavy one finds candidates but rounds the corners.
  const fine = gaussianBlur(gray, w, h, 0.7);
  const pts = cand.slice(0, Math.min(cand.length, nx * ny * 3)).map((c) => refineCorner(fine, w, h, c.x, c.y, 5));
  // Grow the grid from the candidate nearest the centre of mass of the strongest nx·ny.
  const strong = pts.slice(0, nx * ny);
  const mx = strong.reduce((a, p) => a + p[0], 0) / strong.length;
  const my = strong.reduce((a, p) => a + p[1], 0) / strong.length;
  let seed = 0;
  pts.forEach((p, i) => {
    if (Math.hypot(p[0] - mx, p[1] - my) < Math.hypot(pts[seed]![0] - mx, pts[seed]![1] - my)) seed = i;
  });
  const near = (p: [number, number], k: number) =>
    pts
      .map((q, i) => ({ i, d: Math.hypot(q[0] - p[0], q[1] - p[1]) }))
      .filter((x) => x.d > 1)
      .sort((a, b) => a.d - b.d)
      .slice(0, k);
  const nb = near(pts[seed]!, 4);
  if (nb.length < 4) return { corners: null, reason: 'Too few neighbours to find the grid' };
  // Two lattice directions: the nearest neighbour, and the nearest one not along it.
  const p0 = pts[seed]!;
  const v1: [number, number] = [pts[nb[0]!.i]![0] - p0[0], pts[nb[0]!.i]![1] - p0[1]];
  let v2: [number, number] | null = null;
  for (const n of nb.slice(1)) {
    const v: [number, number] = [pts[n.i]![0] - p0[0], pts[n.i]![1] - p0[1]];
    const cos = Math.abs(v[0] * v1[0] + v[1] * v1[1]) / (Math.hypot(...v) * Math.hypot(...v1));
    if (cos < 0.5) {
      v2 = v;
      break;
    }
  }
  if (!v2) return { corners: null, reason: 'Could not find the grid directions' };
  // BFS over grid cells; each cell's position predicted from known neighbours' local vectors.
  const grid = new Map<string, number>();
  const pos = new Map<string, [number, number]>();
  const used = new Set<number>([seed]);
  grid.set('0,0', seed);
  pos.set('0,0', p0);
  const queue: [number, number][] = [[0, 0]];
  const dirs: [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  while (queue.length) {
    const [a, b] = queue.shift()!;
    const here = pos.get(`${a},${b}`)!;
    for (const [da, db] of dirs) {
      const key = `${a + da},${b + db}`;
      if (grid.has(key)) continue;
      // Local lattice vectors: from neighbours already placed, else the seed's.
      const vecA = (() => {
        const n1 = pos.get(`${a + 1},${b}`);
        const n0 = pos.get(`${a - 1},${b}`);
        if (n1) return [n1[0] - here[0], n1[1] - here[1]];
        if (n0) return [here[0] - n0[0], here[1] - n0[1]];
        return v1;
      })();
      const vecB = (() => {
        const n1 = pos.get(`${a},${b + 1}`);
        const n0 = pos.get(`${a},${b - 1}`);
        if (n1) return [n1[0] - here[0], n1[1] - here[1]];
        if (n0) return [here[0] - n0[0], here[1] - n0[1]];
        return v2!;
      })();
      const pred: [number, number] = [here[0] + da * vecA[0]! + db * vecB[0]!, here[1] + da * vecA[1]! + db * vecB[1]!];
      const step = Math.hypot(da * vecA[0]! + db * vecB[0]!, da * vecA[1]! + db * vecB[1]!);
      let best = -1;
      let bd = 0.35 * step;
      pts.forEach((q, i) => {
        if (used.has(i)) return;
        const d = Math.hypot(q[0] - pred[0], q[1] - pred[1]);
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      if (best < 0) continue;
      used.add(best);
      grid.set(key, best);
      pos.set(key, pts[best]!);
      queue.push([a + da, b + db]);
    }
  }
  const keys = [...grid.keys()].map((k) => k.split(',').map(Number) as [number, number]);
  const aMin = Math.min(...keys.map((k) => k[0]));
  const aMax = Math.max(...keys.map((k) => k[0]));
  const bMin = Math.min(...keys.map((k) => k[1]));
  const bMax = Math.max(...keys.map((k) => k[1]));
  const spanA = aMax - aMin + 1;
  const spanB = bMax - bMin + 1;
  let cols: number;
  let rows: number;
  let transpose = false;
  if (spanA === nx && spanB === ny) {
    cols = nx;
    rows = ny;
  } else if (spanA === ny && spanB === nx) {
    cols = ny;
    rows = nx;
    transpose = true;
  } else return { corners: null, reason: `Found a ${spanA} × ${spanB} grid of corners; the board has ${nx} × ${ny} inner corners. Is all of it in frame?` };
  if (grid.size !== nx * ny) return { corners: null, reason: `${nx * ny - grid.size} corners of the board were not found` };
  // Order: rows along the board's longer-or-first axis, starting top-left in the image.
  let ordered: [number, number][] = [];
  if (!transpose) for (let b = bMin; b <= bMax; b += 1) for (let a = aMin; a <= aMax; a += 1) ordered.push(pos.get(`${a},${b}`)!);
  else for (let a = aMin; a <= aMax; a += 1) for (let b = bMin; b <= bMax; b += 1) ordered.push(pos.get(`${a},${b}`)!);
  void cols;
  void rows;
  // Make the first row the top one and run left to right (image coordinates).
  const rowOf = (k: number) => ordered.slice(k * nx, (k + 1) * nx);
  const topY = rowOf(0).reduce((s2, p) => s2 + p[1], 0);
  const botY = rowOf(ny - 1).reduce((s2, p) => s2 + p[1], 0);
  if (topY > botY) ordered = Array.from({ length: ny }, (_, k) => rowOf(ny - 1 - k)).flat();
  const firstRow = ordered.slice(0, nx);
  if (firstRow[0]![0] > firstRow[nx - 1]![0]) ordered = Array.from({ length: ny }, (_, k) => ordered.slice(k * nx, (k + 1) * nx).reverse()).flat();
  return { corners: ordered, reason: null };
}

// ---------------------------------------------------------------------------
// Zhang's method
// ---------------------------------------------------------------------------

export interface CalibrationResult {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  k1: number;
  k2: number;
  k3: number;
  p1: number;
  p2: number;
  /** RMS reprojection error over all corners, pixels. */
  rms: number;
  perView: number[];
  poses: { R: number[]; t: number[] }[];
}

const vij = (H: number[], i: number, j: number) => {
  const h = (r: number, c: number) => H[r * 3 + c]!; // column c of H is h_c
  return [h(0, i) * h(0, j), h(0, i) * h(1, j) + h(1, i) * h(0, j), h(1, i) * h(1, j), h(2, i) * h(0, j) + h(0, i) * h(2, j), h(2, i) * h(1, j) + h(1, i) * h(2, j), h(2, i) * h(2, j)];
};

function projectBoard(p: { fx: number; fy: number; cx: number; cy: number; k1: number; k2: number; k3: number; p1: number; p2: number }, R: number[], t: number[], X: number, Y: number): [number, number] | null {
  const xc = R[0]! * X + R[1]! * Y + t[0]!;
  const yc = R[3]! * X + R[4]! * Y + t[1]!;
  const zc = R[6]! * X + R[7]! * Y + t[2]!;
  if (zc <= 0) return null;
  const [xd, yd] = distort({ f: 1, cx: 0, cy: 0, k1: p.k1, k2: p.k2, k3: p.k3, p1: p.p1, p2: p.p2 }, xc / zc, yc / zc);
  return [p.fx * xd + p.cx, p.fy * yd + p.cy];
}

/** Calibrate from views of the board: each view lists the image corners for `board` (same order). */
export function calibrateZhang(board: readonly [number, number][], views: readonly (readonly [number, number][])[], options: { k3?: boolean; tangential?: boolean; iterations?: number } = {}): CalibrationResult {
  if (views.length < 3) throw new Error('Calibration needs at least three views of the board at different angles');
  const src = new Float64Array(board.flatMap((p) => [p[0], p[1]]));
  const Hs = views.map((v) => {
    const H = dltHomography(src, new Float64Array(v.flatMap((p) => [p[0], p[1]])));
    if (!H) throw new Error('A view’s homography could not be computed');
    return H;
  });
  // V b = 0, b = (B11, B12, B22, B13, B23, B33).
  const V = new Mat(2 * Hs.length, 6);
  Hs.forEach((H, k) => {
    const v12 = vij(H, 0, 1);
    const v11 = vij(H, 0, 0);
    const v22 = vij(H, 1, 1);
    for (let c = 0; c < 6; c += 1) {
      V.data[2 * k * 6 + c] = v12[c]!;
      V.data[(2 * k + 1) * 6 + c] = v11[c]! - v22[c]!;
    }
  });
  const b = Array.from(nullVector(V));
  const [B11, B12, B22, B13, B23, B33] = b as [number, number, number, number, number, number];
  const v0 = (B12 * B13 - B11 * B23) / (B11 * B22 - B12 * B12);
  const lambda = B33 - (B13 * B13 + v0 * (B12 * B13 - B11 * B23)) / B11;
  const alpha = Math.sqrt(lambda / B11);
  const beta = Math.sqrt((lambda * B11) / (B11 * B22 - B12 * B12));
  const u0 = -(B13 * alpha * alpha) / lambda; // skew assumed zero
  if (![alpha, beta, u0, v0].every(Number.isFinite)) throw new Error('The views are too similar to calibrate (tilt the board more between them)');
  const K = [alpha, 0, u0, 0, beta, v0, 0, 0, 1];
  const Ki = [1 / alpha, 0, -u0 / alpha, 0, 1 / beta, -v0 / beta, 0, 0, 1];
  const poses = Hs.map((H) => {
    const A = mul3(Ki, H);
    const c0 = [A[0]!, A[3]!, A[6]!];
    const c1 = [A[1]!, A[4]!, A[7]!];
    const c2 = [A[2]!, A[5]!, A[8]!];
    const l = 1 / Math.hypot(...c0);
    const r1 = c0.map((x) => x * l);
    const r2 = c1.map((x) => x * l);
    const r3 = cross(r1, r2);
    let R = nearestRotation([r1[0]!, r2[0]!, r3[0]!, r1[1]!, r2[1]!, r3[1]!, r1[2]!, r2[2]!, r3[2]!]);
    let t = c2.map((x) => x * l);
    if (t[2]! < 0) {
      // The board must be in front of the camera.
      R = [-R[0]!, -R[1]!, R[2]!, -R[3]!, -R[4]!, R[5]!, -R[6]!, -R[7]!, R[8]!];
      t = t.map((x) => -x);
    }
    return { R, t };
  });
  void K;
  void normalize3;
  void t3;
  // Levenberg–Marquardt over intrinsics + poses.
  const nIntr = 4 + 2 + (options.k3 ? 1 : 0) + (options.tangential === false ? 0 : 2);
  const P = { fx: alpha, fy: beta, cx: u0, cy: v0, k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 };
  let w = poses.map((p) => logRotation(p.R));
  let tr = poses.map((p) => [...p.t]);
  const pack = () => [P.fx, P.fy, P.cx, P.cy, P.k1, P.k2, ...(options.k3 ? [P.k3] : []), ...(options.tangential === false ? [] : [P.p1, P.p2]), ...w.flatMap((x, i) => [...x, ...tr[i]!])];
  const unpack = (x: number[]) => {
    let k = 0;
    P.fx = x[k++]!;
    P.fy = x[k++]!;
    P.cx = x[k++]!;
    P.cy = x[k++]!;
    P.k1 = x[k++]!;
    P.k2 = x[k++]!;
    if (options.k3) P.k3 = x[k++]!;
    if (options.tangential !== false) {
      P.p1 = x[k++]!;
      P.p2 = x[k++]!;
    }
    // Per view: ω (3) then t (3), as packed.
    const ws: [number, number, number][] = [];
    const ts: number[][] = [];
    for (let v = 0; v < views.length; v += 1) {
      ws.push([x[k++]!, x[k++]!, x[k++]!]);
      ts.push([x[k++]!, x[k++]!, x[k++]!]);
    }
    w = ws;
    tr = ts;
  };
  const residuals = (x: number[]): number[] => {
    const keep = { ...P };
    const ww = w;
    const tt = tr;
    unpack(x);
    const out: number[] = [];
    views.forEach((v, vi) => {
      const R = rodrigues(w[vi]!);
      board.forEach((bp, i) => {
        const pr = projectBoard(P, R, tr[vi]!, bp[0], bp[1]);
        out.push(pr ? pr[0] - v[i]![0] : 1e3, pr ? pr[1] - v[i]![1] : 1e3);
      });
    });
    Object.assign(P, keep);
    w = ww;
    tr = tt;
    return out;
  };
  let x = pack();
  let r = residuals(x);
  let cost = r.reduce((a, b2) => a + b2 * b2, 0);
  let lam = 1e-3;
  const n = x.length;
  for (let it = 0; it < (options.iterations ?? 60); it += 1) {
    // Numerical Jacobian, block-sparse in the poses (each view's residuals depend on its 6 pose parameters).
    const m = r.length;
    const J = new Float64Array(m * n);
    for (let j = 0; j < n; j += 1) {
      const h = Math.max(1e-7, Math.abs(x[j]!) * 1e-6);
      const xp = [...x];
      xp[j]! += h;
      // Only the rows that can change: intrinsics affect all; a pose parameter only its view.
      const rp = residuals(xp);
      for (let i = 0; i < m; i += 1) J[i * n + j] = (rp[i]! - r[i]!) / h;
    }
    const A = new Mat(n, n);
    const g = new Float64Array(n);
    for (let i = 0; i < m; i += 1) {
      const row = i * n;
      for (let a = 0; a < n; a += 1) {
        const ja = J[row + a]!;
        if (ja === 0) continue;
        g[a]! += ja * r[i]!;
        for (let c = a; c < n; c += 1) A.data[a * n + c]! += ja * J[row + c]!;
      }
    }
    for (let a = 0; a < n; a += 1) for (let c = 0; c < a; c += 1) A.data[a * n + c] = A.data[c * n + a]!;
    let improved = false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const Ad = A.clone();
      for (let a = 0; a < n; a += 1) Ad.data[a * n + a]! *= 1 + lam;
      for (let a = 0; a < n; a += 1) Ad.data[a * n + a]! += 1e-12;
      const dx = solveSPD(Ad, Array.from(g, (v) => -v));
      if (!dx) {
        lam *= 10;
        continue;
      }
      const xn = x.map((v, i) => v + dx[i]!);
      const rn = residuals(xn);
      const cn = rn.reduce((a, b2) => a + b2 * b2, 0);
      if (cn < cost) {
        const rel = (cost - cn) / cost;
        x = xn;
        r = rn;
        cost = cn;
        lam = Math.max(1e-12, lam / 3);
        improved = rel > 1e-10;
        break;
      }
      lam *= 4;
    }
    if (!improved) break;
  }
  unpack(x);
  const perView = views.map((v, vi) => {
    const off = vi * board.length * 2;
    let s2 = 0;
    for (let i = 0; i < board.length * 2; i += 1) s2 += r[off + i]! ** 2;
    return Math.sqrt(s2 / board.length);
  });
  return { ...P, rms: Math.sqrt(cost / (r.length / 2)), perView, poses: views.map((_, i) => ({ R: rodrigues(w[i]!), t: tr[i]! })) };
}

/**
 * The calibration as the solver's intrinsics at the plate's pixel aspect
 * (addendum 17): fx = f / a, fy = f, so f is the mean of fy and fx · a. Zhang's
 * distortion is already on physical (de-squeezed) normalised coordinates.
 */
export function calibrationIntrinsics(c: CalibrationResult, pixelAspect = 1): Intrinsics {
  return { f: (c.fx * pixelAspect + c.fy) / 2, cx: c.cx, cy: c.cy, k1: c.k1, k2: c.k2, k3: c.k3, p1: c.p1, p2: c.p2, ...(pixelAspect !== 1 ? { a: pixelAspect } : {}) };
}

/** The pixel aspect the board measured (fy / fx): a check on the shot's pixel aspect. */
export function measuredPixelAspect(c: Pick<CalibrationResult, 'fx' | 'fy'>): number {
  return c.fy / c.fx;
}

export { applyH };
