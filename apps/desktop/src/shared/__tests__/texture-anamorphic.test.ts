import { describe, expect, it } from 'vitest';
import type { TextureReference, TextureRegion } from '@vcvfx/domain';
import { lumaWeights } from '../key/linear';
import { buildTextures } from '../texture/engine';
import { photoIntrinsics } from '../texture/geometry';
import { cornerAspect, desqueezeCorners, focalAspect, pinholeCorners, rectangleFocal } from '../texture/rectify';
import { SAMPLE_PHOTOS, regionCorners, renderPhoto, truthTexture, type SynthCamera } from '../texture/synthetic';

/**
 * Textures from a non-square picture (addendum 17): a surface photographed
 * by a camera whose frames are stored squeezed (DVCPRO HD 1.5, a 2×
 * anamorphic) must come out at its real aspect — the corners and the focal
 * length are measured on the de-squeezed picture. Before, the texture came out
 * squeezed (the real-footage painting: 0.69 for a card that is not that shape).
 */

const luma = lumaWeights('ap1');
const brick = SAMPLE_PHOTOS[0]!;
const truthAspect = (brick.region.x1 - brick.region.x0) / (brick.region.y1 - brick.region.y0);

describe('texture aspect from a squeezed picture', () => {
  for (const a of [1.5, 2]) {
    it(`${a}× pixel aspect: corners and focal length give the true aspect once de-squeezed`, () => {
      const cam: SynthCamera = { ...brick.camera, width: Math.round(960 / a), height: 720, pixelAspect: a, supersample: 1 };
      const corners = regionCorners(cam, brick.region);
      const record = { body: '', lens: '', focalMm: 0, filmBackWidthMm: 36, distortion: { k1: brick.camera.k1 ?? 0, k2: brick.camera.k2 ?? 0, k3: 0, p1: 0, p2: 0 }, lensProfileId: null };
      // The focal length of the de-squeezed picture across a 36 mm back.
      record.focalMm = (36 / 2) / Math.tan((brick.camera.fov * Math.PI) / 360);
      const k = photoIntrinsics(record, cam.width, cam.height, null, a)!;
      expect(k.a).toBe(a);
      const pin = pinholeCorners(corners, k);
      const squeezed = focalAspect(pin, k.f, k.cx, k.cy);
      const right = focalAspect(desqueezeCorners(pin, a), k.f, k.cx * a, k.cy)!;
      console.log(`pixel aspect ${a}: focal aspect squeezed ${squeezed?.toFixed(4) ?? 'none'}, de-squeezed ${right.toFixed(4)} (true ${truthAspect.toFixed(4)}); corner aspect ${cornerAspect(pin).toFixed(4)} → ${cornerAspect(desqueezeCorners(pin, a)).toFixed(4)}`);
      expect(Math.abs(right / truthAspect - 1)).toBeLessThan(0.02);
      expect(squeezed === null || Math.abs(squeezed / truthAspect - 1) > 0.1).toBe(true);
      expect(Math.abs(cornerAspect(desqueezeCorners(pin, a)) / cornerAspect(pin) - a)).toBeLessThan(0.15);
    });
  }

  it('builds the texture at the true aspect end to end from a 1.5 frame with no camera known (corners) and with one (focal)', async () => {
    const a = 1.5;
    const cam: SynthCamera = { ...brick.camera, k1: 0, k2: 0, width: 640, height: 720, pixelAspect: a, supersample: 2 };
    const photo = renderPhoto(cam);
    const corners = regionCorners(cam, brick.region);
    const ref = (camera: TextureReference['camera'], pixelAspect: number | null): TextureReference => ({
      id: 'ph1', kind: 'photo', name: 'frame.png', path: '/x/frame.png', from: 'disk', format: 'png', checksum: null, bytes: null, width: cam.width, height: cam.height, points: null,
      encoding: 'linear_rec709', camera, pixelAspect, pixelAspectFrom: pixelAspect ? 'shot' : null, scan: null, panorama: null, addedBy: 'ana', addedAt: 'now',
    });
    const region: TextureRegion = {
      id: 'rg1', name: 'Brick', photoId: 'ph1', corners, enabled: true, size: null,
      settings: { undistort: true, rectify: true, delight: 0, delightRadius: 0.25, tile: 'none', output: { mode: 'resolution', density: 160, resolution: 512 } },
      target: { planeId: null },
    } as unknown as TextureRegion;
    const io = { picture: async () => photo, scan: async () => { throw new Error('no scan'); } };
    const run = async (r: TextureReference) => (await buildTextures(io, { references: [r], regions: [region], placements: [] }, { luma, revision: 1, maxTexture: 512, maxPhoto: null }, () => undefined)).result.regions[0]!;
    const fov = brick.camera.fov;
    const camera = { body: '', lens: '', focalMm: 18 / Math.tan((fov * Math.PI) / 360), filmBackWidthMm: 36, distortion: null, lensProfileId: null };
    const before = await run(ref(null, null));
    const corner = await run(ref(null, a));
    const focal = await run(ref(camera, a));
    console.log(`end to end: aspect square-pixel ${before.metrics.aspect} (${before.metrics.aspectFrom}), corners ${corner.metrics.aspect}, focal ${focal.metrics.aspect} (${focal.metrics.aspectFrom}); true ${truthAspect.toFixed(4)}; texture ${focal.metrics.width}×${focal.metrics.height}`);
    expect(Math.abs(before.metrics.aspect / truthAspect - 1)).toBeGreaterThan(0.2);
    expect(focal.metrics.aspectFrom).toBe('focal');
    expect(Math.abs(focal.metrics.aspect / truthAspect - 1)).toBeLessThan(0.02);
    expect(Math.abs(corner.metrics.aspect / truthAspect - 1)).toBeLessThan(0.12);
    expect(Math.abs(focal.metrics.width / focal.metrics.height / truthAspect - 1)).toBeLessThan(0.02);
    void truthTexture;
  }, 60_000);

  it('finds the focal length from the rectangle itself (both vanishing points), only on de-squeezed corners', () => {
    // A 1.6 × 1 card turned 35° about y and tilted 20° about x, 4 m away; f = 1500 de-squeezed px; stored at 2×.
    const a = 2;
    const f = 1500;
    const W = 960;
    const H = 1080;
    const cx = (W - 1) / 2;
    const cy = (H - 1) / 2;
    const ry = (35 * Math.PI) / 180;
    const rx = (20 * Math.PI) / 180;
    const corners3d = [[-0.8, -0.5], [0.8, -0.5], [0.8, 0.5], [-0.8, 0.5]].map(([x, y]) => {
      // rotate about y then x, push to z = 4
      const x1 = x! * Math.cos(ry);
      const z1 = -x! * Math.sin(ry);
      const y2 = y! * Math.cos(rx) - z1 * Math.sin(rx);
      const z2 = y! * Math.sin(rx) + z1 * Math.cos(rx) + 4;
      return [x1, y2, z2] as const;
    });
    const stored = corners3d.map(([X, Y, Z]) => [(f * X) / Z / a + cx, (f * Y) / Z + cy] as [number, number]);
    const phys = desqueezeCorners(stored, a);
    const fr = rectangleFocal(phys, cx * a, cy)!;
    expect(Math.abs(fr / f - 1)).toBeLessThan(1e-6);
    expect(focalAspect(phys, fr, cx * a, cy)).toBeCloseTo(1.6, 6);
    // Read as square pixels, the same corners give no consistent answer.
    const wrong = rectangleFocal(stored, cx, cy);
    const wrongAspect = wrong ? focalAspect(stored, wrong, cx, cy) : null;
    console.log(`rectangle focal: de-squeezed ${fr.toFixed(2)} px (true ${f}), aspect 1.6; read squeezed: focal ${wrong?.toFixed(1) ?? 'none'}, aspect ${wrongAspect?.toFixed(3) ?? 'none'}`);
    expect(wrongAspect === null || Math.abs(wrongAspect - 1.6) > 0.1).toBe(true);
  });
});
