import { z } from 'zod';
import type { Camera } from './handoff.js';
import type { CameraMode } from './camera-db.js';

/**
 * Pixel aspect ratio (addendum 17): the width of one stored pixel over its
 * height. 1 for square pixels; 2 for a 2× anamorphic plate delivered squeezed;
 * 1.5 for DVCPRO HD 1080 (1280 × 1080 stored, shown 1920 × 1080).
 *
 * VC VFX never resamples a plate to undo it (spec §4, §19: delivered plates
 * are the camera's pixels). The pixel aspect is metadata: it travels with the
 * shot, every computation that measures shape or angle de-squeezes through it
 * (camera solve, textures, lighting directions, alignment), every picture is
 * shown de-squeezed in the view transform only, and every export declares it
 * in the receiving application's own terms.
 *
 * Where it comes from, in priority order:
 *   1. the artist's override on the shot;
 *   2. the handoff (`camera.pixelAspect`, the shot's `pixelAspect`, or a lens
 *      squeeze `camera.anamorphicSqueeze` / `camera.lensSqueeze`);
 *   3. the camera database: the recording mode's squeeze and raster (a mode
 *      recorded desqueezed in camera has square pixels however anamorphic the lens);
 *   4. the clip's own metadata (ffprobe's sample aspect ratio: QuickTime
 *      `pasp`, MXF, PNG `pHYs`, DPX/EXR header pixel aspect);
 *   5. square.
 * The source used is recorded and shown; when two sources disagree the
 * decision carries a warning rather than silently picking one.
 */

/** Two aspects closer than this (relative) are the same. */
export const PIXEL_ASPECT_TOLERANCE = 0.005;

export const PixelAspectValueSchema = z.number().min(0.25).max(4);

export const PixelAspectOverrideSchema = z.object({
  value: PixelAspectValueSchema,
  note: z.string().default(''),
  by: z.string(),
  at: z.string(),
});
export type PixelAspectOverride = z.infer<typeof PixelAspectOverrideSchema>;

export const PIXEL_ASPECT_SOURCES = ['override', 'handoff', 'camera', 'clip', 'default'] as const;
export type PixelAspectSource = (typeof PIXEL_ASPECT_SOURCES)[number];

export const PIXEL_ASPECT_SOURCE_LABELS: Record<PixelAspectSource, string> = {
  override: 'Set on the shot',
  handoff: 'From the handoff',
  camera: 'From the camera database',
  clip: 'From the clip’s metadata',
  default: 'Square (nothing says otherwise)',
};

export interface PixelAspectPreset {
  value: number;
  label: string;
  /** The stored raster this is usually seen at, when it is a video format. */
  raster?: { width: number; height: number };
}

/** Common pixel aspects (the anamorphic squeezes, then the legacy video formats). */
export const PIXEL_ASPECT_PRESETS: readonly PixelAspectPreset[] = [
  { value: 1, label: 'Square' },
  { value: 2, label: '2× anamorphic' },
  { value: 1.8, label: '1.8× anamorphic' },
  { value: 1.65, label: '1.65× anamorphic' },
  { value: 1.6, label: '1.6× anamorphic' },
  { value: 1.5, label: '1.5× anamorphic / DVCPRO HD 1080', raster: { width: 1280, height: 1080 } },
  { value: 1.33, label: '1.33× anamorphic' },
  { value: 4 / 3, label: 'HDV / DVCPRO HD (4:3 samples)', raster: { width: 1440, height: 1080 } },
  { value: 1.3, label: '1.3× anamorphic' },
  { value: 1.25, label: '1.25× anamorphic' },
  { value: 10 / 11, label: 'NTSC DV 4:3' },
  { value: 40 / 33, label: 'NTSC DV 16:9' },
  { value: 59 / 54, label: 'PAL DV 4:3' },
  { value: 118 / 81, label: 'PAL DV 16:9' },
  { value: 0.9, label: 'NTSC D1 4:3 (0.9)' },
];

/** Rasters that are almost never square-pixel: a hint, never applied on their own. */
export const NON_SQUARE_RASTERS: readonly { width: number; height: number; value: number; label: string }[] = [
  { width: 1280, height: 1080, value: 1.5, label: 'DVCPRO HD 1080 (1280 × 1080 shown 1920 × 1080)' },
  { width: 1440, height: 1080, value: 4 / 3, label: 'HDV / DVCPRO HD 1080 (1440 × 1080 shown 1920 × 1080)' },
  { width: 960, height: 720, value: 4 / 3, label: 'DVCPRO HD 720 (960 × 720 shown 1280 × 720)' },
  { width: 720, height: 480, value: 10 / 11, label: 'NTSC DV (0.909 for 4:3, 1.212 for 16:9)' },
  { width: 720, height: 486, value: 10 / 11, label: 'NTSC D1 (0.909 for 4:3, 1.212 for 16:9)' },
  { width: 720, height: 576, value: 59 / 54, label: 'PAL DV (1.093 for 4:3, 1.459 for 16:9)' },
];

export const sameAspect = (a: number, b: number): boolean => Math.abs(a - b) <= PIXEL_ASPECT_TOLERANCE * Math.max(a, b);

export const isSquare = (a: number): boolean => sameAspect(a, 1);

/** "1.5" / "1.333" / "0.909" — three decimals at most, trailing zeros off. */
export function formatPixelAspect(a: number): string {
  return String(Math.round(a * 1000) / 1000);
}

/** The preset a value is (within tolerance), if any. */
export function pixelAspectPreset(a: number): PixelAspectPreset | null {
  return PIXEL_ASPECT_PRESETS.find((p) => sameAspect(p.value, a)) ?? null;
}

/** "1.5 (1.5× anamorphic / DVCPRO HD 1080)"; "1 (square)". */
export function pixelAspectLabel(a: number): string {
  if (isSquare(a)) return '1 (square)';
  const p = pixelAspectPreset(a);
  return p ? `${formatPixelAspect(a)} (${p.label})` : formatPixelAspect(a);
}

/** "3:2", "4/3", "1.5", "40:33" → number; null for nonsense, 0:1 (unknown) or out of range. */
export function parsePixelAspect(text: unknown): number | null {
  if (typeof text === 'number') return text >= 0.25 && text <= 4 && Number.isFinite(text) ? text : null;
  if (typeof text !== 'string') return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:[:/]\s*(\d+(?:\.\d+)?))?\s*×?\s*$/.exec(text);
  if (!m) return null;
  const den = m[2] ? Number(m[2]) : 1;
  if (!(den > 0)) return null;
  const v = Number(m[1]) / den;
  return v >= 0.25 && v <= 4 && Number.isFinite(v) ? v : null;
}

/**
 * The pixel aspect of a camera-database recording mode: its lens squeeze
 * times how much wider its film back is than its raster. A mode recorded
 * squeezed (2560 × 2146 of a 6:5 area for 2× lenses) is 2; the same area
 * desqueezed in camera to 4096 × 1716 is 1; a spherical mode is 1.
 */
export function modePixelAspect(mode: Pick<CameraMode, 'anamorphicSqueeze' | 'filmBackMm' | 'px'>): number {
  const squeeze = mode.anamorphicSqueeze ?? 1;
  if (squeeze === 1) return 1;
  const v = squeeze * (mode.filmBackMm.width / mode.filmBackMm.height) / (mode.px.width / mode.px.height);
  // Snap the rounding of published figures to the nearest preset.
  return pixelAspectPreset(v)?.value ?? v;
}

/**
 * A handoff camera's pixel aspect and how it was read. An explicit pixel
 * aspect is used as it is. A lens squeeze is the plate's pixel aspect unless
 * the handoff's film back and resolution show the raster was desqueezed in
 * camera (then 1).
 */
export function handoffPixelAspect(shot: { pixelAspect?: unknown; camera?: Camera; resolution?: { width: number; height: number } }): { value: number; detail: string } | null {
  const cam = (shot.camera ?? {}) as Camera & { pixelAspect?: unknown; anamorphicSqueeze?: unknown; lensSqueeze?: unknown; squeeze?: unknown };
  const explicit = parsePixelAspect(cam.pixelAspect) ?? parsePixelAspect(shot.pixelAspect);
  if (explicit !== null) return { value: explicit, detail: `pixel aspect ${formatPixelAspect(explicit)}` };
  const squeeze = parsePixelAspect(cam.anamorphicSqueeze) ?? parsePixelAspect(cam.lensSqueeze) ?? parsePixelAspect(cam.squeeze);
  if (squeeze === null) return null;
  if (squeeze !== 1 && cam.filmBackMm && shot.resolution) {
    const fb = cam.filmBackMm.width / cam.filmBackMm.height;
    const res = shot.resolution.width / shot.resolution.height;
    if (Math.abs(fb * squeeze - res) / res < 0.03) return { value: 1, detail: `${formatPixelAspect(squeeze)}× lens squeeze, but the ${shot.resolution.width} × ${shot.resolution.height} raster is already desqueezed (film back ${cam.filmBackMm.width} × ${cam.filmBackMm.height} mm)` };
  }
  return { value: squeeze, detail: `${formatPixelAspect(squeeze)}× lens squeeze` };
}

export interface PixelAspectCandidate {
  source: Exclude<PixelAspectSource, 'default'>;
  value: number;
  detail: string;
}

export interface PixelAspectDecision {
  value: number;
  source: PixelAspectSource;
  /** One line: "1.5 (DVCPRO HD 1080) · From the handoff: pixel aspect 1.5". */
  summary: string;
  detail: string;
  /** Every source that said something, highest priority first. */
  candidates: PixelAspectCandidate[];
  /** Disagreements between sources; also a known non-square raster left square. */
  warnings: string[];
  /** A suggested value when nothing says, from a raster that is almost never square. */
  hint: { value: number; detail: string } | null;
  /** `value !== 1` */
  anamorphic: boolean;
}

export interface PixelAspectInputs {
  override?: PixelAspectOverride | null;
  handoff?: { value: number; detail: string } | null;
  camera?: { value: number; detail: string } | null;
  /** The clip's own sample aspect (absent when the file does not say). */
  clip?: { value: number; detail: string } | null;
  resolution?: { width: number; height: number } | null;
}

const SOURCE_SHORT: Record<Exclude<PixelAspectSource, 'default'>, string> = { override: 'the shot’s override', handoff: 'the handoff', camera: 'the camera database', clip: 'the clip' };

/** Decide a shot's pixel aspect from what each source says (pure). */
export function resolvePixelAspect(input: PixelAspectInputs): PixelAspectDecision {
  const candidates: PixelAspectCandidate[] = [];
  if (input.override) candidates.push({ source: 'override', value: input.override.value, detail: `${input.override.by}${input.override.note ? `: ${input.override.note}` : ''}` });
  if (input.handoff) candidates.push({ source: 'handoff', ...input.handoff });
  if (input.camera) candidates.push({ source: 'camera', ...input.camera });
  if (input.clip) candidates.push({ source: 'clip', ...input.clip });
  const chosen = candidates[0] ?? null;
  const value = chosen?.value ?? 1;
  const source: PixelAspectSource = chosen?.source ?? 'default';
  const warnings: string[] = [];
  if (chosen) {
    for (const c of candidates.slice(1)) {
      if (!sameAspect(c.value, value)) warnings.push(`${SOURCE_SHORT[c.source][0]!.toUpperCase()}${SOURCE_SHORT[c.source].slice(1)} says ${pixelAspectLabel(c.value)} (${c.detail}); ${SOURCE_SHORT[chosen.source]}’s ${formatPixelAspect(value)} is used.`);
    }
  }
  let hint: PixelAspectDecision['hint'] = null;
  const r = input.resolution;
  const raster = r ? NON_SQUARE_RASTERS.find((x) => x.width === r.width && x.height === r.height) : undefined;
  if (raster && isSquare(value)) {
    hint = { value: raster.value, detail: raster.label };
    warnings.push(`${r!.width} × ${r!.height} is usually ${raster.label}, not square pixels. Check the format and set the pixel aspect if the picture looks squeezed.`);
  }
  const detail = chosen ? chosen.detail : 'no source gives a pixel aspect';
  return {
    value,
    source,
    summary: `${pixelAspectLabel(value)} · ${PIXEL_ASPECT_SOURCE_LABELS[source]}${chosen ? `: ${chosen.detail}` : ''}`,
    detail,
    candidates,
    warnings,
    hint,
    anamorphic: !isSquare(value),
  };
}

// ---------------------------------------------------------------------------
// Geometry helpers shared by the modules
// ---------------------------------------------------------------------------

/** The plate's shape on screen: stored width × pixel aspect, by height. */
export function displaySize(size: { width: number; height: number }, pixelAspect: number): { width: number; height: number } {
  return { width: size.width * pixelAspect, height: size.height };
}

/**
 * The horizontal aperture that matches the de-squeezed picture (what Nuke's
 * `haperture`, Maya's film back × lens squeeze, Blender's sensor width…
 * describe), from a film back the stored raster spans.
 *
 *  - A film back already the shape of the de-squeezed picture (width / height
 *    ≈ W·PAR / H: a DV camera's 16:9 sensor sampled 1280 × 1080, or a back
 *    typed in de-squeezed) is used as it is.
 *  - Otherwise it is the sensor area behind an anamorphic lens, and the
 *    picture spans its width × the squeeze (the 3DE / Nuke convention).
 */
export function effectiveFilmBack(filmBackMm: { width: number; height: number }, plate: { width: number; height: number }, pixelAspect: number): { width: number; height: number; desqueezed: boolean } {
  if (isSquare(pixelAspect)) return { ...filmBackMm, desqueezed: false };
  const fb = filmBackMm.width / filmBackMm.height;
  const shown = (plate.width * pixelAspect) / plate.height;
  if (Math.abs(fb - shown) / shown < 0.03) return { ...filmBackMm, desqueezed: false };
  return { width: filmBackMm.width * pixelAspect, height: filmBackMm.height, desqueezed: true };
}

/** A pixel aspect as a small fraction [num, den] (best approximation with den ≤ maxDen): 1.5 → [3, 2], 10/11 → [10, 11]. */
export function pixelAspectRational(a: number, maxDen = 1000): [number, number] {
  let [h0, h1, k0, k1] = [0, 1, 1, 0];
  let x = a;
  for (let i = 0; i < 32; i += 1) {
    const q = Math.floor(x);
    const h2 = q * h1 + h0;
    const k2 = q * k1 + k0;
    if (k2 > maxDen) break;
    [h0, h1, k0, k1] = [h1, h2, k1, k2];
    if (Math.abs(h1 / k1 - a) < 1e-9 || x - q < 1e-12) break;
    x = 1 / (x - q);
  }
  return [h1, k1];
}
