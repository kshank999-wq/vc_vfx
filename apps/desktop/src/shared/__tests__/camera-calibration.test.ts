import { describe, expect, it } from 'vitest';
import { boardPoints, calibrateZhang, checkerboardPdf, checkerboardPixels, detectCheckerboard, type TargetSpec } from '../camera/calibration';
import { distort, rodrigues, undistort, type Intrinsics } from '../camera/geometry';
import { mul3 } from '../camera/linalg';

/**
 * Lens calibration (addendum 06 §4): a plain checkerboard rendered through a
 * known distorted lens from several poses, detected and calibrated by
 * Zhang's method with LM refinement. The known lens must come back.
 */

const T: TargetSpec = { cols: 10, rows: 7, squareMm: 30, marginMm: 15 };
const W = 960;
const H = 540;
const lens: Intrinsics = { f: 900, cx: 483, cy: 268, k1: -0.21, k2: 0.06, k3: 0, p1: 0.0008, p2: -0.0005 };

function renderView(R: number[], t: number[]): Float32Array {
  // Inverse mapping: pixel → (undistorted) ray → board plane z = 0 → checker colour (3×3 supersampled).
  const img = new Float32Array(W * H);
  const Rt = [R[0]!, R[3]!, R[6]!, R[1]!, R[4]!, R[7]!, R[2]!, R[5]!, R[8]!];
  const C = [-(Rt[0]! * t[0]! + Rt[1]! * t[1]! + Rt[2]! * t[2]!), -(Rt[3]! * t[0]! + Rt[4]! * t[1]! + Rt[5]! * t[2]!), -(Rt[6]! * t[0]! + Rt[7]! * t[1]! + Rt[8]! * t[2]!)];
  const ss = 3;
  for (let y = 0; y < H; y += 1)
    for (let x = 0; x < W; x += 1) {
      let acc = 0;
      for (let j = 0; j < ss; j += 1)
        for (let i = 0; i < ss; i += 1) {
          const [xn, yn] = undistort(lens, (x + (i + 0.5) / ss - 0.5 - lens.cx) / lens.f, (y + (j + 0.5) / ss - 0.5 - lens.cy) / lens.f);
          const d = [Rt[0]! * xn + Rt[1]! * yn + Rt[2]!, Rt[3]! * xn + Rt[4]! * yn + Rt[5]!, Rt[6]! * xn + Rt[7]! * yn + Rt[8]!];
          if (Math.abs(d[2]!) < 1e-9) {
            acc += 0.5;
            continue;
          }
          const s = -C[2]! / d[2]!;
          const bx = C[0]! + s * d[0]! + T.marginMm;
          const by = C[1]! + s * d[1]! + T.marginMm;
          let v = 0.55; // background
          if (s > 0 && bx >= 0 && by >= 0 && bx < T.cols * T.squareMm + 2 * T.marginMm && by < T.rows * T.squareMm + 2 * T.marginMm) {
            const mx = bx - T.marginMm;
            const my = by - T.marginMm;
            v = mx >= 0 && my >= 0 && mx < T.cols * T.squareMm && my < T.rows * T.squareMm && (Math.floor(mx / T.squareMm) + Math.floor(my / T.squareMm)) % 2 === 0 ? 0.08 : 0.92;
          }
          acc += v;
        }
      img[y * W + x] = acc / (ss * ss);
    }
  return img;
}

describe('lens calibration from a checkerboard', () => {
  it('writes an exact-size PDF and a 300 dpi image of the board', () => {
    const pdf = new TextDecoder().decode(checkerboardPdf(T));
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
    // 10 × 30 mm + 2 × 15 mm = 330 mm = 935.433 pt wide.
    expect(pdf).toMatch(/MediaBox \[0 0 935\.433/);
    expect(pdf.match(/ re f/g)).toHaveLength(35);
    // The xref offsets point at the objects.
    const xref = Number(/startxref\n(\d+)/.exec(pdf)![1]);
    expect(pdf.slice(xref, xref + 4)).toBe('xref');
    const png = checkerboardPixels(T, 300);
    expect(png.width).toBe(Math.round((330 / 25.4) * 300));
  });

  it('detects the corners in order and recovers focal length, principal point and distortion', () => {
    const board = boardPoints(T);
    // Board centred at the origin of its plane, viewed from ~0.8 m with tilts.
    const views: [number, number][][] = [];
    // Tilted views, and views with the board pushed towards each corner of the frame (as a
    // calibration is shot: the distortion is measured where it is).
    const poses = [
      [0, 0, 0, 0, 0],
      [0.35, 0, 0, 0, 0],
      [-0.3, 0.2, 0.1, 0, 0],
      [0, 0.4, -0.05, 0, 0],
      [0.2, 0.25, 0.05, -150, -85],
      [-0.2, 0.25, -0.05, 150, -85],
      [0.2, -0.25, 0.05, -150, 85],
      [-0.2, -0.25, -0.05, 150, 85],
    ];
    for (const [ax, ay, az, sx, sy] of poses) {
      const R = rodrigues([ax!, ay!, az!]);
      // Camera looks at the board centre (150, 90 mm) from 650 mm.
      const centre = [(T.cols * T.squareMm) / 2, (T.rows * T.squareMm) / 2, 0];
      const Rc = R;
      const tc = [sx! - (Rc[0]! * centre[0]! + Rc[1]! * centre[1]!), sy! - (Rc[3]! * centre[0]! + Rc[4]! * centre[1]!), 650 - (Rc[6]! * centre[0]! + Rc[7]! * centre[1]!)];
      const img = renderView(Rc, tc);
      const det = detectCheckerboard(img, W, H, T);
      expect(det.reason).toBeNull();
      // Detected corners agree with the truth to a fraction of a pixel.
      let worst = 0;
      board.forEach((bp, i) => {
        const xc = Rc[0]! * bp[0] + Rc[1]! * bp[1] + tc[0]!;
        const yc = Rc[3]! * bp[0] + Rc[4]! * bp[1] + tc[1]!;
        const zc = Rc[6]! * bp[0] + Rc[7]! * bp[1] + tc[2]!;
        const [xd, yd] = distort(lens, xc / zc, yc / zc);
        const u = lens.f * xd + lens.cx;
        const v = lens.f * yd + lens.cy;
        worst = Math.max(worst, Math.hypot(det.corners![i]![0] - u, det.corners![i]![1] - v));
      });
      expect(worst).toBeLessThan(0.35);
      views.push(det.corners!);
    }
    const cal = calibrateZhang(board, views, { tangential: true });
    expect(cal.rms).toBeLessThan(0.15);
    expect(Math.abs(cal.fx - lens.f) / lens.f).toBeLessThan(0.005);
    expect(Math.abs(cal.fy - lens.f) / lens.f).toBeLessThan(0.005);
    expect(Math.abs(cal.cx - lens.cx)).toBeLessThan(3);
    expect(Math.abs(cal.cy - lens.cy)).toBeLessThan(3);
    expect(Math.abs(cal.k1 - lens.k1)).toBeLessThan(0.01);
    // The distortion where it matters, at the frame corner: < 0.5 px.
    const rc = Math.hypot(W / 2, H / 2) / lens.f;
    const radial = (k1: number, k2: number) => (1 + k1 * rc * rc + k2 * rc ** 4) * rc * lens.f;
    expect(Math.abs(radial(cal.k1, cal.k2) - radial(lens.k1, lens.k2))).toBeLessThan(0.5);
    void mul3;
  }, 60_000);
});
