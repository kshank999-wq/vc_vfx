import {
  TEXTURE_UNIT_METRES,
  textureConfidence,
  textureSizeMetres,
  type TextureMetrics,
  type TexturePlacement,
  type TexturePlane,
  type TextureReference,
  type TextureRegion,
  type TextureRunResult,
} from '@vcvfx/domain';
import type { Intrinsics } from '../camera/geometry';
import type { PointCloud } from '../camera/lidar';
import type { LinearImage } from '../key/linear';
import { applyGain, delight, medianLuminance } from './delight';
import { add, cameraRotation, cross, dot3, fovOf, fromCanonical, len, photoIntrinsics, pixelRay, rotT, scale, sub, toCanonical, unit, type V3 } from './geometry';
import { estimateHeading, estimatePanoramaPose, matchToPanorama, panoramaGrey, panoramaToCanonical, photoGrey, type PanoramaGrey, type PanoramaMatch } from './panorama';
import { directionTo, placeRegion, planeMap, type PlaneMap, type RegionPlacement, type RegionTemplate } from './placement';
import { firstHit, fitPlanes, hitPlane, type FittedPlane } from './planes';
import { photoProblems, photoWhite, specularShare } from './problems';
import { cornerAspect, desqueezeCorners, focalAspect, pinholeCorners, rectangleFocal, rectifyRegion } from './rectify';
import { makeTileable } from './seamless';

/**
 * The texture-extraction engine (master spec §12; addendum 12 §3): pure
 * TypeScript on typed arrays in linear light, the same code in the desktop's
 * worker thread and in the browser preview.
 *
 * A build, from source + settings:
 *  1. the scan's dominant planes (RANSAC), when there is a scan;
 *  2. the panorama's heading in the scan (given, or from a coloured scan);
 *  3. every photo matched against the panorama → which way it looked; its
 *     regions' centre and corner rays → the scan plane each one is on and
 *     the planar patch it covers (the artist's own placement or plane wins);
 *  4. a quick pass over every region (small) for its delit brightness, so
 *     regions of one surface are brought to one exposure;
 *  5. every region in full: undistorted and rectified, delit, exposure
 *     matched, made to tile when asked, measured (texel density, residual
 *     light, detail kept, seam visibility, sharpness, clipping, glints) and
 *     scored.
 * Nothing here reads or writes files: `TextureIO` hands the pictures in.
 */

export interface TextureIO {
  /** A photo or the panorama in linear working RGB, its long edge at most `maxLong` (null: the file's own size). */
  picture(id: string, maxLong: number | null): Promise<LinearImage>;
  scan(id: string): Promise<PointCloud>;
  signal?: { aborted: boolean };
}

export interface TextureInputs {
  references: readonly TextureReference[];
  regions: readonly TextureRegion[];
  placements: readonly TexturePlacement[];
}

export interface TextureBuildOptions {
  luma: readonly [number, number, number];
  /** The settings revision built. */
  revision: number;
  /** Longest texture edge (the review build); null: each region's own output size (the export). */
  maxTexture: number | null;
  /** Longest photo edge read for the full pass; null: the file's size. */
  maxPhoto: number | null;
  /** The working space's value of a display photo's white (1 for ACEScg from sRGB). */
  displayWhite?: number;
  progress?(done: number, total: number, label?: string): void;
  /** Only these regions (e.g. one, after a change); placements and exposure still look at all. */
  only?: readonly string[];
}

export interface RegionOutput {
  regionId: string;
  /** Rectified (and exposure matched), before delighting. */
  original: LinearImage;
  delit: LinearImage;
  /** The tile, when made to tile. */
  tiled: LinearImage | null;
  /** 1 where the texel came from inside the photo (the final texture's size). */
  mask: Uint8Array;
  metrics: TextureMetrics;
  confidence: number;
  /** Photo pixel (the file's, undistorted when `undistorted`) → texture pixel of `original`. */
  H: number[];
  undistorted: boolean;
  /** Texels per metre of the output at its full size, or null. */
  texelDensity: number | null;
  /** The planar patch in scan coordinates (TL, TR, BR, BL), or null. */
  patch: V3[] | null;
}

export interface PhotoPlacementOut {
  photoId: string;
  /** The photo's direction match against the panorama, when one was made. */
  match: PanoramaMatch | null;
  fov: number | null;
}

export interface TextureBuildOutput {
  result: TextureRunResult;
  planes: FittedPlane[];
  /** The scan as fitted (downsampled), scan coordinates relative to its origin. */
  cloud: PointCloud | null;
  heading: { value: number; from: 'given' | 'scan' | 'default'; confidence: number } | null;
  panoramaPosition: V3 | null;
  photos: PhotoPlacementOut[];
  /** Every region's planar patch (scan coordinates), where it has one. */
  patches: { regionId: string; corners: V3[] }[];
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** The texture size of a region: its aspect and output setting, capped. */
export function regionOutputSize(region: TextureRegion, aspect: number, cap: number | null): { width: number; height: number; full: { width: number; height: number } } {
  const s = region.settings.output;
  const m = textureSizeMetres(region.size);
  let W: number;
  let H: number;
  if (s.mode === 'density' && m) {
    W = Math.round(m.width * s.density);
    H = Math.round(m.height * s.density);
  } else if (aspect >= 1) {
    W = s.resolution;
    H = Math.round(s.resolution / aspect);
  } else {
    H = s.resolution;
    W = Math.round(s.resolution * aspect);
  }
  const big = Math.max(W, H);
  if (big > 8192) {
    W = Math.round((W * 8192) / big);
    H = Math.round((H * 8192) / big);
  }
  W = Math.max(16, W);
  H = Math.max(16, H);
  const full = { width: W, height: H };
  if (cap && Math.max(W, H) > cap) {
    const k = cap / Math.max(W, H);
    return { width: Math.max(16, Math.round(W * k)), height: Math.max(16, Math.round(H * k)), full };
  }
  return { width: W, height: H, full };
}

/** Where the quadrilateral's diagonals cross (its perspective centre). */
function quadCentre(q: readonly (readonly [number, number])[]): [number, number] {
  const [a, b, c, d] = q as [readonly [number, number], readonly [number, number], readonly [number, number], readonly [number, number]];
  const x1 = a[0], y1 = a[1], x2 = c[0], y2 = c[1], x3 = b[0], y3 = b[1], x4 = d[0], y4 = d[1];
  const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(den) < 1e-9) return [(x1 + x2 + x3 + x4) / 4, (y1 + y2 + y3 + y4) / 4];
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
  return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
}

/** A patch of real size on a plane, centred where the region's rays put it (or the plane's centroid). */
function sizedPatch(plane: TexturePlane, centre: V3 | null, rayPatch: V3[] | null, w: number, h: number): V3[] {
  const n = plane.normal as V3;
  let eu: V3 = plane.axisU as V3;
  if (rayPatch) {
    const top = add(sub(rayPatch[1]!, rayPatch[0]!), sub(rayPatch[2]!, rayPatch[3]!));
    const inPlane = sub(top, scale(n, dot3(top, n)));
    if (len(inPlane) > 1e-9) eu = unit(inPlane);
  }
  // Texture down, in the plane: perpendicular to u, on the side n × u is not (v up on a wall).
  let ed = unit(cross(eu, n));
  if (rayPatch) {
    const down = add(sub(rayPatch[3]!, rayPatch[0]!), sub(rayPatch[2]!, rayPatch[1]!));
    if (dot3(down, ed) < 0) ed = scale(ed, -1);
  } else if (dot3(ed, plane.axisV) > 0) ed = scale(ed, -1);
  const c = centre ?? (plane.centroid as V3);
  const hu = scale(eu, w / 2);
  const hd = scale(ed, h / 2);
  return [sub(sub(c, hu), hd), sub(add(c, hu), hd), add(add(c, hu), hd), add(sub(c, hu), hd)];
}

export async function buildTextures(io: TextureIO, inputs: TextureInputs, o: TextureBuildOptions, onRegion: (out: RegionOutput) => Promise<void> | void): Promise<TextureBuildOutput> {
  const signal = io.signal;
  const check = () => {
    if (signal?.aborted) throw new Error('Cancelled');
  };
  const refs = new Map(inputs.references.map((r) => [r.id, r]));
  const photos = inputs.references.filter((r) => r.kind === 'photo');
  const panoRef = inputs.references.find((r) => r.kind === 'panorama') ?? null;
  const scanRef = inputs.references.find((r) => r.kind === 'scan') ?? null;
  const regions = inputs.regions.filter((r) => r.enabled && refs.get(r.photoId)?.kind === 'photo');
  const built = o.only ? regions.filter((r) => o.only!.includes(r.id)) : regions;
  if (!built.length) throw new Error('Mark a region on a photo first (step 2).');
  const total = 3 + photos.length + built.length;
  let done = 0;
  const step = (label?: string) => o.progress?.(++done, total, label);

  // 1. The scan's planes.
  let cloud: PointCloud | null = null;
  let planes: FittedPlane[] = [];
  const up = scanRef?.scan?.up ?? 'y';
  const unitM = scanRef?.scan ? TEXTURE_UNIT_METRES[scanRef.scan.units] : 1;
  if (scanRef) {
    const raw = await io.scan(scanRef.id);
    check();
    planes = fitPlanes(raw, { threshold: 0.02 / unitM, up });
    cloud = raw;
  }
  step('planes');

  // 2. The panorama and its heading.
  let grey: PanoramaGrey | null = null;
  let pano: LinearImage | null = null;
  let heading: TextureBuildOutput['heading'] = null;
  let position: V3 | null = null;
  let pose: TextureRunResult['panoramaPose'] = null;
  if (panoRef) {
    pano = await io.picture(panoRef.id, 4096);
    check();
    grey = panoramaGrey(pano, o.luma, 1024);
    const given = (panoRef.panorama?.position as V3 | null) ?? null;
    const givenHeading = panoRef.panorama?.headingDeg ?? null;
    if (given) position = given;
    if (!given && cloud) {
      // Where it was taken (and its heading) from the coloured scan.
      const floor = planes.find((p) => p.label === 'floor');
      const est = estimatePanoramaPose(grey, cloud, up, { unitMetres: unitM, heading: givenHeading, floor: floor ? toCanonical(floor.centroid, up)[1] : null, ...(signal ? { signal } : {}) });
      if (est) {
        position = est.position;
        heading = givenHeading !== null ? { value: givenHeading, from: 'given', confidence: 1 } : { value: est.heading, from: 'scan', confidence: est.confidence };
        pose = { position: est.position.map(r3) as V3, headingDeg: r3(heading.value), positionFrom: 'scan', headingFrom: heading.from, confidence: r3(est.confidence) };
      }
    }
    if (!position) position = cloud ? ([0, 1, 2].map((k) => (cloud!.bbox.min[k]! + cloud!.bbox.max[k]!) / 2) as V3) : [0, 0, 0];
    if (!heading) {
      if (givenHeading !== null) heading = { value: givenHeading, from: 'given', confidence: 1 };
      else {
        const est = cloud ? estimateHeading(grey, cloud, up, position) : null;
        heading = est ? { value: est.heading, from: 'scan', confidence: est.confidence } : { value: 0, from: 'default', confidence: 0.3 };
      }
    }
    pose ??= { position: position.map(r3) as V3, headingDeg: r3(heading.value), positionFrom: given ? 'given' : 'default', headingFrom: heading.from, confidence: r3(heading.confidence * (given ? 1 : 0.5)) };
  }
  step('panorama');

  // 3. Plane maps: the panorama projected onto every plane (for finding regions on the scan).
  const maps: PlaneMap[] = [];
  if (pano && heading && position && planes.length) {
    for (const pl of planes) {
      check();
      const r = Math.max(0.5 / unitM, len(sub(pl.centroid, position)));
      const density = Math.max(10 / unitM, Math.min(100 / unitM, pano.width / (2 * Math.PI * r)));
      maps.push(planeMap(pano, pl, planes, { position, heading: heading.value, up, density, luma: o.luma }));
    }
  }
  step('plane maps');

  // 4. Photos: where each region is on the scan, and a quick pass for each region's delit brightness.
  const photoOut: PhotoPlacementOut[] = [];
  const placements: TextureRunResult['placements'] = [];
  type RegionPlan = { region: TextureRegion; plane: TexturePlane | null; planeConfidence: number; patch: V3[] | null; aspect: number; aspectFrom: TextureMetrics['aspectFrom']; median: number; placement: RegionPlacement | null };
  const plan = new Map<string, RegionPlan>();
  for (const ph of photos) {
    check();
    const own = regions.filter((r) => r.photoId === ph.id);
    const fullW = ph.width ?? 1;
    const fullH = ph.height ?? 1;
    const par = ph.pixelAspect ?? 1;
    const intr = photoIntrinsics(ph.camera, fullW, fullH, null, par);
    const decided = inputs.placements.find((x) => x.photoId === ph.id);
    if (!own.length) {
      step();
      continue;
    }
    const small = await io.picture(ph.id, 1024);
    // The photo's direction from the panorama, when something needs it: a region without a real size, or no scan.
    let match: PanoramaMatch | null = null;
    let fov: number | null = intr ? fovOf(intr, fullW) : null;
    const directionMatch = () => {
      if (!match && grey && heading) {
        match = matchToPanorama(grey, photoGrey(small, o.luma, 160, intr, fullW, par), fov, { ...(signal ? { signal } : {}) });
        fov = fov ?? match.fov;
      }
      return match;
    };
    const lensFor = (): Intrinsics | null => intr ?? (fov ? photoIntrinsics(null, fullW, fullH, fov, par) : null);
    let best: { region: TextureRegion; placement: RegionPlacement } | null = null;
    for (const region of own) {
      check();
      const pinhole = pinholeCorners(region.corners, intr);
      // Shape is measured on the de-squeezed picture (addendum 17).
      const physical = desqueezeCorners(pinhole, par);
      const m = textureSizeMetres(region.size);
      // The aspect: the real size, else the focal length, else the corners.
      let aspect: number;
      let aspectFrom: TextureMetrics['aspectFrom'];
      if (m) {
        aspect = m.width / m.height;
        aspectFrom = 'size';
      } else {
        // The focal length: the lens's, else the one at which these corners are a rectangle (both vanishing points finite).
        const cxp = ((fullW - 1) / 2) * par;
        const cyp = (fullH - 1) / 2;
        const fRect = intr ? null : rectangleFocal(physical, cxp, cyp);
        const fUse = intr ? intr.f : fRect && fRect > 0.25 * fullW * par && fRect < 20 * fullW * par ? fRect : null;
        const fa = fUse ? focalAspect(physical, fUse, intr ? intr.cx * par : cxp, intr ? intr.cy : cyp) : null;
        aspect = fa ?? cornerAspect(physical);
        aspectFrom = fa ? 'focal' : 'corners';
      }
      if (!region.settings.rectify) {
        const xs = physical.map((p) => p[0]);
        const ys = physical.map((p) => p[1]);
        aspect = (Math.max(...xs) - Math.min(...xs)) / Math.max(1, Math.max(...ys) - Math.min(...ys));
        aspectFrom = 'corners';
      }
      const editedPlane = decided?.decision === 'edited' ? (decided.edited?.planeId ?? null) : null;
      const chosenId = region.target.planeId ?? editedPlane;
      const chosen = chosenId ? (planes.find((x) => x.id === chosenId) ?? null) : null;
      const rejected = decided?.decision === 'rejected' && !region.target.planeId;
      let placement: RegionPlacement | null = null;
      let plane: TexturePlane | null = chosen;
      let planeConfidence = chosen ? 1 : 0;
      let patch: V3[] | null = null;
      if (maps.length && !rejected && !(decided?.decision === 'edited' && !region.target.planeId)) {
        const cache = new Map<string, RegionTemplate>();
        const makeTemplate = (sw: number, density: number): RegionTemplate => {
          const key = `${sw.toFixed(5)}|${density.toFixed(5)}`;
          const hit = cache.get(key);
          if (hit) return hit;
          const tw = Math.max(4, Math.round(sw * density));
          const th = Math.max(4, Math.round((sw / aspect) * density));
          const r = rectifyRegion({ photo: small, fullWidth: fullW, fullHeight: fullH, corners: region.corners, intr, undistort: region.settings.undistort, rectify: region.settings.rectify, width: tw, height: th, texelDensity: null });
          const g = new Float32Array(tw * th);
          for (let i = 0; i < tw * th; i += 1) g[i] = Math.sqrt(Math.max(0, o.luma[0] * r.image.data[3 * i]! + o.luma[1] * r.image.data[3 * i + 1]! + o.luma[2] * r.image.data[3 * i + 2]!));
          const t = { grey: g, width: tw, height: th, surfaceWidth: sw, surfaceHeight: sw / aspect };
          cache.set(key, t);
          return t;
        };
        const candidates = chosen ? maps.filter((x) => x.plane.id === chosen.id) : maps;
        let guess: { planeId: string; width: number } | null = null;
        if (!m) {
          // Without a real size: roughly where and how big, from the photo's direction (parallax and all).
          const mt = directionMatch();
          const lens = lensFor();
          if (mt && lens && position && heading) {
            const R = cameraRotation(mt.yaw + heading.value, mt.pitch, mt.roll);
            const ray = (u: number, v: number) => fromCanonical(rotT(R, pixelRay(lens, u, v)), up);
            const [cu, cv] = quadCentre(region.corners);
            const hit = chosen ? (hitPlane(chosen, position, ray(cu, cv), 10) ? { plane: chosen } : null) : firstHit(planes, position, ray(cu, cv));
            if (hit) {
              const c = region.corners.map(([u, v]) => hitPlane(hit.plane, position!, ray(u, v), 10)?.point ?? null);
              if (c.every((q) => q !== null)) {
                const top = (len(sub(c[1]!, c[0]!)) + len(sub(c[2]!, c[3]!))) / 2;
                const side = (len(sub(c[3]!, c[0]!)) + len(sub(c[2]!, c[1]!))) / 2;
                guess = { planeId: hit.plane.id, width: Math.max(0.1 / unitM, top) };
                // No focal length: the region's aspect from where its corners meet the plane.
                if (aspectFrom === 'corners' && region.settings.rectify && side > 0) {
                  aspect = top / side;
                  aspectFrom = 'plane';
                }
              }
            }
          }
        }
        if (m || guess) placement = placeRegion(candidates, makeTemplate, { knownWidth: m ? m.width / unitM : null, aspect, guess, ...(signal ? { signal } : {}) });
        if (placement) {
          plane = placement.plane;
          planeConfidence = chosen ? Math.max(0.5, placement.confidence) : placement.confidence;
          patch = placement.patch;
          if (!best || placement.confidence > best.placement.confidence) best = { region, placement };
        }
      }
      if (!patch && decided?.decision === 'edited' && decided.edited && position && heading && (plane ?? chosen)) {
        // The artist's own placement: the region where their direction meets their plane.
        const pl = (plane ?? chosen)!;
        const d = fromCanonical(panoramaToCanonical(decided.edited.direction.yawDeg, decided.edited.direction.pitchDeg, heading.value), up);
        const hit = hitPlane(pl, position, d, 10);
        if (hit) {
          const w = m ? m.width / unitM : (pl.extent.u1 - pl.extent.u0) / 3;
          patch = sizedPatch(pl, hit.point, null, w, w / aspect);
          planeConfidence = 1;
        }
      }
      if (!patch && plane) {
        const w = m ? m.width / unitM : (plane.extent.u1 - plane.extent.u0) / 3;
        patch = sizedPatch(plane, null, null, w, w / aspect);
      }
      // The quick pass: small, delit, its median brightness (for exposure matching).
      const quick = regionOutputSize(region, aspect, 128);
      const rq = rectifyRegion({ photo: small, fullWidth: fullW, fullHeight: fullH, corners: region.corners, intr, undistort: region.settings.undistort, rectify: region.settings.rectify, width: quick.width, height: quick.height, texelDensity: null, ...(signal ? { signal } : {}) });
      const dq = region.settings.delight > 0 ? delight(rq.image, rq.mask, o.luma, { strength: region.settings.delight, radius: region.settings.delightRadius }).image : rq.image;
      plan.set(region.id, { region, plane, planeConfidence: r3(planeConfidence), patch: patch ? (patch.map((p) => p.map((v) => Math.round(v * 1e5) / 1e5)) as V3[]) : null, aspect, aspectFrom, median: medianLuminance(dq, rq.mask, o.luma), placement });
    }
    // The photo's suggestion: where its best-placed region is, seen from the panorama; else its direction match.
    if (grey && heading && position) {
      const fovDeg = r3(fov ?? 60);
      if (best) {
        const dir = directionTo(best.placement.centre, { position, heading: heading.value, up });
        placements.push({
          photoId: ph.id,
          suggested: {
            direction: { yawDeg: r3(dir.yaw), pitchDeg: r3(dir.pitch), rollDeg: 0, fovDeg },
            planeId: best.placement.plane.id,
            hit: best.placement.centre.map(r3) as V3,
            confidence: r3(best.placement.confidence * (heading.from === 'given' ? 1 : 0.5 + 0.5 * heading.confidence)),
            score: r3(Math.max(-1, Math.min(1, best.placement.score))),
            method: 'panorama',
            note: `${best.region.name} found on ${best.placement.plane.label} in the panorama projected onto the scan (NCC ${best.placement.score.toFixed(2)}, next best ${best.placement.runnerUp.toFixed(2)}); panorama ${pose?.positionFrom === 'scan' ? 'placed from the coloured scan' : pose?.positionFrom === 'given' ? 'where you put it' : 'assumed at the middle of the scan'}, heading ${heading.value.toFixed(1)}° ${heading.from === 'given' ? 'given' : heading.from === 'scan' ? 'from the scan' : 'unknown (0°)'}`,
          },
        });
      } else {
        const mt = directionMatch() as PanoramaMatch | null;
        if (mt) {
          const d = panoramaToCanonical(mt.yaw, mt.pitch, heading.value);
          const hit = planes.length ? firstHit(planes, position, fromCanonical(d, up)) : null;
          placements.push({
            photoId: ph.id,
            suggested: {
              direction: { yawDeg: r3(mt.yaw), pitchDeg: r3(mt.pitch), rollDeg: r3(mt.roll), fovDeg: r3(mt.fov) },
              planeId: hit?.plane.id ?? null,
              hit: hit ? (hit.point.map(r3) as V3) : null,
              // Matched by direction from where the panorama was: parallax makes this rough near the camera.
              confidence: r3(0.6 * mt.confidence * (heading.from === 'given' ? 1 : 0.5 + 0.5 * heading.confidence)),
              score: r3(Math.max(-1, Math.min(1, mt.score))),
              method: 'panorama',
              note: `Matched by direction (NCC ${mt.score.toFixed(2)}, next best ${mt.runnerUp.toFixed(2)}): rough where the photo was taken away from the panorama. Enter the regions’ real size for a placement on the scan.`,
            },
          });
        }
      }
    }
    photoOut.push({ photoId: ph.id, match, fov });
    step();
  }

  // 5. Exposure: regions of one surface brought to the geometric mean of their brightness.
  const gains = new Map<string, number>();
  const groups = new Map<string, RegionPlan[]>();
  for (const p of plan.values()) {
    if (!p.region.settings.exposureMatch || !p.plane || !(p.median > 0)) continue;
    groups.set(p.plane.id, [...(groups.get(p.plane.id) ?? []), p]);
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const target = Math.exp(g.reduce((a, p) => a + Math.log(p.median), 0) / g.length);
    for (const p of g) gains.set(p.region.id, target / p.median);
  }

  // 6. Every region in full.
  const records: TextureRunResult['regions'] = [];
  const white = o.displayWhite ?? 1;
  for (const ph of photos) {
    const own = built.filter((r) => r.photoId === ph.id);
    if (!own.length) continue;
    check();
    const fullW = ph.width ?? 1;
    const fullH = ph.height ?? 1;
    const intr = photoIntrinsics(ph.camera, fullW, fullH, null, ph.pixelAspect ?? 1);
    const photo = await io.picture(ph.id, o.maxPhoto);
    const displayReferred = !ph.encoding || ph.encoding === 'srgb' || ph.encoding === 'rec709';
    const whiteHere = photoWhite(photo, displayReferred, white);
    for (const region of own) {
      check();
      const p = plan.get(region.id)!;
      const size = regionOutputSize(region, p.aspect, o.maxTexture);
      const m = textureSizeMetres(region.size);
      const texelDensity = m ? size.full.width / m.width : null;
      const rect = rectifyRegion({ photo, fullWidth: fullW, fullHeight: fullH, corners: region.corners, intr, undistort: region.settings.undistort, rectify: region.settings.rectify, width: size.width, height: size.height, texelDensity: m ? size.width / m.width : null, ...(signal ? { signal } : {}) });
      const gain = gains.get(region.id) ?? 1;
      const original = applyGain(rect.image, gain);
      const d = delight(original, rect.mask, o.luma, { strength: region.settings.delight, radius: region.settings.delightRadius });
      const delit = region.settings.delight > 0 ? d.image : original;
      let tiled: LinearImage | null = null;
      let seamScore: number | null = null;
      let mask = rect.mask;
      if (region.settings.tile !== 'none') {
        const t = makeTileable(delit, region.settings.tile, region.settings.tileOverlap, o.luma, Math.max(1, 1 / Math.max(1e-3, rect.minScale * (photo.width / fullW))));
        tiled = t.image;
        seamScore = r3(t.score);
        // The tile's mask: the texture's, cut to the tile.
        const tm = new Uint8Array(t.image.width * t.image.height);
        for (let y = 0; y < t.image.height; y += 1) for (let x = 0; x < t.image.width; x += 1) tm[y * t.image.width + x] = rect.mask[y * delit.width + x]!;
        mask = tm;
      }
      const probs = photoProblems(photo, region.corners, fullW, o.luma, whiteHere);
      const metrics: TextureMetrics = {
        width: tiled ? Math.round((tiled.width * size.full.width) / size.width) : size.full.width,
        height: tiled ? Math.round((tiled.height * size.full.height) / size.height) : size.full.height,
        texelDensity: texelDensity !== null ? r3(texelDensity) : null,
        nativeDensity: rect.nativeDensity !== null ? r3(rect.nativeDensity) : null,
        residualBefore: r3(d.residualBefore),
        residualAfter: r3(region.settings.delight > 0 ? d.residualAfter : d.residualBefore),
        detailKept: r3(region.settings.delight > 0 ? d.detailKept : 1),
        seamScore,
        sharpness: r3(probs.sharpness),
        clipped: Math.round(probs.clipped * 10_000) / 10_000,
        specular: Math.round(specularShare(delit, rect.mask, o.luma) * 10_000) / 10_000,
        exposureGain: r3(gain),
        coverage: r3(rect.coverage),
        aspect: r3(p.aspect),
        aspectFrom: p.aspectFrom,
        planeId: p.plane?.id ?? null,
        planeConfidence: p.planeConfidence,
      };
      const confidence = textureConfidence(metrics, region.settings.tile !== 'none');
      records.push({ regionId: region.id, confidence, metrics });
      await onRegion({ regionId: region.id, original, delit, tiled, mask, metrics, confidence, H: rect.H.map((v) => +v.toPrecision(10)), undistorted: rect.undistorted, texelDensity, patch: p.patch });
      step(region.name);
    }
  }
  const order = new Map(inputs.regions.map((r, i) => [r.id, i]));
  records.sort((a, b) => order.get(a.regionId)! - order.get(b.regionId)!);
  // Planes as the document keeps them (no member lists).
  const docPlanes: TexturePlane[] = planes.map(({ members: _m, ...pl }) => pl);
  return {
    result: { revision: o.revision, regions: records, planes: docPlanes, placements, panoramaPose: pose },
    planes,
    cloud,
    heading,
    panoramaPosition: position,
    photos: photoOut,
    patches: [...plan.values()].filter((p) => p.patch).map((p) => ({ regionId: p.region.id, corners: p.patch! })),
  };
}

