import { describe, expect, it } from 'vitest';
import { rotY } from '../camera/geometry';
import type { SceneCamera } from '../camera/coords';
import {
  verticalAperture,
  writeAfterEffects,
  writeBlender,
  writeCameraJson,
  writeChan,
  writeExportReadme,
  writeFbx,
  writeFusionComp,
  writeFusionSetting,
  writeHoudini,
  writeMax,
  writeMaya,
  writeNuke,
  writeUnity,
  writeUnreal,
  writeUsda,
  type CameraExportData,
} from '../camera/export-formats';
import { writeCornerPinJsx, writeMochaText, writeNukeCornerPin, writeTrack2dJson } from '../camera/track2d-export';
import type { Track2d } from '@vcvfx/domain';

/**
 * Golden checks of every exporter's pixel-aspect fields (addendum 17): a 2×
 * anamorphic plate kept squeezed (2048 × 1716 stored on a 6:5 sensor area
 * 24.89 × 20.85 mm → a 49.78 mm de-squeezed picture) and the square case
 * left unchanged. Values follow each application's documented convention.
 */

const PAR = 2;
const W = 2048;
const H = 1716;
const SENSOR = { width: 24.89, height: 20.85 };
const EFF_W = SENSOR.width * PAR;

function anamorphic(par = PAR): CameraExportData {
  const cameras: SceneCamera[] = Array.from({ length: 5 }, (_, i) => ({ frame: 1001 + i, position: [0.1 * i, 1.5, 4] as [number, number, number], rotation: rotY(0.02 * i) }));
  const filmW = par === 1 ? SENSOR.width : EFF_W;
  // A 50 mm lens: f in de-squeezed pixels = 50 × (W · par) / film width.
  const focalPx = (50 * W * par) / filmW;
  return {
    shot: '030_010',
    version: 2,
    generator: 'VC VFX test',
    writtenAt: '2026-10-22T12:00:00.000Z',
    fps: 24,
    width: W,
    height: H,
    filmBackMm: { width: filmW, height: SENSOR.height },
    sensorFilmBackMm: SENSOR,
    pixelAspect: par,
    nominalFilmBack: false,
    focalMm: 50,
    focalPx,
    principalOffsetPx: { x: 0, y: 0 },
    distortion: { k1: -0.03, k2: 0, k3: 0, p1: 0, p2: 0 },
    units: 'm',
    upAxis: 'y',
    cameras,
    points: [{ id: 1, position: [0, 0, -5], error: 0.3 }],
    solve: { number: 1, rms: 0.4, frames: 5, engine: 'vcvfx-ts@1.0.0', nodal: false, confidence: 0.9, warnings: [] },
    files: { obj: 'x_points.obj', undistort: 'x_undistort.exr', redistort: 'x_redistort.exr' },
  };
}

const n = (text: string, re: RegExp) => Number(re.exec(text)?.[1]);

describe('camera exports declare the pixel aspect', () => {
  const d = anamorphic();
  const vAp = verticalAperture(d);

  it('vertical aperture follows the de-squeezed shape (and equals the sensor height here)', () => {
    expect(vAp).toBeCloseTo(EFF_W * H / (W * PAR), 9);
    expect(vAp).toBeCloseTo(SENSOR.height, 1);
  });

  it('Nuke: formats carry pixel_aspect 2, haperture is the de-squeezed picture', () => {
    const nk = writeNuke(d);
    expect(nk).toContain(`format "${W} ${H} 0 0 ${W} ${H} 2 030_010_plate"`);
    expect(nk.match(/ 2 030_010_plate"/g)!.length).toBe(3); // Root + both STMap Reads
    expect(n(nk, /haperture ([\d.]+)/)).toBeCloseTo(EFF_W, 3);
    expect(n(nk, /vaperture ([\d.]+)/)).toBeCloseTo(vAp, 3);
    expect(n(nk, /focal ([\d.]+)/)).toBe(50);
  });

  it('Maya: squeezed camera aperture × lensSqueezeRatio, render pixel aspect', () => {
    const ma = writeMaya(d);
    const cap = /setAttr ".cap" -type "double2" ([\d.]+) ([\d.]+)/.exec(ma)!;
    expect(Number(cap[1]) * 25.4).toBeCloseTo(SENSOR.width, 3);
    expect(Number(cap[2]) * 25.4).toBeCloseTo(vAp, 3);
    expect(n(ma, /setAttr "\.lsr" ([\d.]+)/)).toBe(2);
    expect(ma).toContain('select -ne :defaultResolution;');
    expect(n(ma, /setAttr "\.pa" ([\d.]+)/)).toBe(2);
    expect(n(ma, /setAttr "\.dar" ([\d.]+)/)).toBeCloseTo((W * PAR) / H, 5);
  });

  it('Blender: pixel_aspect_x, sensor width de-squeezed, horizontal fit', () => {
    const py = writeBlender(d);
    expect(n(py, /pixel_aspect_x = ([\d.]+)/)).toBe(2);
    expect(n(py, /pixel_aspect_y = ([\d.]+)/)).toBe(1);
    expect(n(py, /sensor_width = ([\d.]+)/)).toBeCloseTo(EFF_W, 4);
    expect(n(py, /sensor_height = ([\d.]+)/)).toBeCloseTo(vAp, 4);
    expect(py).toContain("sensor_fit = 'HORIZONTAL'");
  });

  it('After Effects: the comp is made at pixel aspect 2; zoom is the vertical focal', () => {
    const jsx = writeAfterEffects(d);
    expect(jsx).toMatch(new RegExp(`addComp\\("[^"]+", W, H, 2, `));
    expect(n(jsx, /ADBE Camera Zoom"\)\.setValue\(([\d.]+)/)).toBeCloseTo(d.focalPx, 3);
  });

  it('3ds Max: renderPixelAspect and the de-squeezed horizontal FOV', () => {
    const ms = writeMax(d);
    expect(n(ms, /renderPixelAspect = ([\d.]+)/)).toBe(2);
    expect(n(ms, /cam\.fov = ([\d.]+)/)).toBeCloseTo((2 * Math.atan(EFF_W / 100) * 180) / Math.PI, 4);
  });

  it('FBX: squeezed film width × FilmSqueezeRatio, PixelAspectRatio', () => {
    const fbx = writeFbx(d);
    expect(n(fbx, /"FilmWidth", "double", "Number", "",([\d.]+)/) * 25.4).toBeCloseTo(SENSOR.width, 3);
    expect(n(fbx, /"FilmSqueezeRatio", "double", "Number", "",([\d.]+)/)).toBe(2);
    expect(n(fbx, /"PixelAspectRatio", "double", "Number", "",([\d.]+)/)).toBe(2);
  });

  it('Houdini, Fusion: aspect / AspectX 2, apertures de-squeezed', () => {
    const hou = writeHoudini(d);
    expect(n(hou, /PIXEL_ASPECT = ([\d.]+)/)).toBe(2);
    expect(hou).toContain("cam.parm('aspect').set(PIXEL_ASPECT)");
    expect(n(hou, /APERTURE_MM = ([\d.]+)/)).toBeCloseTo(EFF_W, 4);
    const comp = writeFusionComp(d);
    expect(n(comp, /AspectX = ([\d.]+)/)).toBe(2);
    expect(n(writeFusionSetting(d), /ApertureW = Input \{ Value = ([\d.]+)/) * 25.4).toBeCloseTo(EFF_W, 3);
  });

  it('Unreal, Unity: the de-squeezed filmback; engines render square pixels', () => {
    const ue = writeUnreal(d);
    const sensor = /SENSOR_MM = \(([\d.]+), ([\d.]+)\)/.exec(ue)!;
    expect(Number(sensor[1])).toBeCloseTo(EFF_W, 4);
    expect(Number(sensor[2])).toBeCloseTo(vAp, 4);
    expect(ue).toMatch(/pixel aspect 2; Unreal renders square pixels/);
    const cs = writeUnity(d);
    expect(n(cs, /SensorMm = new Vector2\(([\d.]+)f/)).toBeCloseTo(EFF_W, 4);
  });

  it('USD: apertures with the de-squeezed aspect, customData and RenderSettings pixelAspectRatio', () => {
    const usd = writeUsda(d);
    const h = n(usd, /float horizontalAperture = ([\d.]+)/);
    const v = n(usd, /float verticalAperture = ([\d.]+)/);
    expect(h / v).toBeCloseTo((W * PAR) / H, 4);
    expect(n(usd, /double pixelAspect = ([\d.]+)/)).toBe(2);
    expect(n(usd, /uniform float pixelAspectRatio = ([\d.]+)/)).toBe(2);
    expect(usd).toContain(`uniform int2 resolution = (${W}, ${H})`);
    expect(usd).toMatch(/rel camera = <\/VCVFX_030_010_camtrack_v002\/camera>/);
  });

  it('.chan: the vertical FOV is the de-squeezed camera’s', () => {
    const row = writeChan(d).split('\n')[0]!.split('\t').map(Number);
    expect(row[7]).toBeCloseTo((2 * Math.atan(vAp / 100) * 180) / Math.PI, 4);
  });

  it('JSON and README: pixel aspect, both focals in plate pixels, both film backs', () => {
    const j = JSON.parse(writeCameraJson(d));
    expect(j.plate).toMatchObject({ width: W, height: H, pixelAspect: 2, displayWidth: W * 2 });
    expect(j.lens.fyPx).toBeCloseTo(d.focalPx, 6);
    expect(j.lens.fxPx).toBeCloseTo(d.focalPx / 2, 6);
    expect(j.filmBackMm).toMatchObject({ desqueezed: true, sensor: SENSOR });
    expect(writeExportReadme(d, ['a.nk'])).toMatch(/PIXEL ASPECT 2: the plate is kept squeezed \(2048 x 1716 stored, 4096 x 1716 shown\)/);
  });

  it('square plates are written as before', () => {
    const sq = anamorphic(1);
    expect(writeNuke(sq)).toContain(`format "${W} ${H} 0 0 ${W} ${H} 1 030_010_plate"`);
    expect(writeMaya(sq)).not.toContain('.lsr');
    expect(writeMaya(sq)).not.toContain('defaultResolution');
    expect(writeUsda(sq)).not.toContain('RenderSettings');
    expect(n(writeBlender(sq), /pixel_aspect_x = ([\d.]+)/)).toBe(1);
  });
});

describe('2D track exports in plate pixels with the pixel aspect', () => {
  const track: Track2d = {
    id: 'plate', name: 'Plate', kind: 'planar', color: '#ff0000', occluders: [], pattern: 12, search: 48, engine: 'planar@1.0.0',
    keys: [{ frame: 1001, points: [[100, 200], [300, 210], [310, 400], [90, 390]], by: 'Ana', at: 'now' }],
    frames: [
      { frame: 1001, points: [[100, 200], [300, 210], [310, 400], [90, 390]], confidence: 1, status: 'key' },
      { frame: 1002, points: [[102, 201], [302, 211], [312, 401], [92, 391]], confidence: 0.9, status: 'tracked' },
    ],
  };
  const info = { shot: '050_010', version: 1, generator: 'VC VFX test', fps: 24, width: 1280, height: 1080, pixelAspect: 1.5, first: 1001, writtenAt: 'now' };

  it('Mocha / AE keyframe text declares the source and comp pixel aspect; corners unscaled', () => {
    const txt = writeMochaText(track, info);
    expect(txt).toContain('\tSource Pixel Aspect Ratio\t1.5');
    expect(txt).toContain('\tComp Pixel Aspect Ratio\t1.5');
    expect(txt).toContain('\t0\t100.5\t200.5\t');
  });

  it('Nuke CornerPin2D and AE script name the plate format; JSON carries it', () => {
    const nk = writeNukeCornerPin(track, info);
    expect(nk).toContain('# plate format "1280 1080 0 0 1280 1080 1.5"');
    expect(nk).toContain('to4 {{curve x1001 100.5 x1002 102.5}');
    expect(writeCornerPinJsx(track, info)).toMatch(/plate pixel aspect 1\.5/);
    const j = JSON.parse(writeTrack2dJson(track, info));
    expect(j.plate.pixelAspect).toBe(1.5);
    expect(j.frames[0].points[0]).toEqual([100.5, 200.5]);
  });
});
