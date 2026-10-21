import { z } from 'zod';

import { CAMERA_DATA, type CameraBodyData, type CameraCategory } from './camera-db-data.js';

/**
 * The built-in camera database (master spec §10.1; addendum 06, "Camera
 * database"): cinema, broadcast, mirrorless, drone, gimbal, action and phone
 * cameras and their recording modes — each mode's active image area (the film
 * back a matchmove needs) in millimetres and its pixel size. The data is in
 * `camera-db-data.ts`; this module is the schema, the lookup and the matching
 * of a handoff's camera text.
 *
 * `verified: true` on a mode marks figures found in the manufacturer's (or a
 * reputable press) published numbers; everything else is derived, modelled or
 * the commonly published figure, is marked unverified in the interface, and
 * should be checked against the camera's spec sheet or overridden per shot.
 */

export const CAMERA_CATEGORIES = ['cinema', 'mirrorless', 'broadcast', 'drone', 'gimbal', 'action', 'phone', 'other'] as const satisfies readonly CameraCategory[];
export type { CameraCategory };

export const FilmBackSchema = z.object({ width: z.number().positive(), height: z.number().positive() });
export type FilmBack = z.infer<typeof FilmBackSchema>;

export const CameraModeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  filmBackMm: FilmBackSchema,
  /** The mode's recorded pixel size (photosites of the active area, or the output raster when scaled). */
  px: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  verified: z.boolean(),
  /** Other names the mode goes by on slates and in metadata. */
  aliases: z.array(z.string()).default([]),
  /** Where the figure comes from or how it was derived ("derived: … pitch", "scaled/binned: …"). */
  notes: z.string().default(''),
  /** Set (≠ 1) where the recorded raster itself is anamorphic. */
  anamorphicSqueeze: z.number().positive().default(1),
});
export type CameraMode = z.infer<typeof CameraModeSchema>;

export const CameraBodySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  make: z.string().min(1),
  model: z.string().min(1),
  category: z.enum(CAMERA_CATEGORIES).default('other'),
  sensorFormat: z.string().default(''),
  aliases: z.array(z.string()).default([]),
  modes: z.array(CameraModeSchema).min(1),
  /** The mode to pick when nothing else says which; the first mode when null. */
  defaultModeId: z.string().nullable().default(null),
  /** The body's default mode was found in a manufacturer or reputable source. */
  verified: z.boolean().default(false),
  verifiedNotes: z.string().default(''),
  source: z.string().default(''),
  /** Source URLs. */
  sources: z.array(z.string()).default([]),
  /** Fixed-lens cameras (drones, phones): the published 35 mm-equivalent focal length. */
  equivFocalMm: z.number().positive().nullable().default(null),
  /** Fixed-lens cameras: the real focal length, filled in as the lens's starting focal. */
  fixedFocalMm: z.number().positive().nullable().default(null),
  fixedFocalNotes: z.string().default(''),
  /** A project's own entry rather than the built-in table. */
  custom: z.boolean().default(false),
});
export type CameraBody = z.infer<typeof CameraBodySchema>;
/** A camera body as written by hand (defaults filled in by the schema). */
export type CameraBodyInput = z.input<typeof CameraBodySchema>;

function fromData(b: CameraBodyData): CameraBody {
  return {
    id: b.id,
    make: b.make,
    model: b.model,
    category: b.category,
    sensorFormat: b.sensorFormat,
    aliases: b.aliases,
    defaultModeId: b.defaultModeId,
    verified: b.verified,
    verifiedNotes: b.verifiedNotes,
    source: b.source,
    sources: b.sources,
    equivFocalMm: b.equivFocalMm ?? null,
    fixedFocalMm: b.fixedFocalMm ?? null,
    fixedFocalNotes: b.fixedFocalNotes ?? '',
    custom: false,
    modes: b.modes.map((m) => ({ id: m.id, name: m.name, filmBackMm: { width: m.mm[0], height: m.mm[1] }, px: { width: m.px[0], height: m.px[1] }, verified: m.verified, aliases: m.aliases ?? [], notes: m.notes ?? '', anamorphicSqueeze: m.squeeze ?? 1 })),
  };
}

export const CAMERA_DB: readonly CameraBody[] = CAMERA_DATA.map(fromData);

/** The body's default mode (its `defaultModeId`, else the first). */
export function defaultMode(c: CameraBody): CameraMode {
  return c.modes.find((m) => m.id === c.defaultModeId) ?? c.modes[0]!;
}

/** "4.6K 3:2 Open Gate — 27.99 × 19.22 mm · 4608×3164" */
export function modeLabel(m: CameraMode): string {
  return `${m.name} — ${m.filmBackMm.width} × ${m.filmBackMm.height} mm · ${m.px.width}×${m.px.height}${m.anamorphicSqueeze !== 1 ? ` · ${m.anamorphicSqueeze}× ana` : ''}`;
}

/** The first source URL, for "check this figure". */
export function sourceUrl(c: CameraBody): string | null {
  return c.sources.find((u) => /^https?:\/\//.test(u)) ?? c.source.match(/https?:\/\/\S+/)?.[0]?.replace(/[),.;]+$/, '') ?? null;
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9.:]+/g, ' ').trim();
/** Spaces, dashes and punctuation out: "ILME-FX3" = "ilme fx3" = "ILMEFX3". */
const compact = (s: string) => norm(s).replace(/[^a-z0-9]+/g, '');
const tokens = (s: string) => new Set(norm(s).split(' ').filter(Boolean));

function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / Math.max(ta.size, tb.size);
}

/** How well a camera body's text names this camera, 0 … 1. */
function nameScore(text: string, c: CameraBody): number {
  const t = compact(text);
  if (!t) return 0;
  // The text without the maker ("Blackmagic URSA Mini Pro 12K" → "URSA Mini Pro 12K").
  const makes = [c.make, c.make.split(/[\s(]/)[0]!];
  const tMake = makes.map((mk) => compact(text.replace(new RegExp(`^\\s*${mk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'), ''))).sort((a, b) => a.length - b.length)[0]!;
  let best = 0;
  for (const n of [`${c.make} ${c.model}`, c.model, ...c.aliases]) {
    const k = compact(n);
    if (!k) continue;
    if (t === k || tMake === k) return 1;
    let s = similarity(text, n) * (norm(text).includes(norm(c.model)) ? 1 : 0.85);
    // "Sony ILME-FX3A body" contains "ilmefx3": a containment scores by how much of the text it explains.
    if (k.length >= 3 && t.includes(k)) s = Math.max(s, 0.55 + 0.4 * (k.length / Math.max(k.length, tMake.length || t.length)));
    if (s > best) best = s;
  }
  return best;
}

export interface CameraMatch {
  camera: CameraBody;
  mode: CameraMode;
  /** 0 … 1 */
  score: number;
  /** Strong enough to choose the camera without asking (score ≥ 0.75). */
  confident: boolean;
  why: string;
}

/**
 * Match a handoff's camera body and sensor-mode text (fuzzy) against the
 * database (plus a project's custom cameras). Prefers a mode whose film back
 * agrees with the handoff's when one is given, then one matching the
 * resolution, then the mode text, then the body's default mode.
 */
export function matchCamera(input: { body?: string; sensorMode?: string; filmBackMm?: FilmBack; resolution?: { width: number; height: number } }, extra: readonly CameraBody[] = []): CameraMatch | null {
  const body = input.body?.trim();
  if (!body) return null;
  const all = [...extra, ...CAMERA_DB];
  let best: { camera: CameraBody; score: number } | null = null;
  for (const c of all) {
    const s = nameScore(body, c);
    if (!best || s > best.score + 1e-9) best = { camera: c, score: s };
  }
  if (!best || best.score < 0.5) return null;
  const c = best.camera;
  const scored = c.modes.map((mode) => {
    let s = mode.id === c.defaultModeId ? 0.1 : 0;
    const why: string[] = [];
    if (input.filmBackMm) {
      const d = Math.abs(mode.filmBackMm.width - input.filmBackMm.width) + Math.abs(mode.filmBackMm.height - input.filmBackMm.height);
      if (d < 0.1) {
        s += 3;
        why.push('film back');
      }
    }
    if (input.sensorMode) {
      const t = Math.max(similarity(input.sensorMode, mode.name) + (compact(input.sensorMode) === compact(mode.name) ? 0.5 : 0), ...mode.aliases.map((a) => similarity(input.sensorMode!, a) + (norm(input.sensorMode!).includes(norm(a)) ? 0.3 : 0)));
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
  return {
    camera: c,
    mode: top.mode,
    score: best.score,
    confident: best.score >= 0.75,
    why: `${c.make} ${c.model} from “${body}”${top.why.length ? `; mode by ${top.why.join(', ')}` : '; default mode (no mode text matched)'}`,
  };
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
