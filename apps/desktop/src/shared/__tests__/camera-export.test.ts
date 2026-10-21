import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rotationFromEuler, rotX, rotY, rotZ, type EulerOrder } from '../camera/geometry';
import { mul3, mulv3, t3 } from '../camera/linalg';
import { YUP_TO_ZUP, type SceneCamera } from '../camera/coords';
import {
  AE_SCALE,
  FBX_KTIME_PER_SECOND,
  writeAfterEffects,
  writeBlender,
  writeCameraJson,
  writeChan,
  writeFbx,
  writeMax,
  writeMaya,
  writeNuke,
  writePointsObj,
  type CameraExportData,
} from '../camera/export-formats';
import { encodeExrFloat, redistortMap, sampleSTMap, stmapExr, undistortMap } from '../camera/stmap';
import { distort, undistort, type Intrinsics } from '../camera/geometry';

/**
 * Every camera writer gets the same known move (addendum 06 §6); the test
 * parses each file back and checks the numbers come out as went in: position
 * per frame, rotation (recomposed with the application's own rotation order
 * and axes), focal length and film back. Syntax-level checks only — no
 * application opened these files here.
 */

const FRAMES = 30;
function knownMove(): CameraExportData {
  const cameras: SceneCamera[] = [];
  for (let i = 0; i < FRAMES; i += 1) {
    const s = i / (FRAMES - 1);
    // Pan through ±170° on purpose: the curves must unwrap rather than jump.
    const R = mul3(rotY((-170 + 340 * s) * (Math.PI / 180)), mul3(rotX((10 * Math.sin(3 * s)) * (Math.PI / 180)), rotZ((4 * s - 2) * (Math.PI / 180))));
    cameras.push({ frame: 1001 + i, position: [2 * s - 1, 1.6 + 0.1 * Math.sin(5 * s), 4 - 3 * s], rotation: R });
  }
  return {
    shot: '020_010',
    version: 1,
    generator: 'VC VFX test',
    writtenAt: '2026-10-20T12:00:00.000Z',
    fps: 24,
    width: 1920,
    height: 1080,
    filmBackMm: { width: 24.88, height: 13.99 },
    nominalFilmBack: false,
    focalMm: 32,
    focalPx: (32 * 1920) / 24.88,
    principalOffsetPx: { x: 0, y: 0 },
    distortion: { k1: -0.05, k2: 0.01, k3: 0, p1: 0, p2: 0 },
    units: 'm',
    upAxis: 'y',
    cameras,
    points: [
      { id: 7, position: [1, 0, -5], error: 0.4 },
      { id: 12, position: [-2, 0.5, -8], error: 0.6 },
    ],
    solve: { number: 3, rms: 0.48, frames: FRAMES, engine: 'vcvfx-ts@1.0.0', nodal: false, confidence: 0.95, warnings: [] },
    files: { obj: '020_010_camtrack_v001_points.obj', undistort: '020_010_camtrack_v001_undistort.exr', redistort: '020_010_camtrack_v001_redistort.exr' },
  };
}

const rad = (d: number) => (d * Math.PI) / 180;
const expectRot = (a: number[], b: ArrayLike<number>) => a.forEach((v, i) => expect(Math.abs(v - b[i]!)).toBeLessThan(2e-5));
const expectVec = (a: ArrayLike<number>, b: ArrayLike<number>, tol = 2e-5) => {
  for (let i = 0; i < b.length; i += 1) expect(Math.abs(a[i]! - b[i]!)).toBeLessThan(tol);
};
const balanced = (s: string, open = '{', close = '}') => {
  let d = 0;
  for (const ch of s) {
    if (ch === open) d += 1;
    if (ch === close) d -= 1;
    if (d < 0) return false;
  }
  return d === 0;
};
const maxJump = (v: number[]) => v.slice(1).reduce((m, x, i) => Math.max(m, Math.abs(x - v[i]!)), 0);

describe('camera exports round-trip a known move', () => {
  const d = knownMove();

  it('Nuke: Camera2 curves in ZXY, focal, apertures, the track OBJ and STMaps referenced', () => {
    const nk = writeNuke(d);
    expect(balanced(nk)).toBe(true);
    expect(nk).toMatch(/^#! nuke file/);
    expect(nk).toMatch(/Camera2 \{[\s\S]*rot_order ZXY/);
    expect(nk).toContain(' focal 32\n');
    expect(nk).toContain(' haperture 24.88\n');
    expect(nk).toMatch(/vaperture 13\.995/);
    expect(nk).toContain(d.files.obj);
    expect(nk).toContain(d.files.redistort!);
    const curves = [...nk.matchAll(/\{curve x(\d+) ([^}]*)\}/g)].map((m) => ({ start: Number(m[1]), values: m[2]!.trim().split(/\s+/).map(Number) }));
    expect(curves).toHaveLength(6);
    for (const c of curves) {
      expect(c.start).toBe(1001);
      expect(c.values).toHaveLength(FRAMES);
    }
    expect(maxJump(curves[4]!.values)).toBeLessThan(20); // ry unwrapped through ±180
    d.cameras.forEach((cam, i) => {
      expectVec([curves[0]!.values[i]!, curves[1]!.values[i]!, curves[2]!.values[i]!], cam.position);
      expectRot(rotationFromEuler({ x: rad(curves[3]!.values[i]!), y: rad(curves[4]!.values[i]!), z: rad(curves[5]!.values[i]!) }, 'ZXY'), cam.rotation);
    });
  });

  it('Maya: keyed transform in xyz order, focal length and film back in inches, locators', () => {
    const ma = writeMaya(d);
    expect(ma).toMatch(/^\/\/Maya ASCII/);
    expect(ma).toContain('currentUnit -l meter -a degree -t film;');
    expect(ma).toMatch(/setAttr "\.fl" 32;/);
    const cap = /setAttr "\.cap" -type "double2" ([\d.]+) ([\d.]+) ;/.exec(ma)!;
    expect(Number(cap[1])).toBeCloseTo(24.88 / 25.4, 6);
    const ktv = (attr: string) => {
      const m = new RegExp(`createNode animCurveT[LA] -n "[^"]*_${attr}";[\\s\\S]*?setAttr -s (\\d+) "\\.ktv\\[0:(\\d+)\\]"  ([^;]*);`).exec(ma)!;
      const nums = m[3]!.trim().split(/\s+/).map(Number);
      expect(Number(m[1])).toBe(FRAMES);
      return nums.filter((_, i) => i % 2 === 1);
    };
    const [tx, ty, tz, rx, ry, rz] = ['translateX', 'translateY', 'translateZ', 'rotateX', 'rotateY', 'rotateZ'].map(ktv) as number[][];
    d.cameras.forEach((cam, i) => {
      expectVec([tx![i]!, ty![i]!, tz![i]!], cam.position);
      expectRot(rotationFromEuler({ x: rad(rx![i]!), y: rad(ry![i]!), z: rad(rz![i]!) }, 'XYZ'), cam.rotation);
    });
    expect(ma.match(/createNode locator/g)).toHaveLength(2);
    expect(ma.match(/connectAttr/g)).toHaveLength(6);
    // Every connected node exists.
    for (const m of ma.matchAll(/connectAttr "([^".]+)\.o" "([^".]+)\./g)) {
      expect(ma).toContain(`-n "${m[1]}"`);
      expect(ma).toContain(`-n "${m[2]}"`);
    }
  });

  it('Blender: Z-up metres, XYZ Euler in radians, lens and sensor', () => {
    const py = writeBlender(d);
    const arr = (name: string) => JSON.parse(`[${new RegExp(`^${name} = \\[([^\\]]*)\\]`, 'm').exec(py)![1]}]`) as number[];
    const frames = arr('FRAMES');
    const loc = arr('LOCATIONS');
    const rot = arr('ROTATIONS');
    expect(frames).toHaveLength(FRAMES);
    expect(py).toContain('data.lens = 32');
    expect(py).toContain('data.sensor_width = 24.88');
    expect(py).toContain("data.sensor_fit = 'HORIZONTAL'");
    d.cameras.forEach((cam, i) => {
      expectVec(loc.slice(3 * i, 3 * i + 3), mulv3(YUP_TO_ZUP, cam.position));
      expectRot(rotationFromEuler({ x: rot[3 * i]!, y: rot[3 * i + 1]!, z: rot[3 * i + 2]! }, 'XYZ'), mul3(YUP_TO_ZUP, cam.rotation));
    });
    // Python syntax is checked by running it under Python when one is available (no bpy needed for parse).
    const python = spawnSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: py });
    if (python.status !== null && !python.error) expect(python.status).toBe(0);
  });

  it('After Effects: pixels, Y down, Orientation applied Z then Y then X, zoom from the film back', () => {
    const jsx = writeAfterEffects(d);
    expect(balanced(jsx)).toBe(true);
    expect(balanced(jsx, '(', ')')).toBe(true);
    const zoom = Number(/ADBE Camera Zoom"\)\.setValue\(([\d.]+)/.exec(jsx)![1]);
    expect(zoom).toBeCloseTo((32 * 1920) / 24.88, 2);
    const pos = JSON.parse(/var pos = (\[\[.*?\]\]);/.exec(jsx)![1]!) as number[][];
    const ori = JSON.parse(/var ori = (\[\[.*?\]\]);/.exec(jsx)![1]!) as number[][];
    const F = [1, 0, 0, 0, -1, 0, 0, 0, -1];
    d.cameras.forEach((cam, i) => {
      expectVec(pos[i]!, [cam.position[0] * AE_SCALE + 960, -cam.position[1] * AE_SCALE + 540, -cam.position[2] * AE_SCALE], 1e-3);
      const R = rotationFromEuler({ x: rad(ori[i]![0]!), y: rad(ori[i]![1]!), z: rad(ori[i]![2]!) }, 'ZYX');
      expectRot(mul3(mul3(F, R), F), cam.rotation);
    });
    // ExtendScript is ES3-era JavaScript: it must at least parse as JavaScript.
    expect(() => new Function('app', 'AutoOrientType', 'CompItem', jsx)).not.toThrow();
  });

  it('3ds Max: Z-up matrix3 keys and the horizontal FOV', () => {
    const ms = writeMax(d);
    expect(balanced(ms, '(', ')')).toBe(true);
    const fov = Number(/cam\.fov = ([\d.]+)/.exec(ms)![1]);
    expect(fov).toBeCloseTo((2 * Math.atan(24.88 / 64) * 180) / Math.PI, 4);
    const keys = [...ms.matchAll(/at time (\d+) cam\.transform = \(matrix3 \[([^\]]*)\] \[([^\]]*)\] \[([^\]]*)\] \[([^\]]*)\]\)/g)];
    expect(keys).toHaveLength(FRAMES);
    keys.forEach((k, i) => {
      const r = [k[2], k[3], k[4]].map((s) => s!.split(',').map(Number)) as number[][];
      const R = [r[0]![0]!, r[1]![0]!, r[2]![0]!, r[0]![1]!, r[1]![1]!, r[2]![1]!, r[0]![2]!, r[1]![2]!, r[2]![2]!];
      expectRot(R, mul3(YUP_TO_ZUP, d.cameras[i]!.rotation));
      expectVec(k[5]!.split(',').map(Number), mulv3(YUP_TO_ZUP, d.cameras[i]!.position));
    });
  });

  it('FBX ASCII 7.4: balanced, counts agree, connections resolve, curves recompose', () => {
    const fbx = writeFbx(d);
    expect(fbx.startsWith('; FBX 7.4.0 project file')).toBe(true);
    expect(balanced(fbx)).toBe(true);
    expect(fbx).toContain('FBXVersion: 7400');
    const ids = new Set([...fbx.matchAll(/^\t(?:NodeAttribute|Model|AnimationStack|AnimationLayer|AnimationCurveNode|AnimationCurve): (\d+),/gm)].map((m) => m[1]!));
    for (const m of fbx.matchAll(/C: "O[OP]",(\d+),(\d+)/g)) {
      expect(ids.has(m[1]!)).toBe(true);
      if (m[2] !== '0') expect(ids.has(m[2]!)).toBe(true);
    }
    // Definitions match the objects.
    for (const [type, n] of [
      ['Model', 1],
      ['NodeAttribute', 1],
      ['AnimationCurveNode', 2],
      ['AnimationCurve', 6],
    ] as const) {
      expect(Number(new RegExp(`ObjectType: "${type}" \\{\\s*Count: (\\d+)`).exec(fbx)![1])).toBe(n);
      expect([...fbx.matchAll(new RegExp(`^\\t${type}: \\d+,`, 'gm'))]).toHaveLength(n);
    }
    const curves = [...fbx.matchAll(/KeyTime: \*(\d+) \{\s*a: ([^}]*)\}\s*KeyValueFloat: \*(\d+) \{\s*a: ([^}]*)\}/g)].map((m) => {
      const t = m[2]!.trim().split(',').map(Number);
      const v = m[4]!.trim().split(',').map(Number);
      expect(t).toHaveLength(Number(m[1]));
      expect(v).toHaveLength(Number(m[3]));
      return { t, v };
    });
    expect(curves).toHaveLength(6);
    expect(curves[0]!.t[0]).toBe(Math.round((1001 / 24) * FBX_KTIME_PER_SECOND));
    const AX = [0, 0, 1, 0, 1, 0, -1, 0, 0];
    d.cameras.forEach((cam, i) => {
      expectVec([curves[0]!.v[i]!, curves[1]!.v[i]!, curves[2]!.v[i]!], cam.position);
      const Rn = rotationFromEuler({ x: rad(curves[3]!.v[i]!), y: rad(curves[4]!.v[i]!), z: rad(curves[5]!.v[i]!) }, 'XYZ');
      expectRot(mul3(Rn, t3(AX)), cam.rotation);
    });
  });

  it('.chan, JSON and OBJ carry the same numbers', () => {
    const chan = writeChan(d).trim().split('\n').map((l) => l.split('\t').map(Number));
    expect(chan).toHaveLength(FRAMES);
    chan.forEach((r, i) => {
      expect(r[0]).toBe(1001 + i);
      expectVec(r.slice(1, 4), d.cameras[i]!.position);
      expectRot(rotationFromEuler({ x: rad(r[4]!), y: rad(r[5]!), z: rad(r[6]!) }, 'ZXY'), d.cameras[i]!.rotation);
      expect(r[7]).toBeCloseTo((2 * Math.atan((24.88 * 1080) / 1920 / 64) * 180) / Math.PI, 4);
    });
    const json = JSON.parse(writeCameraJson(d));
    expect(json.format).toBe('vcvfx.camera/1');
    expect(json.lens.focalMm).toBe(32);
    expect(json.lens.distortion.k1).toBe(-0.05);
    expect(json.cameras).toHaveLength(FRAMES);
    expectVec(json.cameras[5].position, d.cameras[5]!.position);
    const zup = JSON.parse(writeCameraJson({ ...d, upAxis: 'z' }));
    expectVec(zup.cameras[5].position, mulv3(YUP_TO_ZUP, d.cameras[5]!.position));
    const obj = writePointsObj(d);
    expect(obj.match(/^v /gm)).toHaveLength(2);
  });

  it('Euler orders: each writer’s convention is the documented one', () => {
    // Nuke ZXY = Ry·Rx·Rz; Maya/Blender/FBX XYZ = Rz·Ry·Rx; AE orientation ZYX = Rx·Ry·Rz.
    const a = { x: 0.2, y: -0.3, z: 0.4 };
    const check = (o: EulerOrder, expected: number[]) => expectRot(rotationFromEuler(a, o), expected);
    check('ZXY', mul3(rotY(a.y), mul3(rotX(a.x), rotZ(a.z))));
    check('XYZ', mul3(rotZ(a.z), mul3(rotY(a.y), rotX(a.x))));
    check('ZYX', mul3(rotX(a.x), mul3(rotY(a.y), rotZ(a.z))));
  });
});

describe('STMaps', () => {
  const k: Intrinsics = { f: 1100, cx: 319.5, cy: 179.5, k1: -0.12, k2: 0.03, k3: 0, p1: 0.0005, p2: -0.0004 };

  it('undistort and redistort maps invert each other and match the lens model', () => {
    const W = 640;
    const H = 360;
    const und = undistortMap(k, W, H);
    const red = redistortMap(k, W, H);
    for (const [x, y] of [
      [10, 10],
      [600, 30],
      [320, 180],
      [100, 300],
    ] as const) {
      // undistort map at output (x, y) samples the distorted plate where the model puts that ray.
      const [px, py] = sampleSTMap(und, x, y);
      const [xd, yd] = distort(k, (x - k.cx) / k.f, (y - k.cy) / k.f);
      expect(px).toBeCloseTo(k.f * xd + k.cx, 3);
      expect(py).toBeCloseTo(k.f * yd + k.cy, 3);
      const [qx, qy] = sampleSTMap(red, x, y);
      const [xu, yu] = undistort(k, (x - k.cx) / k.f, (y - k.cy) / k.f);
      expect(qx).toBeCloseTo(k.f * xu + k.cx, 3);
      expect(qy).toBeCloseTo(k.f * yu + k.cy, 3);
    }
  });

  it('writes an OpenEXR that ffmpeg decodes to the same float values', () => {
    const ffmpeg = spawnSync('ffmpeg', ['-version']);
    if (ffmpeg.error || ffmpeg.status !== 0) return; // no ffmpeg on this machine
    const W = 64;
    const H = 36;
    const m = undistortMap({ ...k, f: 110, cx: 31.5, cy: 17.5 }, W, H);
    const dir = mkdtempSync(join(tmpdir(), 'vcvfx-exr-'));
    const file = join(dir, 'map.exr');
    writeFileSync(file, stmapExr(m));
    const out = join(dir, 'map.raw');
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'gbrpf32le', out]);
    expect(r.status, r.stderr?.toString()).toBe(0);
    const raw = readFileSync(out);
    const plane = (p: number) => new Float32Array(raw.buffer.slice(raw.byteOffset + p * W * H * 4, raw.byteOffset + (p + 1) * W * H * 4));
    // gbrp plane order: G, B, R
    const G = plane(0);
    const R = plane(2);
    for (let i = 0; i < W * H; i += 97) {
      expect(R[i]).toBeCloseTo(m.uv[2 * i]!, 6);
      expect(G[i]).toBeCloseTo(m.uv[2 * i + 1]!, 6);
    }
    expect(encodeExrFloat(2, 2, { Y: new Float32Array(4) }).length).toBeGreaterThan(100);
  });
});
