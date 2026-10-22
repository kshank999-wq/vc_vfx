import { z } from 'zod';
import { COLOR_ENCODINGS } from './color.js';

/**
 * The lighting-and-lens analysis document a shot carries in the project file
 * (master spec §13; addendum 14). Kept apart from `lighting.ts` so
 * `project.ts` can embed the schema without importing the mutations.
 *
 * What lives here is small and is the artist's work plus the estimate it
 * started from: the frames analysed and the references used (paths,
 * checksums, a ball's circle — never the pictures), the analysis settings,
 * the estimated rig and lens **with their ranges** (§13 "confidence ranges
 * rather than false precision"), the artist's edits kept apart from the
 * estimate so a new analysis never overwrites them, the AI reviews and the
 * artist's decisions on them, and the versioned exports. Pictures are files —
 * never here.
 *
 * Directions are relative to the camera at the analysed frame, as seen from
 * the subject: azimuth 0° = the light comes from the camera's side (a front
 * light), +90° = from frame right, ±180° = from behind the subject (a back
 * light); elevation 0° = level with the camera's horizon, +90° = straight
 * down from above. The exports place them in the camera track's scene.
 */

export const LIGHTING_FORMAT_VERSION = 1;
/** Shading + contour + cast shadows + highlights / balls / HDRI + practicals + vanishing points (addendum 14 §3). */
export const LIGHTING_ALGORITHM = { id: 'vcvfx-lighting', version: '1.0.0' } as const;

export const LIGHT_ROLES = ['key', 'fill', 'rim', 'back', 'practical', 'background', 'ambient', 'sun', 'sky'] as const;
export type LightRole = (typeof LIGHT_ROLES)[number];

export const LIGHT_TYPES = ['point', 'spot', 'rect', 'directional', 'dome'] as const;
export type LightType = (typeof LIGHT_TYPES)[number];

/** What a figure was estimated from. */
export const LIGHT_EVIDENCE = ['shading', 'contour', 'shadow', 'penumbra', 'highlight', 'chrome_ball', 'grey_ball', 'hdri', 'practical', 'fill_ratio', 'sky', 'background', 'colour', 'artist', 'ai'] as const;
export type LightEvidence = (typeof LIGHT_EVIDENCE)[number];

export const LIGHTING_REFERENCE_KINDS = ['chrome_ball', 'grey_ball', 'hdri'] as const;
export type LightingReferenceKind = (typeof LIGHTING_REFERENCE_KINDS)[number];

/** Where a reference is: a frame of the plate (balls held up at the end of the take), a file chosen on disk, named by the handoff, a Textures panorama, or the preview's sample. */
export const LIGHTING_REFERENCE_ORIGINS = ['plate', 'disk', 'handoff', 'texture', 'sample'] as const;
export type LightingReferenceOrigin = (typeof LIGHTING_REFERENCE_ORIGINS)[number];

/** Where the subject matte for the shading analysis comes from (addendum 14 §3.1). */
export const LIGHTING_SUBJECT_SOURCES = ['auto', 'roto', 'bg_matte', 'key_alpha', 'none'] as const;
export type LightingSubjectSource = (typeof LIGHTING_SUBJECT_SOURCES)[number];

export const LIGHTING_EXPORT_FORMATS = ['unreal', 'usd', 'json', 'blender', 'report'] as const;
export type LightingExportFormat = (typeof LIGHTING_EXPORT_FORMATS)[number];

const Id = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
const finite = z.number().finite();

/** An estimate: the figure and the range it is believed to lie in (low ≤ value ≤ high). */
export const RangeSchema = z
  .object({ value: finite, low: finite, high: finite })
  .refine((r) => r.low <= r.value + 1e-9 && r.value <= r.high + 1e-9, { message: 'A range must hold its value (low ≤ value ≤ high)' });
export type Range = z.infer<typeof RangeSchema>;

const Rgb = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]);

/** The editable figures of a light: one value each (the artist's, or the estimate's middle). */
export const LightSpecSchema = z.object({
  role: z.enum(LIGHT_ROLES),
  type: z.enum(LIGHT_TYPES),
  name: z.string().min(1).max(60),
  enabled: z.boolean().default(true),
  azimuthDeg: z.number().min(-180).max(180),
  elevationDeg: z.number().min(-90).max(90),
  /** From the subject, metres; null for a directional light or a dome (at infinity). */
  distanceM: z.number().min(0.05).max(100000).nullable(),
  /** Relative to the key's illuminance at the subject, in stops (the key is 0). */
  intensityStops: z.number().min(-20).max(20),
  /** The source's apparent angular diameter seen from the subject, degrees (softness); null: a point / unknown. */
  sizeDeg: z.number().min(0).max(180).nullable(),
  /** Correlated colour temperature, kelvin; null: not a blackbody (use rgb). */
  temperatureK: z.number().min(1000).max(40000).nullable(),
  /** The light's colour, linear in the working gamut, normalised so its largest channel is 1. */
  rgb: Rgb,
});
export type LightSpec = z.infer<typeof LightSpecSchema>;

export const LIGHT_FIELDS = ['role', 'type', 'name', 'enabled', 'azimuthDeg', 'elevationDeg', 'distanceM', 'intensityStops', 'sizeDeg', 'temperatureK', 'rgb'] as const;
export type LightField = (typeof LIGHT_FIELDS)[number];
export const LightFieldsSchema = LightSpecSchema.partial();
export type LightFields = z.infer<typeof LightFieldsSchema>;

/** A light the analysis estimated, with a range for every figure and what it rests on. */
export const LightEstimateSchema = z.object({
  /** Stable across analyses (key, fill, rim, practical1 …) so the artist's edits follow the light. */
  id: Id,
  role: z.enum(LIGHT_ROLES),
  type: z.enum(LIGHT_TYPES),
  name: z.string().min(1).max(60),
  azimuth: RangeSchema,
  elevation: RangeSchema,
  distance: RangeSchema.nullable(),
  intensity: RangeSchema,
  size: RangeSchema.nullable(),
  temperature: RangeSchema.nullable(),
  rgb: Rgb,
  /** A practical seen in frame: where (0 … 1 of the plate's width and height) and how big. */
  practical: z.object({ x: z.number(), y: z.number(), radius: z.number().nonnegative() }).nullable().default(null),
  /** Likely motivation ("window light from frame left", "the desk lamp") — a note for the artist. */
  motivation: z.string().max(400).default(''),
  evidence: z.array(z.enum(LIGHT_EVIDENCE)).max(16).default([]),
  confidence: z.number().min(0).max(1),
});
export type LightEstimate = z.infer<typeof LightEstimateSchema>;

/** The artist's values for an estimated light's fields: they survive every new analysis (they are "locked"). */
export const LightEditSchema = z.object({
  lightId: Id,
  fields: LightFieldsSchema,
  /** "artist", or "ai:<review>/<suggestion>" when an accepted AI suggestion set them. */
  from: z.string().max(40).default('artist'),
  by: z.string(),
  at: z.string(),
});
export type LightEdit = z.infer<typeof LightEditSchema>;

/** A light the artist added (or accepted from an AI suggestion). */
export const ArtistLightSchema = z.object({
  id: Id,
  spec: LightSpecSchema,
  from: z.string().max(40).default('artist'),
  by: z.string(),
  at: z.string(),
});
export type ArtistLight = z.infer<typeof ArtistLightSchema>;

export const LightingCircleSchema = z.object({ cx: finite, cy: finite, r: z.number().positive() });
export type LightingCircle = z.infer<typeof LightingCircleSchema>;

export const LightingReferenceSchema = z.object({
  id: Id,
  kind: z.enum(LIGHTING_REFERENCE_KINDS),
  name: z.string().min(1).max(200),
  from: z.enum(LIGHTING_REFERENCE_ORIGINS),
  /** Absolute path on disk; handoff-relative for `handoff`; the Textures reference id for `texture`; '' for `plate`; a name for `sample`. Read only, always. */
  path: z.string().max(4096).default(''),
  /** A ball in the plate: the frame it is held up in. */
  frame: z.number().int().nonnegative().nullable().default(null),
  /** A ball: its circle, in pixels of the picture it is in (the plate, or the still). */
  circle: LightingCircleSchema.nullable().default(null),
  /** An HDRI: the panorama yaw (degrees, positive to the right of its centre column) the camera looked along; null: aligned to the plate's shading by the analysis. */
  headingDeg: z.number().min(-360).max(360).nullable().default(null),
  format: z.string().max(16).default(''),
  checksum: z.object({ algorithm: z.literal('sha256'), value: z.string().regex(/^[0-9a-f]{64}$/) }).nullable().default(null),
  bytes: z.number().int().nonnegative().nullable().default(null),
  width: z.number().int().positive().nullable().default(null),
  height: z.number().int().positive().nullable().default(null),
  encoding: z.enum(COLOR_ENCODINGS).nullable().default(null),
  addedBy: z.string(),
  addedAt: z.string(),
});
export type LightingReference = z.infer<typeof LightingReferenceSchema>;

export const LightingSettingsSchema = z.object({
  /** The plate frames analysed (the first is the one the rig is placed at). Empty: the shot's middle frame. */
  frames: z.array(z.number().int().nonnegative()).max(8).default([]),
  subject: z.enum(LIGHTING_SUBJECT_SOURCES).default('auto'),
  /** Use the sky (isolated, or detected) as a dome light and to tell outdoors from in. */
  useSky: z.boolean().default(true),
  /** Camera to subject, metres: where the lights are placed from (the camera track's scene when there is one). */
  subjectDistanceM: z.number().min(0.2).max(1000).default(3),
  /** The camera's white balance, kelvin, when the metadata does not give it (null: from the handoff, else the working space's white). */
  whiteBalanceK: z.number().min(1500).max(20000).nullable().default(null),
  /** The exposure reference for the engines: the key's illuminance at the subject, lux (addendum 14 §5). */
  keyLux: z.number().min(0.1).max(200000).default(1000),
});
export type LightingSettings = z.infer<typeof LightingSettingsSchema>;
export const DEFAULT_LIGHTING_SETTINGS: LightingSettings = LightingSettingsSchema.parse({});

export const FOCAL_SOURCES = ['artist', 'solve', 'metadata', 'vanishing', 'unknown'] as const;
export type FocalSource = (typeof FOCAL_SOURCES)[number];

export const LensEstimateSchema = z.object({
  focalMm: RangeSchema.nullable(),
  focalSource: z.enum(FOCAL_SOURCES),
  /** Other evidence for the focal length and whether it agrees (vanishing points against the metadata …). */
  checks: z.array(z.object({ source: z.enum(FOCAL_SOURCES), focalMm: RangeSchema, agrees: z.boolean(), note: z.string().max(300).default('') })).max(8).default([]),
  filmBackMm: z.object({ width: z.number().positive(), height: z.number().positive() }).nullable(),
  filmBackSource: z.enum(['artist', 'camera_track', 'handoff', 'database', 'nominal']),
  hfovDeg: RangeSchema.nullable(),
  vfovDeg: RangeSchema.nullable(),
  distortion: z.object({ k1: z.number().nullable(), source: z.enum(['solve', 'profile', 'lines', 'none']), note: z.string().max(300).default('') }),
  aperture: z.object({ fStop: RangeSchema.nullable(), source: z.enum(['artist', 'metadata', 'blur', 'unknown']), note: z.string().max(300).default('') }),
  focusDistance: z.string().max(60).nullable().default(null),
  /** Straight lines and vanishing points found. */
  lines: z.number().int().nonnegative().default(0),
  vanishingPoints: z.number().int().nonnegative().default(0),
});
export type LensEstimate = z.infer<typeof LensEstimateSchema>;

export const LIGHTING_MARK_KINDS = ['practical', 'highlight', 'catchlight', 'shadow', 'rim', 'ball', 'vanishing'] as const;
export type LightingMarkKind = (typeof LIGHTING_MARK_KINDS)[number];

/** Something the analysis found in the frame, for the overlay (0 … 1 of the plate's width and height). */
export const LightingMarkSchema = z.object({
  kind: z.enum(LIGHTING_MARK_KINDS),
  x: finite,
  y: finite,
  /** A line's other end (a shadow's direction). */
  x2: finite.nullable().default(null),
  y2: finite.nullable().default(null),
  r: z.number().nonnegative().nullable().default(null),
  lightId: z.string().max(32).nullable().default(null),
  label: z.string().max(120).default(''),
});
export type LightingMark = z.infer<typeof LightingMarkSchema>;

export const LightingAnalysisSchema = z.object({
  algorithm: z.string(),
  /** The settings revision the analysis used. */
  revision: z.number().int().nonnegative(),
  frame: z.number().int().nonnegative(),
  frames: z.array(z.number().int().nonnegative()).max(8),
  lights: z.array(LightEstimateSchema).max(24),
  lens: LensEstimateSchema,
  /** How sure the key's direction is (0 … 1), and how well the rig's shading matches the plate's (null without a subject). */
  keyConfidence: z.number().min(0).max(1),
  matchScore: z.number().min(0).max(1).nullable(),
  subject: z.object({
    source: z.enum(['roto', 'bg_matte', 'key_alpha', 'sample', 'none']),
    coverage: z.number().min(0).max(1),
    /** Where the subject is in the frame (0 … 1 of the width and height): the rig is placed around it. */
    centre: z.object({ x: z.number(), y: z.number() }).nullable().default(null),
  }),
  sky: z.object({ found: z.boolean(), coverage: z.number().min(0).max(1), source: z.enum(['sky_matte', 'detected', 'sample', 'none']) }),
  ground: z.object({ source: z.enum(['solve', 'assumed', 'sample']), heightM: z.number(), pitchDeg: z.number() }).nullable(),
  whiteBalance: z.object({ kelvin: z.number(), source: z.enum(['artist', 'metadata', 'assumed']) }),
  marks: z.array(LightingMarkSchema).max(200).default([]),
  warnings: z.array(z.string().max(400)).max(30).default([]),
  ms: z.number().nonnegative(),
  taskVersion: z.number().int().positive(),
  at: z.string(),
  by: z.string(),
});
export type LightingAnalysis = z.infer<typeof LightingAnalysisSchema>;

export const LightingRunSchema = z.object({
  algorithm: z.string(),
  revision: z.number().int().nonnegative(),
  frame: z.number().int().nonnegative(),
  lights: z.number().int().nonnegative(),
  keyConfidence: z.number().min(0).max(1),
  matchScore: z.number().min(0).max(1).nullable(),
  focalMm: RangeSchema.nullable(),
  focalSource: z.enum(FOCAL_SOURCES),
  taskVersion: z.number().int().positive(),
  ms: z.number().nonnegative(),
  at: z.string(),
  by: z.string(),
});
export type LightingRun = z.infer<typeof LightingRunSchema>;

export const LensOverrideSchema = z.object({
  focalMm: z.number().positive().max(2000).nullable().default(null),
  filmBackMm: z.object({ width: z.number().positive().max(200), height: z.number().positive().max(200) }).nullable().default(null),
  fStop: z.number().min(0.5).max(64).nullable().default(null),
});
export type LensOverride = z.infer<typeof LensOverrideSchema>;

export const LIGHTING_SUGGESTION_KINDS = ['adjust', 'add', 'remove', 'note'] as const;
export const LIGHTING_DECISIONS = ['pending', 'accepted', 'rejected'] as const;

export const LightingSuggestionSchema = z.object({
  id: Id,
  kind: z.enum(LIGHTING_SUGGESTION_KINDS),
  lightId: z.string().max(32).nullable().default(null),
  change: LightFieldsSchema.nullable().default(null),
  light: LightSpecSchema.nullable().default(null),
  reason: z.string().max(600).default(''),
  confidence: z.number().min(0).max(1).default(0.5),
  decision: z.enum(LIGHTING_DECISIONS).default('pending'),
  by: z.string().nullable().default(null),
  at: z.string().nullable().default(null),
});
export type LightingSuggestion = z.infer<typeof LightingSuggestionSchema>;

/** A second opinion on the rig from the AI assistant through vc-vfx.com (addendum 14 §7): suggestions only, each decided by the artist. */
export const LightingAiReviewSchema = z.object({
  id: Id,
  /** The model that answered and the prompt's version (§19 "log model/version where AI is used"). */
  model: z.string().max(120),
  promptVersion: z.string().max(40),
  summary: z.string().max(1200).default(''),
  credits: z.number().nonnegative().default(0),
  suggestions: z.array(LightingSuggestionSchema).max(20),
  /** The edit revision the review saw. */
  editRevision: z.number().int().nonnegative(),
  at: z.string(),
  by: z.string(),
});
export type LightingAiReview = z.infer<typeof LightingAiReviewSchema>;

/** A versioned export into the shot package's 09_PROJECT_DATA (§13, §17). */
export const LightingExportSchema = z.object({
  version: z.number().int().positive(),
  /** Package-relative `09_PROJECT_DATA/<shot>_light_vNNN`. */
  folder: z.string(),
  /** File names inside `folder`. */
  files: z.array(z.string()),
  formats: z.array(z.enum(LIGHTING_EXPORT_FORMATS)),
  lights: z.number().int().nonnegative(),
  /** Where the camera came from: the camera track's solve at the analysed frame, or the lens estimate at the origin. */
  camera: z.enum(['solve', 'estimate']),
  revision: z.number().int().nonnegative(),
  editRevision: z.number().int().nonnegative(),
  algorithm: z.string(),
  writtenAt: z.string(),
  by: z.string(),
});
export type LightingExport = z.infer<typeof LightingExportSchema>;
export type LightingExportInput = Omit<LightingExport, 'writtenAt' | 'by'>;

export const LightingDocumentSchema = z.object({
  formatVersion: z.literal(LIGHTING_FORMAT_VERSION).default(LIGHTING_FORMAT_VERSION),
  algorithm: z.object({ id: z.string(), version: z.string() }).default({ ...LIGHTING_ALGORITHM }),
  settings: LightingSettingsSchema.default(DEFAULT_LIGHTING_SETTINGS),
  references: z.array(LightingReferenceSchema).max(16).default([]),
  /** The newest analysis: the estimate the rig starts from. */
  analysis: LightingAnalysisSchema.nullable().default(null),
  /** The artist's values per estimated light (kept apart: a new analysis never overwrites them). */
  edits: z.array(LightEditSchema).max(64).default([]),
  added: z.array(ArtistLightSchema).max(24).default([]),
  /** Estimated lights the artist took out. */
  removed: z.array(z.string().max(32)).max(24).default([]),
  lens: LensOverrideSchema.default({ focalMm: null, filmBackMm: null, fStop: null }),
  reviews: z.array(LightingAiReviewSchema).max(20).default([]),
  /** Kept to the most recent 200. */
  runs: z.array(LightingRunSchema).default([]),
  exports: z.array(LightingExportSchema).default([]),
  /** Bumped by every change of what is analysed (frames, references, settings): an analysis records which it used (§19). */
  revision: z.number().int().nonnegative().default(0),
  /** Bumped by every change of the rig (edits, lights added or removed, the lens): an export records which it wrote. */
  editRevision: z.number().int().nonnegative().default(0),
  seq: z.number().int().nonnegative().default(0),
});
export type LightingDocument = z.infer<typeof LightingDocumentSchema>;
