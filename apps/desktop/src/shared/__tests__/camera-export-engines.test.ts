import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mulv3 } from '../camera/linalg';
import { YUP_TO_ZUP, type SceneCamera } from '../camera/coords';
import { rotX, rotY, rotZ, rotationFromEuler } from '../camera/geometry';
import { mul3 } from '../camera/linalg';
import {
  SCENE_TO_UNREAL,
  frameRateRational,
  unrealAxes,
  usdLensValue,
  writeExportReadme,
  writeFusionComp,
  writeFusionSetting,
  writeHoudini,
  writeUnity,
  writeUnreal,
  writeUsda,
  type CameraExportData,
} from '../camera/export-formats';

/**
 * Unreal, Unity and USD exports (addendum 06 §6.2): a known move written and
 * the numbers parsed back — positions after each engine's axes and units,
 * rotation recomposed in the engine's convention, focal, filmback, frame
 * range. Structural checks only: none of these was opened in Unreal, Unity or
 * a USD library here.
 */

const N = 24;
function move(units: CameraExportData['units'] = 'm', upAxis: CameraExportData['upAxis'] = 'y', fps = 23.976): CameraExportData {
  const cameras: SceneCamera[] = [];
  for (let i = 0; i < N; i += 1) {
    const s = i / (N - 1);
    const R = mul3(rotY((-170 + 340 * s) * (Math.PI / 180)), mul3(rotX(12 * Math.sin(3 * s) * (Math.PI / 180)), rotZ((6 * s - 3) * (Math.PI / 180))));
    cameras.push({ frame: 1001 + i, position: [2 * s - 1, 1.6 + 0.1 * Math.sin(5 * s), 4 - 3 * s], rotation: R });
  }
  return {
    shot: '020_010',
    version: 2,
    generator: 'VC VFX test',
    writtenAt: '2026-10-21T12:00:00.000Z',
    fps,
    width: 1920,
    height: 1080,
    filmBackMm: { width: 35.9, height: 24 },
    nominalFilmBack: false,
    focalMm: 25.5,
    focalPx: (25.5 * 1920) / 35.9,
    principalOffsetPx: { x: 4, y: -2 },
    distortion: { k1: -0.03, k2: 0.004, k3: 0, p1: 0, p2: 0 },
    units,
    upAxis,
    cameras,
    points: [
      { id: 7, position: [1, 0, -5], error: 0.4 },
      { id: 12, position: [-2, 0.5, -8], error: 0.6 },
      { id: 40, position: [0.5, -1, -12], error: 0.2 },
    ],
    solve: { number: 1, rms: 0.31, frames: N, engine: 'vcvfx-ts@1.0.0', nodal: false, confidence: 1, warnings: [] },
    files: { obj: '020_010_camtrack_v002_points.obj' },
  };
}

const col = (R: number[], j: number) => [R[j]!, R[3 + j]!, R[6 + j]!];
const close = (a: ArrayLike<number>, b: ArrayLike<number>, tol: number) => {
  for (let i = 0; i < b.length; i += 1) expect(Math.abs(a[i]! - b[i]!)).toBeLessThan(tol);
};
const balanced = (s: string, open: string, closeCh: string) => {
  let d = 0;
  for (const ch of s) {
    if (ch === open) d += 1;
    else if (ch === closeCh) d -= 1;
    if (d < 0) return false;
  }
  return d === 0;
};
/** A Python list literal of numbers / lists → JSON. */
const pyValue = (src: string, name: string) => JSON.parse(new RegExp(`^${name} = (.*)$`, 'm').exec(src)![1]!.replace(/\(/g, '[').replace(/\)/g, ']'));
function writeTemp(texts: string[], ext: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'vcvfx-exp-'));
  return texts.map((t, i) => {
    const p = join(dir, `f${i}${ext}`);
    writeFileSync(p, t);
    return p;
  });
}
const csArray = (src: string, name: string) => new RegExp(`${name} = \\{ ([^}]*) \\}`).exec(src)![1]!.split(',').map((v) => Number(v.trim().replace(/f$/, '')));

describe('real-time engine and USD exports', () => {
  it('frame rates are exact rationals', () => {
    expect(frameRateRational(23.976)).toEqual([24000, 1001]);
    expect(frameRateRational(29.97)).toEqual([30000, 1001]);
    expect(frameRateRational(25)).toEqual([25, 1]);
  });

  it('Unreal: CineCamera keys in cm, Z-up left-handed, FRotator recomposes the camera, filmback, focal and 1001-based range', () => {
    const d = move('m');
    const py = writeUnreal(d);
    expect(py).toMatch(/^# 020_010_camtrack_v002: camera track for Unreal Engine 5\.x/);
    expect(py).toContain('import unreal');
    expect(py).toContain('unreal.CineCameraActor');
    expect(py).toContain('unreal.MovieScene3DTransformTrack');
    expect(py).toContain("set_property_name_and_path('Current Focal Length', 'CurrentFocalLength')");
    expect(balanced(py, '(', ')')).toBe(true);
    expect(balanced(py, '[', ']')).toBe(true);
    expect(pyValue(py, 'FPS')).toEqual([24000, 1001]);
    expect(py).toMatch(/^FIRST, LAST = 1001, 1024$/m);
    const sensor = pyValue(py, 'SENSOR_MM');
    expect(sensor[0]).toBeCloseTo(35.9, 6);
    expect(sensor[1]).toBeCloseTo((35.9 * 1080) / 1920, 5);
    const frames: number[] = pyValue(py, 'FRAMES');
    const loc: number[][] = pyValue(py, 'LOCATION_CM');
    const rot: number[][] = pyValue(py, 'ROTATION_PYR');
    const focal: number[] = pyValue(py, 'FOCAL_MM');
    expect(frames).toEqual(d.cameras.map((c) => c.frame));
    expect(focal.every((f) => f === 25.5)).toBe(true);
    d.cameras.forEach((c, i) => {
      // Unreal X = −z (forward), Y = x (right), Z = y (up), in cm.
      close(loc[i]!, [-c.position[2] * 100, c.position[0] * 100, c.position[1] * 100], 1e-3);
      const ax = unrealAxes({ pitch: rot[i]![0]!, yaw: rot[i]![1]!, roll: rot[i]![2]! });
      close(ax.fwd, mulv3(SCENE_TO_UNREAL, col(c.rotation, 2).map((v) => -v)), 1e-5);
      close(ax.right, mulv3(SCENE_TO_UNREAL, col(c.rotation, 0)), 1e-5);
      close(ax.up, mulv3(SCENE_TO_UNREAL, col(c.rotation, 1)), 1e-5);
    });
    // Yaw unwrapped through the ±180° pan.
    const yaw = rot.map((r) => r[1]!);
    expect(Math.max(...yaw.slice(1).map((y, i) => Math.abs(y - yaw[i]!)))).toBeLessThan(30);
    // Track markers in cm too.
    expect(py).toMatch(/\(7, \[500, 100, 0\]\)/);
  });

  it('Unreal: other scene units scale to centimetres', () => {
    const py = writeUnreal(move('ft'));
    const loc: number[][] = pyValue(py, 'LOCATION_CM');
    const d = move('ft');
    close(loc[0]!, [-d.cameras[0]!.position[2] * 30.48, d.cameras[0]!.position[0] * 30.48, d.cameras[0]!.position[1] * 30.48], 1e-3);
  });

  it('Unity: physical camera, metres, z flipped, quaternions turn +Z onto the camera’s forward, continuous', () => {
    const d = move('cm', 'y', 24);
    const cs = writeUnity(d);
    expect(cs).toContain('#if UNITY_EDITOR');
    expect(cs).toContain('[MenuItem("VC VFX/Import Camera Track/020_010_camtrack_v002")]');
    expect(cs).toContain('cam.usePhysicalProperties = true;');
    expect(cs).toContain('cam.gateFit = Camera.GateFitMode.Horizontal;');
    expect(cs).toContain('timeline.CreateTrack<AnimationTrack>');
    expect(cs).toContain('const float Fps = 24f;');
    expect(cs).toContain('const int FirstFrame = 1001;');
    expect(cs).toMatch(/SensorMm = new Vector2\(35\.9f, 20\.19375f\)/);
    expect(balanced(cs, '{', '}')).toBe(true);
    expect(balanced(cs, '(', ')')).toBe(true);
    const [px, py, pz] = ['PosX', 'PosY', 'PosZ'].map((n) => csArray(cs, n));
    const [qx, qy, qz, qw] = ['RotX', 'RotY', 'RotZ', 'RotW'].map((n) => csArray(cs, n));
    expect(csArray(cs, 'FocalMm').every((f) => f === 25.5)).toBe(true);
    d.cameras.forEach((c, i) => {
      close([px![i]!, py![i]!, pz![i]!], [c.position[0] * 0.01, c.position[1] * 0.01, -c.position[2] * 0.01], 1e-6);
      const q = [qx![i]!, qy![i]!, qz![i]!, qw![i]!];
      expect(Math.hypot(...q)).toBeCloseTo(1, 5);
      // Rotate Unity's +Z (forward) and +Y (up) by q.
      const rot = (v: number[]) => {
        const [x, y, z, w] = q as [number, number, number, number];
        const t = [2 * (y * v[2]! - z * v[1]!), 2 * (z * v[0]! - x * v[2]!), 2 * (x * v[1]! - y * v[0]!)];
        return [v[0]! + w * t[0]! + (y * t[2]! - z * t[1]!), v[1]! + w * t[1]! + (z * t[0]! - x * t[2]!), v[2]! + w * t[2]! + (x * t[1]! - y * t[0]!)];
      };
      const fwd = col(c.rotation, 2).map((v) => -v);
      close(rot([0, 0, 1]), [fwd[0]!, fwd[1]!, -fwd[2]!], 1e-5);
      const up = col(c.rotation, 1);
      close(rot([0, 1, 0]), [up[0]!, up[1]!, -up[2]!], 1e-5);
      if (i) expect(q[0]! * qx![i - 1]! + q[1]! * qy![i - 1]! + q[2]! * qz![i - 1]! + q[3]! * qw![i - 1]!).toBeGreaterThan(0);
    });
  });

  it('USD: stage metadata, a time-sampled camera with lens in tenths of a scene unit, and the track points', () => {
    for (const [units, mpu] of [['cm', 0.01], ['m', 1]] as const) {
      for (const up of ['y', 'z'] as const) {
        const d = move(units, up, 24);
        const usda = writeUsda(d);
        expect(usda.startsWith('#usda 1.0\n')).toBe(true);
        expect(balanced(usda, '{', '}')).toBe(true);
        expect(balanced(usda, '(', ')')).toBe(true);
        expect(balanced(usda, '[', ']')).toBe(true);
        expect(usda).toContain(`upAxis = "${up.toUpperCase()}"`);
        expect(usda).toMatch(new RegExp(`metersPerUnit = ${mpu}\\n`));
        expect(usda).toContain('timeCodesPerSecond = 24\n');
        expect(usda).toContain('startTimeCode = 1001\n');
        expect(usda).toContain('endTimeCode = 1024\n');
        expect(usda).toContain('defaultPrim = "VCVFX_020_010_camtrack_v002"');
        expect(usda).toMatch(/def Xform "VCVFX_020_010_camtrack_v002"/);
        // Prim names must not start with a digit (USD's identifier rule).
        for (const m of usda.matchAll(/def \w+ "([^"]+)"/g)) expect(m[1]).toMatch(/^[A-Za-z_]\w*$/);
        expect(usda).toMatch(/def Camera "camera"/);
        expect(usda).toMatch(/def Points "tracks"/);
        expect(usda).toContain('uniform token[] xformOpOrder = ["xformOp:transform"]');
        // Lens and filmback: tenths of a scene unit (mm at cm; mm/100 at m).
        const f = Number(/float focalLength = ([\d.]+)/.exec(usda)![1]);
        const h = Number(/float horizontalAperture = ([\d.]+)/.exec(usda)![1]);
        expect(f).toBeCloseTo(usdLensValue(25.5, mpu), 6);
        expect(f).toBeCloseTo(units === 'cm' ? 25.5 : 0.255, 6);
        expect(h).toBeCloseTo(units === 'cm' ? 35.9 : 0.359, 6);
        // Matrices: rows are the camera axes, translation in the last row; Z-up stages rotated.
        const block = /matrix4d xformOp:transform\.timeSamples = \{([\s\S]*?)\n {8}\}/.exec(usda)![1]!;
        const samples = [...block.matchAll(/(\d+): \( (\([^)]*\)), (\([^)]*\)), (\([^)]*\)), (\([^)]*\)) \)/g)];
        expect(samples).toHaveLength(N);
        samples.forEach((m, i) => {
          const rows = [m[2], m[3], m[4], m[5]].map((r) => r!.slice(1, -1).split(',').map(Number));
          const c = d.cameras[i]!;
          expect(Number(m[1])).toBe(c.frame);
          const conv = (v: number[]) => (up === 'z' ? mulv3(YUP_TO_ZUP, v) : v);
          close(rows[3]!.slice(0, 3), conv(c.position), 1e-5);
          close(rows[2]!.slice(0, 3), conv(col(c.rotation, 2)), 1e-6);
          close(rows[1]!.slice(0, 3), conv(col(c.rotation, 1)), 1e-6);
          expect(rows[3]![3]).toBe(1);
        });
        const pts = /point3f\[\] points = \[(.*)\]/.exec(usda)![1]!;
        expect(pts.match(/\(/g)).toHaveLength(3);
        expect(usda).toContain('int64[] ids = [7, 12, 40]');
        // Every attribute line has a USD type.
        for (const line of usda.split('\n').filter((l) => /^\s+(float|float2|matrix4d|point3f|int64|color3f|uniform token|token)\b/.test(l))) expect(line).toMatch(/=|\($/);
      }
    }
  });

  it('Houdini: cam keys in metres with rOrd xyz recomposing the rotation, focal, aperture, resolution, range; the script parses', () => {
    const d = move('cm', 'y', 24);
    const py = writeHoudini(d);
    expect(py).toContain("cam = obj.createNode('cam', NAME)");
    expect(py).toContain("cam.parm('rOrd').set('xyz')");
    expect(py).toContain("cam.parm('xOrd').set('srt')");
    expect(py).toContain('hou.playbar.setFrameRange(FIRST, LAST)');
    expect(py).toMatch(/^FIRST, LAST = 1001, 1024$/m);
    expect(py).toMatch(/^RES = \(1920, 1080\)$/m);
    expect(py).toMatch(/^APERTURE_MM = 35\.9$/m);
    expect(py).toMatch(/^FPS = 24$/m);
    const [tx, ty, tz, rx, ry, rz, focal] = ['TX', 'TY', 'TZ', 'RX', 'RY', 'RZ', 'FOCAL_MM'].map((n) => pyValue(py, n) as number[]);
    expect(focal!.every((f) => f === 25.5)).toBe(true);
    d.cameras.forEach((c, i) => {
      close([tx![i]!, ty![i]!, tz![i]!], c.position.map((v) => v * 0.01), 1e-6);
      // Houdini xyz: X applied first, then Y, then Z.
      const R = rotationFromEuler({ x: (rx![i]! * Math.PI) / 180, y: (ry![i]! * Math.PI) / 180, z: (rz![i]! * Math.PI) / 180 }, 'XYZ');
      close(R, c.rotation, 1e-5);
    });
    expect(Math.max(...ry!.slice(1).map((v, i) => Math.abs(v - ry![i]!)))).toBeLessThan(30);
    expect(py).toMatch(/\(7, \[0\.01, 0, -0\.05\], 0\.4\)/);
  });

  it('Python exports parse (when python3 is installed)', () => {
    const py = spawnSync('python3', ['-c', 'import ast,sys; [ast.parse(open(p).read()) for p in sys.argv[1:]]', ...writeTemp([writeUnreal(move()), writeHoudini(move())], '.py')]);
    if (py.error) return; // no python3 here
    expect(py.stderr.toString()).toBe('');
    expect(py.status).toBe(0);
  });

  it('Fusion: Camera3D with BezierSpline keys, RotOrder XYZ recomposing the rotation, aperture in inches; balanced Lua tables', () => {
    const d = move('m', 'y', 25);
    for (const text of [writeFusionSetting(d), writeFusionComp(d)]) {
      const body = text.replace(/^--.*$/gm, '');
      expect(balanced(body, '{', '}')).toBe(true);
      expect(balanced(body, '(', ')')).toBe(true);
      expect(body).toMatch(/Tools = ordered\(\) \{/);
      expect(body).toMatch(/Cam_020_010_camtrack_v002 = Camera3D \{/);
      expect(body).toContain('["Transform3DOp.RotOrder"] = Input { Value = FuID { "XYZ" }, },');
      expect(Number(/ApertureW = Input \{ Value = ([\d.]+)/.exec(body)![1])).toBeCloseTo(35.9 / 25.4, 6);
      expect(Number(/ApertureH = Input \{ Value = ([\d.]+)/.exec(body)![1])).toBeCloseTo((35.9 * 1080) / 1920 / 25.4, 6);
      expect(body).toContain('ResolutionGateFit = Input { Value = FuID { "Width" }, },');
      const spline = (id: string) => {
        const block = new RegExp(`Cam_020_010_camtrack_v002${id} = BezierSpline \\{[\\s\\S]*?KeyFrames = \\{([\\s\\S]*?)\\n\\t\\t\\t\\}`).exec(body)![1]!;
        return [...block.matchAll(/\[(\d+)\] = \{ (-?[\d.e-]+), Flags/g)].map((m) => ({ frame: Number(m[1]), value: Number(m[2]) }));
      };
      const [x, y, z, rx, ry, rz, f] = ['XOffset', 'YOffset', 'ZOffset', 'XRotation', 'YRotation', 'ZRotation', 'FocalLength'].map(spline);
      expect(x).toHaveLength(N);
      expect(x![0]!.frame).toBe(1001);
      expect(f!.every((k) => k.value === 25.5)).toBe(true);
      d.cameras.forEach((c, i) => {
        close([x![i]!.value, y![i]!.value, z![i]!.value], c.position, 1e-5);
        const R = rotationFromEuler({ x: (rx![i]!.value * Math.PI) / 180, y: (ry![i]!.value * Math.PI) / 180, z: (rz![i]!.value * Math.PI) / 180 }, 'XYZ');
        close(R, c.rotation, 1e-5);
      });
    }
    expect(writeFusionComp(d)).toMatch(/RenderRange = \{ 1001, 1024 \}/);
    expect(writeFusionComp(d)).toMatch(/Rate = 25,/);
    // A Lua interpreter, when there is one, loads both as tables.
    const files = writeTemp([`return ${writeFusionSetting(d).replace(/^--.*$/gm, '')}`, `Composition = function(t) return t end\nreturn ${writeFusionComp(d).replace(/^--.*$/gm, '').replace('Composition {', 'Composition {')}`], '.lua');
    const stubs = 'ordered=function() return function(t) return t end end; FuID=function(t) return t end; Input=function(t) return t end; OperatorInfo=function(t) return t end; Camera3D=function(t) return t end; BezierSpline=function(t) return t end; ';
    for (const file of files) {
      const lua = spawnSync('lua5.4', ['-e', `${stubs} local t = dofile(${JSON.stringify(file)}); assert(type(t) == "table" and t.Tools)`]);
      if (lua.error) return; // no Lua here
      expect(lua.stderr.toString()).toBe('');
      expect(lua.status).toBe(0);
    }
  });

  it('README: how to bring each file in', () => {
    const d = move();
    const names = ['020_010_camtrack_v002_houdini.py', '020_010_camtrack_v002_fusion.setting', '020_010_camtrack_v002_fusion.comp', '020_010_camtrack_v002.nk', '020_010_camtrack_v002.py', '020_010_camtrack_v002_unreal.py', '020_010_camtrack_v002_Unity.cs', '020_010_camtrack_v002.usda', '020_010_camtrack_v002.fbx', '020_010_camtrack_v002_report.html'];
    const readme = writeExportReadme(d, names);
    expect(readme).toContain('Unreal Engine 5.x — 020_010_camtrack_v002_unreal.py');
    expect(readme).toContain('Tools > Execute Python Script');
    expect(readme).toContain('Blender — 020_010_camtrack_v002.py');
    expect(readme).toContain('VC VFX > Import Camera Track');
    expect(readme).toContain('tenths of a scene unit');
    expect(readme).toContain('Import...');
    expect(readme.match(/Blender —/g)).toHaveLength(1);
    expect(readme).toContain('Houdini — 020_010_camtrack_v002_houdini.py');
    expect(readme).toContain('DaVinci Resolve / Fusion — 020_010_camtrack_v002_fusion.setting');
    expect(readme).toContain('Solaris');
  });
});
