import { z } from 'zod';

/**
 * The built-in camera database (master spec §10.1; addendum 06 §4): cinema
 * camera sensors and their common recording modes, each mode's active image
 * area (the film back a matchmove needs) in millimetres and its pixel size.
 *
 * `verified: true` marks figures checked against the manufacturer's (or the
 * manufacturer's press) published numbers when this table was written
 * (October 2026, by web search; the source is named). Everything else is the
 * commonly published figure and is marked `verified: false` — check it
 * against the camera's spec sheet, or override it per shot.
 */

export const FilmBackSchema = z.object({ width: z.number().positive(), height: z.number().positive() });
export type FilmBack = z.infer<typeof FilmBackSchema>;

export const CameraModeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  filmBackMm: FilmBackSchema,
  /** The mode's recorded pixel size (photosites of the active area). */
  px: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  verified: z.boolean(),
  /** Other names the mode goes by on slates and in metadata. */
  aliases: z.array(z.string()).default([]),
});
export type CameraMode = z.infer<typeof CameraModeSchema>;

export const CameraBodySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  make: z.string().min(1),
  model: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  modes: z.array(CameraModeSchema).min(1),
  source: z.string().default(''),
  /** A project's own entry rather than the built-in table. */
  custom: z.boolean().default(false),
});
export type CameraBody = z.infer<typeof CameraBodySchema>;

const m = (id: string, name: string, w: number, h: number, pw: number, ph: number, verified: boolean, aliases: string[] = []): CameraMode => ({ id, name, filmBackMm: { width: w, height: h }, px: { width: pw, height: ph }, verified, aliases });

export const CAMERA_DB: readonly CameraBody[] = [
  // ARRI — arri.com/alexa35 technical data (sensor modes), checked by web search 2026-10.
  {
    id: 'arri-alexa-35',
    make: 'ARRI',
    model: 'ALEXA 35',
    aliases: ['alexa35', 'a35'],
    source: 'https://www.arri.com/alexa35 (technical data, sensor modes)',
    custom: false,
    modes: [
      m('4.6k-3x2-og', '4.6K 3:2 Open Gate', 27.99, 19.22, 4608, 3164, true, ['open gate', '4.6k og', '4.6k 3:2']),
      m('4.6k-16x9', '4.6K 16:9', 27.99, 15.75, 4608, 2592, true, ['4.6k 16:9']),
      m('4k-16x9', '4K 16:9', 24.88, 14.0, 4096, 2304, true, ['4k 16:9']),
      m('4k-2x1', '4K 2:1', 24.88, 12.44, 4096, 2048, true, ['4k 2:1']),
      m('3.8k-16x9', '3.8K 16:9 (UHD)', 23.33, 13.12, 3840, 2160, true, ['uhd', '3.8k']),
      m('3.3k-6x5', '3.3K 6:5', 20.22, 16.95, 3328, 2790, true, ['6:5', '3.3k']),
      m('3k-1x1', '3K 1:1', 18.66, 18.66, 3072, 3072, true, ['1:1', '3k']),
      m('2.7k-8x9', '2.7K 8:9', 16.66, 18.75, 2743, 3086, true, ['8:9', '2.7k']),
      m('2k-16x9-s16', '2K 16:9 S16', 12.44, 7.0, 2048, 1152, true, ['s16', '2k']),
    ],
  },
  {
    id: 'arri-alexa-mini-lf',
    make: 'ARRI',
    model: 'ALEXA Mini LF',
    aliases: ['mini lf', 'alexa mini lf'],
    source: 'ARRI ALEXA Mini LF technical data (Open Gate confirmed by web search 2026-10; other modes not)',
    custom: false,
    modes: [
      m('lf-og', 'LF Open Gate 4.5K 3:2', 36.7, 25.54, 4448, 3096, true, ['open gate', '4.5k', 'lf og']),
      m('lf-16x9-uhd', 'LF 16:9 UHD', 31.68, 17.82, 3840, 2160, false, ['uhd', '16:9']),
      m('lf-2.39', 'LF 2.39:1', 36.7, 15.31, 4448, 1856, false, ['2.39']),
    ],
  },
  {
    id: 'arri-alexa-lf',
    make: 'ARRI',
    model: 'ALEXA LF',
    aliases: ['alexa lf'],
    source: 'ARRI ALEXA LF technical data (same A2X sensor as the Mini LF)',
    custom: false,
    modes: [
      m('lf-og', 'LF Open Gate 4.5K 3:2', 36.7, 25.54, 4448, 3096, true, ['open gate', '4.5k']),
      m('lf-16x9-uhd', 'LF 16:9 UHD', 31.68, 17.82, 3840, 2160, false, ['uhd', '16:9']),
      m('lf-2.39', 'LF 2.39:1', 36.7, 15.31, 4448, 1856, false, ['2.39']),
    ],
  },
  {
    id: 'arri-alexa-mini',
    make: 'ARRI',
    model: 'ALEXA Mini',
    aliases: ['alexa mini', 'mini'],
    source: 'ARRI ALEXA Mini technical data (not re-checked)',
    custom: false,
    modes: [
      m('og-3.4k', 'Open Gate 3.4K', 28.25, 18.17, 3424, 2202, false, ['open gate', '3.4k']),
      m('4x3-2.8k', '4:3 2.8K', 23.76, 17.82, 2880, 2160, false, ['4:3', '2.8k 4:3']),
      m('16x9-3.2k', '16:9 3.2K', 26.4, 14.85, 3200, 1800, false, ['3.2k']),
      m('16x9-hd', '16:9 HD', 23.76, 13.37, 1920, 1080, false, ['hd', '2.8k 16:9']),
      m('16x9-uhd', '16:9 4K UHD (from 3.2K)', 26.4, 14.85, 3840, 2160, false, ['uhd', '4k']),
    ],
  },
  {
    id: 'arri-amira',
    make: 'ARRI',
    model: 'AMIRA',
    aliases: ['amira'],
    source: 'ARRI AMIRA technical data (not re-checked)',
    custom: false,
    modes: [
      m('3.2k', '3.2K 16:9', 26.4, 14.85, 3200, 1800, false, ['3.2k']),
      m('hd', 'HD 16:9', 23.76, 13.37, 1920, 1080, false, ['hd']),
      m('uhd', '4K UHD (from 3.2K)', 26.4, 14.85, 3840, 2160, false, ['uhd', '4k']),
    ],
  },
  // RED
  {
    id: 'red-v-raptor-8k-vv',
    make: 'RED',
    model: 'V-RAPTOR 8K VV',
    aliases: ['v-raptor vv', 'vraptor', 'v raptor'],
    source: 'https://www.red.com/press (V-RAPTOR 8K VV: 40.96 × 21.60 mm, 8192 × 4320), checked 2026-10',
    custom: false,
    modes: [
      m('8k-17x9', '8K 17:9', 40.96, 21.6, 8192, 4320, true, ['8k vv', '8k']),
      m('6k-s35', '6K 17:9 (S35 crop)', 30.72, 16.2, 6144, 3240, false, ['6k']),
    ],
  },
  {
    id: 'red-v-raptor-8k-s35',
    make: 'RED',
    model: 'V-RAPTOR 8K S35',
    aliases: ['v-raptor s35'],
    source: 'RED V-RAPTOR 8K S35 published specs (not re-checked)',
    custom: false,
    modes: [m('8k-17x9', '8K 17:9', 26.21, 13.82, 8192, 4320, false, ['8k'])],
  },
  {
    id: 'red-komodo-6k',
    make: 'RED',
    model: 'KOMODO 6K',
    aliases: ['komodo'],
    source: 'RED KOMODO 6K S35: 27.03 × 14.26 mm (retailer listing only, 2026-10)',
    custom: false,
    modes: [m('6k-17x9', '6K 17:9', 27.03, 14.26, 6144, 3240, false, ['6k'])],
  },
  {
    id: 'red-monstro-8k-vv',
    make: 'RED',
    model: 'MONSTRO 8K VV',
    aliases: ['monstro'],
    source: 'RED MONSTRO 8K VV published specs (not re-checked)',
    custom: false,
    modes: [m('8k-17x9', '8K 17:9', 40.96, 21.6, 8192, 4320, false, ['8k'])],
  },
  {
    id: 'red-helium-8k-s35',
    make: 'RED',
    model: 'HELIUM 8K S35',
    aliases: ['helium'],
    source: 'RED HELIUM 8K S35 published specs (not re-checked)',
    custom: false,
    modes: [m('8k-17x9', '8K 17:9', 29.9, 15.77, 8192, 4320, false, ['8k'])],
  },
  // Sony
  {
    id: 'sony-venice-2-8k',
    make: 'Sony',
    model: 'VENICE 2 8K',
    aliases: ['venice 2', 'venice2'],
    source: 'Sony VENICE 2 brochure / pro.sony imager modes (8.6K 3:2: 8640 × 5760, 35.9 × 24.0 mm), checked 2026-10',
    custom: false,
    modes: [
      m('8.6k-3x2', '8.6K 3:2', 35.9, 24.0, 8640, 5760, true, ['8.6k', '3:2', 'ff 3:2']),
      m('8.2k-17x9', '8.2K 17:9', 35.9, 18.9, 8192, 4320, false, ['8.2k', '17:9']),
    ],
  },
  {
    id: 'sony-venice-6k',
    make: 'Sony',
    model: 'VENICE / VENICE 2 6K',
    aliases: ['venice', 'venice 2 6k'],
    source: 'Sony VENICE 2 imager modes (6K 3:2: 6048 × 4032, 35.9 × 24.0 mm), checked 2026-10',
    custom: false,
    modes: [
      m('6k-3x2', '6K 3:2', 35.9, 24.0, 6048, 4032, true, ['6k 3:2', 'ff 3:2']),
      m('6k-17x9', '6K 17:9', 35.9, 18.9, 6054, 3192, false, ['6k 17:9']),
      m('4k-s35', '4K 4:3 S35', 24.3, 18.0, 4096, 3024, false, ['s35', '4k 4:3']),
    ],
  },
  {
    id: 'sony-burano',
    make: 'Sony',
    model: 'BURANO',
    aliases: ['burano'],
    source: 'Sony BURANO published specs (not re-checked)',
    custom: false,
    modes: [m('8.6k-3x2', '8.6K 3:2', 35.9, 24.0, 8632, 5760, false, ['8.6k']), m('8.6k-17x9', '8.6K 17:9', 35.9, 18.9, 8632, 4552, false, ['17:9'])],
  },
  {
    id: 'sony-fx9',
    make: 'Sony',
    model: 'PXW-FX9',
    aliases: ['fx9'],
    source: 'Sony FX9 published specs (not re-checked)',
    custom: false,
    modes: [m('ff-uhd', 'FF 6K scan → UHD (16:9 within the 17:9 sensor)', 33.4, 18.8, 3840, 2160, false, ['ff', 'uhd'])],
  },
  {
    id: 'sony-fx6',
    make: 'Sony',
    model: 'ILME-FX6',
    aliases: ['fx6'],
    source: 'Sony FX6 published specs (not re-checked)',
    custom: false,
    modes: [m('ff-uhd', 'FF UHD', 35.6, 20.0, 3840, 2160, false, ['uhd'])],
  },
  {
    id: 'sony-fx3',
    make: 'Sony',
    model: 'ILME-FX3',
    aliases: ['fx3'],
    source: 'Sony FX3 published specs (not re-checked)',
    custom: false,
    modes: [m('ff-uhd', 'FF UHD', 35.6, 20.0, 3840, 2160, false, ['uhd'])],
  },
  // Canon
  {
    id: 'canon-c70',
    make: 'Canon',
    model: 'EOS C70',
    aliases: ['c70'],
    source: 'Canon EOS C70 (Super 35 DGO; figure not re-checked)',
    custom: false,
    modes: [m('4k-dci', '4K DCI', 26.2, 13.8, 4096, 2160, false, ['4k'])],
  },
  {
    id: 'canon-c300-iii',
    make: 'Canon',
    model: 'EOS C300 Mark III',
    aliases: ['c300 mk iii', 'c300 mark iii', 'c300 iii'],
    source: 'Canon Asia spec page lists the S35 DGO sensor as 26.4 × 13.8 (approx.) — mode width not confirmed',
    custom: false,
    modes: [m('4k-dci', '4K DCI', 26.2, 13.8, 4096, 2160, false, ['4k'])],
  },
  {
    id: 'canon-c500-ii',
    make: 'Canon',
    model: 'EOS C500 Mark II',
    aliases: ['c500 mk ii', 'c500 mark ii', 'c500 ii'],
    source: 'Canon EOS C500 Mark II published effective area (not confirmed by search)',
    custom: false,
    modes: [m('5.9k', '5.9K FF', 38.1, 20.1, 5952, 3140, false, ['5.9k', 'ff'])],
  },
  {
    id: 'canon-c400',
    make: 'Canon',
    model: 'EOS C400',
    aliases: ['c400'],
    source: 'Canon EOS C400 (6K full frame; figure not re-checked)',
    custom: false,
    modes: [m('6k-ff', '6K FF 17:9', 36.0, 19.0, 6000, 3164, false, ['6k'])],
  },
  // Blackmagic
  {
    id: 'bmd-ursa-mini-pro-12k',
    make: 'Blackmagic Design',
    model: 'URSA Mini Pro 12K',
    aliases: ['ursa 12k', 'ursa mini pro 12k'],
    source: 'Blackmagic tech specs: effective sensor 27.03 × 14.25 mm, 12K DCI 12288 × 6480 (full sensor in every mode), checked 2026-10',
    custom: false,
    modes: [
      m('12k-dci', '12K DCI', 27.03, 14.25, 12288, 6480, true, ['12k']),
      m('8k-dci', '8K DCI (full sensor)', 27.03, 14.25, 8192, 4320, true, ['8k']),
      m('4k-dci', '4K DCI (full sensor)', 27.03, 14.25, 4096, 2160, true, ['4k']),
    ],
  },
  {
    id: 'bmd-pocket-6k',
    make: 'Blackmagic Design',
    model: 'Pocket Cinema Camera 6K',
    aliases: ['bmpcc 6k', 'pocket 6k'],
    source: 'Blackmagic published specs (not confirmed by search)',
    custom: false,
    modes: [m('6k-16x9', '6K 16:9', 23.1, 12.99, 6144, 3456, false, ['6k'])],
  },
  {
    id: 'bmd-pocket-4k',
    make: 'Blackmagic Design',
    model: 'Pocket Cinema Camera 4K',
    aliases: ['bmpcc 4k', 'pocket 4k'],
    source: 'Blackmagic published specs (not confirmed by search)',
    custom: false,
    modes: [m('4k-dci', '4K DCI', 18.96, 10.0, 4096, 2160, false, ['4k'])],
  },
  {
    id: 'bmd-pyxis-6k',
    make: 'Blackmagic Design',
    model: 'PYXIS 6K',
    aliases: ['pyxis'],
    source: 'Blackmagic PYXIS 6K published specs (not re-checked)',
    custom: false,
    modes: [m('6k-3x2', '6K 3:2 Open Gate', 36.0, 24.0, 6048, 4032, false, ['open gate', '6k'])],
  },
  // Panasonic
  {
    id: 'panasonic-varicam-lt',
    make: 'Panasonic',
    model: 'VariCam LT',
    aliases: ['varicam'],
    source: 'Panasonic VariCam LT published specs (not re-checked)',
    custom: false,
    modes: [m('4k-dci', '4K DCI', 26.68, 14.07, 4096, 2160, false, ['4k'])],
  },
  {
    id: 'panasonic-s1h',
    make: 'Panasonic',
    model: 'LUMIX S1H',
    aliases: ['s1h'],
    source: 'Panasonic LUMIX S1H published specs (not re-checked)',
    custom: false,
    modes: [m('6k-3x2', '6K 3:2', 35.6, 23.8, 5952, 3968, false, ['6k']), m('uhd', 'UHD (full width)', 35.6, 20.0, 3840, 2160, false, ['uhd', '4k'])],
  },
  // Phones
  {
    id: 'apple-iphone-15-pro-main',
    make: 'Apple',
    model: 'iPhone 15 Pro (main camera)',
    aliases: ['iphone 15 pro', 'iphone 15 pro max'],
    source: 'Apple: 48 MP main, 1/1.28-inch class; active area estimated (not verified)',
    custom: false,
    modes: [m('uhd', '4K UHD', 9.8, 5.5, 3840, 2160, false, ['4k'])],
  },
  {
    id: 'apple-iphone-16-pro-main',
    make: 'Apple',
    model: 'iPhone 16 Pro (main camera)',
    aliases: ['iphone 16 pro', 'iphone 16 pro max'],
    source: 'Apple: 48 MP Fusion main, 1/1.28-inch class; active area estimated (not verified)',
    custom: false,
    modes: [m('uhd', '4K UHD', 9.8, 5.5, 3840, 2160, false, ['4k'])],
  },
];

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9.:]+/g, ' ').trim();
const tokens = (s: string) => new Set(norm(s).split(' ').filter(Boolean));

function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / Math.max(ta.size, tb.size);
}

export interface CameraMatch {
  camera: CameraBody;
  mode: CameraMode;
  /** 0 … 1 */
  score: number;
  why: string;
}

/**
 * Match a handoff's camera body and sensor-mode text (fuzzy) against the
 * database (plus a project's custom cameras). Prefers a mode whose film back
 * agrees with the handoff's when one is given, then one matching the
 * resolution, then the mode text.
 */
export function matchCamera(input: { body?: string; sensorMode?: string; filmBackMm?: FilmBack; resolution?: { width: number; height: number } }, extra: readonly CameraBody[] = []): CameraMatch | null {
  const body = input.body?.trim();
  if (!body) return null;
  const all = [...extra, ...CAMERA_DB];
  let best: { camera: CameraBody; score: number } | null = null;
  for (const c of all) {
    const names = [`${c.make} ${c.model}`, c.model, ...c.aliases];
    const s = Math.max(...names.map((n) => (norm(body) === norm(n) ? 1 : similarity(body, n) * (norm(body).includes(norm(c.model)) ? 1 : 0.85))));
    if (!best || s > best.score) best = { camera: c, score: s };
  }
  if (!best || best.score < 0.5) return null;
  const c = best.camera;
  const scored = c.modes.map((mode) => {
    let s = 0;
    const why: string[] = [];
    if (input.filmBackMm) {
      const d = Math.abs(mode.filmBackMm.width - input.filmBackMm.width) + Math.abs(mode.filmBackMm.height - input.filmBackMm.height);
      if (d < 0.1) {
        s += 3;
        why.push('film back');
      }
    }
    if (input.sensorMode) {
      const t = Math.max(similarity(input.sensorMode, mode.name), ...mode.aliases.map((a) => similarity(input.sensorMode!, a) + (norm(input.sensorMode!).includes(norm(a)) ? 0.3 : 0)));
      s += 2 * t;
      if (t > 0.4) why.push('mode name');
    }
    if (input.resolution) {
      const ar = input.resolution.width / input.resolution.height;
      const mr = mode.px.width / mode.px.height;
      if (Math.abs(ar - mr) < 0.02) {
        s += 0.5;
        why.push('aspect');
      }
      if (input.resolution.width === mode.px.width && input.resolution.height === mode.px.height) {
        s += 1;
        why.push('resolution');
      }
    }
    return { mode, s, why };
  });
  scored.sort((a, b) => b.s - a.s);
  const top = scored[0]!;
  return { camera: c, mode: top.mode, score: best.score, why: `${c.make} ${c.model} from “${body}”${top.why.length ? `; mode by ${top.why.join(', ')}` : '; first mode (no mode text matched)'}` };
}

export function findCamera(cameraId: string, extra: readonly CameraBody[] = []): CameraBody | undefined {
  return [...extra, ...CAMERA_DB].find((c) => c.id === cameraId);
}

/** Focal length in pixels for a lens on a film back whose width spans `imageWidthPx` pixels. */
export function focalPixels(focalMm: number, filmBackWidthMm: number, imageWidthPx: number): number {
  return (focalMm * imageWidthPx) / filmBackWidthMm;
}

export function focalMillimetres(focalPx: number, filmBackWidthMm: number, imageWidthPx: number): number {
  return (focalPx * filmBackWidthMm) / imageWidthPx;
}

// ---------------------------------------------------------------------------
// Lens profiles (per project), keyed by camera + lens + focal length
// ---------------------------------------------------------------------------

export const DistortionSchema = z.object({
  /** Brown–Conrady on coordinates normalised by the focal length (OpenCV's model). */
  k1: z.number().finite().default(0),
  k2: z.number().finite().default(0),
  k3: z.number().finite().default(0),
  p1: z.number().finite().default(0),
  p2: z.number().finite().default(0),
});
export type Distortion = z.infer<typeof DistortionSchema>;
export const NO_DISTORTION: Distortion = { k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 };

export const LensProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  /** "ARRI ALEXA 35 · 4.6K 3:2 Open Gate" or a custom label. */
  camera: z.string().min(1),
  cameraId: z.string().nullable().default(null),
  modeId: z.string().nullable().default(null),
  lens: z.string().default(''),
  focalMm: z.number().positive(),
  distortion: DistortionSchema,
  /** Anamorphic squeeze (1 for spherical); recorded for 3DE/Nuke-style models, not used by the solver yet. */
  squeeze: z.number().positive().default(1),
  /** The image width (pixels) the coefficients were measured at; they are resolution independent in this model. */
  measuredWidthPx: z.number().int().positive().nullable().default(null),
  source: z.enum(['calibration', 'solve', 'manual']),
  /** RMS reprojection error of the calibration or solve, pixels. */
  rms: z.number().nonnegative().nullable().default(null),
  notes: z.string().default(''),
  at: z.string(),
  by: z.string(),
});
export type LensProfile = z.infer<typeof LensProfileSchema>;

/** The profile for a camera/lens/focal combination: exact focal first, else the nearest within 10 %. */
export function findLensProfile(profiles: readonly LensProfile[], q: { cameraId?: string | null; modeId?: string | null; lens?: string; focalMm?: number | null }): LensProfile | null {
  const cands = profiles.filter((p) => (!q.cameraId || !p.cameraId || p.cameraId === q.cameraId) && (!q.lens || !p.lens || norm(p.lens) === norm(q.lens)));
  if (!cands.length) return null;
  if (!q.focalMm) return cands[0] ?? null;
  const sorted = [...cands].sort((a, b) => Math.abs(a.focalMm - q.focalMm!) - Math.abs(b.focalMm - q.focalMm!));
  const p = sorted[0]!;
  return Math.abs(p.focalMm - q.focalMm) / q.focalMm <= 0.1 ? p : null;
}
