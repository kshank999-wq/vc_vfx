import { z } from 'zod';

/**
 * The green/blue-screen key document a shot carries in the project file
 * (master spec §6, §7; addendum 09). Kept apart from `key.ts` so `project.ts`
 * can embed the schema without importing the mutations.
 *
 * What lives here is small and is the operator's work: the screen colour
 * (detected or sampled), the keyer's parameters, which roto parts or drawn
 * boxes act as garbage, holdout or repair mattes, the despill, light-wrap and
 * background-match settings, per-frame confidence, and the record of each
 * run and export. Mattes, clean plates and foregrounds are never here — they
 * are files (a working cache while keying, versioned sequences once exported).
 */

export const KEY_FORMAT_VERSION = 1;
/** The keyer: colour difference against a clean-plate screen model, unmixing edge refinement (addendum 09 §3). */
export const KEY_ALGORITHM = { id: 'vcvfx-cdk', version: '1.0.0' } as const;

export const SCREEN_KINDS = ['green', 'blue'] as const;
export type ScreenKind = (typeof SCREEN_KINDS)[number];

const Rgb = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
export type KeyRgb = z.infer<typeof Rgb>;

export const KeyRectSchema = z
  .object({ x0: z.number().finite(), y0: z.number().finite(), x1: z.number().finite(), y1: z.number().finite() })
  .refine((r) => r.x1 > r.x0 && r.y1 > r.y0, 'A box needs a width and a height');
export type KeyRect = z.infer<typeof KeyRectSchema>;

/** A point (or small region) the operator sampled with the eyedropper, in plate pixels, and the linear colour it read. */
export const ScreenSampleSchema = z.object({
  frame: z.number().int().nonnegative(),
  x: z.number().finite(),
  y: z.number().finite(),
  /** Plate pixels averaged around the point. */
  radius: z.number().min(0).max(500).default(4),
  rgb: Rgb,
});
export type ScreenSample = z.infer<typeof ScreenSampleSchema>;

export const ScreenSchema = z.object({
  kind: z.enum(SCREEN_KINDS),
  /** auto: detected; manual: the mean of the operator's samples. */
  source: z.enum(['auto', 'manual']),
  /** Linear RGB of the screen, in the key's working encoding. */
  rgb: Rgb,
  samples: z.array(ScreenSampleSchema).max(64).default([]),
  /** Share of the analysed frames' pixels found to be screen (auto). */
  coverage: z.number().min(0).max(1).nullable().default(null),
  /** Frames the detection looked at. */
  frames: z.array(z.number().int().nonnegative()).max(64).default([]),
  /** Follow slow per-frame changes of the screen's brightness and colour (flicker, a cloud). */
  track: z.boolean().default(true),
});
export type KeyScreen = z.infer<typeof ScreenSchema>;

export const KeyParamsSchema = z.object({
  /** Green: weight of red against blue in the colour difference (G − (b·R + (1−b)·B)); blue: of red against green. */
  balance: z.number().min(0).max(1).default(0.5),
  /** Raw key at or below this is clean screen (alpha 0). */
  clipBlack: z.number().min(0).max(0.5).default(0.04),
  /** Raw key at or above this is solid (alpha 1). */
  clipWhite: z.number().min(0.5).max(1).default(0.9),
  gamma: z.number().min(0.2).max(5).default(1),
  /** Core matte: raw key above this, closed, holes filled, eroded, clipped hard. */
  coreThreshold: z.number().min(0.2).max(0.99).default(0.6),
  /** Plate pixels the core is eroded by, so it never reaches the soft edge. */
  coreErodePx: z.number().min(0).max(128).default(6),
  /** Plate pixels of closing that bridge small spill holes in the core. */
  coreClosePx: z.number().min(0).max(64).default(4),
  /** 0 … 1: how much of the unmixing edge refinement replaces the colour-difference edge (hair, motion blur). */
  edgeDetail: z.number().min(0).max(1).default(0.8),
  /** Extra softening of the edge matte, plate pixels (0: none). */
  edgeSoftnessPx: z.number().min(0).max(32).default(0),
  /** Key against a clean-plate model of the screen (uneven lighting) rather than one colour. */
  cleanPlate: z.boolean().default(true),
  /** Frames the clean plate is built from, spread over the shot. */
  cleanPlateFrames: z.number().int().min(1).max(16).default(5),
  /** Cells across the clean-plate grid (its smoothness). */
  cleanPlateGrid: z.number().int().min(4).max(128).default(32),
});
export type KeyParams = z.infer<typeof KeyParamsSchema>;
export const DEFAULT_KEY_PARAMS: KeyParams = KeyParamsSchema.parse({});

export const KEY_LINK_KINDS = ['garbage', 'holdout', 'repair'] as const;
export type KeyLinkKind = (typeof KEY_LINK_KINDS)[number];
/** replace: the roto matte is the matte inside the region; max: whichever is more solid; min: whichever is less. */
export const KEY_REPAIR_MODES = ['replace', 'max', 'min'] as const;
export type KeyRepairMode = (typeof KEY_REPAIR_MODES)[number];

export const KeyLinkSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('roto'), partId: z.string().min(1).max(32) }),
  z.object({ type: z.literal('rect'), rect: KeyRectSchema }),
]);
export type KeyLinkSource = z.infer<typeof KeyLinkSourceSchema>;

/**
 * A garbage matte (outside it, or inside it when inverted, is transparent), a
 * holdout (inside is solid) or a repair region (the roto matte replaces or is
 * combined with the key there), from a roto part or a drawn box (§6 bullets 2, 3).
 */
export const KeyLinkSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
  kind: z.enum(KEY_LINK_KINDS),
  label: z.string().max(64).default(''),
  source: KeyLinkSourceSchema,
  invert: z.boolean().default(false),
  mode: z.enum(KEY_REPAIR_MODES).default('replace'),
  /** Plate pixels the shape is grown by (negative shrinks). */
  growPx: z.number().min(-128).max(256).default(0),
  /** Plate pixels of soft edge on the shape. */
  softnessPx: z.number().min(0).max(128).default(2),
  /**
   * For a repair from a roto part: the box (plate pixels) the repair acts in.
   * Null: the part's matte grown by `growPx` — so a repair only acts near what
   * was painted.
   */
  region: KeyRectSchema.nullable().default(null),
  /** Delivered frames it applies to; null: the whole shot. */
  frames: z.object({ first: z.number().int().nonnegative(), last: z.number().int().nonnegative() }).nullable().default(null),
  enabled: z.boolean().default(true),
});
export type KeyLink = z.infer<typeof KeyLinkSchema>;

export const DESPILL_LIMITS = ['average', 'max', 'min', 'weighted'] as const;
export type DespillLimit = (typeof DESPILL_LIMITS)[number];
export const DESPILL_RESTORE = ['background', 'neutral', 'none'] as const;
export type DespillRestore = (typeof DESPILL_RESTORE)[number];

export const ProtectColourSchema = z.object({
  label: z.string().max(64).default(''),
  /** A linear colour whose hue is protected. */
  rgb: Rgb,
  /** Degrees either side of its hue. */
  hueTolerance: z.number().min(1).max(90).default(12),
});
export type ProtectColour = z.infer<typeof ProtectColourSchema>;

/** The background the despill and light wrap draw on (§7): none, the handoff's background-plate reference, a file, or a frame of this shot. */
export const KeyBackgroundSchema = z.object({
  kind: z.enum(['none', 'reference', 'file', 'frame']),
  /** Handoff-relative (reference) or absolute (file) path; null for none/frame. */
  path: z.string().max(4096).nullable().default(null),
  /** For `frame`: the delivered frame of this shot used as the representative background. */
  frame: z.number().int().nonnegative().nullable().default(null),
  label: z.string().max(200).default(''),
});
export type KeyBackground = z.infer<typeof KeyBackgroundSchema>;

export const DespillSchema = z.object({
  enabled: z.boolean().default(true),
  /** Green is limited to this of red and blue (blue: of red and green). */
  limit: z.enum(DESPILL_LIMITS).default('average'),
  /** For `weighted`: the weight of red. */
  weight: z.number().min(0).max(1).default(0.5),
  strength: z.number().min(0).max(1).default(1),
  /** What replaces the removed spill: the background's colour near the edge, neutral grey, or nothing. */
  restore: z.enum(DESPILL_RESTORE).default('background'),
  restoreAmount: z.number().min(0).max(1).default(1),
  /** Plate pixels of blur on the background before its colour is used. */
  backgroundBlurPx: z.number().min(0).max(400).default(40),
  protectSkin: z.boolean().default(true),
  protect: z.array(ProtectColourSchema).max(16).default([]),
  background: KeyBackgroundSchema.default({ kind: 'none', path: null, frame: null, label: '' }),
});
export type DespillSettings = z.infer<typeof DespillSchema>;

export const LightWrapSchema = z.object({
  /** Write the light-wrap layer on export (it is always a separate layer, never baked into the foreground). */
  output: z.boolean().default(false),
  /** Show it in the over-background preview. */
  preview: z.boolean().default(true),
  /** Plate pixels the background reaches into the subject. */
  widthPx: z.number().min(1).max(400).default(16),
  intensity: z.number().min(0).max(2).default(0.6),
  /** 0: colour as is; 1: weighted by the background's luminance (bright areas wrap more). */
  lumaWeight: z.number().min(0).max(1).default(0.5),
});
export type LightWrapSettings = z.infer<typeof LightWrapSchema>;

/** A suggested foreground → background colour match (§7 bullet 3): metadata, never baked into the prep output. */
export const BgMatchSchema = z.object({
  gain: Rgb,
  offset: Rgb,
  /** log2 of the luminance gain. */
  exposureStops: z.number().finite(),
  /** Samples it was estimated from, foreground and background. */
  samples: z.object({ foreground: z.number().int().nonnegative(), background: z.number().int().nonnegative() }),
  /** 0 … 1: how well-founded the estimate is (samples, spread). */
  confidence: z.number().min(0).max(1),
  /** How much of the full match the suggestion applies (the full match is rarely right). */
  strength: z.number().min(0).max(1).default(0.5),
  frame: z.number().int().nonnegative(),
  method: z.string().default('robust per-channel gain/offset (median, MAD) of the despilled foreground inside the edge against the background around it'),
  at: z.string(),
  by: z.string(),
});
export type BgMatch = z.infer<typeof BgMatchSchema>;
export type BgMatchInput = Omit<BgMatch, 'at' | 'by' | 'method' | 'strength'> & { strength?: number };

export const KeyMetricsSchema = z.object({
  /** Share of pixels that keyed as clean screen. */
  screenCoverage: z.number().min(0).max(1),
  /** Share of the core whose raw key is not solid (spill or noise holes). */
  coreNoise: z.number().min(0).max(1),
  /** Share of pixels on the soft edge. */
  edgeActivity: z.number().min(0).max(1),
  /** Share of the subject's silhouette that is a hole (enclosed, transparent). */
  holes: z.number().min(0).max(1),
  /** Mean difference between the clean-screen pixels and the screen model, relative to the screen. */
  residual: z.number().min(0),
});
export type KeyMetrics = z.infer<typeof KeyMetricsSchema>;

export const KeyFrameRecordSchema = z.object({
  frame: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1),
  metrics: KeyMetricsSchema,
  /** processed by the keyer; flagged by someone (or by problem detection, with a reason). */
  status: z.enum(['processed', 'flagged']).default('processed'),
  reason: z.string().default(''),
  reviewed: z.object({ by: z.string(), at: z.string() }).nullable().default(null),
  note: z.string().default(''),
});
export type KeyFrameRecord = z.infer<typeof KeyFrameRecordSchema>;

export const KeyRunSchema = z.object({
  algorithm: z.string(),
  /** The settings revision the run used (`settingsRevision`). */
  revision: z.number().int().nonnegative(),
  first: z.number().int().nonnegative(),
  last: z.number().int().nonnegative(),
  frames: z.number().int().nonnegative(),
  meanConfidence: z.number().min(0).max(1),
  minConfidence: z.number().min(0).max(1),
  problems: z.array(z.number().int()).default([]),
  taskVersion: z.number().int().positive(),
  despill: z.boolean(),
  at: z.string(),
  by: z.string(),
});
export type KeyRun = z.infer<typeof KeyRunSchema>;

/** A versioned export into the shot package's 03_KEYS (§6, §7, §17). */
export const KeyExportSchema = z.object({
  version: z.number().int().positive(),
  /** Package-relative folder `03_KEYS/<shot>_key_vNNN`. */
  folder: z.string(),
  /** printf patterns of what was written, package-relative to `folder`. */
  alpha: z.string(),
  foreground: z.string().nullable(),
  core: z.string().nullable().default(null),
  edge: z.string().nullable().default(null),
  lightWrap: z.string().nullable().default(null),
  alphaExr: z.boolean().default(false),
  first: z.number().int().nonnegative(),
  last: z.number().int().nonnegative(),
  frames: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** The encoding of the foreground's pixels, e.g. "ACEScg (linear AP1)". */
  encoding: z.string(),
  despill: z.boolean(),
  confidence: z.object({ mean: z.number(), min: z.number(), low: z.array(z.number().int()) }),
  algorithm: z.string(),
  revision: z.number().int().nonnegative(),
  /** Package-relative path of `<shot>_key_vNNN.json`. */
  metadata: z.string(),
  files: z.number().int().nonnegative(),
  writtenAt: z.string(),
  by: z.string(),
});
export type KeyExport = z.infer<typeof KeyExportSchema>;
export type KeyExportInput = Omit<KeyExport, 'writtenAt' | 'by'>;

export const KeyDocumentSchema = z.object({
  formatVersion: z.literal(KEY_FORMAT_VERSION).default(KEY_FORMAT_VERSION),
  algorithm: z.object({ id: z.string(), version: z.string() }).default({ ...KEY_ALGORITHM }),
  screen: ScreenSchema.nullable().default(null),
  params: KeyParamsSchema.default(DEFAULT_KEY_PARAMS),
  links: z.array(KeyLinkSchema).max(32).default([]),
  despill: DespillSchema.default({}),
  lightWrap: LightWrapSchema.default({}),
  match: z.object({ suggestion: BgMatchSchema.nullable().default(null), preview: z.boolean().default(false) }).default({ suggestion: null, preview: false }),
  /** One record per processed frame, sorted. */
  frames: z.array(KeyFrameRecordSchema).default([]),
  /** Kept to the most recent 200. */
  runs: z.array(KeyRunSchema).default([]),
  exports: z.array(KeyExportSchema).default([]),
  /** Longest edge the keyer works at while reviewing; exports are keyed at plate resolution. */
  workingWidth: z.number().int().min(256).max(8192).default(1920),
  /** Bumped by every change of settings: a run records which revision it keyed with (§19). */
  revision: z.number().int().nonnegative().default(0),
  seq: z.number().int().nonnegative().default(0),
});
export type KeyDocument = z.infer<typeof KeyDocumentSchema>;
