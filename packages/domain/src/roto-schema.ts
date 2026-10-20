import { z } from 'zod';

/**
 * The paint-to-roto document a shot carries in the project file (master spec
 * §5, §5.1, §5.2; addendum 04). Kept apart from `roto.ts` so `project.ts` can
 * embed the schema without importing the mutations that import it.
 *
 * What lives here is small and is the operator's work: parts, the strokes
 * painted on key frames, settings, per-frame status and confidence, and the
 * record of each propagation and export. Masks never do — they are files on
 * disk (a working cache while painting, versioned PNG sequences once exported).
 */

export const ROTO_FORMAT_VERSION = 1;

/** Segmentation engines. `track` is classical and always there; `sam2` needs its model on disk. */
export const ROTO_ENGINES = ['track', 'sam2'] as const;
export type RotoEngineId = (typeof ROTO_ENGINES)[number];

/**
 * key: painted (or accepted as a reference) before any propagation reached it;
 * corrected: painted after a propagation had produced it — a correction;
 * propagated: produced by propagation from a key frame;
 * flagged: someone marked it as needing correction.
 */
export const ROTO_FRAME_STATUSES = ['key', 'corrected', 'propagated', 'flagged'] as const;
export type RotoFrameStatus = (typeof ROTO_FRAME_STATUSES)[number];

export const ROTO_COMBINE = ['union', 'subtract'] as const;
export type RotoCombine = (typeof ROTO_COMBINE)[number];

export const ROTO_DIRECTIONS = ['key', 'forward', 'backward'] as const;
export type RotoDirection = (typeof ROTO_DIRECTIONS)[number];

/** Plate pixel coordinates, x then y. */
export const RotoPointSchema = z.tuple([z.number().finite(), z.number().finite()]);
export type RotoPoint = z.infer<typeof RotoPointSchema>;

export const RotoStrokeSchema = z.object({
  id: z.string().min(1).max(64),
  /** include paints the subject in; exclude paints background out. */
  mode: z.enum(['include', 'exclude']),
  /** Brush radius in plate pixels. */
  radius: z.number().positive().max(2000),
  points: z.array(RotoPointSchema).min(1).max(4000),
  by: z.string(),
  at: z.string(),
});
export type RotoStroke = z.infer<typeof RotoStrokeSchema>;

export const RotoKeyFrameSchema = z.object({
  /** Delivered frame number. */
  frame: z.number().int().nonnegative(),
  /** Empty: the frame's current matte is accepted as a reference as it stands. */
  strokes: z.array(RotoStrokeSchema).max(500),
  /** Painted after propagation had produced this frame (§5.2 "corrects with the paint tool"). */
  correction: z.boolean().default(false),
  by: z.string(),
  at: z.string(),
});
export type RotoKeyFrame = z.infer<typeof RotoKeyFrameSchema>;

/** Per-part matte refinement (§5.1 "independent matte refinement, feathering, motion behaviour"). */
export const RotoRefineSchema = z.object({
  /** Gaussian softening of the edge, plate pixels. */
  featherPx: z.number().min(0).max(64).default(1),
  /** Positive grows the matte, negative shrinks it, plate pixels. */
  shrinkGrowPx: z.number().min(-64).max(64).default(0),
  /** 0 … 1: how much of the neighbouring frames' (motion-compensated) edge is blended in. */
  temporalSmoothing: z.number().min(0).max(1).default(0),
  /** Snap the edge to the image (guided filter) when masks are scaled to plate resolution. */
  edgeSnap: z.boolean().default(true),
});
export type RotoRefine = z.infer<typeof RotoRefineSchema>;
export const DEFAULT_REFINE: RotoRefine = { featherPx: 1, shrinkGrowPx: 0, temporalSmoothing: 0, edgeSnap: true };

export const RotoEngineRefSchema = z.object({
  id: z.enum(ROTO_ENGINES),
  /** The engine's own version string; recorded with every result (§19). */
  version: z.string().default(''),
  settings: z.record(z.union([z.number(), z.string(), z.boolean()])).default({}),
});
export type RotoEngineRef = z.infer<typeof RotoEngineRefSchema>;

export const RotoFrameRecordSchema = z.object({
  frame: z.number().int().nonnegative(),
  status: z.enum(ROTO_FRAME_STATUSES),
  /** 0 … 1, the engine's estimate; key frames painted by hand still carry the engine's own. */
  confidence: z.number().min(0).max(1),
  /** `track@1.0.0`: what produced this frame's matte. */
  engine: z.string().default(''),
  reviewed: z.object({ by: z.string(), at: z.string() }).nullable().default(null),
  note: z.string().default(''),
});
export type RotoFrameRecord = z.infer<typeof RotoFrameRecordSchema>;

export const ROTO_PART_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const ROOT_PART_ID = 'subject';

export const RotoPartSchema = z.object({
  id: z.string().regex(ROTO_PART_ID),
  name: z.string().min(1).max(64),
  /** Null for the overall subject matte; component parts hang below it (§5.1). */
  parentId: z.string().nullable(),
  /** How the part enters its parent's matte. */
  combine: z.enum(ROTO_COMBINE).default('union'),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  visible: z.boolean().default(true),
  keyFrames: z.array(RotoKeyFrameSchema).default([]),
  refine: RotoRefineSchema.default(DEFAULT_REFINE),
  engine: RotoEngineRefSchema.default({ id: 'track', version: '', settings: {} }),
  /** One record per frame that has a matte, sorted by frame. */
  frames: z.array(RotoFrameRecordSchema).default([]),
});
export type RotoPart = z.infer<typeof RotoPartSchema>;

/** One propagation (or key-frame segmentation) run, as recorded. */
export const RotoRunSchema = z.object({
  partId: z.string(),
  engine: z.string(),
  settings: z.record(z.union([z.number(), z.string(), z.boolean()])).default({}),
  direction: z.enum(ROTO_DIRECTIONS),
  from: z.number().int().nonnegative(),
  first: z.number().int().nonnegative(),
  last: z.number().int().nonnegative(),
  frames: z.number().int().nonnegative(),
  meanConfidence: z.number().min(0).max(1),
  minConfidence: z.number().min(0).max(1),
  /** The roto task version the run belongs to. */
  taskVersion: z.number().int().positive(),
  at: z.string(),
  by: z.string(),
});
export type RotoRun = z.infer<typeof RotoRunSchema>;

/** A versioned export of the mattes into the shot package's 02_MATTES_ROTO (§5.2 final bullet, §17). */
export const RotoExportSchema = z.object({
  /** The roto task version: names every file. */
  version: z.number().int().positive(),
  /** Package-relative folder of the combined matte. */
  folder: z.string(),
  /** printf pattern of the combined matte. */
  pattern: z.string(),
  parts: z.array(z.object({ partId: z.string(), name: z.string(), folder: z.string(), pattern: z.string() })),
  first: z.number().int().nonnegative(),
  last: z.number().int().nonnegative(),
  frames: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bitDepth: z.number().int().positive(),
  exr: z.boolean().default(false),
  confidence: z.object({ mean: z.number(), min: z.number(), low: z.array(z.number().int()) }),
  engines: z.array(z.string()),
  /** Package-relative path of `<shot>_roto_vNNN.json`. */
  metadata: z.string(),
  writtenAt: z.string(),
  by: z.string(),
});
export type RotoExport = z.infer<typeof RotoExportSchema>;
export type RotoExportInput = Omit<RotoExport, 'writtenAt' | 'by'>;

export const RotoDocumentSchema = z.object({
  formatVersion: z.literal(ROTO_FORMAT_VERSION).default(ROTO_FORMAT_VERSION),
  parts: z.array(RotoPartSchema).min(1),
  /** Kept to the most recent 500. */
  runs: z.array(RotoRunSchema).default([]),
  exports: z.array(RotoExportSchema).default([]),
  /** Longest edge the engines work at; masks are scaled and edge-snapped to plate resolution on export. */
  workingWidth: z.number().int().min(256).max(8192).default(1920),
  /** Source of stroke ids. */
  seq: z.number().int().nonnegative().default(0),
});
export type RotoDocument = z.infer<typeof RotoDocumentSchema>;
