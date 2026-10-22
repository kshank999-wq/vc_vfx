import { beforeAll, describe, expect, it } from 'vitest';
import { SAMPLE_HANDOFF, addTextureReference, addTextureRegion, createProject, parseHandoff, recordTextureRun, shotState, textureDoc, type Project, type TextureRegion } from '@vcvfx/domain';
import type { PointCloud } from '../camera/lidar';
import { lumaWeights, resizeLinear, type LinearImage } from '../key/linear';
import { gaussianBlur } from '../roto/image';
import { applyGain, delight, medianLuminance } from '../texture/delight';
import { buildTextures, type TextureIO } from '../texture/engine';
import { cameraFromExif, parseExif } from '../texture/exif';
import { anglesOf, fovOf, photoIntrinsics, sub, toCanonical, wrapDeg } from '../texture/geometry';
import { tileImage } from '../texture/image';
import { cornerNormal, parseMtlText, parseObjText, writeMtl, writeObj } from '../texture/obj';
import { canonicalToPanorama, estimatePanoramaPose, matchToPanorama, panoramaGrey, photoGrey } from '../texture/panorama';
import { fitPlanes } from '../texture/planes';
import { photoProblems, specularShare } from '../texture/problems';
import { focalAspect, pinholeCorners, rectifyRegion } from '../texture/rectify';
import { makeTileable, repeatScore, wrapRatio } from '../texture/seamless';
import { PANO_POSITION, SAMPLE_PHOTOS, cameraOf, rectCorners3d, regionCorners, renderPanorama, renderPhoto, renderSample, sampleReferences, sampleRegions, scanCloud, truthTexture, type SampleSetOptions, type SynthCamera } from '../texture/synthetic';

/**
 * Texture extraction (addendum 12) on a synthetic storeroom with known
 * ground truth: procedural albedo on the walls and floor, two lamps, photos
 * with perspective, lens distortion and exposure, a panorama, a coloured
 * scan. The numbers asserted here are the ones the addendum reports.
 */

const luma = lumaWeights('ap1');
const W = 960;
const H = 720;
const NOW = new Date('2026-10-22T12:00:00Z');

/** Relative RMS error of a against b where the mask is set, both low-passed by σ texels. */
function relError(a: LinearImage, b: LinearImage, mask: Uint8Array, sigma: number): number {
  const n = a.width * a.height;
  let e = 0;
  let s = 0;
  for (let c = 0; c < 3; c += 1) {
    const pa = new Float32Array(n);
    const pb = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      pa[i] = a.data[3 * i + c]!;
      pb[i] = b.data[3 * i + c]!;
    }
    const ba = gaussianBlur(pa, a.width, a.height, sigma);
    const bb = gaussianBlur(pb, a.width, a.height, sigma);
    for (let i = 0; i < n; i += 1) {
      const x = i % a.width;
      const y = Math.floor(i / a.width);
      if (!mask[i] || x < 4 || y < 4 || x >= a.width - 4 || y >= a.height - 4) continue;
      e += (ba[i]! - bb[i]!) ** 2;
      s += bb[i]! ** 2;
    }
  }
  return Math.sqrt(e / s);
}

/** The shift (texels) of a against b that best aligns them (sub-texel, by a parabola through the NCC). */
function misregistration(a: LinearImage, b: LinearImage): { dx: number; dy: number } {
  const g = (img: LinearImage) => {
    const L = new Float32Array(img.width * img.height);
    for (let i = 0; i < L.length; i += 1) L[i] = Math.log(1e-4 + luma[0] * img.data[3 * i]! + luma[1] * img.data[3 * i + 1]! + luma[2] * img.data[3 * i + 2]!);
    const lo = gaussianBlur(L, img.width, img.height, 12);
    return L.map((v, i) => v - lo[i]!);
  };
  const A = g(a);
  const B = g(b);
  const w = a.width;
  const h = a.height;
  const m = 8;
  const score = (dx: number, dy: number) => {
    let s = 0;
    for (let y = m; y < h - m; y += 1) for (let x = m; x < w - m; x += 1) s += A[y * w + x]! * B[(y + dy) * w + x + dx]!;
    return s;
  };
  let best = { dx: 0, dy: 0, s: -Infinity };
  for (let dy = -3; dy <= 3; dy += 1) for (let dx = -3; dx <= 3; dx += 1) {
    const s = score(dx, dy);
    if (s > best.s) best = { dx, dy, s };
  }
  const par = (a1: number, b1: number, c1: number) => (a1 - 2 * b1 + c1 < 0 ? (0.5 * (a1 - c1)) / (a1 - 2 * b1 + c1) : 0);
  return {
    dx: best.dx + par(score(best.dx - 1, best.dy), best.s, score(best.dx + 1, best.dy)),
    dy: best.dy + par(score(best.dx, best.dy - 1), best.s, score(best.dx, best.dy + 1)),
  };
}

/** Correlation of log luminance high-passes (the albedo's detail) of two textures. */
function detailCorrelation(a: LinearImage, b: LinearImage, mask: Uint8Array): number {
  const hp = (img: LinearImage) => {
    const L = new Float32Array(img.width * img.height);
    for (let i = 0; i < L.length; i += 1) L[i] = Math.log(1e-4 + luma[0] * img.data[3 * i]! + luma[1] * img.data[3 * i + 1]! + luma[2] * img.data[3 * i + 2]!);
    return L;
  };
  const A = hp(a);
  const B = hp(b);
  let sa = 0, sb = 0, sab = 0, saa = 0, sbb = 0, n = 0;
  for (let i = 0; i < A.length; i += 1) {
    if (!mask[i]) continue;
    sa += A[i]!;
    sb += B[i]!;
    sab += A[i]! * B[i]!;
    saa += A[i]! * A[i]!;
    sbb += B[i]! * B[i]!;
    n += 1;
  }
  return (sab / n - (sa / n) * (sb / n)) / Math.sqrt((saa / n - (sa / n) ** 2) * (sbb / n - (sb / n) ** 2));
}

const brick = SAMPLE_PHOTOS[0]!;
const camA: SynthCamera = { ...brick.camera, width: W, height: H, supersample: 2 };
const camRecord = (c: SynthCamera) => {
  const intr = cameraOf(c).intr;
  return { body: '', lens: '', focalMm: (intr.f / c.width) * 36, filmBackWidthMm: 36, distortion: { k1: intr.k1, k2: intr.k2, k3: 0, p1: 0, p2: 0 }, lensProfileId: null };
};

let photoA: LinearImage;
beforeAll(() => {
  photoA = renderPhoto(camA);
});

describe('rectification', () => {
  it('squares a surface up from its four corners within a fraction of a texel of the truth, undistorting the lens', () => {
    const corners = regionCorners(camA, brick.region);
    const k = photoIntrinsics(camRecord(camA), W, H)!;
    const rw = brick.region.x1 - brick.region.x0;
    const rh = brick.region.y1 - brick.region.y0;
    // At about the photo's own texel density here (≈ 240 px/m), 200 px/m.
    const tw = Math.round(rw * 200);
    const th = Math.round(rh * 200);
    const r = rectifyRegion({ photo: photoA, fullWidth: W, fullHeight: H, corners, intr: k, undistort: true, rectify: true, width: tw, height: th, texelDensity: 200 });
    const truth = truthTexture(brick.region, tw, th, { lit: true });
    expect(r.coverage).toBe(1);
    expect(r.nativeDensity!).toBeGreaterThan(200);
    const err = relError(r.image, truth, r.mask, 1);
    const shift = misregistration(r.image, truth);
    // Without undistortion the lens's barrel bends the texture.
    const bent = rectifyRegion({ photo: photoA, fullWidth: W, fullHeight: H, corners, intr: k, undistort: false, rectify: true, width: tw, height: th, texelDensity: 200 });
    const errBent = relError(bent.image, truth, bent.mask, 1);
    console.log(`rectification ${tw}×${th}: error ${(err * 100).toFixed(2)} % (low-passed σ 1), shift ${shift.dx.toFixed(3)}, ${shift.dy.toFixed(3)} texels; without undistortion ${(errBent * 100).toFixed(2)} %`);
    expect(err).toBeLessThan(0.05);
    expect(Math.hypot(shift.dx, shift.dy)).toBeLessThan(0.25);
    expect(errBent).toBeGreaterThan(1.5 * err);
    // The rectangle's aspect from the focal length alone (no real size): Zhang & He.
    const aspect = focalAspect(pinholeCorners(corners, k), k.f, k.cx, k.cy)!;
    console.log(`aspect from the focal length ${aspect.toFixed(4)} (true ${(rw / rh).toFixed(4)})`);
    expect(Math.abs(aspect / (rw / rh) - 1)).toBeLessThan(0.02);
  });
});

describe('delighting, exposure and tiling', () => {
  it('takes the light falloff out and keeps the albedo’s detail', () => {
    for (const sp of SAMPLE_PHOTOS) {
      const cam = { ...sp.camera, width: W, height: H, supersample: 2 };
      const photo = sp === brick ? photoA : renderPhoto(cam);
      const k = photoIntrinsics(camRecord(cam), W, H)!;
      const rw = sp.region.x1 - sp.region.x0;
      const rh = sp.region.y1 - sp.region.y0;
      const tw = Math.round(rw * 120);
      const th = Math.round(rh * 120);
      const r = rectifyRegion({ photo, fullWidth: W, fullHeight: H, corners: regionCorners(cam, sp.region), intr: k, undistort: true, rectify: true, width: tw, height: th, texelDensity: 120 });
      const d = delight(r.image, r.mask, luma, { strength: 1, radius: 0.2 });
      const albedo = truthTexture(sp.region, tw, th);
      const before = detailCorrelation(r.image, albedo, r.mask);
      const after = detailCorrelation(d.image, albedo, r.mask);
      const own = delight(albedo, null, luma, { strength: 0, radius: 0.2 }).residualBefore;
      console.log(`${sp.region.name}: light across it ${d.residualBefore.toFixed(2)} → ${d.residualAfter.toFixed(2)} stops (the albedo's own ${own.toFixed(2)}); detail kept ${d.detailKept.toFixed(3)}; correlation with the albedo ${before.toFixed(3)} → ${after.toFixed(3)}`);
      expect(d.residualBefore).toBeGreaterThan(0.35);
      expect(d.residualAfter).toBeLessThan(0.25);
      expect(d.residualAfter).toBeLessThan(0.4 * d.residualBefore);
      expect(d.detailKept).toBeGreaterThan(0.97);
      expect(d.detailKept).toBeLessThan(1.03);
      expect(after).toBeGreaterThan(before);
    }
  });

  it('brings two photos of one surface to one exposure', () => {
    const other: SynthCamera = { eye: [0.9, 1.3, 0.6], target: [0.3, 1.4, 2.5], fov: 58, width: W, height: H, exposure: 0.55, supersample: 1 };
    const kA = photoIntrinsics(camRecord(camA), W, H)!;
    const kB = photoIntrinsics(camRecord(other), W, H)!;
    const a = rectifyRegion({ photo: photoA, fullWidth: W, fullHeight: H, corners: regionCorners(camA, brick.region), intr: kA, undistort: true, rectify: true, width: 192, height: 144, texelDensity: null });
    const b = rectifyRegion({ photo: renderPhoto(other), fullWidth: W, fullHeight: H, corners: regionCorners(other, brick.region), intr: kB, undistort: true, rectify: true, width: 192, height: 144, texelDensity: null });
    const ma = medianLuminance(delight(a.image, a.mask, luma, { strength: 1, radius: 0.2 }).image, a.mask, luma);
    const mb = medianLuminance(delight(b.image, b.mask, luma, { strength: 1, radius: 0.2 }).image, b.mask, luma);
    const target = Math.sqrt(ma * mb);
    const ga = target / ma;
    const gb = target / mb;
    const after = medianLuminance(applyGain(b.image, gb), b.mask, luma) / medianLuminance(applyGain(a.image, ga), a.mask, luma);
    console.log(`exposure: medians ${ma.toFixed(4)} and ${mb.toFixed(4)} (true ratio 0.55, measured ${(mb / ma).toFixed(3)}); gains ${ga.toFixed(3)}, ${gb.toFixed(3)}; after ${after.toFixed(3)}`);
    expect(Math.abs(mb / ma - 0.55)).toBeLessThan(0.03);
    expect(Math.abs(after - 1)).toBeLessThan(0.02);
  });

  it('makes a texture tile in x and y with seams that do not show, the tile’s edges continuous', () => {
    const k = photoIntrinsics(camRecord(camA), W, H)!;
    const r = rectifyRegion({ photo: photoA, fullWidth: W, fullHeight: H, corners: regionCorners(camA, brick.region), intr: k, undistort: true, rectify: true, width: 320, height: 240, texelDensity: null });
    const d = delight(r.image, r.mask, luma, { strength: 1, radius: 0.2 }).image;
    const t = makeTileable(d, 'xy', 0.2, luma);
    expect(t.image.width).toBe(320 - t.overlapX);
    expect(t.image.height).toBe(240 - t.overlapY);
    const wrapX = wrapRatio(t.image, luma);
    // Down the columns: the transposed picture's wrap.
    const tr = { width: t.image.height, height: t.image.width, data: new Float32Array(t.image.data.length) };
    for (let y = 0; y < t.image.height; y += 1) for (let x = 0; x < t.image.width; x += 1) for (let c = 0; c < 3; c += 1) tr.data[3 * (x * t.image.height + y) + c] = t.image.data[3 * (y * t.image.width + x) + c]!;
    const wrapY = wrapRatio(tr, luma);
    // Delit but repeated as it is, and not even delit.
    const naive = repeatScore(d, 'xy', luma);
    const raw = repeatScore(r.image, 'xy', luma);
    console.log(`tiling: seam score ${t.score.toFixed(3)}; wrap x ${wrapX.toFixed(3)}, y ${wrapY.toFixed(3)}; repeated as it is ${naive.toFixed(2)} (not delit ${raw.toFixed(2)})`);
    expect(t.score).toBeLessThan(1.6);
    expect(wrapX).toBeLessThan(1.3);
    expect(wrapY).toBeLessThan(1.3);
    expect(naive).toBeGreaterThan(2.5);
    expect(t.scoreBefore).toBeCloseTo(naive, 6);
    expect(tileImage(t.image, 3).width).toBe(3 * t.image.width);
    const x = makeTileable(d, 'x', 0.25, luma);
    expect(x.image.height).toBe(240);
    expect(x.score).toBeLessThan(1.6);
  });
});

describe('problems', () => {
  it('flags a blurred photo, blown highlights and specular glints', () => {
    const corners = regionCorners(camA, brick.region);
    const sharp = photoProblems(photoA, corners, W, luma, 1);
    const blurred = photoProblems(renderPhoto({ ...camA, blur: 2.5, supersample: 1 }), corners, W, luma, 1);
    const hot = photoProblems(renderPhoto({ ...camA, exposure: 5, supersample: 1 }), corners, W, luma, 1);
    console.log(`sharpness ${sharp.sharpness.toFixed(2)} → blurred (σ 2.5 px) ${blurred.sharpness.toFixed(2)}; clipped ${(sharp.clipped * 100).toFixed(2)} % → over-exposed ${(hot.clipped * 100).toFixed(1)} %`);
    expect(sharp.sharpness).toBeGreaterThan(0.6);
    expect(blurred.sharpness).toBeLessThan(0.3);
    expect(sharp.clipped).toBe(0);
    expect(hot.clipped).toBeGreaterThan(0.05);
    const k = photoIntrinsics(camRecord(camA), W, H)!;
    const r = rectifyRegion({ photo: photoA, fullWidth: W, fullHeight: H, corners, intr: k, undistort: true, rectify: true, width: 256, height: 192, texelDensity: null });
    const d = delight(r.image, r.mask, luma, { strength: 1, radius: 0.2 }).image;
    expect(specularShare(d, r.mask, luma)).toBeLessThan(0.002);
    // A glint: a few near-white spots.
    const glint = { ...d, data: d.data.slice() };
    let spots = 0;
    for (const [cx, cy] of [[60, 50], [150, 120], [200, 60], [100, 150], [220, 160]] as const)
      for (let y = -8; y <= 8; y += 1) for (let x = -8; x <= 8; x += 1) if (x * x + y * y <= 64) {
        spots += 1;
        for (let c = 0; c < 3; c += 1) glint.data[3 * ((cy + y) * 256 + cx + x) + c] = 1.5;
      }
    const share = specularShare(glint, r.mask, luma);
    console.log(`specular share ${(specularShare(d, r.mask, luma) * 100).toFixed(2)} % → with glints ${(share * 100).toFixed(2)} % (they cover ${((spots / (256 * 192)) * 100).toFixed(2)} %)`);
    expect(share).toBeGreaterThan(0.01);
    expect(share).toBeGreaterThan(0.8 * (spots / (256 * 192)));
  });
});

describe('the scan and the panorama', () => {
  it('finds the room’s planes in a scan, Y- or Z-up, named by which way they face', () => {
    for (const up of ['y', 'z'] as const) {
      const planes = fitPlanes(scanCloud(0.05, { up }), { threshold: 0.02, up });
      expect(planes).toHaveLength(6);
      const labels = planes.map((p) => p.label).sort();
      expect(labels).toEqual(up === 'y' ? ['ceiling', 'floor', 'wall facing +X', 'wall facing +Z', 'wall facing −X', 'wall facing −Z'] : ['ceiling', 'floor', 'wall facing +X', 'wall facing +Y', 'wall facing −X', 'wall facing −Y']);
      for (const p of planes) expect(p.rms).toBeLessThan(0.002);
      const floor = planes.find((p) => p.label === 'floor')!;
      expect(toCanonical(floor.normal, up)[1]).toBeGreaterThan(0.999);
      expect(Math.abs(floor.d)).toBeLessThan(0.003);
    }
  });

  it('finds where the panorama was taken, and its heading, from a coloured scan', () => {
    const pano = panoramaGrey(renderPanorama(2048, 1024, PANO_POSITION, 25, 1, 1), luma, 1024);
    const cloud = scanCloud(0.05, { up: 'z' });
    const t0 = Date.now();
    const est = estimatePanoramaPose(pano, cloud, 'z', { unitMetres: 1, floor: 0 })!;
    const truth = [PANO_POSITION[0], -PANO_POSITION[2], PANO_POSITION[1]];
    const err = Math.hypot(...est.position.map((v, i) => v - truth[i]!));
    console.log(`panorama pose from the scan: ${(err * 100).toFixed(1)} cm from where it was, heading ${est.heading.toFixed(2)}° (true 25°), ${Date.now() - t0} ms`);
    expect(err).toBeLessThan(0.08);
    expect(Math.abs(est.heading - 25)).toBeLessThan(0.75);
    // Without colour there is nothing to match: no estimate.
    expect(estimatePanoramaPose(pano, scanCloud(0.1, { up: 'z', colour: false }), 'z', { unitMetres: 1 })).toBeNull();
  }, 60_000);

  it('matches a photo taken where the panorama was to its direction within a fraction of a degree', () => {
    const pano = panoramaGrey(renderPanorama(1024, 512, PANO_POSITION, 0), luma, 1024);
    for (const sp of SAMPLE_PHOTOS) {
      const dir = sub(sp.camera.target, sp.camera.eye);
      const cam: SynthCamera = { ...sp.camera, eye: PANO_POSITION, target: [PANO_POSITION[0] + dir[0], PANO_POSITION[1] + dir[1], PANO_POSITION[2] + dir[2]], width: 320, height: 240 };
      const c = cameraOf(cam);
      const truth = anglesOf(c.R);
      const m = matchToPanorama(pano, photoGrey(renderPhoto(cam), luma, 160, c.intr, 320), fovOf(c.intr, 320));
      console.log(`${sp.id} from the panorama's centre: yaw error ${wrapDeg(m.yaw - truth.yaw).toFixed(2)}°, pitch ${(m.pitch - truth.pitch).toFixed(2)}°, NCC ${m.score.toFixed(2)}, confidence ${m.confidence.toFixed(2)}`);
      expect(Math.abs(wrapDeg(m.yaw - truth.yaw))).toBeLessThan(0.75);
      expect(Math.abs(m.pitch - truth.pitch)).toBeLessThan(0.75);
      expect(m.confidence).toBeGreaterThan(0.5);
    }
  });
});

/** The sample set as a project and an IO, at a size the tests can afford. */
function sampleBuild(o: SampleSetOptions, regionSettings: Partial<TextureRegion['settings']> = {}, pano: { position: 'given' | 'unknown' } = { position: 'given' }) {
  const r = parseHandoff(JSON.stringify(SAMPLE_HANDOFF));
  if (!r.ok) throw new Error('bad sample');
  let p: Project = createProject(r.handoff, 'sample', 'ana', NOW);
  for (const ref of sampleReferences(o, pano)) {
    const x = addTextureReference(p, '040_010', ref, 'ana', NOW);
    if (!x.ok) throw new Error(x.reason);
    p = x.project;
  }
  for (const reg of sampleRegions(o)) {
    const ph = textureDoc(shotState(p, '040_010'))!.references.find((q) => q.path === reg.photo)!;
    const x = addTextureRegion(p, '040_010', { photoId: ph.id, corners: reg.corners, name: reg.name, size: reg.size, settings: regionSettings }, 'ana', NOW);
    if (!x.ok) throw new Error(x.reason);
    p = x.project;
  }
  const doc = textureDoc(shotState(p, '040_010'))!;
  const cache = new Map<string, LinearImage | PointCloud>();
  const get = (id: string) => {
    const ref = doc.references.find((q) => q.id === id)!;
    let v = cache.get(ref.path);
    if (!v) cache.set(ref.path, (v = renderSample(ref.path, o)));
    return v;
  };
  const io: TextureIO = {
    picture: async (id, max) => {
      const img = get(id) as LinearImage;
      if (!max || Math.max(img.width, img.height) <= max) return img;
      const k = max / Math.max(img.width, img.height);
      return resizeLinear(img, Math.round(img.width * k), Math.round(img.height * k));
    },
    scan: async (id) => get(id) as PointCloud,
  };
  return { project: p, doc, io };
}

describe('placement on the scan, end to end', () => {
  it('puts each photographed region on the right plane within centimetres, through parallax, and suggests its panorama direction', async () => {
    const o: SampleSetOptions = { photo: { width: 800, height: 600, supersample: 1 }, panorama: { width: 2048, supersample: 1, heading: 25 }, scan: { spacing: 0.05, up: 'z' } };
    const { project, doc, io } = sampleBuild(o, { tile: 'xy', output: { mode: 'density', density: 160, resolution: 1024 } });
    const t0 = Date.now();
    const outputs: string[] = [];
    const out = await buildTextures(io, doc, { luma, revision: doc.revision, maxTexture: 384, maxPhoto: null }, (r) => void outputs.push(r.regionId));
    const ms = Date.now() - t0;
    expect(out.heading!.from).toBe('scan');
    console.log(`end to end (3 photos 800×600, a 2048 panorama, ${out.cloud!.count} scan points, the panorama's position surveyed): ${ms} ms; heading ${out.heading!.value.toFixed(2)}° (true 25°)`);
    expect(out.result.panoramaPose).toMatchObject({ positionFrom: 'given', headingFrom: 'scan' });
    expect(Math.abs(out.heading!.value - 25)).toBeLessThan(1);
    expect(out.result.planes).toHaveLength(6);
    expect(outputs).toEqual(doc.regions.map((r) => r.id));
    const expected: Record<string, string> = { back: 'wall facing +Y', west: 'wall facing +X', floor: 'floor' };
    for (const sp of SAMPLE_PHOTOS) {
      const region = doc.regions.find((r) => r.name === sp.region.name)!;
      const rec = out.result.regions.find((r) => r.regionId === region.id)!;
      const plane = out.result.planes.find((p) => p.id === rec.metrics.planeId)!;
      expect(plane.label).toBe(expected[sp.region.surface]);
      // The truth in scan coordinates (z-up): the rectangle's centre.
      const truth = rectCorners3d(sp.region).map((c) => [c[0], -c[2], c[1]]);
      const centre = [0, 1, 2].map((i) => truth.reduce((a, q) => a + q[i]!, 0) / 4);
      const sugg = out.result.placements.find((x) => x.photoId === region.photoId)!.suggested;
      const err = Math.hypot(sugg.hit![0] - centre[0]!, sugg.hit![1] - centre[1]!, sugg.hit![2] - centre[2]!);
      const want = canonicalToPanorama(sub(toCanonical(centre, 'z'), PANO_POSITION), 25);
      const dirErr = Math.hypot(wrapDeg(sugg.direction.yawDeg - want.yaw), sugg.direction.pitchDeg - want.pitch);
      console.log(`${sp.region.name}: on ${plane.label}, centre ${(err * 100).toFixed(1)} cm from the truth, direction ${dirErr.toFixed(2)}° off; NCC ${sugg.score}, confidence ${sugg.confidence}; texture ${rec.metrics.width}×${rec.metrics.height}, seam ${rec.metrics.seamScore}, light ${rec.metrics.residualBefore} → ${rec.metrics.residualAfter} stops, confidence ${rec.confidence}`);
      expect(err).toBeLessThan(0.03);
      expect(dirErr).toBeLessThan(1);
      expect(rec.metrics.seamScore!).toBeLessThan(1.6);
      expect(rec.metrics.residualAfter).toBeLessThan(0.25);
      expect(rec.metrics.texelDensity).toBe(160);
    }
    // The floor's photo has fewer pixels per metre than 160: flagged as upsampled.
    const floor = out.result.regions.find((r) => r.regionId === doc.regions.find((x) => x.name === 'Floor tiles')!.id)!;
    expect(floor.metrics.nativeDensity!).toBeLessThan(160 / 1.25);
    // The domain takes the build as it is: placements suggested (not decided), the task up for review.
    const recorded = recordTextureRun(project, '040_010', out.result, 'ana', NOW);
    if (!recorded.ok) throw new Error(recorded.reason);
    const d = textureDoc(shotState(recorded.project, '040_010'))!;
    expect(d.placements.every((x) => x.decision === 'pending')).toBe(true);
    expect(d.records.find((r) => r.regionId === floor.regionId)!.reason).toContain('too low a texel density');
    expect(shotState(recorded.project, '040_010')!.tasks[0]!.state).toBe('needs_review');
  }, 120_000);
});

describe('mesh and metadata', () => {
  it('writes planar patches as OBJ + MTL that read back with their UVs, normals and textures', () => {
    const quads = SAMPLE_PHOTOS.map((sp) => ({ name: sp.region.name, corners: rectCorners3d(sp.region) as [number, number, number][], texture: `${sp.id}.png` }));
    const obj = writeObj(quads, 'set.mtl', ['VC VFX test']);
    const mtl = writeMtl(quads);
    const parsed = parseObjText(obj);
    expect(parsed.mtllib).toEqual(['set.mtl']);
    expect(parsed.vertices).toHaveLength(12);
    expect(parsed.uvs).toHaveLength(12);
    expect(parsed.objects.map((x) => x.name)).toEqual(['Brick_wall', 'Plaster_wall', 'Floor_tiles']);
    const mats = parseMtlText(mtl);
    for (const [i, ob] of parsed.objects.entries()) {
      expect(mats.get(ob.material!)).toBe(quads[i]!.texture);
      const f = ob.faces[0]!;
      expect(f.v).toHaveLength(4);
      // The face is wound counter-clockwise seen from the room, and its normal faces the room.
      const [a, b, c] = f.v.map((k) => parsed.vertices[k]!);
      const n = cornerNormal(quads[i]!.corners);
      const e1 = sub(b!, a!);
      const e2 = sub(c!, a!);
      const wound = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      expect(wound[0]! * n[0] + wound[1]! * n[1] + wound[2]! * n[2]).toBeGreaterThan(0);
      const surf = ['back', 'west', 'floor'][i]!;
      const want = { back: [0, 0, -1], west: [1, 0, 0], floor: [0, 1, 0] }[surf]!;
      expect(parsed.normals[f.vn[0]!]!).toEqual(want.map((v) => v));
      // UVs: top-left (0,1) … bottom-left (0,0).
      expect(f.vt.map((k) => parsed.uvs[k])).toEqual([[0, 0], [1, 0], [1, 1], [0, 1]]);
    }
  });

  it('reads a still’s camera from its EXIF', () => {
    // A minimal JPEG: SOI, APP1 Exif with Make, Model, an Exif IFD with FocalLength 24/1 and 35 mm equivalent 36.
    const tiff: number[] = [];
    const u16 = (v: number) => tiff.push(v & 0xff, v >> 8);
    const u32 = (v: number) => tiff.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24);
    tiff.push(0x49, 0x49);
    u16(42);
    u32(8);
    // IFD0: 3 entries.
    u16(3);
    const make = 'Canon\0';
    const model = 'Canon EOS R5\0';
    const ifd0End = 8 + 2 + 3 * 12 + 4;
    u16(0x010f), u16(2), u32(make.length), u32(ifd0End);
    u16(0x0110), u16(2), u32(model.length), u32(ifd0End + make.length);
    const exifAt = ifd0End + make.length + model.length;
    u16(0x8769), u16(4), u32(1), u32(exifAt);
    u32(0);
    for (const ch of make + model) tiff.push(ch.charCodeAt(0));
    // Exif IFD: 2 entries.
    u16(2);
    const ratAt = exifAt + 2 + 2 * 12 + 4;
    u16(0x920a), u16(5), u32(1), u32(ratAt);
    u16(0xa405), u16(3), u32(1), u32(36);
    u32(0);
    u32(24), u32(1);
    const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, (app1.length + 2) >> 8, (app1.length + 2) & 0xff, ...app1, 0xff, 0xd9]);
    const e = parseExif(jpeg)!;
    expect(e).toMatchObject({ make: 'Canon', model: 'Canon EOS R5', focalMm: 24, focal35Mm: 36 });
    expect(cameraFromExif(e)).toEqual({ body: 'Canon EOS R5', lens: '', focalMm: 24, filmBackWidthMm: 24 });
    expect(parseExif(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
  });
});
