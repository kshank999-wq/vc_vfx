import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { crc32c, downsampleTo, formatFromName, LidarError, parseE57, parsePointFile, voxelDownsample, type PointCloud } from '../camera/lidar';
import { applySim, estimateNormals, icpPointToPlane, PointGrid, umeyama } from '../camera/align';
import { rodrigues } from '../camera/geometry';
import { roomScene, sampleSurface } from '../camera/render';
import { rng } from '../camera/synthetic';

/**
 * LiDAR / survey import (addendum 06 §5). The fixtures were written by
 * independent implementations — pye57 (libE57Format) for E57, laspy for LAS,
 * plain Python per spec for the text formats and PLY (scripts/make-lidar-
 * fixtures.py) — so a shared misreading of a format cannot pass unnoticed.
 */

const dir = join(__dirname, 'fixtures', 'lidar');
const truth = JSON.parse(readFileSync(join(dir, 'truth.json'), 'utf8')) as { points: number[][]; colors: number[][] };
const read = (name: string) => new Uint8Array(readFileSync(join(dir, name)));
const abs = (c: PointCloud, i: number) => [c.positions[3 * i]! + c.origin[0], c.positions[3 * i + 1]! + c.origin[1], c.positions[3 * i + 2]! + c.origin[2]];

function expectSame(c: PointCloud, colours: boolean, tol = 0.0011) {
  expect(c.count).toBe(truth.points.length);
  // Float32 relative to a nearby origin: sub-millimetre at survey coordinates.
  for (let i = 0; i < c.count; i += 1) {
    const p = abs(c, i);
    for (let k = 0; k < 3; k += 1) expect(Math.abs(p[k]! - truth.points[i]![k]!)).toBeLessThan(tol);
  }
  if (colours) {
    expect(c.colors).not.toBeNull();
    for (let i = 0; i < c.count; i += 37) for (let k = 0; k < 3; k += 1) expect(Math.abs(c.colors![3 * i + k]! - truth.colors[i]![k]!)).toBeLessThanOrEqual(1);
  }
}

describe('point cloud import', () => {
  it('PLY ascii, binary little- and big-endian (faces after the vertices skipped)', () => {
    for (const f of ['scan_ascii.ply', 'scan_le.ply', 'scan_be.ply']) {
      const c = parsePointFile(read(f), 'ply');
      expectSame(c, true);
      expect(c.notes.join(' ')).toMatch(/faces ignored/);
    }
  });

  it('OBJ vertices, XYZ and PTS text, survey CSV with names', () => {
    expectSame(parsePointFile(read('mesh.obj'), 'obj'), false);
    expectSame(parsePointFile(read('scan.xyz'), 'xyz'), true);
    expectSame(parsePointFile(read('scan.pts'), 'pts'), true);
    const s = parsePointFile(read('survey.csv'), 'csv');
    expect(s.named).toHaveLength(12);
    expect(s.named[3]!.name).toBe('CP04');
    for (let k = 0; k < 3; k += 1) expect(s.named[3]!.X[k]).toBeCloseTo(truth.points[3]![k]!, 6);
  });

  it('LAS 1.2 point format 2 (16-bit RGB) and LAS 1.4 point format 0 from laspy', () => {
    const a = parsePointFile(read('scan_12_f2.las'), 'las');
    expectSame(a, true);
    expect(a.notes[0]).toMatch(/LAS 1\.2, point format 2/);
    const b = parsePointFile(read('scan_14_f0.las'), 'las');
    expectSame(b, false);
    expect(b.notes[0]).toMatch(/LAS 1\.4, point format 0/);
  });

  it('E57 from libE57Format: float coordinates with a scan pose, and scaled-integer coordinates', () => {
    const posed = parseE57(read('scan_pose.e57'));
    expectSame(posed, true, 0.0015);
    const scaled = parseE57(read('scan_scaled.e57'));
    expect(scaled.count).toBe(600);
    // No pose in that one: coordinates relative to the survey offset.
    const off = [512345, 6789012, 120];
    for (let i = 0; i < 600; i += 1) {
      const p = abs(scaled, i);
      for (let k = 0; k < 3; k += 1) expect(Math.abs(p[k]! + off[k]! - truth.points[i]![k]!)).toBeLessThan(0.0011);
    }
  });

  it('E57 pages are CRC-32C checked: a flipped byte is refused', () => {
    expect(crc32c(new TextEncoder().encode('123456789'))).toBe(0xe3069283); // the standard check value
    const bytes = read('scan_pose.e57');
    bytes[2000] = bytes[2000]! ^ 0xff;
    expect(() => parseE57(bytes)).toThrow(/CRC-32C/);
    expect(() => parsePointFile(new TextEncoder().encode('hello'), 'e57')).toThrow(LidarError);
    expect(formatFromName('Alley_Scan.E57')).toBe('e57');
  });

  it('voxel downsampling keeps one averaged point per voxel and reaches a target', () => {
    const c = parsePointFile(read('scan_le.ply'), 'ply');
    const d = voxelDownsample(c, 1);
    expect(d.count).toBeLessThan(c.count);
    expect(d.count).toBeGreaterThan(20);
    const big = sampleSurface(roomScene(1), 0.05);
    const cloud: PointCloud = { positions: big.points, colors: big.colors, origin: [0, 0, 0], count: big.points.length / 3, named: [], bbox: { min: [-9, -6, 2], max: [9, 2, 28] }, notes: [] };
    const t = downsampleTo(cloud, 20000);
    expect(t.cloud.count).toBeGreaterThan(20000 / 3);
    expect(t.cloud.count).toBeLessThan(20000 * 1.5);
  });
});

describe('alignment to a cloud', () => {
  const quads = roomScene(2);
  const scan = sampleSurface(quads, 0.12, 3);
  const cloud = scan.points;

  it('Umeyama finds scale, rotation and translation from three or more correspondences', () => {
    const T = { s: 0.37, R: rodrigues([0.1, 1.2, -0.3]), t: [5, -2, 40] };
    const src = [cloud.slice(0, 3), cloud.slice(3000, 3003), cloud.slice(9000, 9003), cloud.slice(15000, 15003)].flatMap((p) => Array.from(p));
    const dst = [];
    for (let i = 0; i < 4; i += 1) dst.push(...applySim(T, src.slice(3 * i, 3 * i + 3)));
    const u = umeyama(src, dst);
    expect(u.s).toBeCloseTo(0.37, 8);
    expect(u.rms).toBeLessThan(1e-8);
  });

  it('point-to-plane ICP pulls a slightly wrong alignment onto the surface', () => {
    // "Track points": a sparse subset of the surface, misaligned by 2° and 15 cm (and 2 % in scale).
    const r = rng(4);
    const pts: number[] = [];
    for (let i = 0; i < 400; i += 1) {
      const k = Math.floor(r() * (cloud.length / 3));
      pts.push(cloud[3 * k]!, cloud[3 * k + 1]!, cloud[3 * k + 2]!);
    }
    const truthT = { s: 1, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
    const wrong = { s: 1.02, R: rodrigues([0, (2 * Math.PI) / 180, 0]), t: [0.15, -0.05, 0.1] };
    const grid = new PointGrid(cloud);
    const normals = estimateNormals(cloud, 10, grid);
    const res = icpPointToPlane(pts, cloud, normals, wrong, { maxDistance: 1.5, iterations: 40, allowScale: true, grid });
    // Applied to the points, the result is back on the truth (within a few mm over a ~20 m set).
    let worst = 0;
    for (let i = 0; i < 400; i += 1) {
      const p = pts.slice(3 * i, 3 * i + 3);
      const a = applySim(res.transform, p);
      const b = applySim(truthT, p);
      worst = Math.max(worst, Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!));
    }
    expect(worst).toBeLessThan(0.03);
    expect(res.rms).toBeLessThan(0.01);
  }, 20_000);
});
