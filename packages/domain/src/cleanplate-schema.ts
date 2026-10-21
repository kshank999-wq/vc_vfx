import { z } from 'zod';

/**
 * The clean-plate document a shot carries in the project file (master spec
 * §8; addendum 10). Kept apart from `cleanplate.ts` so `project.ts` can embed
 * the schema without importing the mutations.
 *
 * What lives here is small and is the artist's work: what to remove (roto
 * parts or drawn boxes, grown by a dilation), whether the result is a still or
 * a per-frame sequence, the reference frame, how frames are aligned, the
 * artist's guidance (frames to prefer or leave out, "take this region from
 * that frame" patches), per-frame confidence, and the record of each build
 * and export. The clean plates themselves, the per-frame alignment and the
 * confidence maps are files — never here.
 */

export const CLEANPLATE_FORMAT_VERSION = 1;
/** Temporal reconstruction from aligned frames, robust vote, spatial fill for what is never seen (addendum 10 §3). */
export const CLEANPLATE_ALGORITHM = { id: 'vcvfx-cleanplate', version: '1.0.0' } as const;

/** auto: the build picks still or sequence from the camera's motion. */
export const CLEANPLATE_MODES = ['auto', 'still', 'sequence'] as const;
export type CleanPlateMode = (typeof CLEANPLATE_MODES)[number];
export type CleanPlateOutputMode = Exclude<CleanPlateMode, 'auto'>;

/** auto: the build finds out whether the camera moved; static: no alignment; homography: always align. */
export const CLEANPLATE_ALIGNMENTS = ['auto', 'static', 'homography'] as const;
export type CleanPlateAlignment = (typeof CLEANPLATE_ALIGNMENTS)[number];

export const CleanPlateRectSchema = z
  .object({ x0: z.number().finite(), y0: z.number().finite(), x1: z.number().finite(), y1: z.number().finite() })
  .refine((r) => r.x1 > r.x0 && r.y1 > r.y0, 'A box needs a width and a height');
export type CleanPlateRect = z.infer<typeof CleanPlateRectSchema>;

const FrameRange = z.object({ first: z.number().int().nonnegative(), last: z.number().int().nonnegative() });
export type CleanPlateFrameRange = z.infer<typeof FrameRange>;

const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Something to remove: a roto part's matte, or a box drawn in plate pixels (§8 "identifies the subject"). */
export const CleanPlateRemoveSchema = z.object({
  id: z.string().regex(ID),
  label: z.string().max(64).default(''),
  source: z.discriminatedUnion('type', [z.object({ type: z.literal('roto'), partId: z.string().min(1).max(32) }), z.object({ type: z.literal('rect'), rect: CleanPlateRectSchema })]),
  /** Delivered frames it applies to; null: the whole shot. */
  frames: FrameRange.nullable().default(null),
  enabled: z.boolean().default(true),
});
export type CleanPlateRemove = z.infer<typeof CleanPlateRemoveSchema>;

/** "Take region R from frame F" (§8 "patch/reference-frame selection"). */
export const CleanPlatePatchSchema = z.object({
  id: z.string().regex(ID),
  label: z.string().max(64).default(''),
  /** Plate pixels of the plate being made (the reference frame's for a still). */
  rect: CleanPlateRectSchema,
  /** The delivered frame whose (aligned) pixels fill the region. */
  sourceFrame: z.number().int().nonnegative(),
  /** Frames of a sequence it applies to; null: every frame. */
  frames: FrameRange.nullable().default(null),
  enabled: z.boolean().default(true),
});
export type CleanPlatePatch = z.infer<typeof CleanPlatePatchSchema>;

export const CleanPlateGuidanceSchema = z.object({
  /** Frames whose pixels win when frames agree (a clean frame the artist knows of). */
  prefer: z.array(z.number().int().nonnegative()).max(64).default([]),
  /** Frames never borrowed from (a flash, a frame where something else crosses). */
  exclude: z.array(z.number().int().nonnegative()).max(1024).default([]),
  patches: z.array(CleanPlatePatchSchema).max(32).default([]),
});
export type CleanPlateGuidance = z.infer<typeof CleanPlateGuidanceSchema>;

export const CleanPlateParamsSchema = z.object({
  /** Plate pixels the removal matte is grown by, so the subject's soft edge and motion blur go too. */
  dilatePx: z.number().min(0).max(128).default(6),
  /** Sequence: frames either side a frame borrows from. */
  window: z.number().int().min(1).max(48).default(12),
  /** Frames spread over the whole shot every plate may also borrow from (what nearby frames never show). */
  anchors: z.number().int().min(2).max(48).default(16),
  /** Relative luminance difference within which borrowed pixels count as agreeing. */
  tolerance: z.number().min(0.01).max(0.5).default(0.06),
  /** Plate pixels over which the filled region blends into the original at its edge. */
  featherPx: z.number().min(0).max(32).default(1.5),
});
export type CleanPlateParams = z.infer<typeof CleanPlateParamsSchema>;
export const DEFAULT_CLEANPLATE_PARAMS: CleanPlateParams = CleanPlateParamsSchema.parse({});

/** What the build found about the shot, and the mode it suggests (§8 "still when sufficient … sequence when necessary"). */
export const CleanPlateSuggestionSchema = z.object({
  mode: z.enum(['still', 'sequence']),
  /** The camera did not move (within half a plate pixel). */
  static: z.boolean(),
  /** Largest camera motion against the reference frame, plate pixels. */
  motionPx: z.number().min(0),
  /** Median alignment residual (parallax, lens distortion, rolling shutter), plate pixels. */
  residualPx: z.number().min(0),
  /** Largest exposure change against the reference, stops. */
  exposureStops: z.number().min(0),
  reason: z.string(),
  revision: z.number().int().nonnegative(),
  at: z.string(),
});
export type CleanPlateSuggestion = z.infer<typeof CleanPlateSuggestionSchema>;

export const CleanPlateMetricsSchema = z.object({
  /** Share of the frame that was removed (the dilated matte). */
  hole: z.number().min(0).max(1),
  /** Share of the removed area filled from other frames or a patch (the rest is painted in spatially). */
  coverage: z.number().min(0).max(1),
  /** Share of the removed area that is low-confidence (unresolved: for paint or a patch). */
  low: z.number().min(0).max(1),
  /** Mean confidence over the removed area. */
  meanHole: z.number().min(0).max(1),
  /** Alignment residual of this frame against the reference, plate pixels. */
  residualPx: z.number().min(0),
  /** Camera motion against the reference frame, plate pixels (largest corner displacement). */
  motionPx: z.number().min(0),
  /** Exposure of this frame against the reference, stops. */
  exposureStops: z.number().finite(),
});
export type CleanPlateMetrics = z.infer<typeof CleanPlateMetricsSchema>;

export const CleanPlateFrameRecordSchema = z.object({
  frame: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1),
  metrics: CleanPlateMetricsSchema,
  status: z.enum(['processed', 'flagged']).default('processed'),
  reason: z.string().default(''),
  reviewed: z.object({ by: z.string(), at: z.string() }).nullable().default(null),
  note: z.string().default(''),
});
export type CleanPlateFrameRecord = z.infer<typeof CleanPlateFrameRecordSchema>;

export const CleanPlateRunSchema = z.object({
  algorithm: z.string(),
  revision: z.number().int().nonnegative(),
  /** What was built (auto resolved). */
  mode: z.enum(['still', 'sequence']),
  alignment: z.enum(['static', 'homography']),
  reference: z.number().int().nonnegative(),
  first: z.number().int().nonnegative(),
  last: z.number().int().nonnegative(),
  frames: z.number().int().nonnegative(),
  meanConfidence: z.number().min(0).max(1),
  minConfidence: z.number().min(0).max(1),
  coverage: z.number().min(0).max(1),
  low: z.number().min(0).max(1),
  residualPx: z.number().min(0),
  problems: z.array(z.number().int()).default([]),
  taskVersion: z.number().int().positive(),
  at: z.string(),
  by: z.string(),
});
export type CleanPlateRun = z.infer<typeof CleanPlateRunSchema>;

/** A versioned export into the shot package's 04_CLEAN_PLATES (§8, §17). */
export const CleanPlateExportSchema = z.object({
  version: z.number().int().positive(),
  /** Package-relative folder `04_CLEAN_PLATES/<shot>_cleanplate_vNNN`. */
  folder: z.string(),
  mode: z.enum(['still', 'sequence']),
  /** The plate: a file name (still) or a printf pattern (sequence), relative to `folder`. */
  plate: z.string(),
  /** Confidence (16-bit PNG, full = seen clean in agreeing frames) and unresolved mask (16-bit PNG, full = needs paint). */
  confidence: z.string(),
  unresolved: z.string(),
  format: z.enum(['exr', 'png']),
  reference: z.number().int().nonnegative(),
  first: z.number().int().nonnegative(),
  last: z.number().int().nonnegative(),
  frames: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  encoding: z.string(),
  summary: z.object({ mean: z.number(), min: z.number(), low: z.array(z.number().int()), coverage: z.number(), unresolved: z.number() }),
  algorithm: z.string(),
  revision: z.number().int().nonnegative(),
  /** Package-relative path of `<shot>_cleanplate_vNNN.json`. */
  metadata: z.string(),
  files: z.number().int().nonnegative(),
  writtenAt: z.string(),
  by: z.string(),
});
export type CleanPlateExport = z.infer<typeof CleanPlateExportSchema>;
export type CleanPlateExportInput = Omit<CleanPlateExport, 'writtenAt' | 'by'>;

export const CleanPlateDocumentSchema = z.object({
  formatVersion: z.literal(CLEANPLATE_FORMAT_VERSION).default(CLEANPLATE_FORMAT_VERSION),
  algorithm: z.object({ id: z.string(), version: z.string() }).default({ ...CLEANPLATE_ALGORITHM }),
  remove: z.array(CleanPlateRemoveSchema).max(32).default([]),
  mode: z.enum(CLEANPLATE_MODES).default('auto'),
  alignment: z.enum(CLEANPLATE_ALIGNMENTS).default('auto'),
  /** The frame a still is made in (and every frame is aligned to); null: the middle of the shot. */
  referenceFrame: z.number().int().nonnegative().nullable().default(null),
  params: CleanPlateParamsSchema.default(DEFAULT_CLEANPLATE_PARAMS),
  guidance: CleanPlateGuidanceSchema.default({ prefer: [], exclude: [], patches: [] }),
  suggestion: CleanPlateSuggestionSchema.nullable().default(null),
  /** One record per built frame (a still: the reference frame), sorted. */
  frames: z.array(CleanPlateFrameRecordSchema).default([]),
  /** Kept to the most recent 200. */
  runs: z.array(CleanPlateRunSchema).default([]),
  exports: z.array(CleanPlateExportSchema).default([]),
  /** Longest edge the build works at for review; exports are built at plate resolution. */
  workingWidth: z.number().int().min(256).max(4096).default(960),
  /** Bumped by every change of settings: a build records which revision it used (§19). */
  revision: z.number().int().nonnegative().default(0),
  seq: z.number().int().nonnegative().default(0),
});
export type CleanPlateDocument = z.infer<typeof CleanPlateDocumentSchema>;
