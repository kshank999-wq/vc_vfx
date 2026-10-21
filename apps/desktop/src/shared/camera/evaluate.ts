import { mul3, nearestRotation, t3 } from './linalg';
import { rotationDistance } from './geometry';
import { applySim, umeyama, type Similarity } from './align';
import { centreOf } from './pose';
import type { SolveResult } from './solver';

/**
 * Compare a solve with ground truth after the best similarity (the solve's
 * world is only defined up to one): camera position error relative to the
 * scene's scale and rotation error in degrees, per solved frame.
 */
export interface PathError {
  /** Largest and RMS camera position error as a fraction of `sceneScale`. */
  maxPosition: number;
  rmsPosition: number;
  /** Largest and RMS camera rotation error, degrees. */
  maxRotationDeg: number;
  rmsRotationDeg: number;
  frames: number;
  alignment: Similarity;
}

export function comparePath(
  solve: SolveResult,
  truth: { R: number[]; C: number[] }[],
  sceneScale: number,
  options: { nodal?: boolean; points?: { truth: Map<number, number>; X: ArrayLike<number> } } = {},
): PathError {
  const solved = solve.frames.map((f, i) => ({ f, i })).filter(({ f }) => f.solved);
  let A: Similarity;
  if (options.nodal) {
    // Positions are all at the origin: align rotations only. R_true = R_s · Aᵀ ⇒ Aᵀ ≈ mean(R_sᵀ R_true).
    const M = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (const { f, i } of solved) {
      const d = mul3(t3(f.R), truth[i]!.R);
      for (let k = 0; k < 9; k += 1) M[k]! += d[k]!;
    }
    A = { s: 1, R: t3(nearestRotation(M)), t: [0, 0, 0] };
  } else {
    // Align on what defines the world best: the triangulated points with known truth when given
    // (camera centres alone are degenerate on a straight path), else the camera centres.
    const src: number[] = [];
    const dst: number[] = [];
    if (options.points) {
      for (const tr of solve.tracks) {
        const pi = options.points.truth.get(tr.id);
        if (pi === undefined || pi < 0 || !tr.X) continue;
        src.push(...tr.X);
        dst.push(options.points.X[3 * pi]!, options.points.X[3 * pi + 1]!, options.points.X[3 * pi + 2]!);
      }
    }
    if (src.length >= 9) {
      const u = umeyama(src, dst);
      A = { s: u.s, R: u.R, t: u.t };
    } else {
      // No point truth: the rotation from the cameras' orientations (well defined even on a
      // straight path), then scale and translation from the centres by least squares.
      const M = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      for (const { f, i } of solved) {
        const d = mul3(t3(f.R), truth[i]!.R);
        for (let k = 0; k < 9; k += 1) M[k]! += d[k]!;
      }
      const Rw = t3(nearestRotation(M));
      const cs = solved.map(({ f }) => applySim({ s: 1, R: Rw, t: [0, 0, 0] }, centreOf(f.R, f.t)));
      const ct = solved.map(({ i }) => truth[i]!.C);
      const ms = [0, 1, 2].map((k) => cs.reduce((a, c) => a + c[k]!, 0) / cs.length);
      const mt = [0, 1, 2].map((k) => ct.reduce((a, c) => a + c[k]!, 0) / ct.length);
      let num = 0;
      let den = 0;
      cs.forEach((c, j) => {
        for (let k = 0; k < 3; k += 1) {
          num += (c[k]! - ms[k]!) * (ct[j]![k]! - mt[k]!);
          den += (c[k]! - ms[k]!) ** 2;
        }
      });
      const sc = den > 0 ? num / den : 1;
      A = { s: sc, R: Rw, t: [mt[0]! - sc * ms[0]!, mt[1]! - sc * ms[1]!, mt[2]! - sc * ms[2]!] };
    }
  }
  let maxP = 0;
  let sP = 0;
  let maxR = 0;
  let sR = 0;
  for (const { f, i } of solved) {
    const C = applySim(A, centreOf(f.R, f.t));
    const T = truth[i]!;
    const e = Math.hypot(C[0]! - T.C[0]!, C[1]! - T.C[1]!, C[2]! - T.C[2]!) / sceneScale;
    const Rs = mul3(f.R, t3(A.R));
    const r = (rotationDistance(Rs, T.R) * 180) / Math.PI;
    maxP = Math.max(maxP, e);
    sP += e * e;
    maxR = Math.max(maxR, r);
    sR += r * r;
  }
  const n = Math.max(1, solved.length);
  return { maxPosition: maxP, rmsPosition: Math.sqrt(sP / n), maxRotationDeg: maxR, rmsRotationDeg: Math.sqrt(sR / n), frames: solved.length, alignment: A };
}

export function sceneScaleOf(points: ArrayLike<number>): number {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < points.length / 3; i += 1)
    for (let k = 0; k < 3; k += 1) {
      lo[k] = Math.min(lo[k]!, points[3 * i + k]!);
      hi[k] = Math.max(hi[k]!, points[3 * i + k]!);
    }
  return Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!);
}
