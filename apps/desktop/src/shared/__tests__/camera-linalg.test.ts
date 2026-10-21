import { describe, expect, it } from 'vitest';
import { EnvelopeMatrix, Mat, cholesky, choleskySolve, det3, gram, inv3, lstsq, matMul, matVec, nearestRotation, nullVector, qr, solveLinear, svd, symEig, transpose, mul3, t3 } from '../camera/linalg';
import {
  distort,
  eulerFromRotation,
  logRotation,
  quatFromRotation,
  rodrigues,
  rotationDistance,
  rotationFromEuler,
  rotationFromQuat,
  slerpRotation,
  undistort,
  type EulerOrder,
  type Intrinsics,
} from '../camera/geometry';
import { rng } from '../camera/synthetic';

const rand = rng(42);
const randMat = (r: number, c: number) => new Mat(r, c, Float64Array.from({ length: r * c }, () => rand() * 2 - 1));
const close = (a: ArrayLike<number>, b: ArrayLike<number>, tol: number) => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i += 1) expect(Math.abs(a[i]! - b[i]!)).toBeLessThan(tol);
};

describe('dense linear algebra', () => {
  it('multiplies and transposes', () => {
    const a = Mat.fromRows([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    const b = Mat.fromRows([
      [7, 8],
      [9, 10],
      [11, 12],
    ]);
    expect(matMul(a, b).toRows()).toEqual([
      [58, 64],
      [139, 154],
    ]);
    expect(transpose(a).toRows()).toEqual([
      [1, 4],
      [2, 5],
      [3, 6],
    ]);
    expect(Array.from(matVec(a, [1, 1, 1]))).toEqual([6, 15]);
  });

  it('Cholesky solves SPD systems and refuses indefinite ones', () => {
    for (let trial = 0; trial < 5; trial += 1) {
      const m = randMat(12, 8);
      const A = gram(m);
      for (let i = 0; i < 8; i += 1) A.data[i * 9]! += 0.1;
      const x = Float64Array.from({ length: 8 }, () => rand());
      const b = matVec(A, x);
      const L = cholesky(A)!;
      close(choleskySolve(L, b), x, 1e-9);
    }
    expect(cholesky(Mat.fromRows([[1, 2], [2, 1]]))).toBeNull();
  });

  it('envelope Cholesky matches dense on a banded matrix with dense trailing rows', () => {
    const n = 60;
    const band = 9;
    const dense = new Mat(n, n);
    const first = new Int32Array(n);
    for (let i = 0; i < n; i += 1) first[i] = i >= n - 3 ? 0 : Math.max(0, i - band);
    // Random SPD inside that envelope: B Bᵀ restricted, plus diagonal dominance.
    for (let i = 0; i < n; i += 1)
      for (let j = first[i]!; j <= i; j += 1) {
        const v = i === j ? n + rand() : rand() - 0.5;
        dense.set(i, j, v);
        dense.set(j, i, v);
      }
    const env = new EnvelopeMatrix(first);
    for (let i = 0; i < n; i += 1) for (let j = first[i]!; j <= i; j += 1) env.add(i, j, dense.get(i, j));
    expect(env.size).toBeLessThan((n * (n + 1)) / 2);
    const x = Float64Array.from({ length: n }, () => rand() * 2 - 1);
    const b = matVec(dense, x);
    expect(env.factor()).toBe(true);
    close(env.solve(b), x, 1e-9);
    const direct = solveLinear(dense, b)!;
    close(direct, x, 1e-9);
  });

  it('QR factors and solves least squares', () => {
    const A = randMat(10, 4);
    const { q, r } = qr(A);
    close(matMul(q, r).data, A.data, 1e-12);
    close(matMul(transpose(q), q).data, Mat.identity(10).data, 1e-12);
    for (let i = 1; i < 10; i += 1) for (let j = 0; j < Math.min(i, 4); j += 1) expect(Math.abs(r.get(i, j))).toBeLessThan(1e-12);
    const x = [0.5, -1, 2, 0.25];
    const b = matVec(A, x);
    close(lstsq(A, b), x, 1e-10);
  });

  it('SVD reconstructs tall, wide and rank-deficient matrices and finds null vectors', () => {
    for (const [r, c] of [
      [7, 4],
      [4, 7],
      [9, 9],
      [8, 9],
    ] as const) {
      const A = randMat(r, c);
      const { u, s, v } = svd(A);
      const k = Math.min(r, c);
      const S = new Mat(k, c);
      for (let i = 0; i < k; i += 1) S.set(i, i, s[i]!);
      close(matMul(matMul(u, S), transpose(v)).data, A.data, 1e-10);
      for (let i = 1; i < s.length; i += 1) expect(s[i]!).toBeLessThanOrEqual(s[i - 1]! + 1e-12);
      close(matMul(transpose(v), v).data, Mat.identity(c).data, 1e-10);
    }
    // A 8×9 system has a null vector.
    const A = randMat(8, 9);
    const nv = nullVector(A);
    const Av = matVec(A, nv);
    for (const x of Av) expect(Math.abs(x)).toBeLessThan(1e-10);
    // Rank 2.
    const B = matMul(randMat(5, 2), randMat(2, 4));
    expect(svd(B).s[2]!).toBeLessThan(1e-12);
  });

  it('symmetric eigendecomposition', () => {
    const m = randMat(6, 6);
    const A = gram(m);
    const { values, vectors } = symEig(A);
    for (let k = 0; k < 6; k += 1) {
      const v = vectors.col(k);
      const Av = matVec(A, v);
      close(Av, v.map((x) => x * values[k]!), 1e-9);
      if (k) expect(values[k]!).toBeGreaterThanOrEqual(values[k - 1]! - 1e-12);
    }
  });

  it('3×3 helpers', () => {
    const a = [2, 1, 0, 0, 3, 1, 1, 0, 4];
    const ai = inv3(a)!;
    close(mul3(a, ai), [1, 0, 0, 0, 1, 0, 0, 0, 1], 1e-12);
    expect(det3(a)).toBeCloseTo(25, 12);
    const R = nearestRotation([1.01, 0.02, 0, -0.01, 0.99, 0.03, 0, -0.02, 1.02]);
    close(mul3(R, t3(R)), [1, 0, 0, 0, 1, 0, 0, 0, 1], 1e-12);
    expect(det3(R)).toBeCloseTo(1, 12);
  });
});

describe('rotations and lens geometry', () => {
  it('Rodrigues, log, quaternions and slerp agree', () => {
    for (let i = 0; i < 50; i += 1) {
      const w = [rand() * 4 - 2, rand() * 4 - 2, rand() * 4 - 2];
      const R = rodrigues(w);
      close(mul3(R, t3(R)), [1, 0, 0, 0, 1, 0, 0, 0, 1], 1e-12);
      close(rodrigues(logRotation(R)), R, 1e-9);
      close(rotationFromQuat(quatFromRotation(R)), R, 1e-9);
    }
    const A = rodrigues([0.1, 0.2, 0.3]);
    const B = rodrigues([0.5, -0.1, 0.2]);
    close(slerpRotation(A, B, 0), A, 1e-9);
    close(slerpRotation(A, B, 1), B, 1e-9);
    expect(rotationDistance(slerpRotation(A, B, 0.5), A)).toBeCloseTo(rotationDistance(A, B) / 2, 9);
  });

  it('Euler angles round-trip in every order, with the documented composition', () => {
    const orders: EulerOrder[] = ['XYZ', 'XZY', 'YXZ', 'YZX', 'ZXY', 'ZYX'];
    for (const order of orders) {
      for (let i = 0; i < 40; i += 1) {
        const ang = { x: (rand() - 0.5) * 3, y: (rand() - 0.5) * 2.6, z: (rand() - 0.5) * 3 };
        const R = rotationFromEuler(ang, order);
        const back = eulerFromRotation(R, order);
        close(rotationFromEuler(back, order), R, 1e-9);
      }
    }
    // 'ZXY' applies Z first: R = Ry · Rx · Rz.
    const a = { x: 0.3, y: -0.4, z: 0.7 };
    const R = rotationFromEuler(a, 'ZXY');
    const back = eulerFromRotation(R, 'ZXY');
    expect(back.x).toBeCloseTo(0.3, 10);
    expect(back.y).toBeCloseTo(-0.4, 10);
    expect(back.z).toBeCloseTo(0.7, 10);
  });

  it('undistort inverts distort (Brown–Conrady with tangential terms)', () => {
    const k: Intrinsics = { f: 1500, cx: 960, cy: 540, k1: -0.18, k2: 0.04, k3: -0.005, p1: 0.001, p2: -0.0008 };
    for (let i = 0; i < 200; i += 1) {
      const x = (rand() - 0.5) * 1.2;
      const y = (rand() - 0.5) * 0.7;
      const [xd, yd] = distort(k, x, y);
      const [ux, uy] = undistort(k, xd, yd);
      expect(Math.abs(ux - x)).toBeLessThan(1e-10);
      expect(Math.abs(uy - y)).toBeLessThan(1e-10);
    }
  });
});
