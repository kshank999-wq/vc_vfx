import { z } from 'zod';
import { RotoStrokeSchema } from './roto-schema.js';

/**
 * The sky-isolation and background-removal documents a shot carries in the
 * project file (master spec §11; addendum 11). Kept apart from `isolate.ts`
 * so `project.ts` can embed the schema without importing the mutations.
 *
 * One document per target: `sky` (the sky against everything in front of it:
 * the skyline, trees, wires, people) is the shot's `sky_replacement` task;
 * `background` (a foreground subject against everything behind it) is its
 * `background_removal` task. What lives here is small and is the artist's
 * work: how the isolation is seeded (automatic, a box, paint, a roto part),
 * the paint corrections on key frames, the settings, per-frame confidence and
 * the record of each build and export. Mattes, foregrounds and plates are
 * files — never here.
 */

export const ISOLATE_FORMAT_VERSION = 1;
/** Cues + graph cut + unmixing edge refinement + motion-compensated smoothing; plates by temporal fill (addendum 11 §3). */
export const ISOLATE_ALGORITHM = { id: 'vcvfx-isolate', version: '1.0.0' } as const;

export const ISOLATE_TARGETS = ['sky', 'background'] as const;
export type IsolateTarget = (typeof ISOLATE_TARGETS)[number];

/**
 * How the isolation starts:
 *  - auto: found by itself (the sky's cues: position, brightness, colour, texture);
 *  - box: a box round the subject on the seed frame (background removal);
 *  - paint: include/exclude strokes on the seed frame (and any key frame);
 *  - roto: a roto part's mattes (the subject already rotoscoped).
 */
export const ISOLATE_SEED_MODES = ['auto', 'box', 'paint', 'roto'] as const;
export type IsolateSeedMode = (typeof ISOLATE_SEED_MODES)[number];

/** The segmentation engine of a subject (background removal): `track` always; `sam2` when its model is installed (addendum 04). */
export const ISOLATE_ENGINES = ['track', 'sam2'] as const;
export type IsolateEngine = (typeof ISOLATE_ENGINES)[number];

export const ISOLATE_SPILL_MODES = ['auto', 'colour', 'off'] as const;
export type IsolateSpillMode = (typeof ISOLATE_SPILL_MODES)[number];

export const IsolateRectSchema = z
  .object({ x0: z.number().finite(), y0: z.number().finite(), x1: z.number().finite(), y1: z.number().finite() })
  .refine((r) => r.x1 > r.x0 && r.y1 > r.y0, 'A box needs a width and a height');
export type IsolateRect = z.infer<typeof IsolateRectSchema>;

export const IsolateSeedSchema = z.object({
  mode: z.enum(ISOLATE_SEED_MODES).default('auto'),
  /** The frame the seed is drawn on (and propagation starts from); null: the middle of the shot. */
  frame: z.number().int().nonnegative().nullable().default(null),
  /** Box round the subject, plate pixels (mode box). */
  rect: IsolateRectSchema.nullable().default(null),
  /** Roto part whose mattes are the subject (mode roto). */
  partId: z.string().min(1).max(32).nullable().default(null),
});
export type IsolateSeed = z.infer<typeof IsolateSeedSchema>;

/**
 * Paint on a frame: include keeps a region as foreground (in front of the
 * sky / the subject); exclude makes it sky / background. On the seed frame it
 * is the seed (mode paint); on any other frame it is a correction that is
 * carried to the neighbouring frames up to the next key frame.
 */
export const IsolateKeyFrameSchema = z.object({
  frame: z.number().int().nonnegative(),
  strokes: z.array(RotoStrokeSchema).max(500),
  correction: z.boolean().default(false),
  by: z.string(),
  at: z.string(),
});
export type IsolateKeyFrame = z.infer<typeof IsolateKeyFrameSchema>;

export const IsolateSpillSchema = z.object({
  /** auto: the edge's own sky/background colour (measured nearby) is unmixed out; colour: this colour is; off: none. */
  mode: z.enum(ISOLATE_SPILL_MODES).default('auto'),
  /** Linear working RGB of the sky to unmix (mode colour). */
  rgb: z.tuple([z.number().min(0).max(64), z.number().min(0).max(64), z.number().min(0).max(64)]).nullable().default(null),
  /** 0 … 1: how much of the spill is taken out of the foreground's edge. */
  amount: z.number().min(0).max(1).default(1),
});
export type IsolateSpill = z.infer<typeof IsolateSpillSchema>;

export const IsolateParamsSchema = z.object({
  /** Gaussian softening of the matte's edge, plate pixels. */
  edgeSoftnessPx: z.number().min(0).max(16).default(1),
  /** 0 … 1: how much of the edge comes from unmixing the colours (fine detail: branches, hair, wires) against the hard cut. */
  edgeDetail: z.number().min(0).max(1).default(1),
  /** Positive grows the foreground, negative shrinks it, plate pixels. */
  growPx: z.number().min(-32).max(32).default(0),
  /** 0 … 1: how much of the neighbouring frames' (motion-compensated) matte is blended in where the picture agrees. */
  temporalSmoothing: z.number().min(0).max(1).default(0.5),
  /** Sky: things that move in front of the sky (a bird, a plane, a head) stay foreground. */
  protectOccluders: z.boolean().default(true),
  /** Sky: −1 … 1, more (positive) or less of the picture called sky where the cues are unsure. */
  skyBias: z.number().min(-1).max(1).default(0),
  /** Background plate: plate pixels the subject's matte is grown by before the background is rebuilt behind it. */
  plateGrowPx: z.number().min(0).max(64).default(4),
  spill: IsolateSpillSchema.default({ mode: 'auto', rgb: null, amount: 1 }),
});
export type IsolateParams = z.infer<typeof IsolateParamsSchema>;
export const DEFAULT_ISOLATE_PARAMS: IsolateParams = IsolateParamsSchema.parse({});

export const IsolateMetricsSchema = z.object({
  /** Share of the frame that is foreground (α ≥ ½). */
  foreground: z.number().min(0).max(1),
  /** Share of the frame on the uncertain edge (0.05 < α < 0.95). */
  edge: z.number().min(0).max(1),
  /** 0 … 1: how clearly the cues and colours tell the two apart. */
  separation: z.number().min(0).max(1),
  /** Median relative contrast between foreground and sky/background across the edge (0 … 1). */
  contrast: z.number().min(0).max(1),
  /** Mean |Δα| against the motion-compensated previous frame over the static edge (0 … 1). */
  flicker: z.number().min(0).max(1),
  /** Share of the plate behind the edge that no frame showed (filled spatially). */
  unresolved: z.number().min(0).max(1),
  /** Camera motion against the reference frame, plate pixels. */
  motionPx: z.number().min(0),
  /** Alignment residual, plate pixels. */
  residualPx: z.number().min(0),
});
export type IsolateMetrics = z.infer<typeof IsolateMetricsSchema>;

export const IsolateFrameRecordSchema = z.object({
  frame: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1),
  metrics: IsolateMetricsSchema,
  status: z.enum(['processed', 'flagged']).default('processed'),
  reason: z.string().default(''),
  reviewed: z.object({ by: z.string(), at: z.string() }).nullable().default(null),
  note: z.string().default(''),
});
export type IsolateFrameRecord = z.infer<typeof IsolateFrameRecordSchema>;

export const IsolateRunSchema = z.object({
  algorithm: z.string(),
  /** The segmentation engine used (sky: the cue cut; background: track or sam2). */
  engine: z.string(),
  revision: z.number().int().nonnegative(),
  first: z.number().int().nonnegative(),
  last: z.number().int().nonnegative(),
  frames: z.number().int().nonnegative(),
  meanConfidence: z.number().min(0).max(1),
  minConfidence: z.number().min(0).max(1),
  flicker: z.number().min(0).max(1),
  unresolved: z.number().min(0).max(1),
  alignment: z.enum(['static', 'homography']),
  problems: z.array(z.number().int()).default([]),
  taskVersion: z.number().int().positive(),
  at: z.string(),
  by: z.string(),
});
export type IsolateRun = z.infer<typeof IsolateRunSchema>;

/** A versioned export into the shot package's 02_MATTES_ROTO (§11, §17). */
export const IsolateExportSchema = z.object({
  version: z.number().int().positive(),
  target: z.enum(ISOLATE_TARGETS),
  /** Package-relative folder `02_MATTES_ROTO/<shot>_sky_vNNN` (or `_bg_`). */
  folder: z.string(),
  /** printf patterns relative to `folder`. */
  matte: z.string(),
  matteExr: z.string().nullable(),
  foreground: z.string(),
  plate: z.string(),
  confidence: z.string(),
  plateConfidence: z.string(),
  format: z.enum(['exr', 'png']),
  first: z.number().int().nonnegative(),
  last: z.number().int().nonnegative(),
  frames: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  encoding: z.string(),
  summary: z.object({ mean: z.number(), min: z.number(), low: z.array(z.number().int()), flicker: z.number(), unresolved: z.number() }),
  algorithm: z.string(),
  engine: z.string(),
  revision: z.number().int().nonnegative(),
  /** Package-relative path of the sequence manifest `<shot>_sky_vNNN.json`. */
  metadata: z.string(),
  files: z.number().int().nonnegative(),
  writtenAt: z.string(),
  by: z.string(),
});
export type IsolateExport = z.infer<typeof IsolateExportSchema>;
export type IsolateExportInput = Omit<IsolateExport, 'writtenAt' | 'by'>;

export const IsolateDocumentSchema = z.object({
  formatVersion: z.literal(ISOLATE_FORMAT_VERSION).default(ISOLATE_FORMAT_VERSION),
  target: z.enum(ISOLATE_TARGETS),
  algorithm: z.object({ id: z.string(), version: z.string() }).default({ ...ISOLATE_ALGORITHM }),
  seed: IsolateSeedSchema.default({ mode: 'auto', frame: null, rect: null, partId: null }),
  engine: z.enum(ISOLATE_ENGINES).default('track'),
  keyFrames: z.array(IsolateKeyFrameSchema).max(1000).default([]),
  params: IsolateParamsSchema.default(DEFAULT_ISOLATE_PARAMS),
  /** One record per built frame, sorted. */
  frames: z.array(IsolateFrameRecordSchema).default([]),
  /** Kept to the most recent 200. */
  runs: z.array(IsolateRunSchema).default([]),
  exports: z.array(IsolateExportSchema).default([]),
  /** Longest edge the build works at for review; exports are refined at plate resolution. */
  workingWidth: z.number().int().min(256).max(4096).default(960),
  /** Bumped by every change of settings: a build records which revision it used (§19). */
  revision: z.number().int().nonnegative().default(0),
  seq: z.number().int().nonnegative().default(0),
});
export type IsolateDocument = z.infer<typeof IsolateDocumentSchema>;

/** A shot's two isolations (either may be null until started). */
export const IsolateDocumentsSchema = z.object({
  sky: IsolateDocumentSchema.nullable().default(null),
  background: IsolateDocumentSchema.nullable().default(null),
});
export type IsolateDocuments = z.infer<typeof IsolateDocumentsSchema>;
