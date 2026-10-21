/**
 * Small dense linear algebra for the camera solver (addendum 06). Pure
 * TypeScript on Float64Arrays, no dependencies, so it runs in the desktop's
 * worker thread and in the browser preview alike.
 *
 * Matrices are row-major `Mat`s. What is here is what the solver needs and is
 * tested on its own (`camera-linalg.test.ts`): products, Cholesky (dense and
 * envelope/profile for the bundle adjuster's reduced camera system),
 * Householder QR, the SVD by one-sided Jacobi (Hestenes), the symmetric
 * eigenproblem by cyclic Jacobi, LU with partial pivoting, and 3×3 helpers.
 */

export class Mat {
  readonly rows: number;
  readonly cols: number;
  readonly data: Float64Array;

  constructor(rows: number, cols: number, data?: Float64Array | readonly number[]) {
    this.rows = rows;
    this.cols = cols;
    if (data) {
      if (data.length !== rows * cols) throw new Error(`Mat ${rows}×${cols} needs ${rows * cols} values, got ${data.length}`);
      this.data = data instanceof Float64Array ? data : Float64Array.from(data);
    } else this.data = new Float64Array(rows * cols);
  }

  static identity(n: number): Mat {
    const m = new Mat(n, n);
    for (let i = 0; i < n; i += 1) m.data[i * n + i] = 1;
    return m;
  }

  static fromRows(rows: readonly (readonly number[])[]): Mat {
    const r = rows.length;
    const c = rows[0]?.length ?? 0;
    const m = new Mat(r, c);
    rows.forEach((row, i) => row.forEach((v, j) => (m.data[i * c + j] = v)));
    return m;
  }

  get(i: number, j: number): number {
    return this.data[i * this.cols + j]!;
  }

  set(i: number, j: number, v: number): void {
    this.data[i * this.cols + j] = v;
  }

  clone(): Mat {
    return new Mat(this.rows, this.cols, new Float64Array(this.data));
  }

  row(i: number): Float64Array {
    return this.data.slice(i * this.cols, (i + 1) * this.cols);
  }

  col(j: number): Float64Array {
    const out = new Float64Array(this.rows);
    for (let i = 0; i < this.rows; i += 1) out[i] = this.data[i * this.cols + j]!;
    return out;
  }

  toRows(): number[][] {
    return Array.from({ length: this.rows }, (_, i) => Array.from(this.data.subarray(i * this.cols, (i + 1) * this.cols)));
  }
}

export function transpose(a: Mat): Mat {
  const out = new Mat(a.cols, a.rows);
  for (let i = 0; i < a.rows; i += 1) for (let j = 0; j < a.cols; j += 1) out.data[j * a.rows + i] = a.data[i * a.cols + j]!;
  return out;
}

export function matMul(a: Mat, b: Mat): Mat {
  if (a.cols !== b.rows) throw new Error(`matMul: ${a.rows}×${a.cols} · ${b.rows}×${b.cols}`);
  const out = new Mat(a.rows, b.cols);
  const n = a.cols;
  const m = b.cols;
  for (let i = 0; i < a.rows; i += 1) {
    for (let k = 0; k < n; k += 1) {
      const aik = a.data[i * n + k]!;
      if (aik === 0) continue;
      const bo = k * m;
      const oo = i * m;
      for (let j = 0; j < m; j += 1) out.data[oo + j]! += aik * b.data[bo + j]!;
    }
  }
  return out;
}

export function matVec(a: Mat, x: ArrayLike<number>): Float64Array {
  const out = new Float64Array(a.rows);
  for (let i = 0; i < a.rows; i += 1) {
    let s = 0;
    const o = i * a.cols;
    for (let j = 0; j < a.cols; j += 1) s += a.data[o + j]! * x[j]!;
    out[i] = s;
  }
  return out;
}

/** AᵀA, symmetric. */
export function gram(a: Mat): Mat {
  const n = a.cols;
  const out = new Mat(n, n);
  for (let r = 0; r < a.rows; r += 1) {
    const o = r * n;
    for (let i = 0; i < n; i += 1) {
      const v = a.data[o + i]!;
      if (v === 0) continue;
      for (let j = i; j < n; j += 1) out.data[i * n + j]! += v * a.data[o + j]!;
    }
  }
  for (let i = 0; i < n; i += 1) for (let j = 0; j < i; j += 1) out.data[i * n + j] = out.data[j * n + i]!;
  return out;
}

export function norm(v: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < v.length; i += 1) s += v[i]! * v[i]!;
  return Math.sqrt(s);
}

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i]! * b[i]!;
  return s;
}

// ---------------------------------------------------------------------------
// Cholesky
// ---------------------------------------------------------------------------

/** Lower-triangular L with A = LLᵀ, or null when A is not (numerically) positive definite. */
export function cholesky(a: Mat): Mat | null {
  const n = a.rows;
  const l = new Mat(n, n);
  const L = l.data;
  const A = a.data;
  for (let j = 0; j < n; j += 1) {
    let d = A[j * n + j]!;
    for (let k = 0; k < j; k += 1) d -= L[j * n + k]! * L[j * n + k]!;
    if (!(d > 0) || !Number.isFinite(d)) return null;
    const ljj = Math.sqrt(d);
    L[j * n + j] = ljj;
    for (let i = j + 1; i < n; i += 1) {
      let s = A[i * n + j]!;
      for (let k = 0; k < j; k += 1) s -= L[i * n + k]! * L[j * n + k]!;
      L[i * n + j] = s / ljj;
    }
  }
  return l;
}

/** Solve LLᵀx = b given L from `cholesky`. */
export function choleskySolve(l: Mat, b: ArrayLike<number>): Float64Array {
  const n = l.rows;
  const L = l.data;
  const y = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    let s = b[i]!;
    for (let k = 0; k < i; k += 1) s -= L[i * n + k]! * y[k]!;
    y[i] = s / L[i * n + i]!;
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i -= 1) {
    let s = y[i]!;
    for (let k = i + 1; k < n; k += 1) s -= L[k * n + i]! * x[k]!;
    x[i] = s / L[i * n + i]!;
  }
  return x;
}

/** Solve a symmetric positive-definite system, or null. */
export function solveSPD(a: Mat, b: ArrayLike<number>): Float64Array | null {
  const l = cholesky(a);
  return l ? choleskySolve(l, b) : null;
}

/**
 * A symmetric matrix stored by its lower envelope (skyline / profile): row i
 * keeps columns first[i] … i. The bundle adjuster's reduced camera system has
 * this shape when cameras are in time order — a camera shares points only
 * with cameras near it in the shot — plus a few dense rows for the shared
 * intrinsics, which go last. Cholesky keeps the envelope (no fill outside it).
 */
export class EnvelopeMatrix {
  readonly n: number;
  readonly first: Int32Array;
  /** Offset of row i's first stored element. */
  readonly offset: Int32Array;
  readonly values: Float64Array;

  constructor(first: Int32Array) {
    this.n = first.length;
    this.first = first;
    this.offset = new Int32Array(this.n + 1);
    for (let i = 0; i < this.n; i += 1) {
      if (first[i]! > i || first[i]! < 0) throw new Error('EnvelopeMatrix: first[i] must be in 0 … i');
      this.offset[i + 1] = this.offset[i]! + (i - first[i]! + 1);
    }
    this.values = new Float64Array(this.offset[this.n]!);
  }

  /** Stored elements; a measure of the work Cholesky will do. */
  get size(): number {
    return this.values.length;
  }

  /** Index of (i, j), j ≤ i, inside the envelope; −1 outside. */
  index(i: number, j: number): number {
    const f = this.first[i]!;
    return j < f ? -1 : this.offset[i]! + (j - f);
  }

  get(i: number, j: number): number {
    if (j > i) [i, j] = [j, i];
    const k = this.index(i, j);
    return k < 0 ? 0 : this.values[k]!;
  }

  add(i: number, j: number, v: number): void {
    if (j > i) [i, j] = [j, i];
    const k = this.index(i, j);
    if (k < 0) throw new Error(`EnvelopeMatrix: (${i}, ${j}) is outside the envelope`);
    this.values[k]! += v;
  }

  /** In-place Cholesky (the envelope then holds L). False when not positive definite. */
  factor(): boolean {
    const { n, first, offset, values } = this;
    for (let i = 0; i < n; i += 1) {
      const fi = first[i]!;
      const oi = offset[i]! - fi;
      for (let j = fi; j <= i; j += 1) {
        const fj = first[j]!;
        const oj = offset[j]! - fj;
        const k0 = fi > fj ? fi : fj;
        let s = values[oi + j]!;
        for (let k = k0; k < j; k += 1) s -= values[oi + k]! * values[oj + k]!;
        if (j === i) {
          if (!(s > 0) || !Number.isFinite(s)) return false;
          values[oi + i] = Math.sqrt(s);
        } else values[oi + j] = s / values[oj + j]!;
      }
    }
    return true;
  }

  /** Solve after `factor()`. */
  solve(b: ArrayLike<number>): Float64Array {
    const { n, first, offset, values } = this;
    const y = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      const fi = first[i]!;
      const oi = offset[i]! - fi;
      let s = b[i]!;
      for (let k = fi; k < i; k += 1) s -= values[oi + k]! * y[k]!;
      y[i] = s / values[oi + i]!;
    }
    // Backward: Lᵀx = y, column-oriented over the rows of L.
    const x = y;
    for (let i = n - 1; i >= 0; i -= 1) {
      const fi = first[i]!;
      const oi = offset[i]! - fi;
      x[i] = x[i]! / values[oi + i]!;
      const xi = x[i]!;
      for (let k = fi; k < i; k += 1) x[k] = x[k]! - values[oi + k]! * xi;
    }
    return x;
  }
}

// ---------------------------------------------------------------------------
// LU with partial pivoting
// ---------------------------------------------------------------------------

/** Solve a general square system; null when singular. */
export function solveLinear(a: Mat, b: ArrayLike<number>): Float64Array | null {
  const n = a.rows;
  const m = a.data.slice();
  const x = Float64Array.from(b as ArrayLike<number>);
  for (let c = 0; c < n; c += 1) {
    let p = c;
    let best = Math.abs(m[c * n + c]!);
    for (let r = c + 1; r < n; r += 1) {
      const v = Math.abs(m[r * n + c]!);
      if (v > best) {
        best = v;
        p = r;
      }
    }
    if (best < 1e-300) return null;
    if (p !== c) {
      for (let k = 0; k < n; k += 1) {
        const t = m[c * n + k]!;
        m[c * n + k] = m[p * n + k]!;
        m[p * n + k] = t;
      }
      const t = x[c]!;
      x[c] = x[p]!;
      x[p] = t;
    }
    const piv = m[c * n + c]!;
    for (let r = c + 1; r < n; r += 1) {
      const f = m[r * n + c]! / piv;
      if (f === 0) continue;
      for (let k = c; k < n; k += 1) m[r * n + k]! -= f * m[c * n + k]!;
      x[r]! -= f * x[c]!;
    }
  }
  for (let r = n - 1; r >= 0; r -= 1) {
    let s = x[r]!;
    for (let k = r + 1; k < n; k += 1) s -= m[r * n + k]! * x[k]!;
    x[r] = s / m[r * n + r]!;
  }
  return x;
}

export function inverse(a: Mat): Mat | null {
  const n = a.rows;
  const out = new Mat(n, n);
  for (let j = 0; j < n; j += 1) {
    const e = new Float64Array(n);
    e[j] = 1;
    const col = solveLinear(a, e);
    if (!col) return null;
    for (let i = 0; i < n; i += 1) out.data[i * n + j] = col[i]!;
  }
  return out;
}

// ---------------------------------------------------------------------------
// QR (Householder)
// ---------------------------------------------------------------------------

/** A = QR with Q m×m orthogonal and R m×n upper triangular. */
export function qr(a: Mat): { q: Mat; r: Mat } {
  const m = a.rows;
  const n = a.cols;
  const r = a.clone();
  const q = Mat.identity(m);
  const R = r.data;
  const Q = q.data;
  const v = new Float64Array(m);
  for (let k = 0; k < Math.min(m - 1, n); k += 1) {
    let alpha = 0;
    for (let i = k; i < m; i += 1) alpha += R[i * n + k]! * R[i * n + k]!;
    alpha = Math.sqrt(alpha);
    if (alpha === 0) continue;
    if (R[k * n + k]! > 0) alpha = -alpha;
    let vnorm = 0;
    for (let i = k; i < m; i += 1) {
      v[i] = R[i * n + k]! - (i === k ? alpha : 0);
      vnorm += v[i]! * v[i]!;
    }
    if (vnorm === 0) continue;
    // R ← (I − 2vvᵀ/vᵀv) R
    for (let j = 0; j < n; j += 1) {
      let s = 0;
      for (let i = k; i < m; i += 1) s += v[i]! * R[i * n + j]!;
      const f = (2 * s) / vnorm;
      for (let i = k; i < m; i += 1) R[i * n + j]! -= f * v[i]!;
    }
    // Q ← Q (I − 2vvᵀ/vᵀv)
    for (let i = 0; i < m; i += 1) {
      let s = 0;
      for (let j = k; j < m; j += 1) s += Q[i * m + j]! * v[j]!;
      const f = (2 * s) / vnorm;
      for (let j = k; j < m; j += 1) Q[i * m + j]! -= f * v[j]!;
    }
  }
  return { q, r };
}

/** Least squares min ‖Ax − b‖ (A m×n, m ≥ n, full column rank) by QR. */
export function lstsq(a: Mat, b: ArrayLike<number>): Float64Array {
  const { q, r } = qr(a);
  const n = a.cols;
  const qtb = matVec(transpose(q), b);
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i -= 1) {
    let s = qtb[i]!;
    for (let k = i + 1; k < n; k += 1) s -= r.get(i, k) * x[k]!;
    x[i] = s / r.get(i, i);
  }
  return x;
}

// ---------------------------------------------------------------------------
// SVD (one-sided Jacobi) and the symmetric eigenproblem (cyclic Jacobi)
// ---------------------------------------------------------------------------

export interface SVD {
  /** m × k, k = min(m, n) left singular vectors (columns). */
  u: Mat;
  /** n singular values, descending (zeros included when m < n). */
  s: Float64Array;
  /** n × n right singular vectors (columns), full: the null space is in the last columns. */
  v: Mat;
}

/**
 * Singular value decomposition A = U diag(s) Vᵀ by one-sided Jacobi
 * (Hestenes): rotate pairs of columns of A until they are orthogonal. Accurate
 * to working precision even for small singular values, and gives the full V
 * (so null vectors) for any shape — what the DLTs need.
 */
export function svd(a: Mat, options: { maxSweeps?: number } = {}): SVD {
  const m = a.rows;
  const n = a.cols;
  // Work on columns: store A column-major for cache-friendly column ops.
  const cols: Float64Array[] = Array.from({ length: n }, (_, j) => a.col(j));
  const vcols: Float64Array[] = Array.from({ length: n }, (_, j) => {
    const e = new Float64Array(n);
    e[j] = 1;
    return e;
  });
  const maxSweeps = options.maxSweeps ?? 60;
  const eps = 1e-15;
  for (let sweep = 0; sweep < maxSweeps; sweep += 1) {
    let off = 0;
    for (let p = 0; p < n - 1; p += 1) {
      const cp = cols[p]!;
      for (let q = p + 1; q < n; q += 1) {
        const cq = cols[q]!;
        let alpha = 0;
        let beta = 0;
        let gamma = 0;
        for (let i = 0; i < m; i += 1) {
          alpha += cp[i]! * cp[i]!;
          beta += cq[i]! * cq[i]!;
          gamma += cp[i]! * cq[i]!;
        }
        if (Math.abs(gamma) <= eps * Math.sqrt(alpha * beta) || gamma === 0) continue;
        off = Math.max(off, Math.abs(gamma) / Math.sqrt(alpha * beta));
        const zeta = (beta - alpha) / (2 * gamma);
        const t = Math.sign(zeta || 1) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta));
        const c = 1 / Math.sqrt(1 + t * t);
        const s = c * t;
        for (let i = 0; i < m; i += 1) {
          const x = cp[i]!;
          const y = cq[i]!;
          cp[i] = c * x - s * y;
          cq[i] = s * x + c * y;
        }
        const vp = vcols[p]!;
        const vq = vcols[q]!;
        for (let i = 0; i < n; i += 1) {
          const x = vp[i]!;
          const y = vq[i]!;
          vp[i] = c * x - s * y;
          vq[i] = s * x + c * y;
        }
      }
    }
    if (off < eps) break;
  }
  const sv = cols.map((c) => norm(c));
  const order = sv.map((_, i) => i).sort((x, y) => sv[y]! - sv[x]!);
  const k = Math.min(m, n);
  const u = new Mat(m, k);
  const v = new Mat(n, n);
  const s = new Float64Array(n);
  order.forEach((src, dst) => {
    s[dst] = sv[src]!;
    for (let i = 0; i < n; i += 1) v.data[i * n + dst] = vcols[src]![i]!;
    if (dst < k && sv[src]! > 0) for (let i = 0; i < m; i += 1) u.data[i * k + dst] = cols[src]![i]! / sv[src]!;
  });
  return { u, s, v };
}

/** The unit vector x minimising ‖Ax‖ (the right singular vector of the smallest singular value). */
export function nullVector(a: Mat): Float64Array {
  const { v } = svd(a);
  return v.col(a.cols - 1);
}

/** Symmetric eigendecomposition A = V diag(values) Vᵀ, values ascending, by cyclic Jacobi. */
export function symEig(a: Mat, options: { maxSweeps?: number } = {}): { values: Float64Array; vectors: Mat } {
  const n = a.rows;
  const A = a.data.slice();
  const V = Mat.identity(n).data;
  const maxSweeps = options.maxSweeps ?? 100;
  for (let sweep = 0; sweep < maxSweeps; sweep += 1) {
    let off = 0;
    let diag = 0;
    for (let i = 0; i < n; i += 1) {
      diag += A[i * n + i]! * A[i * n + i]!;
      for (let j = i + 1; j < n; j += 1) off += A[i * n + j]! * A[i * n + j]!;
    }
    if (off <= 1e-30 * Math.max(diag, 1e-300)) break;
    for (let p = 0; p < n - 1; p += 1) {
      for (let q = p + 1; q < n; q += 1) {
        const apq = A[p * n + q]!;
        if (apq === 0) continue;
        const app = A[p * n + p]!;
        const aqq = A[q * n + q]!;
        const theta = (aqq - app) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k += 1) {
          const akp = A[k * n + p]!;
          const akq = A[k * n + q]!;
          A[k * n + p] = c * akp - s * akq;
          A[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k += 1) {
          const apk = A[p * n + k]!;
          const aqk = A[q * n + k]!;
          A[p * n + k] = c * apk - s * aqk;
          A[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k += 1) {
          const vkp = V[k * n + p]!;
          const vkq = V[k * n + q]!;
          V[k * n + p] = c * vkp - s * vkq;
          V[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const vals = Array.from({ length: n }, (_, i) => A[i * n + i]!);
  const order = vals.map((_, i) => i).sort((x, y) => vals[x]! - vals[y]!);
  const values = new Float64Array(n);
  const vectors = new Mat(n, n);
  order.forEach((src, dst) => {
    values[dst] = vals[src]!;
    for (let k = 0; k < n; k += 1) vectors.data[k * n + dst] = V[k * n + src]!;
  });
  return { values, vectors };
}

// ---------------------------------------------------------------------------
// 3×3 helpers on plain arrays (row-major, length 9) — the solver's hot paths
// ---------------------------------------------------------------------------

export type M3 = Float64Array | number[];
export type V3 = Float64Array | number[];

export const I3 = (): number[] => [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mul3(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const o = new Array<number>(9);
  for (let i = 0; i < 3; i += 1)
    for (let j = 0; j < 3; j += 1) o[i * 3 + j] = a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!;
  return o;
}

export function t3(a: ArrayLike<number>): number[] {
  return [a[0]!, a[3]!, a[6]!, a[1]!, a[4]!, a[7]!, a[2]!, a[5]!, a[8]!];
}

export function mulv3(a: ArrayLike<number>, v: ArrayLike<number>): number[] {
  return [a[0]! * v[0]! + a[1]! * v[1]! + a[2]! * v[2]!, a[3]! * v[0]! + a[4]! * v[1]! + a[5]! * v[2]!, a[6]! * v[0]! + a[7]! * v[1]! + a[8]! * v[2]!];
}

export function det3(a: ArrayLike<number>): number {
  return a[0]! * (a[4]! * a[8]! - a[5]! * a[7]!) - a[1]! * (a[3]! * a[8]! - a[5]! * a[6]!) + a[2]! * (a[3]! * a[7]! - a[4]! * a[6]!);
}

export function inv3(a: ArrayLike<number>): number[] | null {
  const d = det3(a);
  if (!Number.isFinite(d) || Math.abs(d) < 1e-300) return null;
  const k = 1 / d;
  return [
    (a[4]! * a[8]! - a[5]! * a[7]!) * k,
    (a[2]! * a[7]! - a[1]! * a[8]!) * k,
    (a[1]! * a[5]! - a[2]! * a[4]!) * k,
    (a[5]! * a[6]! - a[3]! * a[8]!) * k,
    (a[0]! * a[8]! - a[2]! * a[6]!) * k,
    (a[2]! * a[3]! - a[0]! * a[5]!) * k,
    (a[3]! * a[7]! - a[4]! * a[6]!) * k,
    (a[1]! * a[6]! - a[0]! * a[7]!) * k,
    (a[0]! * a[4]! - a[1]! * a[3]!) * k,
  ];
}

/** Inverse of a symmetric positive (semi)definite 3×3 with a ridge for safety. */
export function invSym3(a: ArrayLike<number>, ridge = 0): number[] | null {
  const m = [a[0]! + ridge, a[1]!, a[2]!, a[3]!, a[4]! + ridge, a[5]!, a[6]!, a[7]!, a[8]! + ridge];
  return inv3(m);
}

export function cross(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  return [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
}

export function sub3(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  return [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
}

export function add3(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  return [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
}

export function scale3(a: ArrayLike<number>, k: number): number[] {
  return [a[0]! * k, a[1]! * k, a[2]! * k];
}

export function norm3(a: ArrayLike<number>): number {
  return Math.hypot(a[0]!, a[1]!, a[2]!);
}

export function normalize3(a: ArrayLike<number>): number[] {
  const n = norm3(a) || 1;
  return [a[0]! / n, a[1]! / n, a[2]! / n];
}

/** 3×3 SVD through the 3×3 Mat path (small, used for essential/rotation projections). */
export function svd3(a: ArrayLike<number>): { u: number[]; s: number[]; v: number[] } {
  const r = svd(new Mat(3, 3, Float64Array.from(a as ArrayLike<number>)));
  // Complete U when a singular value is zero (u column left 0).
  const u = Array.from(r.u.data);
  for (let j = 0; j < 3; j += 1) {
    if (Math.hypot(u[j]!, u[3 + j]!, u[6 + j]!) > 0.5) continue;
    const others = [0, 1, 2].filter((x) => x !== j && Math.hypot(u[x]!, u[3 + x]!, u[6 + x]!) > 0.5);
    let c: number[];
    if (others.length === 2) c = cross([u[others[0]!]!, u[3 + others[0]!]!, u[6 + others[0]!]!], [u[others[1]!]!, u[3 + others[1]!]!, u[6 + others[1]!]!]);
    else c = [1, 0, 0];
    const cn = normalize3(c);
    u[j] = cn[0]!;
    u[3 + j] = cn[1]!;
    u[6 + j] = cn[2]!;
  }
  return { u, s: Array.from(r.s), v: Array.from(r.v.data) };
}

/** The nearest rotation (polar decomposition by SVD), det +1. */
export function nearestRotation(a: ArrayLike<number>): number[] {
  const { u, v } = svd3(a);
  let r = mul3(u, t3(v));
  if (det3(r) < 0) {
    const u2 = [...u];
    u2[2] = -u2[2]!;
    u2[5] = -u2[5]!;
    u2[8] = -u2[8]!;
    r = mul3(u2, t3(v));
  }
  return r;
}

/** Median of numbers (copy). */
export function median(values: ArrayLike<number>): number {
  const n = values.length;
  if (!n) return 0;
  const s = Float64Array.from(values as ArrayLike<number>).sort();
  return n % 2 ? s[n >> 1]! : (s[(n >> 1) - 1]! + s[n >> 1]!) / 2;
}

/** Gaussian random numbers (Box–Muller) from a uniform source. */
export function gaussian(rand: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = 0;
    let v = 0;
    while (u <= 1e-12) u = rand();
    v = rand();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}
