import { z } from 'zod';
import type { ChecksumAlgorithm, HandoffIssue, HandoffSchema } from './handoff.js';

/**
 * The handoff VCDIT actually writes: `vcdit.vfx-handoff/1`.
 *
 * VCDIT's "Send to VC VFX Prep" (its `VfxService.sendToPrep`) writes, on every
 * destination drive that holds the day's VFX mirrors,
 *
 *   <drive>/<PRODUCTION>/SHOOT_DAY_###_YYYY-MM-DD/VFX/VC_VFX_PREP_<CODE>_D###_<stamp>.json
 *
 * beside the VFX → SCENE_### → SETUP_X → T##_<clip> mirror folders. Every
 * path in it is relative to that VFX folder, which is the JSON's own folder.
 * It describes takes, not VFX shots: there is no shot number, frame range,
 * timecode, camera, lens, colour or task list. `fromVcditHandoff` turns it
 * into VC VFX's own `Handoff`, filling what it can and saying what it could
 * not (docs/spec/addendum-02-vcdit-handoff.md).
 *
 * The schema is tolerant (`passthrough`, nullable strings) so a VCDIT that
 * grows new fields still opens.
 */

export const VCDIT_HANDOFF_FORMAT = 'vcdit.vfx-handoff';
export const VCDIT_HANDOFF_VERSION = 1;

const text = z
  .string()
  .nullish()
  .transform((v) => (v ?? '').trim());

export const VcditFileSchema = z
  .object({
    /** Relative to the clip's card folder, forward slashes: "A015R1AB/A015C002_261007_R1AB.mxf". */
    path: z.string().min(1),
    size: z.number().nonnegative().nullish(),
    /** Lowercase hex, from ingest; null when the card was not hashed. */
    checksum: z.string().nullish(),
  })
  .passthrough();
export type VcditFile = z.infer<typeof VcditFileSchema>;

export const VcditShotSchema = z
  .object({
    scene: text,
    /** "—" when the take has no setup. */
    setup: text,
    /** Two digits: "03". */
    take: text,
    clip: z.string().min(1),
    note: text,
    /** "Script sup." or "DIT tag". */
    flaggedBy: text,
    mirror: z
      .object({
        /** "Hard link" | "Reference" | "Physical copy". */
        method: z.string(),
        /** The take's mirror folder, relative to the VFX folder: "SCENE_014/SETUP_B/T03_A015C002". */
        folder: z.string(),
      })
      .passthrough(),
    /** The editorial copy's card folder, relative to the VFX folder: "../CAMERA_ORIGINALS/A015". */
    editorialFolder: text,
    /** "xxHash64" | "MD5" | "SHA-1". */
    checksumMethod: text,
    files: z.array(VcditFileSchema).default([]),
  })
  .passthrough();
export type VcditShot = z.infer<typeof VcditShotSchema>;

export const VcditHandoffSchema = z
  .object({
    schema: z.string().regex(/^vcdit\.vfx-handoff\/\d+$/, 'Not a vcdit.vfx-handoff document'),
    createdAt: z.string().optional(),
    tool: z.object({ name: text, version: text }).passthrough().optional(),
    production: z
      .object({
        name: text,
        code: text,
        /** Free text in VCDIT, e.g. "23.976 fps", "24", "29.97 DF". */
        frameRate: z.union([z.string(), z.number()]).nullish(),
      })
      .passthrough()
      .default({}),
    day: z.object({ number: z.number().int().nonnegative().optional(), date: z.string().optional() }).passthrough().optional(),
    shots: z.array(VcditShotSchema).min(1, 'The VCDIT handoff has no shots'),
  })
  .passthrough();
export type VcditHandoff = z.infer<typeof VcditHandoffSchema>;

/** True for any VCDIT document (it carries `schema: "vcdit.…"`), handoff or not. */
export function isVcditDocument(raw: unknown): raw is { schema: string } {
  return typeof raw === 'object' && raw !== null && typeof (raw as { schema?: unknown }).schema === 'string' && (raw as { schema: string }).schema.startsWith('vcdit.');
}

// ---------------------------------------------------------------------------
// Pure helpers, exported for tests
// ---------------------------------------------------------------------------

/** The common rates written with two decimals, mapped to their exact NTSC value. */
const NTSC: Record<string, number> = { '23.98': 23.976, '29.97': 29.97, '47.95': 47.952, '59.94': 59.94, '119.88': 119.88 };

/**
 * A frame rate from VCDIT's free-text production setting: "23.976 fps",
 * "24", "25p", "29.97 DF", "24000/1001", or a number. Null when unreadable.
 */
export function parseFrameRate(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 && value <= 1000 ? value : null;
  if (!value) return null;
  const fraction = /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/.exec(value);
  if (fraction) {
    const rate = Number(fraction[1]) / Number(fraction[2]);
    return Number.isFinite(rate) && rate > 0 && rate <= 1000 ? Math.round(rate * 1000) / 1000 : null;
  }
  const m = /(\d+(?:[.,]\d+)?)/.exec(value);
  if (!m) return null;
  const n = Number(m[1]!.replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0 || n > 1000) return null;
  return NTSC[n.toFixed(2)] ?? n;
}

const VIDEO_EXTENSIONS = new Set(['mov', 'mxf', 'mp4', 'm4v', 'r3d', 'braw', 'ari', 'crm', 'avi', 'mkv', 'mts', 'm2ts']);
const SEQUENCE_EXTENSIONS = new Set(['dng', 'exr', 'dpx', 'tif', 'tiff', 'cin']);
/** Camera raw formats ffmpeg cannot decode: plates for these come from the vendor's tool. */
const NOT_FFMPEG = new Set(['r3d', 'braw', 'crm', 'ari']);

export const extensionOf = (path: string): string => {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

const byPath = new Intl.Collator('en', { numeric: true }).compare;

/**
 * The take's primary media file among its files: the largest movie file
 * (MOV, MXF, MP4, R3D, BRAW, ARI…), else the first frame of an image
 * sequence (DNG, EXR, DPX, TIFF), else the largest file. A spanned R3D clip
 * starts at its first segment, not its largest. `sequenceFrames` is the
 * number of frames when the take is an image sequence.
 */
export function primaryMediaFile<F extends { path: string; size?: number | null | undefined }>(files: readonly F[]): { primary: F; sequenceFrames: number | null } | null {
  if (files.length === 0) return null;
  const size = (f: F) => f.size ?? 0;
  const videos = files.filter((f) => VIDEO_EXTENSIONS.has(extensionOf(f.path)));
  if (videos.length) {
    const r3d = videos.filter((f) => extensionOf(f.path) === 'r3d').sort((a, b) => byPath(a.path, b.path));
    if (r3d.length && r3d.length === videos.length) return { primary: r3d[0]!, sequenceFrames: null };
    const largest = videos.reduce((best, f) => (size(f) > size(best) ? f : best));
    return { primary: largest, sequenceFrames: null };
  }
  const frames = files.filter((f) => SEQUENCE_EXTENSIONS.has(extensionOf(f.path))).sort((a, b) => byPath(a.path, b.path));
  if (frames.length) {
    const ext = extensionOf(frames[0]!.path);
    const same = frames.filter((f) => extensionOf(f.path) === ext);
    return { primary: same[0]!, sequenceFrames: same.length > 1 ? same.length : null };
  }
  return { primary: files.reduce((best, f) => (size(f) > size(best) ? f : best)), sequenceFrames: null };
}

/** VCDIT's checksum method name → VC VFX's algorithm, or null when unknown. */
export function checksumAlgorithmOf(method: string): ChecksumAlgorithm | null {
  const key = method.toLowerCase().replace(/[^a-z0-9]/g, '');
  const table: Record<string, ChecksumAlgorithm> = {
    xxhash64: 'xxh64',
    xxh64: 'xxh64',
    xxhash: 'xxh64',
    xxh128: 'xxh128',
    xxhash128: 'xxh128',
    xxh3: 'xxh3',
    md5: 'md5',
    sha1: 'sha1',
    sha256: 'sha256',
  };
  return table[key] ?? null;
}

/** Join forward-slash path parts, dropping empty and "." segments (".." is kept for resolution later). */
export function joinRelative(...parts: string[]): string {
  return parts
    .flatMap((p) => p.replace(/\\/g, '/').split('/'))
    .filter((seg) => seg !== '' && seg !== '.')
    .join('/');
}

/** "A015C002" → "A015"; "A001_C002_0712AB" → "A001"; undefined when the name does not say. */
export function cameraRollOf(clip: string): string | undefined {
  const m = /^([A-Z]\d{3})_?C\d{3}/i.exec(clip);
  return m ? m[1]!.toUpperCase() : undefined;
}

const idPart = (s: string) => s.trim().replace(/[^A-Za-z0-9_-]+/g, '').replace(/_+/g, '_').replace(/^_|_$/g, '');
const noSetup = (s: string) => (s === '—' || s === '-' ? '' : s);

/**
 * Readable, stable shot IDs for VCDIT takes, which have none: `14_B_03`
 * (scene, setup, take). Takes that share one — several cameras on the same
 * take — each get their clip name added (`14_B_03_A015C002`), so no camera is
 * privileged by the order VCDIT wrote them in.
 */
export function deriveShotIds(shots: readonly { scene: string; setup: string; take: string; clip: string }[]): string[] {
  const bases = shots.map((s) => [s.scene, noSetup(s.setup), s.take].map(idPart).filter(Boolean).join('_') || idPart(s.clip) || 'SHOT');
  const counts = new Map<string, number>();
  for (const b of bases) counts.set(b, (counts.get(b) ?? 0) + 1);
  const named = bases.map((b, i) => ((counts.get(b) ?? 0) > 1 ? [b, idPart(shots[i]!.clip)].filter(Boolean).join('_') : b));
  const seen = new Map<string, number>();
  return named.map((id) => {
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    return n === 1 ? id : `${id}_${n}`;
  });
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

export type HandoffInput = z.input<typeof HandoffSchema>;

export type VcditConversion = { ok: true; handoff: HandoffInput; warnings: HandoffIssue[] } | { ok: false; issues: HandoffIssue[] };

export interface VcditOptions {
  /** Used for the project name when the production has neither name nor code. */
  fileName?: string;
}

function pathOf(p: (string | number)[]): string {
  return p.reduce<string>((acc, part) => (typeof part === 'number' ? `${acc}[${part}]` : acc ? `${acc}.${part}` : part), '');
}

/**
 * Convert a parsed `vcdit.vfx-handoff/1` document into a VC VFX handoff
 * (not yet validated: `parseHandoff` runs it through `HandoffSchema`).
 */
export function fromVcditHandoff(raw: unknown, opts: VcditOptions = {}): VcditConversion {
  if (isVcditDocument(raw) && !raw.schema.startsWith(`${VCDIT_HANDOFF_FORMAT}/`)) {
    const reference = raw.schema.startsWith('vcdit.vfx-reference/');
    return {
      ok: false,
      issues: [
        {
          path: 'schema',
          message: reference
            ? 'This is the VFX_REFERENCE.json VCDIT leaves in one take’s folder. Open the day’s VC_VFX_PREP_….json in the VFX folder instead.'
            : `${raw.schema} is a VCDIT file, but not a VFX handoff.`,
        },
      ],
    };
  }
  const parsed = VcditHandoffSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((i) => ({ path: pathOf(i.path), message: i.message })) };
  const doc = parsed.data;
  const warnings: HandoffIssue[] = [];
  const version = Number(doc.schema.split('/')[1]);
  if (version > VCDIT_HANDOFF_VERSION) {
    warnings.push({ path: 'schema', message: `Written by a newer VCDIT (${doc.schema}); read as version ${VCDIT_HANDOFF_VERSION}, and fields it does not know are kept but ignored` });
  }

  const rate = parseFrameRate(doc.production.frameRate);
  if (rate === null) {
    warnings.push({
      path: 'production.frameRate',
      message: `The production frame rate${doc.production.frameRate ? ` “${doc.production.frameRate}”` : ''} could not be read; 24 fps is assumed until each clip is read with ffprobe`,
    });
  }
  const frameRate = rate ?? 24;
  const tool = [doc.tool?.name, doc.tool?.version].filter(Boolean).join(' ') || undefined;
  const dayNumber = doc.day?.number;
  const shootDay = dayNumber !== undefined ? `Day ${String(dayNumber).padStart(3, '0')}${doc.day?.date ? ` · ${doc.day.date}` : ''}` : doc.day?.date;

  const ids = deriveShotIds(doc.shots);
  const shots = doc.shots.map((s, i) => {
    const at = `shots[${i}]`;
    const shotId = ids[i]!;
    const referenced = s.mirror.method.toLowerCase() === 'reference';
    // A reference mirror holds no media, only a note of where it is: the editorial copy is the source.
    let base = s.mirror.folder;
    if (referenced) {
      if (s.editorialFolder) {
        base = s.editorialFolder;
        warnings.push({ path: `${at}.mirror.method`, message: `${shotId} is referenced, not mirrored: its source is the editorial copy in ${s.editorialFolder} (read only, as always)` });
      } else {
        warnings.push({ path: `${at}.editorialFolder`, message: `${shotId} is referenced but names no editorial folder; its media may not be found` });
      }
    }
    const pick = primaryMediaFile(s.files);
    if (!pick) warnings.push({ path: `${at}.files`, message: `${shotId} lists no files; only its folder is known` });
    const sourcePath = pick ? joinRelative(base, pick.primary.path) : joinRelative(base) || s.clip;
    const others = s.files.filter((f) => f !== pick?.primary).map((f) => joinRelative(base, f.path));
    const ext = pick ? extensionOf(pick.primary.path) : '';
    if (NOT_FFMPEG.has(ext)) {
      warnings.push({ path: `${at}.files`, message: `${shotId}: ffmpeg cannot decode .${ext} camera raw; make its plates with the camera vendor’s tool and record them here` });
    }

    const algorithm = s.checksumMethod ? checksumAlgorithmOf(s.checksumMethod) : null;
    if (s.files.length && !algorithm) {
      warnings.push({ path: `${at}.checksumMethod`, message: `${shotId}: checksum method “${s.checksumMethod}” is not one VC VFX knows; its checksums are not kept` });
    }
    const unhashed = s.files.filter((f) => !f.checksum).length;
    if (algorithm && unhashed) warnings.push({ path: `${at}.files`, message: `${shotId}: ${unhashed} file${unhashed === 1 ? ' was' : 's were'} not checksummed at ingest` });
    const checksums = algorithm
      ? s.files
          .filter((f) => f.checksum)
          .map((f) => ({
            path: joinRelative(base, f.path),
            algorithm,
            value: f.checksum!.trim().toLowerCase(),
            ...(typeof f.size === 'number' ? { bytes: Math.round(f.size) } : {}),
          }))
      : [];

    const setup = noSetup(s.setup);
    const cameraRoll = cameraRollOf(s.clip);
    return {
      shotId,
      ...(shootDay ? { shootDay } : {}),
      scene: s.scene || '—',
      ...(setup ? { setup } : {}),
      ...(s.take ? { take: s.take } : {}),
      ...(cameraRoll ? { cameraRoll } : {}),
      clip: s.clip,
      circled: false,
      sourcePath,
      ...(others.length ? { sourceFiles: others } : {}),
      ...(s.flaggedBy ? { flaggedBy: s.flaggedBy } : {}),
      // A whole take has no handles beyond itself; an image sequence's length is known from its files.
      handles: 0,
      ...(pick?.sequenceFrames ? { frameIn: 0, frameOut: pick.sequenceFrames - 1 } : {}),
      frameRate,
      tasks: [],
      ...(s.note ? { supervisorNotes: s.note } : {}),
      checksums,
    };
  });

  if (doc.shots.some((s) => !s.scene)) warnings.push({ path: 'shots', message: 'Some takes have no scene in VCDIT; they are listed under “—”' });
  warnings.unshift(
    { path: 'shots[].shotId', message: `VCDIT sends no VFX shot numbers, so shots are named scene_setup_take (e.g. ${ids[0]}). Assign the VFX editor’s numbers in each shot’s panel.` },
    { path: 'shots[].tasks', message: 'VCDIT sends no prep tasks: assign prep tasks in VC VFX. Shift- or Ctrl/Cmd-click several shots to add a task to all of them.' },
    { path: 'shots[].frameIn', message: 'VCDIT sends no frame range, timecode or resolution. VC VFX reads each clip with ffprobe; until then frames show “—”.' },
    { path: 'shots[].camera', message: 'VCDIT sends no camera, lens or colour metadata, and does not mark circle takes.' },
  );

  return {
    ok: true,
    warnings,
    handoff: {
      schemaVersion: 1,
      ...(tool ? { generator: tool } : {}),
      ...(doc.createdAt ? { generatedAt: doc.createdAt } : {}),
      project: doc.production.name || doc.production.code || opts.fileName || 'Untitled production',
      origin: {
        format: doc.schema,
        ...(tool ? { tool } : {}),
        ...(doc.production.code ? { productionCode: doc.production.code } : {}),
        ...(doc.day ? { day: { ...(dayNumber !== undefined ? { number: dayNumber } : {}), ...(doc.day.date ? { date: doc.day.date } : {}) } } : {}),
        ...(doc.createdAt ? { createdAt: doc.createdAt } : {}),
      },
      shots,
    },
  };
}
