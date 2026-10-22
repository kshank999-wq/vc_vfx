import { z } from 'zod';
import { PREP_TASK_KINDS } from './tasks.js';
import { SHOT_STATUSES } from './status.js';
import { fromVcditHandoff, isVcditDocument } from './vcdit.js';
import { parsePixelAspect } from './pixel-aspect.js';

/**
 * The VCDIT → VCVFX handoff specification (master spec §2, §18).
 *
 * VCDIT writes this JSON file onto the drive next to the mirrored VFX folder
 * structure. VCVFX reads it and builds the shot queue. Everything here is
 * information about the shoot; nothing in it is VCVFX's own working state,
 * which lives in the project file (see project.ts).
 *
 * The schema is deliberately tolerant of fields it does not know about
 * (`passthrough`), because VCDIT may grow faster than VCVFX and an unknown
 * field must never make a production's drive unreadable.
 *
 * Two formats are read: this one (VC VFX's own, richer schema) and the file
 * VCDIT actually writes today, `vcdit.vfx-handoff/1`, which `parseHandoff`
 * recognises by its `schema` field and converts (see vcdit.ts and
 * docs/spec/addendum-02-vcdit-handoff.md).
 */

export const HANDOFF_SCHEMA_VERSION = 1;

export const SEQUENCE_FORMATS = ['dpx', 'tiff', 'exr', 'png', 'jpeg'] as const;
export type SequenceFormat = (typeof SEQUENCE_FORMATS)[number];

export const TimecodeSchema = z
  .string()
  .regex(/^\d{2}:\d{2}:\d{2}[:;]\d{2}$/, 'Timecode must be HH:MM:SS:FF (or ;FF for drop-frame)');

/**
 * Checksum algorithms a handoff may carry. VCDIT ingests with xxHash64, MD5 or
 * SHA-1 (its `ChecksumMethod`); sha256 is VC VFX's own. xxh128 / xxh3 are
 * accepted so an ASC MHL-style record is never refused, but are reported
 * rather than computed.
 */
export const CHECKSUM_ALGORITHMS = ['sha256', 'md5', 'sha1', 'xxh64', 'xxh128', 'xxh3'] as const;
export type ChecksumAlgorithm = (typeof CHECKSUM_ALGORITHMS)[number];

export const ChecksumRecordSchema = z
  .object({
    path: z.string().min(1),
    algorithm: z.enum(CHECKSUM_ALGORITHMS).default('sha256'),
    value: z.string().min(1),
    /** File size in bytes, when the handoff states it. */
    bytes: z.number().int().nonnegative().optional(),
    verifiedAt: z.string().optional(),
  })
  .passthrough();
export type ChecksumRecord = z.infer<typeof ChecksumRecordSchema>;

/** A pixel aspect or squeeze as a handoff may write it: 1.5, "1.5", "3:2", "4/3". Read by `parsePixelAspect`. */
const PixelAspectInputSchema = z.union([z.number().positive(), z.string().min(1)]);

export const CameraSchema = z
  .object({
    body: z.string().optional(),
    sensorMode: z.string().optional(),
    /** Film back in millimetres, width × height. */
    filmBackMm: z.object({ width: z.number().positive(), height: z.number().positive() }).optional(),
    lens: z.string().optional(),
    focalLengthMm: z.number().positive().optional(),
    focusDistance: z.string().optional(),
    iris: z.string().optional(),
    /**
     * The plate's pixel aspect (stored pixel width / height): 2 for a 2×
     * anamorphic delivered squeezed, 1.5 for DVCPRO HD 1080. A number or
     * "3:2". Addendum 17.
     */
    pixelAspect: PixelAspectInputSchema.optional(),
    /** The lens's anamorphic squeeze (the plate's pixel aspect unless the raster was desqueezed in camera). */
    anamorphicSqueeze: PixelAspectInputSchema.optional(),
    lensSqueeze: PixelAspectInputSchema.optional(),
  })
  .passthrough();
export type Camera = z.infer<typeof CameraSchema>;

export const ColorSchema = z
  .object({
    /** The source encoding, e.g. "ARRI LogC4 / AWG4". */
    sourceColorSpace: z.string().optional(),
    gamma: z.string().optional(),
    workingColorSpace: z.string().optional(),
    displayTransform: z.string().optional(),
    /** Optional LUT or OCIO config reference; never baked into plates (§4). */
    lookReference: z.string().optional(),
  })
  .passthrough();
export type Color = z.infer<typeof ColorSchema>;

export const OutputSpecSchema = z
  .object({
    format: z.enum(SEQUENCE_FORMATS).default('exr'),
    bitDepth: z.union([z.literal(8), z.literal(10), z.literal(12), z.literal(16), z.literal(32)]).default(16),
    /** First frame number of the delivered sequence, conventionally 1001 (§4). */
    startFrame: z.number().int().nonnegative().default(1001),
    compression: z.string().optional(),
  })
  .passthrough();
export type OutputSpec = z.infer<typeof OutputSpecSchema>;

export const PrepTaskRequestSchema = z
  .object({
    kind: z.enum(PREP_TASK_KINDS),
    notes: z.string().optional(),
  })
  .passthrough();
export type PrepTaskRequest = z.infer<typeof PrepTaskRequestSchema>;

export const ReferenceSchema = z
  .object({
    kind: z.enum(['lidar', 'survey', 'reference_photo', 'panorama', 'background_plate', 'hdri', 'other']),
    path: z.string().min(1),
    notes: z.string().optional(),
  })
  .passthrough();
export type Reference = z.infer<typeof ReferenceSchema>;

export const HandoffShotSchema = z
  .object({
    /** The VFX shot ID, e.g. "010_020". Unique within the handoff. */
    shotId: z.string().min(1),
    unit: z.string().optional(),
    shootDay: z.string().optional(),
    scene: z.string().min(1),
    setup: z.string().optional(),
    take: z.string().optional(),
    cameraRoll: z.string().optional(),
    clip: z.string().optional(),
    circled: z.boolean().default(false),
    /** Path to the duplicated VFX source, relative to the handoff file. */
    sourcePath: z.string().min(1),
    /** The take's other files (sidecars, further frames), relative to the handoff file. */
    sourceFiles: z.array(z.string().min(1)).optional(),
    /** Who flagged the shot on set (VCDIT: "Script sup." or "DIT tag"). */
    flaggedBy: z.string().optional(),
    /** Where VCDIT expects VCVFX to write; VCVFX picks one if absent. */
    outputPath: z.string().optional(),
    /**
     * The editorial range. Optional: VCDIT does not send one today. When
     * absent, VC VFX reads the clip with ffprobe and works on the whole take
     * (see `shotTiming` in project.ts).
     */
    frameIn: z.number().int().nonnegative().optional(),
    frameOut: z.number().int().nonnegative().optional(),
    handles: z.number().int().nonnegative().default(8),
    timecodeIn: TimecodeSchema.optional(),
    timecodeOut: TimecodeSchema.optional(),
    frameRate: z.number().positive(),
    resolution: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
    /** The plate's pixel aspect, when the handoff gives it for the shot rather than in `camera` (addendum 17). */
    pixelAspect: PixelAspectInputSchema.optional(),
    camera: CameraSchema.default({}),
    color: ColorSchema.default({}),
    output: OutputSpecSchema.optional(),
    tasks: z.array(PrepTaskRequestSchema).default([]),
    supervisorNotes: z.string().optional(),
    references: z.array(ReferenceSchema).default([]),
    status: z.enum(SHOT_STATUSES).optional(),
    operator: z.string().optional(),
    checksums: z.array(ChecksumRecordSchema).default([]),
  })
  .passthrough()
  .superRefine((s, ctx) => {
    if ((s.frameIn === undefined) !== (s.frameOut === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'frameIn and frameOut come together, or not at all', path: [s.frameIn === undefined ? 'frameIn' : 'frameOut'] });
    } else if (s.frameIn !== undefined && s.frameOut !== undefined && s.frameOut < s.frameIn) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'frameOut must not be before frameIn', path: ['frameOut'] });
    }
  });
export type HandoffShot = z.infer<typeof HandoffShotSchema>;

/** Where a converted handoff came from (absent for VC VFX's own format). */
export const HandoffOriginSchema = z
  .object({
    /** The source document's schema, e.g. "vcdit.vfx-handoff/1". */
    format: z.string().min(1),
    tool: z.string().optional(),
    productionCode: z.string().optional(),
    day: z.object({ number: z.number().int().nonnegative().optional(), date: z.string().optional() }).passthrough().optional(),
    createdAt: z.string().optional(),
  })
  .passthrough();
export type HandoffOrigin = z.infer<typeof HandoffOriginSchema>;

export const HandoffSchema = z
  .object({
    schemaVersion: z.number().int().positive().default(HANDOFF_SCHEMA_VERSION),
    generator: z.string().optional(),
    generatedAt: z.string().optional(),
    project: z.string().min(1),
    productionCompany: z.string().optional(),
    ditOperator: z.string().optional(),
    vfxSupervisor: z.string().optional(),
    origin: HandoffOriginSchema.optional(),
    /** Project-wide output default; a shot's own `output` wins. */
    output: OutputSpecSchema.default({}),
    shots: z.array(HandoffShotSchema).min(1, 'A handoff must contain at least one shot'),
  })
  .passthrough()
  .superRefine((h, ctx) => {
    const seen = new Set<string>();
    h.shots.forEach((s, i) => {
      if (seen.has(s.shotId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate shot ID ${s.shotId}`, path: ['shots', i, 'shotId'] });
      }
      seen.add(s.shotId);
    });
  });
export type Handoff = z.infer<typeof HandoffSchema>;

export interface HandoffIssue {
  path: string;
  message: string;
}

export type ParseHandoffResult = { ok: true; handoff: Handoff; warnings: HandoffIssue[] } | { ok: false; issues: HandoffIssue[] };

export function pathOf(p: (string | number)[]): string {
  return p.reduce<string>((acc, part) => (typeof part === 'number' ? `${acc}[${part}]` : acc ? `${acc}.${part}` : part), '');
}

/**
 * Parse handoff JSON text, reporting every problem rather than the first.
 * A VCDIT `vcdit.vfx-handoff/N` document is recognised by its `schema` field
 * and converted; the warnings then say what VCDIT did not supply.
 */
export function parseHandoff(text: string): ParseHandoffResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, issues: [{ path: '', message: `Not valid JSON: ${(e as Error).message}` }] };
  }
  let warnings: HandoffIssue[] = [];
  const vcdit = isVcditDocument(raw);
  if (vcdit) {
    const converted = fromVcditHandoff(raw);
    if (!converted.ok) return converted;
    raw = converted.handoff;
    warnings = converted.warnings;
  }
  const parsed = HandoffSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => ({ path: pathOf(i.path), message: i.message })) };
  }
  const handoff = parsed.data;
  if (vcdit) return { ok: true, handoff, warnings };
  if (handoff.schemaVersion > HANDOFF_SCHEMA_VERSION) {
    warnings.push({ path: 'schemaVersion', message: `Written by a newer VCDIT (schema ${handoff.schemaVersion}); unknown fields are kept but ignored` });
  }
  handoff.shots.forEach((s, i) => {
    if (s.tasks.length === 0) warnings.push({ path: `shots[${i}].tasks`, message: `${s.shotId} has no prep tasks requested` });
    if (s.checksums.length === 0) warnings.push({ path: `shots[${i}].checksums`, message: `${s.shotId} carries no source checksums to verify against` });
    if (s.frameIn === undefined) warnings.push({ path: `shots[${i}].frameIn`, message: `${s.shotId} has no frame range; it is read from the clip with ffprobe` });
    const cam = s.camera as Record<string, unknown>;
    for (const [where, v] of [['camera.pixelAspect', cam['pixelAspect']], ['camera.anamorphicSqueeze', cam['anamorphicSqueeze']], ['camera.lensSqueeze', cam['lensSqueeze']], ['pixelAspect', s.pixelAspect]] as const) {
      if (v !== undefined && parsePixelAspect(v) === null) warnings.push({ path: `shots[${i}].${where}`, message: `${s.shotId}: “${String(v)}” is not a pixel aspect (a number from 0.25 to 4, or a ratio like 3:2); it is ignored` });
    }
  });
  return { ok: true, handoff, warnings };
}

/** The output spec that applies to a shot: its own, else the project default. */
export function outputFor(handoff: Handoff, shot: HandoffShot): OutputSpec {
  return shot.output ?? handoff.output;
}
