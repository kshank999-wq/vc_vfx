import { LIGHTING_ALGORITHM, estimateSpec, kelvinRange, temperatureOf, type GamutId, type LensEstimate, type LightEstimate, type LightingAnalysisInput, type LightingMark, type Range } from '@vcvfx/domain';
import type { LinearImage } from '../key/linear';
import { DEG, add, azDiff, azElOf, azRange, cameraToLevel, circularMean, dirOf, norm, percentile, pinhole, rangeOf, scale, sub, wrap180, type PinholeCamera, type V3 } from './geometry';
import { apertureFromBlur, curvatureK1, detectLines, edgeWidth, focalFromLines, undistortSegments } from './lens';
import { chromeBall, findPracticals, greyBallField, hdriSources, type ProbeResult, type ProbeSource } from './probes';
import { relightModel, matchScore, type RelightModel } from './relight';
import { fitShading, gaussianBlur, silhouetteNormals, type ShadingFit } from './shading';
import { analyseShadows, type ShadowAnalysis } from './shadows';

/**
 * The lighting and lens analysis (master spec §13; addendum 14 §3): every
 * cue the frame and the references offer, combined into an estimated rig
 * and lens, each figure with the range it is believed to lie in and the
 * evidence it rests on. Pure and deterministic (seeded), the same in the
 * desktop's worker and the browser preview.
 *
 * Priorities: an HDRI is the light itself, measured — preferred for
 * direction, size and colour; a chrome ball next; a grey ball gives exact
 * normals; the subject's shading and its cast shadows are the estimate when
 * there is no probe, and a cross-check when there is. The lens: the camera
 * track's solve, then the metadata (handoff camera and lens, the camera
 * database's film back), then vanishing points; each cross-checked against
 * the next.
 */

export interface CameraPriors {
  /** A known focal length: the camera track's solve, else the handoff's lens. */
  focalMm: number | null;
  focalSource: 'solve' | 'metadata' | null;
  filmBackMm: { width: number; height: number } | null;
  filmBackSource: 'camera_track' | 'handoff' | 'database' | 'nominal';
  /** The camera's tilt at the frame, from the solve (degrees; pitch up positive). */
  pitchDeg: number | null;
  rollDeg: number | null;
  /** Lens distortion from the solve or a lens profile (Brown–Conrady k₁). */
  k1: number | null;
  k1Source: 'solve' | 'profile' | null;
  /** The handoff's iris ("T2.8") and focus distance, as text. */
  iris: string | null;
  focusDistance: string | null;
  /** The subject's distance when the camera track places it (metres), else the setting. */
  subjectDistanceM: number;
  subjectDistanceSource: 'solve' | 'setting' | 'sample';
}

export interface AnalysisInput {
  frame: LinearImage;
  frameNumber: number;
  frames: number[];
  luma: [number, number, number];
  gamut: GamutId;
  subject: { matte: Float32Array; source: 'roto' | 'bg_matte' | 'key_alpha' | 'sample' } | null;
  sky: { matte: Float32Array; source: 'sky_matte' | 'detected' | 'sample' } | null;
  /** Further frames (the same size), for the key's direction. */
  extra?: { image: LinearImage; matte: Float32Array | null }[];
  camera: CameraPriors;
  /** The ground below the camera (metres) when it can be placed. */
  ground: { heightM: number; source: 'solve' | 'assumed' | 'sample' } | null;
  whiteBalance: { kelvin: number | null; source: 'artist' | 'metadata' | 'assumed' };
  references: {
    chrome: { id: string; image: LinearImage; circle: { cx: number; cy: number; r: number }; inPlate: boolean }[];
    grey: { id: string; image: LinearImage; circle: { cx: number; cy: number; r: number }; inPlate: boolean }[];
    hdri: { id: string; image: LinearImage; headingDeg: number | null } | null;
  };
  revision: number;
  seed?: number;
  progress?: (done: number, total: number) => void;
  signal?: AbortSignal;
  /** Let the page breathe between the stages (the browser preview). */
  yieldNow?: () => Promise<void>;
}

export interface AnalysisOutput {
  analysis: LightingAnalysisInput;
  model: RelightModel | null;
  /** The camera at the analysis size (for the overlays and the exports). */
  camera: PinholeCamera;
}

const R = (value: number, low: number, high: number): Range => ({ value, low: Math.min(low, value), high: Math.max(high, value) });
const stopsRange = (v: number, half: number): Range => rangeOf(Math.max(-20, Math.min(20, v)), half, -20, 20);
const elRange = (v: number, half: number): Range => rangeOf(v, half, -90, 90);
const sizeRange = (v: number, low: number, high: number): Range => R(Math.max(0, Math.min(180, v)), Math.max(0, low), Math.min(180, high));
const check = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new Error('Cancelled');
};

/** f-number from text like "T2.8", "f/4", "5.6". */
export function parseIris(text: string | null | undefined): { value: number; isT: boolean } | null {
  if (!text) return null;
  const m = /([tTfF])?\s*\/?\s*(\d+(?:\.\d+)?)/.exec(text);
  if (!m) return null;
  const v = Number(m[2]);
  if (!(v >= 0.5 && v <= 64)) return null;
  return { value: v, isT: (m[1] ?? '').toLowerCase() === 't' };
}

interface DirEstimate {
  az: number;
  el: number;
  /** Half-widths (degrees). */
  azHalf: number;
  elHalf: number;
  source: LightEstimate['evidence'][number];
}

/** Inverse-variance fusion of direction estimates, kept honest: the range also covers every estimate that is not an outlier. */
function fuse(list: DirEstimate[]): { az: number; el: number; azRange: Range; elRange: Range; agree: boolean } {
  const w = list.map((d) => 1 / Math.max(1, (d.azHalf / 2.5) ** 2));
  const we = list.map((d) => 1 / Math.max(1, (d.elHalf / 2.5) ** 2));
  const az = circularMean(
    list.map((d) => d.az),
    w,
  );
  const el = list.reduce((a, d, i) => a + we[i]! * d.el, 0) / we.reduce((a, b) => a + b, 0);
  const sAz = 2.5 / Math.sqrt(w.reduce((a, b) => a + b, 0));
  const sEl = 2.5 / Math.sqrt(we.reduce((a, b) => a + b, 0));
  let azLow = -sAz;
  let azHigh = sAz;
  let elLow = el - sEl;
  let elHigh = el + sEl;
  let agree = true;
  for (const d of list) {
    const dz = azDiff(d.az, az);
    if (Math.abs(dz) > d.azHalf + sAz || Math.abs(d.el - el) > d.elHalf + sEl) agree = false;
    // An estimate's own range overlapping the fused one pulls the range out to its centre.
    azLow = Math.min(azLow, Math.min(dz, 0) - 0.3 * d.azHalf);
    azHigh = Math.max(azHigh, Math.max(dz, 0) + 0.3 * d.azHalf);
    elLow = Math.min(elLow, d.el - 0.3 * d.elHalf);
    elHigh = Math.max(elHigh, d.el + 0.3 * d.elHalf);
  }
  const a = wrap180(az);
  return { az: a, el, azRange: { value: a, low: a + Math.max(-180, azLow), high: a + Math.min(180, azHigh) }, elRange: R(Math.max(-90, Math.min(90, el)), Math.max(-90, elLow), Math.min(90, elHigh)), agree };
}

/** Colour temperature with a range (mired spread) from a seen colour. */
function colourOf(rgb: [number, number, number], wb: number | null, gamut: GamutId, spreadMired: number): { temperature: Range; rgb: [number, number, number] } {
  const t = temperatureOf(rgb, wb, gamut);
  return { temperature: kelvinRange(Math.max(1000, Math.min(40000, t.kelvin)), spreadMired + Math.min(60, Math.abs(t.duv) * 4000)), rgb: t.rgb };
}

export async function analyseLighting(input: AnalysisInput): Promise<AnalysisOutput> {
  const started = Date.now();
  const seed = input.seed ?? 1;
  const { frame, luma, gamut } = input;
  const W = frame.width;
  const H = frame.height;
  const warnings: string[] = [];
  const marks: LightingMark[] = [];
  const total = 7;
  let step = 0;
  const tick = () => input.progress?.(++step, total);
  const wb = input.whiteBalance.kelvin;
  if (input.whiteBalance.source === 'assumed') warnings.push('The camera’s white balance is not known: colour temperatures are relative to the working space’s white. Enter it (step 4) for absolute figures.');

  // 1. The lens.
  const lines = detectLines(frame, luma, { exclude: null });
  const curve = input.camera.k1 === null ? curvatureK1(lines, W, H) : null;
  const straight = curve && curve.k1 !== 0 ? undistortSegments(lines, curve.k1, W, H) : lines;
  const vpFocal = focalFromLines(straight, W, H, { seed });
  check(input.signal);
  tick();
  await input.yieldNow?.();
  const fb = input.camera.filmBackMm ?? { width: 36, height: (36 * H) / W };
  const fbSource = input.camera.filmBackMm ? input.camera.filmBackSource : 'nominal';
  if (!input.camera.filmBackMm) warnings.push('The film back is not known: focal lengths are 36 mm (full-frame) equivalents. Choose the camera in Camera Track for real millimetres.');
  const pxToMm = (px: number) => (px / W) * fb.width;
  let focalMm: Range | null = null;
  let focalSource: LensEstimate['focalSource'] = 'unknown';
  const checks: LensEstimate['checks'] = [];
  const vpRange = vpFocal.focalPx ? R(pxToMm(vpFocal.focalPx), pxToMm(vpFocal.low), pxToMm(vpFocal.high)) : null;
  if (input.camera.focalMm && input.camera.focalSource) {
    const f = input.camera.focalMm;
    focalMm = input.camera.focalSource === 'solve' ? R(f, f * 0.99, f * 1.01) : R(f, f * 0.98, f * 1.02);
    focalSource = input.camera.focalSource;
    if (vpRange) {
      const agrees = vpRange.low <= focalMm.high && vpRange.high >= focalMm.low;
      checks.push({ source: 'vanishing', focalMm: vpRange, agrees, note: agrees ? `Vanishing points agree (${vpRange.low.toFixed(1)}–${vpRange.high.toFixed(1)} mm).` : `Vanishing points suggest ${vpRange.low.toFixed(1)}–${vpRange.high.toFixed(1)} mm: check the lens or the film back.` });
      if (!agrees) warnings.push(`The ${focalSource === 'solve' ? 'camera track’s' : 'metadata’s'} ${f.toFixed(1)} mm and the vanishing points (${vpRange.low.toFixed(1)}–${vpRange.high.toFixed(1)} mm) disagree.`);
    }
  } else if (vpRange) {
    focalMm = vpRange;
    focalSource = 'vanishing';
  } else warnings.push('No focal length: no metadata, no camera track, and too few straight lines for vanishing points. Enter it in step 4.');
  const focalPx = focalMm ? (focalMm.value / fb.width) * W : 0.9 * W;
  // The camera's tilt: the solve's, else from a vertical vanishing point, else level.
  let pitch = input.camera.pitchDeg ?? 0;
  let roll = input.camera.rollDeg ?? 0;
  let tiltFrom: 'solve' | 'vanishing' | 'assumed' = input.camera.pitchDeg !== null ? 'solve' : 'assumed';
  if (tiltFrom === 'assumed') {
    for (const vp of vpFocal.vps) {
      if (Math.abs(vp.v[2]) < 1e-9) continue;
      const d = norm([(vp.v[0] / vp.v[2] - W / 2) / focalPx, -(vp.v[1] / vp.v[2] - H / 2) / focalPx, -1]);
      const up: V3 = d[1] < 0 ? [-d[0], -d[1], -d[2]] : d;
      if (Math.abs(up[1]) < 0.85) continue;
      pitch = Math.asin(Math.max(-1, Math.min(1, -up[2]))) / DEG;
      roll = Math.atan2(-up[0], up[1]) / DEG;
      tiltFrom = 'vanishing';
      break;
    }
  }
  if (tiltFrom === 'assumed') warnings.push('The camera’s tilt is not known (no camera track, no vertical lines): it is taken as level; elevations may be off by the camera’s tilt.');
  const cam = pinhole(W, H, focalPx, pitch, roll);
  const hfov = focalMm ? R((2 * Math.atan(fb.width / (2 * focalMm.value))) / DEG, (2 * Math.atan(fb.width / (2 * focalMm.high))) / DEG, (2 * Math.atan(fb.width / (2 * focalMm.low))) / DEG) : null;
  const vfov = focalMm ? R((2 * Math.atan(fb.height / (2 * focalMm.value))) / DEG, (2 * Math.atan(fb.height / (2 * focalMm.high))) / DEG, (2 * Math.atan(fb.height / (2 * focalMm.low))) / DEG) : null;
  for (const vp of vpFocal.vps) {
    if (Math.abs(vp.v[2]) < 1e-9) continue;
    const x = vp.v[0] / vp.v[2];
    const y = vp.v[1] / vp.v[2];
    if (x >= 0 && x <= W && y >= 0 && y <= H) marks.push({ kind: 'vanishing', x: x / W, y: y / H, x2: null, y2: null, r: null, lightId: null, label: `vanishing point (${vp.inliers.length} lines)` });
  }

  // 2. The subject's shading.
  const subjectMask = new Uint8Array(W * H);
  let field = null as ReturnType<typeof silhouetteNormals>;
  let fit: ShadingFit | null = null;
  if (input.subject) {
    field = silhouetteNormals(input.subject.matte, W, H, 0.5, cam);
    if (field) {
      subjectMask.set(field.mask);
      fit = fitShading(frame, field, luma, cam, { seed });
      if (!fit) warnings.push('The subject’s shading could not be read (too small, too flat or clipped).');
      else if (field.roundness < 0.55) warnings.push('The subject is far from round: its silhouette normals are rough, so the shading’s directions carry wider ranges.');
    } else warnings.push('The subject matte is too small to read the shading from.');
  } else warnings.push('No subject matte: roto or isolate the subject (Roto, Sky & BG tabs) for the shading-based estimates; the shadows need it too.');
  check(input.signal);
  tick();
  await input.yieldNow?.();
  // Further frames: the key's direction again on each (they steady it).
  const extraKeys: DirEstimate[] = [];
  for (const ex of input.extra ?? []) {
    if (!ex.matte) continue;
    const f2 = silhouetteNormals(ex.matte, W, H, 0.5, cam);
    if (!f2) continue;
    const r = fitShading(ex.image, f2, luma, cam, { seed: seed + 1, bootstrap: 6 });
    if (r?.key) {
      const d = azElOf(r.key.L);
      extraKeys.push({ az: d.az, el: d.el, azHalf: 10, elHalf: 10, source: 'shading' });
    }
    check(input.signal);
  }
  // The subject's size in metres (its inscribed radius), at its distance.
  const subjectRadiusM = field ? (field.radius / focalPx) * input.camera.subjectDistanceM : 0.4;

  // 3. Shadows on the ground.
  let shadows: ShadowAnalysis | null = null;
  if (field && input.ground) {
    const lum = new Float32Array(W * H);
    for (let i = 0; i < W * H; i += 1) lum[i] = luma[0] * frame.data[3 * i]! + luma[1] * frame.data[3 * i + 1]! + luma[2] * frame.data[3 * i + 2]!;
    const sky = input.sky ? Uint8Array.from(input.sky.matte, (v) => (v > 0.5 ? 1 : 0)) : null;
    shadows = analyseShadows(lum, W, H, field.mask, cam, { heightM: input.ground.heightM }, { sky });
    for (const s of shadows?.shadows ?? []) marks.push({ kind: 'shadow', x: s.from.x / W, y: s.from.y / H, x2: s.to.x / W, y2: s.to.y / H, r: null, lightId: null, label: `shadow · depth ${(s.depth * 100).toFixed(0)} %` });
  }
  check(input.signal);
  tick();
  await input.yieldNow?.();

  // 4. Probes.
  const chrome: (ProbeResult & { id: string })[] = input.references.chrome.map((c) => ({ id: c.id, ...chromeBall(c.image, c.circle, luma, cam) }));
  const grey = input.references.grey.map((g) => ({ id: g.id, fit: fitShading(g.image, greyBallField(g.image, g.circle), luma, cam, { seed, bootstrap: 10 }) }));
  for (const c of [...input.references.chrome, ...input.references.grey]) if (c.inPlate) marks.push({ kind: 'ball', x: c.circle.cx / W, y: c.circle.cy / H, x2: null, y2: null, r: c.circle.r / W, lightId: null, label: c.id });
  let hdri: (ProbeResult & { heading: number; headingFrom: 'given' | 'aligned' | 'assumed' }) | null = null;
  if (input.references.hdri) {
    const h = input.references.hdri;
    let heading = h.headingDeg ?? 0;
    let headingFrom: 'given' | 'aligned' | 'assumed' = h.headingDeg !== null ? 'given' : 'assumed';
    let res = hdriSources(h.image, heading, luma);
    if (h.headingDeg === null && res.sources[0]) {
      // Align: turn the panorama so its strongest source sits where the plate's own evidence puts the key.
      const plateKey = fit?.key ? azElOf(fit.key.L).az : chrome[0]?.sources[0]?.az ?? null;
      if (plateKey !== null) {
        heading = wrap180(heading + azDiff(res.sources[0].az, plateKey) * -1);
        res = hdriSources(h.image, heading, luma);
        headingFrom = 'aligned';
      } else warnings.push('The HDRI’s heading is not known and the plate gives no key to align it to: its centre column is taken as the camera’s view. Set the heading (step 1).');
    }
    hdri = { ...res, heading, headingFrom };
  }
  check(input.signal);
  tick();
  await input.yieldNow?.();

  // 5. Practicals in frame (off the subject, the balls and the sky).
  const exclude = new Uint8Array(W * H);
  if (field) {
    const dil = gaussianBlur(Float32Array.from(field.mask), W, H, 2);
    for (let i = 0; i < W * H; i += 1) if (dil[i]! > 0.02) exclude[i] = 1;
  }
  for (const c of [...input.references.chrome, ...input.references.grey])
    if (c.inPlate)
      for (let y = Math.max(0, Math.floor(c.circle.cy - c.circle.r * 1.2)); y < Math.min(H, c.circle.cy + c.circle.r * 1.2); y += 1)
        for (let x = Math.max(0, Math.floor(c.circle.cx - c.circle.r * 1.2)); x < Math.min(W, c.circle.cx + c.circle.r * 1.2); x += 1) exclude[y * W + x] = 1;
  const practicals = findPracticals(frame, luma, cam, { exclude });
  tick();
  await input.yieldNow?.();

  // 6. The rig.
  const lights: LightEstimate[] = [];
  const subjectRay = field ? cameraToLevel(cam, norm([((field.box.x0 + field.box.x1 + 1) / 2 - W / 2) / focalPx, -((field.box.y0 + field.box.y1 + 1) / 2 - H / 2) / focalPx, -1])) : cameraToLevel(cam, [0, 0, -1]);
  const subjectC: V3 = scale(subjectRay, input.camera.subjectDistanceM);
  const greyFit = grey.find((g) => g.fit?.key)?.fit ?? null;
  const keyE = fit?.key?.E ?? null;
  // The key's direction: from every source of evidence.
  const dirs: DirEstimate[] = [];
  let keySize: { v: number; lo: number; hi: number; from: LightEstimate['evidence'][number] } | null = null;
  let keyColour: { rgb: [number, number, number]; spread: number; balanced: boolean } | null = null;
  const evidence = new Set<LightEstimate['evidence'][number]>();
  const hdriKey = hdri?.sources[0] ?? null;
  if (hdriKey) {
    const headingHalf = hdri!.headingFrom === 'given' ? 2 : hdri!.headingFrom === 'aligned' ? 8 : 90;
    dirs.push({ az: hdriKey.az, el: hdriKey.el, azHalf: hdriKey.dirHalf + headingHalf, elHalf: hdriKey.dirHalf + 1, source: 'hdri' });
    keySize = { v: hdriKey.sizeDeg, lo: hdriKey.sizeDeg / 1.3, hi: hdriKey.sizeDeg * 1.3 + 0.5, from: 'hdri' };
    keyColour = { rgb: hdriKey.rgb, spread: 10, balanced: false };
    evidence.add('hdri');
  }
  const chromeKey = chrome.find((c) => c.sources[0])?.sources[0] ?? null;
  if (chromeKey) {
    dirs.push({ az: chromeKey.az, el: chromeKey.el, azHalf: chromeKey.dirHalf + 2, elHalf: chromeKey.dirHalf + 2, source: 'chrome_ball' });
    if (!keySize) keySize = { v: chromeKey.sizeDeg, lo: chromeKey.sizeDeg / 1.5, hi: chromeKey.sizeDeg * 1.5 + 1, from: 'chrome_ball' };
    if (!keyColour) keyColour = { rgb: chromeKey.rgb, spread: 15, balanced: true };
    evidence.add('chrome_ball');
  }
  if (greyFit?.key) {
    const d = azElOf(greyFit.key.L);
    dirs.push({ az: d.az, el: d.el, azHalf: Math.max(4, 2.5 * greyFit.key.azRange), elHalf: Math.max(4, 2.5 * greyFit.key.elRange), source: 'grey_ball' });
    if (!keyColour) keyColour = { rgb: greyFit.colours.key, spread: 12, balanced: true };
    evidence.add('grey_ball');
  }
  if (fit?.key) {
    const d = azElOf(fit.key.L);
    // How far the shading model can be trusted: its residual, and how sphere-like the silhouette is.
    const floor = 5 + 25 * Math.max(0, 0.95 - fit.r2) + 20 * Math.max(0, 0.85 - fit.roundness);
    dirs.push({ az: d.az, el: d.el, azHalf: Math.max(floor, 2.5 * fit.key.azRange), elHalf: Math.max(floor, 2.5 * fit.key.elRange), source: 'shading' });
    if (!keyColour) keyColour = { rgb: fit.colours.key, spread: 35, balanced: true };
    evidence.add('shading');
    evidence.add('contour');
    const s = (2 * Math.asin(fit.key.sinA)) / DEG;
    if (!keySize) keySize = { v: s, lo: s / 2.2 - 1, hi: s * 2 + 4, from: 'shading' };
  }
  dirs.push(...extraKeys);
  const keyShadow = shadows?.shadows[0] ?? null;
  if (keyShadow && keyShadow.el !== null) {
    // Only when it agrees with the other evidence about which light it is (a fill's shadow is not the key's).
    const ref = dirs[0];
    if (!ref || Math.abs(azDiff(keyShadow.az, ref.az)) < 60) {
      dirs.push({ az: keyShadow.az, el: keyShadow.el, azHalf: keyShadow.azHalf, elHalf: keyShadow.elHalf, source: 'shadow' });
      evidence.add('shadow');
      if (keyShadow.sizeDeg !== null && (!keySize || keySize.from === 'shading')) {
        keySize = { v: keyShadow.sizeDeg, lo: keyShadow.sizeLow, hi: keyShadow.sizeHigh, from: 'penumbra' };
        evidence.add('penumbra');
      }
    }
  }
  let keyConfidence = 0;
  if (dirs.length) {
    // An HDRI with a known heading is the light itself: it is used as measured, the rest only checks it.
    const primary = hdriKey && hdri!.headingFrom === 'given' ? dirs.filter((d) => d.source === 'hdri') : dirs;
    const f = fuse(primary);
    if (primary !== dirs) {
      const all = fuse(dirs);
      if (!all.agree) warnings.push('The plate’s shading or shadows disagree with the HDRI about the key: the HDRI is used; check its heading.');
    } else if (!f.agree && dirs.length > 1) warnings.push(`The cues disagree about the key’s direction (${dirs.map((d) => `${d.source} ${d.az.toFixed(0)}°/${d.el.toFixed(0)}°`).join(', ')}): the range covers them; check it in the viewer.`);
    const width = (f.azRange.high - f.azRange.low + (f.elRange.high - f.elRange.low)) / 2;
    keyConfidence = Math.max(0.05, Math.min(0.97, (1 - width / 90) * (f.agree ? 1 : 0.75) * (fit ? 0.6 + 0.4 * fit.r2 : 0.85) + 0.05 * Math.min(3, evidence.size - 1)));
    const outdoor = Boolean(input.sky);
    const size = keySize ?? { v: 15, lo: 1, hi: 60, from: 'shading' as const };
    const sun = outdoor && size.v < 2 && (evidence.has('hdri') || evidence.has('shadow') || evidence.has('chrome_ball'));
    const inv = fit?.key?.inv ?? 0;
    const distance = sun ? null : inv > 0.02 ? R(subjectRadiusM / inv, subjectRadiusM / (inv + Math.max(0.03, 2.5 * fit!.key!.invRange)), inv > Math.max(0.03, 2.5 * fit!.key!.invRange) ? subjectRadiusM / (inv - Math.max(0.03, 2.5 * fit!.key!.invRange)) : 100000) : R(Math.max(4, 30 * subjectRadiusM), Math.max(2, 8 * subjectRadiusM), 100000);
    const col = keyColour ? colourOf(keyColour.rgb, keyColour.balanced ? wb : null, gamut, keyColour.spread) : null;
    lights.push({
      id: 'key',
      role: sun ? 'sun' : 'key',
      type: sun ? 'directional' : size.v > 8 ? 'rect' : 'spot',
      name: sun ? 'Sun' : 'Key',
      azimuth: f.azRange,
      elevation: f.elRange,
      distance,
      intensity: R(0, 0, 0),
      size: sizeRange(size.v, size.lo, size.hi),
      temperature: col?.temperature ?? null,
      rgb: col?.rgb ?? [1, 1, 1],
      practical: null,
      motivation: sun ? 'Sunlight: a hard, distant source in an outdoor shot.' : `The strongest source: ${f.az > 20 ? 'from frame right' : f.az < -20 ? 'from frame left' : 'from near the camera'}${Math.abs(f.az) > 100 ? ', behind the subject' : ''}, ${f.el > 45 ? 'high' : f.el > 15 ? 'above eye level' : f.el > -10 ? 'at eye level' : 'from below'}.`,
      evidence: [...evidence],
      confidence: Math.round(keyConfidence * 1000) / 1000,
    });
  }
  const key = lights[0] ?? null;
  // The key's illuminance in the shading's units, for the others' stops.
  const relTo = (E: number, ref: number | null) => (ref && ref > 0 ? Math.log2(Math.max(1e-9, E) / ref) : NaN);

  // A probe (HDRI, chrome ball) measures the other sources directly: then the shading's own fill and rim are only a cross-check.
  const probeSources = (hdri?.sources.length ?? 0) > 1 || (chrome[0]?.sources.length ?? 0) > 1;
  // Fill: the shading's second source in front, or a probe's.
  if (fit?.fill && !probeSources) {
    const d = azElOf(fit.fill.L);
    // The shading separates a soft fill from the key and the ambient only roughly: wide ranges.
    const half = Math.max(30, 2.5 * fit.fill.dirSigma);
    const stops = Math.log2(fit.fill.ratio);
    const s = (2 * Math.asin(fit.fill.sinA)) / DEG;
    const col = fit.colours.fill ? colourOf(fit.colours.fill, wb, gamut, 50) : null;
    lights.push({ id: 'fill', role: 'fill', type: 'rect', name: 'Fill', azimuth: azRange(d.az, half), elevation: elRange(d.el, Math.max(25, half * 0.8)), distance: R(3 * input.camera.subjectDistanceM * 0.6, 0.5, 100), intensity: stopsRange(stops, Math.max(0.8, 2.5 * fit.fill.ratioSigma)), size: sizeRange(s, s / 2.5, Math.min(180, s * 2 + 10)), temperature: col?.temperature ?? null, rgb: col?.rgb ?? [1, 1, 1], practical: null, motivation: `Softer light filling the shadow side ${d.az < 0 ? 'from frame left' : 'from frame right'}: key-to-fill about ${(1 / fit.fill.ratio).toFixed(1)}:1. From the shading alone its direction is rough; a grey or chrome ball pins it down.`, evidence: ['shading', 'fill_ratio'], confidence: 0.35 });
  }
  // Rim / back.
  if (fit?.rim && !probeSources) {
    const d = azElOf(fit.rim.L);
    const near = azElOf(fit.rim.Lnear);
    const far = azElOf(fit.rim.Lfar);
    const half = Math.max(25, 2.5 * fit.rim.dirSigma);
    const azs = [d.az, near.az, far.az];
    const els = [d.el, near.el, far.el];
    const back = d.el > 45;
    const col = fit.colours.rim ? colourOf(fit.colours.rim, wb, gamut, 60) : null;
    lights.push({
      id: back ? 'back' : 'rim',
      role: back ? 'back' : 'rim',
      type: 'spot',
      name: back ? 'Back light' : 'Rim',
      azimuth: { value: wrap180(d.az), low: wrap180(d.az) + Math.min(-half, ...azs.map((a) => azDiff(a, d.az))), high: wrap180(d.az) + Math.max(half, ...azs.map((a) => azDiff(a, d.az))) },
      elevation: R(d.el, Math.max(-90, Math.min(...els) - half * 0.6), Math.min(90, Math.max(...els) + half * 0.6)),
      distance: R(3, 1, 30),
      intensity: stopsRange(Math.log2(fit.rim.ratio), Math.max(0.9, 2.5 * fit.rim.ratioSigma)),
      size: sizeRange(8, 1, 40),
      temperature: col?.temperature ?? null,
      rgb: col?.rgb ?? [1, 1, 1],
      practical: null,
      motivation: `Light along the subject’s ${fit.rim.phiDeg > 30 && fit.rim.phiDeg < 150 ? 'top' : Math.abs(fit.rim.phiDeg) > 90 ? 'left' : 'right'} edge from behind: a ${back ? 'back' : 'rim'} light separating it from the background.`,
      evidence: ['contour', 'shading'],
      confidence: fit.rim.fitted ? 0.5 : 0.35,
    });
    if (field) {
      // The rim's mark: on the silhouette where it is brightest.
      const cxs = (field.box.x0 + field.box.x1) / 2;
      const cys = (field.box.y0 + field.box.y1) / 2;
      const rr = (field.box.x1 - field.box.x0) / 2;
      marks.push({ kind: 'rim', x: (cxs + Math.cos(fit.rim.phiDeg * DEG) * rr) / W, y: (cys - Math.sin(fit.rim.phiDeg * DEG) * rr) / H, x2: null, y2: null, r: null, lightId: back ? 'back' : 'rim', label: back ? 'back light' : 'rim' });
    }
  }
  // Practicals in frame.
  practicals.forEach((p, i) => {
    const D = input.camera.subjectDistanceM;
    const at = (t: number) => {
      const pos = scale(p.ray, t);
      const v = sub(pos, subjectC);
      const d = azElOf(v);
      return { ...d, dist: Math.hypot(...v), pos };
    };
    const depths = [0.6 * D, 1.4 * D, 3 * D];
    const pts = depths.map(at);
    const mid = pts[1]!;
    const rM = (p.radius / focalPx) * (1.4 * D);
    // Its light at the subject: radiance × area / distance², against the key's (ρ assumed 0.2–0.6).
    let stops = NaN;
    let lo = NaN;
    let hi = NaN;
    if (keyE) {
      const Ep = (p.meanLuminance * rM * rM) / (mid.dist * mid.dist);
      stops = relTo(Ep * 0.4, keyE);
      const spread = pts.map((q) => relTo(((p.meanLuminance * ((p.radius / focalPx) * Math.hypot(...q.pos)) ** 2) / (q.dist * q.dist)) * 0.4, keyE));
      lo = Math.min(...spread) - 1.6;
      hi = Math.max(...spread) + 1.6 + (p.clipped ? 3 : 0);
    }
    const col = colourOf(p.rgb, wb, gamut, 40);
    const id = `practical${i + 1}`;
    lights.push({
      id,
      role: 'practical',
      type: 'point',
      name: `Practical ${i + 1}`,
      azimuth: { value: wrap180(mid.az), low: wrap180(mid.az) + Math.min(-8, ...pts.map((q) => azDiff(q.az, mid.az))) - 4, high: wrap180(mid.az) + Math.max(8, ...pts.map((q) => azDiff(q.az, mid.az))) + 4 },
      elevation: R(mid.el, Math.min(...pts.map((q) => q.el)) - 4, Math.max(...pts.map((q) => q.el)) + 4),
      distance: R(mid.dist, Math.min(...pts.map((q) => q.dist)), Math.max(...pts.map((q) => q.dist))),
      intensity: Number.isFinite(stops) ? R(Math.max(-20, Math.min(20, stops)), Math.max(-20, lo), Math.min(20, hi)) : R(-4, -10, 2),
      size: sizeRange((2 * Math.atan(rM / mid.dist)) / DEG, 0, (4 * Math.atan(rM / mid.dist)) / DEG + 1),
      temperature: col.temperature,
      rgb: col.rgb,
      practical: { x: p.x / W, y: p.y / H, radius: p.radius / W },
      motivation: `A practical seen in frame at ${Math.round((p.x / W) * 100)} % across, ${Math.round((p.y / H) * 100)} % down${p.clipped ? ' (clipped: at least this bright)' : ''}: a lamp or fitting; its depth is not known, hence the ranges.`,
      evidence: ['practical', 'colour'],
      confidence: 0.45,
    });
    marks.push({ kind: 'practical', x: p.x / W, y: p.y / H, x2: null, y2: null, r: p.radius / W, lightId: id, label: `practical ${i + 1}` });
  });
  // Further probe sources (HDRI or chrome): each a light, unless one already stands there.
  const probe = hdri ?? chrome[0] ?? null;
  if (probe && probe.sources.length > 1 && probe.sources[0]) {
    const ref = probe.sources[0].E;
    probe.sources.slice(1, 5).forEach((src: ProbeSource, i: number) => {
      const near = lights.find((l) => Math.abs(azDiff(l.azimuth.value, src.az)) < 25 && Math.abs(l.elevation.value - src.el) < 20);
      const stops = Math.log2(src.E / ref);
      const col = colourOf(src.rgb, hdri ? null : wb, gamut, hdri ? 12 : 18);
      const kind: LightEstimate['evidence'][number] = hdri ? 'hdri' : 'chrome_ball';
      if (near) {
        // The probe measures it better: take its direction and size, keep the role.
        near.azimuth = azRange(src.az, src.dirHalf + (hdri && hdri.headingFrom !== 'given' ? 8 : 2));
        near.elevation = elRange(src.el, src.dirHalf + 1);
        near.intensity = stopsRange(stops, src.clipped ? 2 : 0.4);
        near.size = sizeRange(src.sizeDeg, src.sizeDeg / 1.4, src.sizeDeg * 1.4 + 0.5);
        near.temperature = col.temperature;
        near.rgb = col.rgb;
        near.evidence = [...new Set([...near.evidence, kind])];
        near.confidence = Math.max(near.confidence, 0.7);
        if (near.role === 'practical') near.motivation += ` Seen in the ${hdri ? 'HDRI' : 'chrome ball'} too, which places it.`;
        return;
      }
      const behind = Math.abs(src.az) > 110;
      const role = behind ? (src.el > 45 ? 'back' : 'rim') : !lights.some((l) => l.role === 'fill') ? 'fill' : src.sizeDeg > 15 ? 'fill' : 'practical';
      const id = !lights.some((l) => l.id === role) && (role === 'fill' || role === 'rim' || role === 'back') ? role : `${hdri ? 'hdri' : 'chrome'}${i + 2}`;
      lights.push({ id, role, type: src.sizeDeg > 8 ? 'rect' : 'spot', name: id === role ? (role === 'fill' ? 'Fill' : role === 'rim' ? 'Rim' : 'Back light') : `${hdri ? 'HDRI' : 'Ball'} source ${i + 2}`, azimuth: azRange(src.az, src.dirHalf + 2), elevation: elRange(src.el, src.dirHalf + 1), distance: R(3, 1, 30), intensity: stopsRange(stops, src.clipped ? 2 : 0.4), size: sizeRange(src.sizeDeg, src.sizeDeg / 1.4, src.sizeDeg * 1.4 + 0.5), temperature: col.temperature, rgb: col.rgb, practical: null, motivation: `A ${src.sizeDeg > 15 ? 'large' : 'small'} source seen in the ${hdri ? 'HDRI' : 'chrome ball'}${src.clipped ? ' (clipped there: at least this bright)' : ''}.`, evidence: [kind], confidence: 0.75 });
    });
  }
  // The even rest: ambient, or the sky outdoors.
  {
    let stops: number | null = null;
    let half = 1.2;
    let rgb: [number, number, number] | null = null;
    let ev: LightEstimate['evidence'][number] = 'shading';
    if (hdri && hdri.sources[0]) {
      stops = Math.log2(Math.max(1e-6, hdri.dome.E) / Math.max(1e-9, hdri.sources[0].E));
      half = 0.6;
      rgb = hdri.dome.rgb;
      ev = 'hdri';
    } else if (chrome[0]?.sources[0]) {
      stops = Math.log2(Math.max(1e-6, chrome[0].dome.E) / Math.max(1e-9, chrome[0].sources[0].E));
      half = 1.2;
      rgb = chrome[0].dome.rgb;
      ev = 'chrome_ball';
    } else if (fit) {
      // The shading separates the ambient from a soft fill only roughly: from the fit, up to the darkest shading.
      const ceiling = Math.log2(fit.ambient.floorRatio);
      stops = Math.min(ceiling, Math.log2(Math.max(fit.ambient.ratio, 0.004)));
      half = Math.max(1.5, ceiling + 0.5 - stops);
      rgb = fit.colours.ambient;
    }
    if (stops !== null && Number.isFinite(stops)) {
      const sky = Boolean(input.sky);
      const col = rgb ? colourOf(rgb, ev === 'hdri' ? null : wb, gamut, 60) : null;
      lights.push({ id: sky ? 'sky' : 'ambient', role: sky ? 'sky' : 'ambient', type: 'dome', name: sky ? 'Sky' : 'Ambient', azimuth: R(0, -180, 180), elevation: R(90, 0, 90), distance: null, intensity: stopsRange(stops, half), size: null, temperature: col?.temperature ?? null, rgb: col?.rgb ?? [1, 1, 1], practical: null, motivation: sky ? 'The sky: even light from above, coloured by it.' : 'Even light from everywhere: bounce from the set.', evidence: [ev, ...(sky ? (['sky'] as const) : [])], confidence: 0.4 });
    }
  }
  // A pool of light on the background (not the subject's light): a background light.
  if (field) {
    const lum = new Float32Array(W * H);
    for (let i = 0; i < W * H; i += 1) lum[i] = luma[0] * frame.data[3 * i]! + luma[1] * frame.data[3 * i + 1]! + luma[2] * frame.data[3 * i + 2]!;
    const bg = new Uint8Array(W * H);
    const sky = input.sky?.matte;
    const horizon = H / 2 - Math.tan(pitch * DEG) * focalPx;
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
      const i = y * W + x;
      bg[i] = !exclude[i] && !(sky && sky[i]! > 0.5) && y < Math.max(0, horizon) ? 1 : 0;
    }
    for (const p of practicals) for (let y = Math.max(0, Math.floor(p.y - p.radius * 6)); y < Math.min(H, p.y + p.radius * 6); y += 1) for (let x = Math.max(0, Math.floor(p.x - p.radius * 6)); x < Math.min(W, p.x + p.radius * 6); x += 1) bg[y * W + x] = 0;
    const vals = Array.from(lum).filter((_, i) => bg[i]);
    if (vals.length > 0.05 * W * H) {
      const med = percentile(vals, 0.5);
      const masked = Float32Array.from(lum, (v, i) => (bg[i] ? v : med));
      const sm = gaussianBlur(masked, W, H, Math.max(3, W / 40));
      let best = -1;
      for (let i = 0; i < W * H; i += 1) if (bg[i] && (best < 0 || sm[i]! > sm[best]!)) best = i;
      const peak = best >= 0 ? sm[best]! : 0;
      let area = 0;
      for (let i = 0; i < W * H; i += 1) if (bg[i] && sm[i]! > 1.5 * med) area += 1;
      if (best >= 0 && peak > 2 * med && area > 0.01 * W * H && area < 0.35 * vals.length) {
        const x = (best % W) + 0.5;
        const y = (best - (best % W)) / W + 0.5;
        const ray = cameraToLevel(cam, [(x - W / 2) / focalPx, -(y - H / 2) / focalPx, -1]);
        const wall = scale(norm(ray), 2 * input.camera.subjectDistanceM);
        // The light: between the subject and the wall, above, aimed at the pool.
        const pos = add(wall, [0, 1.2, 1.5]);
        const v = sub(pos, subjectC);
        const d = azElOf(v);
        lights.push({ id: 'background', role: 'background', type: 'spot', name: 'Background', azimuth: azRange(d.az, 40), elevation: elRange(d.el, 30), distance: R(Math.hypot(...v), 1, 40), intensity: stopsRange(Math.log2(Math.max(1e-6, (peak - med) / Math.max(1e-6, keyE ?? peak))), 2), size: sizeRange(20, 5, 60), temperature: colourOf([frame.data[3 * best]!, frame.data[3 * best + 1]!, frame.data[3 * best + 2]!], wb, gamut, 60).temperature, rgb: colourOf([frame.data[3 * best]!, frame.data[3 * best + 1]!, frame.data[3 * best + 2]!], wb, gamut, 60).rgb, practical: { x: x / W, y: y / H, radius: Math.sqrt(area / Math.PI) / W }, motivation: `A pool of light on the background around ${Math.round((x / W) * 100)} % across, ${Math.round((y / H) * 100)} % down: a light aimed at the set behind the subject. Aim it at that spot in the engine.`, evidence: ['background'], confidence: 0.3 });
      }
    }
  }
  check(input.signal);
  tick();
  await input.yieldNow?.();

  // 7. The lens figures, the relight model and the match score.
  const iris = parseIris(input.camera.iris);
  let aperture: LensEstimate['aperture'] = { fStop: null, source: 'unknown', note: 'No iris in the metadata and no measurable background blur.' };
  if (iris) aperture = { fStop: iris.isT ? R(iris.value, iris.value * 0.9, iris.value) : R(iris.value, iris.value, iris.value), source: 'metadata', note: iris.isT ? `T${iris.value} from the handoff (the f-number is a little lower).` : `f/${iris.value} from the handoff.` };
  else if (field && focalMm) {
    const bg = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i += 1) bg[i] = exclude[i] ? 0 : 1;
    const ring = gaussianBlur(Float32Array.from(field.mask), W, H, 3);
    const inner = Uint8Array.from(field.mask, (v, i) => (v && ring[i]! > 0.99 ? 1 : 0));
    const wBg = edgeWidth(frame, luma, bg);
    const wSub = edgeWidth(frame, luma, inner) ?? 1.2;
    if (wBg !== null) {
      const extra = Math.max(0, wBg - wSub);
      const a = apertureFromBlur(extra, focalMm.value, fb.width, W, input.camera.subjectDistanceM);
      if (a) aperture = { fStop: R(a.value, a.low, a.high), source: 'blur', note: `A hint only: the background’s edges are ${wBg.toFixed(1)} px wide against the subject’s ${wSub.toFixed(1)} px; through a thin lens focused on the subject.` };
      else aperture = { fStop: R(11, 5.6, 32), source: 'blur', note: 'A hint only: the background is as sharp as the subject — a deep focus (a small aperture), or the background is close.' };
    }
  }
  const distortion: LensEstimate['distortion'] =
    input.camera.k1 !== null
      ? { k1: input.camera.k1, source: input.camera.k1Source ?? 'profile', note: input.camera.k1Source === 'solve' ? 'From the camera track’s solve.' : 'From the project’s lens profile.' }
      : curve && curve.k1 !== 0
        ? { k1: -curve.k1, source: 'lines', note: `The long straight edges bend ${curve.k1 < 0 ? 'outwards (barrel)' : 'inwards (pincushion)'}: about k₁ ≈ ${(-curve.k1).toFixed(3)} (Brown–Conrady, first order). A hint: profile the lens for a real figure.` }
        : { k1: null, source: 'none', note: lines.length > 8 ? 'The straight edges are straight within what can be measured.' : 'Too few straight edges to read the lens’s distortion.' };
  const lens: LensEstimate = { focalMm, focalSource, checks, filmBackMm: input.camera.filmBackMm ?? fb, filmBackSource: fbSource, hfovDeg: hfov, vfovDeg: vfov, distortion, aperture, focusDistance: input.camera.focusDistance, lines: lines.length, vanishingPoints: vpFocal.vps.length };
  let model: RelightModel | null = null;
  let match: number | null = null;
  if (field) {
    model = relightModel(frame, field.normals, field.mask, { pitchDeg: pitch, rollDeg: roll }, lights.map(estimateSpec), wb, luma);
    match = matchScore(model, lights.map(estimateSpec));
  }
  if (match !== null && match < 0.6) warnings.push(`The rig explains the subject’s shading only partly (match ${(match * 100).toFixed(0)} %): a textured or non-diffuse subject, or light the model does not see.`);
  if (!lights.length) warnings.push('No light could be estimated: add a subject matte, a ball or an HDRI — or place the lights by hand (step 3).');
  tick();
  await input.yieldNow?.();
  const subjectCover = field ? field.count / (W * H) : 0;
  const skyCover = input.sky ? input.sky.matte.reduce((a, v) => a + (v > 0.5 ? 1 : 0), 0) / (W * H) : 0;
  return {
    analysis: {
      algorithm: `${LIGHTING_ALGORITHM.id}@${LIGHTING_ALGORITHM.version}`,
      revision: input.revision,
      frame: input.frameNumber,
      frames: input.frames,
      lights: lights.slice(0, 24).map((l) => ({ ...l, azimuth: roundRange(l.azimuth, 2), elevation: roundRange(l.elevation, 2), distance: l.distance ? roundRange(l.distance, 3) : null, intensity: roundRange(l.intensity, 3), size: l.size ? roundRange(l.size, 2) : null, temperature: l.temperature ? roundRange(l.temperature, 0) : null, rgb: l.rgb.map((v) => Math.round(v * 1e4) / 1e4) as [number, number, number] })),
      lens: { ...lens, focalMm: lens.focalMm ? roundRange(lens.focalMm, 2) : null, hfovDeg: lens.hfovDeg ? roundRange(lens.hfovDeg, 2) : null, vfovDeg: lens.vfovDeg ? roundRange(lens.vfovDeg, 2) : null, aperture: { ...lens.aperture, fStop: lens.aperture.fStop ? roundRange(lens.aperture.fStop, 2) : null }, checks: lens.checks.map((c) => ({ ...c, focalMm: roundRange(c.focalMm, 2) })) },
      keyConfidence: Math.round(keyConfidence * 1000) / 1000,
      matchScore: match === null ? null : Math.round(match * 1000) / 1000,
      subject: { source: input.subject && field ? input.subject.source : 'none', coverage: Math.round(subjectCover * 1e4) / 1e4, centre: field ? { x: Math.round((((field.box.x0 + field.box.x1 + 1) / 2) / W) * 1e4) / 1e4, y: Math.round((((field.box.y0 + field.box.y1 + 1) / 2) / H) * 1e4) / 1e4 } : null },
      sky: { found: Boolean(input.sky), coverage: Math.round(skyCover * 1e4) / 1e4, source: input.sky?.source ?? 'none' },
      ground: input.ground ? { source: input.ground.source, heightM: Math.round(input.ground.heightM * 1000) / 1000, pitchDeg: Math.round(pitch * 100) / 100 } : null,
      whiteBalance: { kelvin: wb ?? 6500, source: input.whiteBalance.source },
      marks: marks.slice(0, 200).map((m) => ({ ...m, x: Math.round(m.x * 1e4) / 1e4, y: Math.round(m.y * 1e4) / 1e4, x2: m.x2 === null ? null : Math.round(m.x2 * 1e4) / 1e4, y2: m.y2 === null ? null : Math.round(m.y2 * 1e4) / 1e4 })),
      warnings: warnings.slice(0, 30),
      ms: Date.now() - started,
    },
    model,
    camera: cam,
  };
}

function roundRange(r: Range, digits: number): Range {
  const k = 10 ** digits;
  const v = Math.round(r.value * k) / k;
  return { value: v, low: Math.min(v, Math.floor(r.low * k) / k), high: Math.max(v, Math.ceil(r.high * k) / k) };
}

export { dirOf };
