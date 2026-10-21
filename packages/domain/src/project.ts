import { z } from 'zod';
import { HandoffSchema, TimecodeSchema, outputFor, type Handoff, type HandoffShot } from './handoff.js';
import { sequencePlan, type SequencePlan } from './frames.js';
import { PREP_TASK_KINDS, PREP_TASKS, TASK_STATE_LABELS, TASK_STATES, sortTaskKinds, type PrepTaskKind, type TaskState } from './tasks.js';
import { SHOT_STATUSES, type ShotStatus } from './status.js';
import {
  COLOR_ENCODINGS,
  PLATE_COLOR_LABELS,
  PLATE_TARGETS,
  PROJECT_EXR_COLOR,
  SHOT_PLATE_COLOR,
  decidePlateColor,
  encodingLabel,
  type ColorEncodingId,
  type PlateColorDecision,
  type ProjectExrColor,
  type ShotPlateColor,
} from './color.js';
import { RotoDocumentSchema } from './roto-schema.js';
import { CamTrackDocumentSchema, Track2dDocumentSchema } from './camtrack-schema.js';
import { KeyDocumentSchema } from './key-schema.js';
import { CameraBodySchema, LensProfileSchema } from './camera-db.js';

/**
 * A VCVFX project: the handoff it was built from plus VCVFX's own working
 * state — task progress, approvals, package versions and the operation log.
 *
 * The rules this file enforces are the spec's safety rules (§15, §19):
 *  - processing finishing never approves anything; approval is an explicit,
 *    attributed act per task and then per shot;
 *  - reopening approved work withdraws the approval and bumps the version
 *    rather than silently replacing what was approved;
 *  - every change is logged with who, when and what.
 *
 * Every function here is pure and returns a new project.
 */

export const PROJECT_FORMAT = 'vcvfx-project';
/**
 * 2: shots carry a paint-to-roto document (`roto`).
 * 3: shots carry a camera-track (`camtrack`) and a 2D-track (`track2d`)
 *    document; the project carries its lens profiles and custom cameras.
 * 4: shots carry a green/blue-screen key document (`key`; addendum 09).
 * An older project opens (the new fields empty) and is saved as the current
 * version; an older VC VFX refuses a newer project rather than silently
 * dropping what it does not know about.
 */
export const PROJECT_VERSION = 4;
export const PROJECT_EXTENSION = 'vcvfx';

export const ApprovalSchema = z.object({ by: z.string().min(1), at: z.string() });
export type Approval = z.infer<typeof ApprovalSchema>;

export const TaskRecordSchema = z.object({
  kind: z.enum(PREP_TASK_KINDS),
  state: z.enum(TASK_STATES),
  /** Output version; bumped whenever approved work is reopened. */
  version: z.number().int().positive(),
  notes: z.string().default(''),
  approval: ApprovalSchema.nullable().default(null),
});
export type TaskRecord = z.infer<typeof TaskRecordSchema>;

/**
 * What ffprobe read from a shot's source clip. Kept in the shot's state, not
 * in the handoff, so the handoff stays as it was received.
 */
export const ProbedMediaSchema = z.object({
  /** Handoff-relative path of the file that was read. */
  file: z.string(),
  frameCount: z.number().int().positive().optional(),
  timecodeIn: TimecodeSchema.optional(),
  frameRate: z.number().positive().optional(),
  resolution: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
  codec: z.string().optional(),
  /** ffmpeg's pixel format, e.g. "yuv422p10le", "gbrp10le". */
  pixelFormat: z.string().optional(),
  /** The file's colour tags as ffprobe reports them ("bt709", "tv"…); absent when untagged. */
  colorSpace: z.string().optional(),
  colorRange: z.string().optional(),
  colorTransfer: z.string().optional(),
  colorPrimaries: z.string().optional(),
  probedAt: z.string(),
});
export type ProbedMedia = z.infer<typeof ProbedMediaSchema>;
export type ProbedMediaInput = Omit<ProbedMedia, 'probedAt'>;

/** What was applied to a set of plates, exactly, so they can be made again from source + settings (§19). */
export const PlateColorRecordSchema = z.object({
  policy: z.union([
    z.object({ mode: z.literal('as_shot') }),
    z.object({ mode: z.literal('convert'), from: z.enum(COLOR_ENCODINGS), to: z.enum(PLATE_TARGETS) }),
  ]),
  sourceEncoding: z.enum(COLOR_ENCODINGS).nullable(),
  plateEncoding: z.enum(COLOR_ENCODINGS).nullable(),
  summary: z.string(),
  /** The transform in words and numbers; null when nothing was applied. */
  transform: z.string().nullable(),
  /** The ffmpeg filter graph that was run, verbatim. */
  filter: z.string(),
  /** Package-relative paths of the files that describe the transform (09_PROJECT_DATA). */
  files: z.array(z.string()).default([]),
  /** Always false: a display look is never baked into plates (§4). */
  lookApplied: z.literal(false).default(false),
});
export type PlateColorRecord = z.infer<typeof PlateColorRecordSchema>;

export const PlateRecordSchema = z.object({
  version: z.number().int().positive(),
  pattern: z.string(),
  format: z.string(),
  bitDepth: z.number().int().positive(),
  frames: z.number().int().nonnegative(),
  firstFrame: z.number().int().nonnegative(),
  lastFrame: z.number().int().nonnegative(),
  color: PlateColorRecordSchema,
  notes: z.array(z.string()).default([]),
  writtenAt: z.string(),
  by: z.string(),
});
export type PlateRecord = z.infer<typeof PlateRecordSchema>;
export type PlateRecordInput = Omit<PlateRecord, 'writtenAt' | 'by'>;

/** A frame marked in review as needing correction (groundwork for roto review, §5.2). */
export const ReviewMarkSchema = z.object({
  /** Delivered frame number. */
  frame: z.number().int().nonnegative(),
  /** What was being looked at: "source" or "plates v001". */
  viewing: z.string().default('source'),
  note: z.string().default(''),
  by: z.string(),
  at: z.string(),
});
export type ReviewMark = z.infer<typeof ReviewMarkSchema>;

export const ShotStateSchema = z.object({
  shotId: z.string(),
  /**
   * The VFX editor's shot number, assigned in VC VFX. Shown in the queue, the
   * shot list and package names in place of the handoff's ID. Null: none yet.
   */
  vfxShotId: z.string().nullable().default(null),
  probe: ProbedMediaSchema.nullable().default(null),
  tasks: z.array(TaskRecordSchema),
  approval: ApprovalSchema.nullable().default(null),
  /** Explicit stages past approval. */
  stage: z.enum(['prep', 'packaged', 'delivered']).default('prep'),
  packageVersion: z.number().int().nonnegative().default(0),
  notes: z.string().default(''),
  sourceVerified: z.enum(['unchecked', 'verified', 'mismatch', 'missing']).default('unchecked'),
  /** The operator's reading of the source encoding, overriding the handoff's text. Null: from the handoff. */
  sourceEncoding: z.enum(COLOR_ENCODINGS).nullable().default(null),
  /** The plate colour choice for this shot; `auto` follows the project default. */
  plateColor: z.enum(SHOT_PLATE_COLOR).default('auto'),
  /** Plates written, one record per version. */
  plates: z.array(PlateRecordSchema).default([]),
  reviewMarks: z.array(ReviewMarkSchema).default([]),
  /** Paint-to-roto (§5): parts, strokes, per-frame status and confidence. Null until roto starts. Masks are files, never here. */
  roto: RotoDocumentSchema.nullable().default(null),
  /** Camera tracking / matchmove (§10). Null until started. Feature tracks and solved cameras are files, never here. */
  camtrack: CamTrackDocumentSchema.nullable().default(null),
  /** 2D / planar tracks (§9). Null until the first track. */
  track2d: Track2dDocumentSchema.nullable().default(null),
  /** Green/blue-screen key (§6, §7). Null until keying starts. Mattes and foregrounds are files, never here. */
  key: KeyDocumentSchema.nullable().default(null),
});
export type ShotState = z.infer<typeof ShotStateSchema>;

export const LogEntrySchema = z.object({
  at: z.string(),
  actor: z.string(),
  shotId: z.string().nullable(),
  action: z.string(),
  detail: z.string().default(''),
});
export type LogEntry = z.infer<typeof LogEntrySchema>;

export const ProjectSchema = z.object({
  format: z.literal(PROJECT_FORMAT),
  version: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Absolute path of the handoff file on the drive when the project was made. */
  handoffPath: z.string(),
  handoff: HandoffSchema,
  /** What EXR plates are converted to unless a shot says otherwise. DPX/TIFF keep the camera encoding. */
  plateColorDefault: z.enum(PROJECT_EXR_COLOR).default('acescg'),
  shots: z.array(ShotStateSchema),
  /** Lens distortion profiles by camera / lens / focal length (§10.1). */
  lensProfiles: z.array(LensProfileSchema).default([]),
  /** Cameras the production added to the built-in database. */
  customCameras: z.array(CameraBodySchema).default([]),
  log: z.array(LogEntrySchema),
});
export type Project = z.infer<typeof ProjectSchema>;

export type Result = { ok: true; project: Project } | { ok: false; reason: string };

function log(p: Project, entry: Omit<LogEntry, 'detail'> & { detail?: string }): Project {
  return { ...p, updatedAt: entry.at, log: [...p.log, { detail: '', ...entry }] };
}

export function createProject(handoff: Handoff, handoffPath: string, actor: string, now: Date): Project {
  const at = now.toISOString();
  const shots: ShotState[] = handoff.shots.map((s) => ({
    shotId: s.shotId,
    vfxShotId: null,
    probe: null,
    tasks: sortTaskKinds([...new Set(s.tasks.map((t) => t.kind))]).map((kind) => ({
      kind,
      state: 'pending' as const,
      version: 1,
      notes: s.tasks.filter((t) => t.kind === kind).map((t) => t.notes ?? '').filter(Boolean).join('\n'),
      approval: null,
    })),
    approval: null,
    stage: 'prep' as const,
    packageVersion: 0,
    notes: '',
    sourceVerified: 'unchecked' as const,
    sourceEncoding: null,
    plateColor: 'auto' as const,
    plates: [],
    reviewMarks: [],
    roto: null,
    camtrack: null,
    track2d: null,
    key: null,
  }));
  return log(
    { format: PROJECT_FORMAT, version: PROJECT_VERSION, createdAt: at, updatedAt: at, handoffPath, handoff, plateColorDefault: 'acescg', shots, lensProfiles: [], customCameras: [], log: [] },
    { at, actor, shotId: null, action: 'project.created', detail: `${shots.length} shots from ${handoffPath}` },
  );
}

export function parseProject(text: string): { ok: true; project: Project } | { ok: false; reason: string } {
  try {
    const parsed = ProjectSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return { ok: false, reason: parsed.error.issues[0]?.message ?? 'Not a VCVFX project' };
    if (parsed.data.version > PROJECT_VERSION) return { ok: false, reason: 'This project was saved by a newer VC VFX. Update to open it.' };
    return { ok: true, project: migrateProject(parsed.data) };
  } catch (e) {
    return { ok: false, reason: `Not valid JSON: ${(e as Error).message}` };
  }
}

/**
 * Bring an older project up to `PROJECT_VERSION`. The schema's defaults have
 * already filled what an older project lacks (`roto`, `camtrack`, `track2d`,
 * `key` null; no lens profiles); this records the version it is now saved as.
 */
export function migrateProject(p: Project): Project {
  return p.version === PROJECT_VERSION ? p : { ...p, version: PROJECT_VERSION };
}

export function serializeProject(p: Project): string {
  return `${JSON.stringify(p, null, 2)}\n`;
}

export function handoffShot(p: Project, shotId: string): HandoffShot | undefined {
  return p.handoff.shots.find((s) => s.shotId === shotId);
}

export function shotState(p: Project, shotId: string): ShotState | undefined {
  return p.shots.find((s) => s.shotId === shotId);
}

/** The name a shot goes by: the VFX shot number once assigned, else the handoff's ID. */
export function displayShotId(p: Project, shotId: string): string {
  return shotState(p, shotId)?.vfxShotId ?? shotId;
}

/** The frame range and timing VC VFX works from, wherever it came from. */
export interface ShotTiming {
  frameIn: number;
  frameOut: number;
  handles: number;
  frameRate: number;
  timecodeIn?: string;
  resolution?: { width: number; height: number };
  /**
   * handoff: the handoff gave the range (absolute frames when it gives a
   * timecodeIn). probe: the whole clip as ffprobe read it, clip-relative from 0.
   */
  from: 'handoff' | 'probe';
}

/**
 * The shot's timing: the handoff's own range when it has one, else the clip
 * as probed (frames 0 … frameCount − 1, the probe's rate and start
 * timecode). Null while the range is unknown.
 */
export function shotTiming(p: Project, shot: HandoffShot): ShotTiming | null {
  const probe = shotState(p, shot.shotId)?.probe ?? null;
  const resolution = shot.resolution ?? probe?.resolution;
  if (shot.frameIn !== undefined && shot.frameOut !== undefined) {
    return {
      frameIn: shot.frameIn,
      frameOut: shot.frameOut,
      handles: shot.handles,
      frameRate: shot.frameRate,
      ...(shot.timecodeIn ? { timecodeIn: shot.timecodeIn } : {}),
      ...(resolution ? { resolution } : {}),
      from: 'handoff',
    };
  }
  if (!probe?.frameCount) return null;
  const timecodeIn = shot.timecodeIn ?? probe.timecodeIn;
  return {
    frameIn: 0,
    frameOut: probe.frameCount - 1,
    handles: shot.handles,
    frameRate: probe.frameRate ?? shot.frameRate,
    ...(timecodeIn ? { timecodeIn } : {}),
    ...(resolution ? { resolution } : {}),
    from: 'probe',
  };
}

/** The shot's sequence plan, or null while its frame range is unknown. */
export function planFor(p: Project, shot: HandoffShot): SequencePlan | null {
  const timing = shotTiming(p, shot);
  return timing ? sequencePlan(timing, outputFor(p.handoff, shot)) : null;
}

/** The shot's status (§16), always derived from its tasks and explicit acts. */
export function shotStatus(s: ShotState): ShotStatus {
  if (s.stage === 'delivered') return 'delivered';
  if (s.stage === 'packaged') return 'packaged';
  if (s.approval) return 'prep_approved';
  if (s.tasks.length === 0) return 'not_started';
  const states = new Set(s.tasks.map((t) => t.state));
  if (states.has('needs_correction')) return 'needs_correction';
  if (states.has('processing')) return 'processing';
  if (states.has('needs_review')) return 'needs_review';
  if ([...states].every((x) => x === 'pending')) return 'ready_for_prep';
  // Every task approved but the shot itself not yet signed off: still a
  // review, never an inferred approval (§15.6).
  if ([...states].every((x) => x === 'approved')) return 'needs_review';
  return 'processing';
}

function updateShot(p: Project, shotId: string, fn: (s: ShotState) => ShotState | string): Result {
  const current = shotState(p, shotId);
  if (!current) return { ok: false, reason: `No shot ${shotId}` };
  const next = fn(current);
  if (typeof next === 'string') return { ok: false, reason: next };
  return { ok: true, project: { ...p, shots: p.shots.map((s) => (s.shotId === shotId ? next : s)) } };
}

function chain(r: Result, fn: (p: Project) => Project): Result {
  return r.ok ? { ok: true, project: fn(r.project) } : r;
}

/**
 * Move a task through its workflow. Approval is not reachable from here —
 * use `approveTask`. Reopening approved work bumps its version and withdraws
 * any shot approval.
 */
export function setTaskState(p: Project, shotId: string, kind: PrepTaskKind, state: Exclude<TaskState, 'approved'>, actor: string, now: Date): Result {
  const at = now.toISOString();
  let reopened = false;
  let withdrew = false;
  const r = updateShot(p, shotId, (s) => {
    if (s.stage !== 'prep') return `${shotId} is ${s.stage}; reopen it before changing its tasks`;
    const task = s.tasks.find((t) => t.kind === kind);
    if (!task) return `${shotId} has no ${kind} task`;
    if (task.state === state) return s;
    reopened = task.state === 'approved';
    withdrew = reopened && s.approval !== null;
    return {
      ...s,
      approval: withdrew ? null : s.approval,
      tasks: s.tasks.map((t) => (t.kind === kind ? { ...t, state, approval: null, version: reopened ? t.version + 1 : t.version } : t)),
    };
  });
  return chain(r, (proj) => {
    let out = log(proj, { at, actor, shotId, action: 'task.state', detail: `${kind} → ${state}${reopened ? ' (approved work reopened; new version)' : ''}` });
    if (withdrew) out = log(out, { at, actor, shotId, action: 'shot.approval_withdrawn', detail: `${kind} reopened` });
    return out;
  });
}

/** Approve one task. Only work that has been put up for review can be approved. */
export function approveTask(p: Project, shotId: string, kind: PrepTaskKind, approver: string, now: Date): Result {
  const at = now.toISOString();
  if (!approver.trim()) return { ok: false, reason: 'Approval needs the name of the person approving' };
  const r = updateShot(p, shotId, (s) => {
    const task = s.tasks.find((t) => t.kind === kind);
    if (!task) return `${shotId} has no ${kind} task`;
    if (task.state === 'approved') return s;
    if (task.state !== 'needs_review') return `${PREP_TASKS[kind].label} is ${TASK_STATE_LABELS[task.state].toLowerCase()}; only work in review can be approved`;
    // Roto made here is approved as files: the mattes of this version must have been exported.
    if (kind === 'roto' && s.roto && s.roto.parts.some((part) => part.frames.length > 0) && !s.roto.exports.some((e) => e.version === task.version)) {
      return `Export the mattes of roto ${'v' + String(task.version).padStart(3, '0')} first; approval approves the files a vendor receives`;
    }
    if (kind === 'camera_track' && s.camtrack && s.camtrack.solves.length > 0 && !s.camtrack.exports.some((e) => e.version === task.version)) {
      return `Export camera track ${'v' + String(task.version).padStart(3, '0')} first; approval approves the files a vendor receives`;
    }
    if (kind === 'track_2d' && s.track2d && s.track2d.tracks.some((t) => t.frames.length > 1) && !s.track2d.exports.some((e) => e.version === task.version)) {
      return `Export the 2D tracks of ${'v' + String(task.version).padStart(3, '0')} first; approval approves the files a vendor receives`;
    }
    // A key made here is approved as files too: the export of this key version (with the despilled foreground, for despill).
    const keyVersion = s.tasks.find((t) => t.kind === 'key')?.version ?? 1;
    if (kind === 'key' && s.key && s.key.frames.length > 0 && !s.key.exports.some((e) => e.version === task.version)) {
      return `Export key ${'v' + String(task.version).padStart(3, '0')} first; approval approves the files a vendor receives`;
    }
    if (kind === 'despill' && s.key && s.key.frames.length > 0 && !s.key.exports.some((e) => e.version === keyVersion && e.despill)) {
      return `Export key ${'v' + String(keyVersion).padStart(3, '0')} with the despilled foreground first; approval approves the files a vendor receives`;
    }
    return { ...s, tasks: s.tasks.map((t) => (t.kind === kind ? { ...t, state: 'approved' as const, approval: { by: approver.trim(), at } } : t)) };
  });
  return chain(r, (proj) => log(proj, { at, actor: approver.trim(), shotId, action: 'task.approved', detail: kind }));
}

/** Approve the shot as a whole; every task must already be approved. */
export function approveShot(p: Project, shotId: string, approver: string, now: Date): Result {
  const at = now.toISOString();
  if (!approver.trim()) return { ok: false, reason: 'Approval needs the name of the person approving' };
  const r = updateShot(p, shotId, (s) => {
    if (s.approval) return s;
    if (s.tasks.length === 0) return `${shotId} has no prep tasks to approve`;
    const open = s.tasks.filter((t) => t.state !== 'approved');
    if (open.length > 0) return `Approve every task first: ${open.map((t) => PREP_TASKS[t.kind].label).join(', ')}`;
    return { ...s, approval: { by: approver.trim(), at } };
  });
  return chain(r, (proj) => log(proj, { at, actor: approver.trim(), shotId, action: 'shot.approved' }));
}

/** Record that the shot's package was written. Returns the package version used. */
export function markPackaged(p: Project, shotId: string, actor: string, now: Date): Result {
  const at = now.toISOString();
  let version = 0;
  const r = updateShot(p, shotId, (s) => {
    if (!s.approval) return `${shotId} must be prep approved before it is packaged`;
    version = s.packageVersion + 1;
    return { ...s, stage: 'packaged', packageVersion: version };
  });
  return chain(r, (proj) => log(proj, { at, actor, shotId, action: 'shot.packaged', detail: `package v${String(version).padStart(3, '0')}` }));
}

export function markDelivered(p: Project, shotId: string, actor: string, now: Date): Result {
  const at = now.toISOString();
  const r = updateShot(p, shotId, (s) => (s.stage !== 'packaged' ? `${shotId} must be packaged before it is delivered` : { ...s, stage: 'delivered' }));
  return chain(r, (proj) => log(proj, { at, actor, shotId, action: 'shot.delivered' }));
}

/** Take a packaged or delivered shot back into prep (e.g. a note came back). */
export function reopenShot(p: Project, shotId: string, actor: string, now: Date): Result {
  const at = now.toISOString();
  const r = updateShot(p, shotId, (s) => (s.stage === 'prep' ? s : { ...s, stage: 'prep' }));
  return chain(r, (proj) => log(proj, { at, actor, shotId, action: 'shot.reopened' }));
}

export function addTask(p: Project, shotId: string, kind: PrepTaskKind, actor: string, now: Date): Result {
  const at = now.toISOString();
  let withdrew = false;
  const r = updateShot(p, shotId, (s) => {
    if (s.tasks.some((t) => t.kind === kind)) return `${shotId} already has ${kind}`;
    if (s.stage !== 'prep') return `${shotId} is ${s.stage}; reopen it first`;
    withdrew = s.approval !== null;
    const tasks = [...s.tasks, { kind, state: 'pending' as const, version: 1, notes: '', approval: null }];
    const order = sortTaskKinds(tasks.map((t) => t.kind));
    return { ...s, approval: null, tasks: order.map((k) => tasks.find((t) => t.kind === k)!) };
  });
  return chain(r, (proj) => {
    let out = log(proj, { at, actor, shotId, action: 'task.added', detail: kind });
    if (withdrew) out = log(out, { at, actor, shotId, action: 'shot.approval_withdrawn', detail: `${kind} added` });
    return out;
  });
}

export function setTaskNotes(p: Project, shotId: string, kind: PrepTaskKind, notes: string, actor: string, now: Date): Result {
  const r = updateShot(p, shotId, (s) =>
    s.tasks.some((t) => t.kind === kind) ? { ...s, tasks: s.tasks.map((t) => (t.kind === kind ? { ...t, notes } : t)) } : `${shotId} has no ${kind} task`,
  );
  return chain(r, (proj) => log(proj, { at: now.toISOString(), actor, shotId, action: 'task.notes', detail: kind }));
}

export function setShotNotes(p: Project, shotId: string, notes: string, actor: string, now: Date): Result {
  const r = updateShot(p, shotId, (s) => ({ ...s, notes }));
  return chain(r, (proj) => log(proj, { at: now.toISOString(), actor, shotId, action: 'shot.notes' }));
}

export function setSourceVerified(p: Project, shotId: string, result: ShotState['sourceVerified'], detail: string, actor: string, now: Date): Result {
  const r = updateShot(p, shotId, (s) => ({ ...s, sourceVerified: result }));
  return chain(r, (proj) => log(proj, { at: now.toISOString(), actor, shotId, action: `source.${result}`, detail }));
}

/**
 * Record what ffprobe read from the shot's source clip. Refused once the shot
 * has left prep: its plates and package were made from the range it had.
 */
export function setProbedMedia(p: Project, shotId: string, media: ProbedMediaInput, actor: string, now: Date): Result {
  const at = now.toISOString();
  const parsed = ProbedMediaSchema.safeParse({ ...media, probedAt: at });
  if (!parsed.success) return { ok: false, reason: `Probe result for ${shotId} is not usable: ${parsed.error.issues[0]?.message ?? 'bad data'}` };
  const r = updateShot(p, shotId, (s) => (s.stage !== 'prep' ? `${shotId} is ${s.stage}; reopen it before reading its clip again` : { ...s, probe: parsed.data }));
  const m = parsed.data;
  const detail = [
    m.frameCount ? `${m.frameCount} frames` : 'frame count unknown',
    m.frameRate ? `${m.frameRate} fps` : null,
    m.timecodeIn ? `TC ${m.timecodeIn}` : null,
    m.resolution ? `${m.resolution.width}×${m.resolution.height}` : null,
    m.codec ?? null,
    m.pixelFormat ?? null,
    m.colorSpace || m.colorTransfer || m.colorPrimaries ? `tags ${[m.colorSpace, m.colorRange, m.colorTransfer, m.colorPrimaries].filter(Boolean).join('/')}` : null,
  ]
    .filter(Boolean)
    .join(', ');
  return chain(r, (proj) => log(proj, { at, actor, shotId, action: 'source.probed', detail: `${m.file}: ${detail}` }));
}

// ---------------------------------------------------------------------------
// Plate colour (§4) and review marks (§5.2)
// ---------------------------------------------------------------------------

/** The colour decision for a shot's plates: what will be applied, from what, and in one sentence. */
export function plateColorFor(p: Project, shotId: string): PlateColorDecision {
  const shot = handoffShot(p, shotId);
  const state = shotState(p, shotId);
  if (!shot || !state) throw new Error(`No shot ${shotId}`);
  const output = outputFor(p.handoff, shot);
  return decidePlateColor({
    format: output.format,
    bitDepth: output.bitDepth,
    shotChoice: state.plateColor,
    projectExr: p.plateColorDefault,
    operatorEncoding: state.sourceEncoding,
    handoffText: [shot.color.sourceColorSpace, shot.color.gamma],
  });
}

function platesLocked(s: ShotState, shotId: string): string | null {
  if (s.stage !== 'prep') return `${shotId} is ${s.stage}; reopen it before changing how its plates are made`;
  const task = s.tasks.find((t) => t.kind === 'sequence_conversion');
  if (task?.state === 'approved') return 'These plates are approved. Reopen the image-sequence task first; the change applies to the new version.';
  return null;
}

/**
 * Set a shot's plate colour choice and/or the operator's reading of its
 * source encoding (null: back to the handoff's text). Refused once its plates
 * are approved: the next version takes the change.
 */
export function setShotPlateColor(
  p: Project,
  shotId: string,
  change: { choice?: ShotPlateColor; encoding?: ColorEncodingId | null },
  actor: string,
  now: Date,
): Result {
  const details: string[] = [];
  const r = updateShot(p, shotId, (s) => {
    const locked = platesLocked(s, shotId);
    if (locked) return locked;
    let next = s;
    if (change.choice !== undefined && change.choice !== s.plateColor) {
      details.push(`plate colour ${PLATE_COLOR_LABELS[s.plateColor]} → ${PLATE_COLOR_LABELS[change.choice]}`);
      next = { ...next, plateColor: change.choice };
    }
    if (change.encoding !== undefined && change.encoding !== s.sourceEncoding) {
      details.push(`source encoding ${s.sourceEncoding ? encodingLabel(s.sourceEncoding) : 'from handoff'} → ${change.encoding ? encodingLabel(change.encoding) : 'from handoff'}`);
      next = { ...next, sourceEncoding: change.encoding };
    }
    return next;
  });
  if (r.ok && details.length === 0) return { ok: true, project: p };
  return chain(r, (proj) => {
    const decision = plateColorFor(proj, shotId);
    return log(proj, { at: now.toISOString(), actor, shotId, action: 'plates.colour', detail: `${details.join('; ')}. ${decision.summary}` });
  });
}

/** The project's default for EXR plates. Plates already written keep the record of what was applied. */
export function setPlateColorDefault(p: Project, value: ProjectExrColor, actor: string, now: Date): Result {
  if (p.plateColorDefault === value) return { ok: true, project: p };
  const before = p.plateColorDefault;
  const label = (v: ProjectExrColor) => (v === 'as_shot' ? 'as shot' : `convert to ${encodingLabel(v)}`);
  return { ok: true, project: log({ ...p, plateColorDefault: value }, { at: now.toISOString(), actor, shotId: null, action: 'project.plate_colour', detail: `EXR plates: ${label(before)} → ${label(value)}` }) };
}

/** Record plates that were written, with exactly what was applied to them. Replaces a record of the same version. */
export function recordPlates(p: Project, shotId: string, record: PlateRecordInput, actor: string, now: Date): Result {
  const at = now.toISOString();
  const parsed = PlateRecordSchema.safeParse({ ...record, writtenAt: at, by: actor });
  if (!parsed.success) return { ok: false, reason: `The plate record for ${shotId} is not usable: ${parsed.error.issues[0]?.message ?? 'bad data'}` };
  const rec = parsed.data;
  const r = updateShot(p, shotId, (s) => (s.stage !== 'prep' ? `${shotId} is ${s.stage}` : { ...s, plates: [...s.plates.filter((x) => x.version !== rec.version), rec].sort((a, b) => a.version - b.version) }));
  const detail = [`${rec.pattern}: ${rec.frames} frames ${rec.firstFrame}–${rec.lastFrame}`, rec.color.summary, rec.color.transform, `ffmpeg -vf ${rec.color.filter}`].filter(Boolean).join(' · ');
  return chain(r, (proj) => log(proj, { at, actor, shotId, action: 'plates.written', detail }));
}

/**
 * Mark a frame as needing correction, or clear its mark. Each mark carries a
 * note and who made it; both acts are logged. Groundwork for roto review.
 */
export function toggleReviewMark(p: Project, shotId: string, mark: { frame: number; viewing: string; note?: string }, actor: string, now: Date): Result {
  const at = now.toISOString();
  let removed = false;
  const r = updateShot(p, shotId, (s) => {
    if (s.stage !== 'prep') return `${shotId} is ${s.stage}; reopen it to mark frames`;
    if (!Number.isInteger(mark.frame) || mark.frame < 0) return 'Not a frame number';
    removed = s.reviewMarks.some((m) => m.frame === mark.frame);
    const marks = removed
      ? s.reviewMarks.filter((m) => m.frame !== mark.frame)
      : [...s.reviewMarks, { frame: mark.frame, viewing: mark.viewing, note: mark.note?.trim() ?? '', by: actor, at }].sort((a, b) => a.frame - b.frame);
    return { ...s, reviewMarks: marks };
  });
  return chain(r, (proj) =>
    log(proj, { at, actor, shotId, action: removed ? 'review.unmarked' : 'review.marked', detail: `frame ${mark.frame} (${mark.viewing})${!removed && mark.note?.trim() ? `: ${mark.note.trim()}` : ''}` }),
  );
}

/**
 * Frames for a contact sheet (§5.2, §15.4): the first and last, and `count`
 * more spread evenly between them. Sorted, no repeats.
 */
export function contactSheetFrames(first: number, last: number, count = 12): number[] {
  if (last < first) return [];
  const frames = new Set<number>([first, last]);
  for (let i = 1; i <= count; i += 1) frames.add(Math.round(first + ((last - first) * i) / (count + 1)));
  return [...frames].sort((a, b) => a - b);
}

const VFX_SHOT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/**
 * Assign (or clear, with "") the VFX editor's shot number. It must be unique
 * in the project, and is fixed once work has been written under the old name:
 * any task past pending, or a package.
 */
export function setVfxShotId(p: Project, shotId: string, vfxShotId: string, actor: string, now: Date): Result {
  const next = vfxShotId.trim() || null;
  if (next && !VFX_SHOT_ID.test(next)) return { ok: false, reason: 'A VFX shot number is letters, digits, “_”, “-” or “.”, up to 64 characters' };
  if (next && p.shots.some((s) => s.shotId !== shotId && (s.vfxShotId ?? s.shotId) === next)) return { ok: false, reason: `Another shot is already ${next}` };
  if (shotState(p, shotId)?.vfxShotId === next) return { ok: true, project: p };
  let before = '';
  const r = updateShot(p, shotId, (s) => {
    if (s.packageVersion > 0) return `${shotId} has been packaged under ${s.vfxShotId ?? shotId}; its number can no longer change`;
    if (s.tasks.some((t) => t.state !== 'pending' || t.version > 1)) return `Work on ${shotId} has started under ${s.vfxShotId ?? shotId}; its number can no longer change`;
    before = s.vfxShotId ?? '';
    return { ...s, vfxShotId: next };
  });
  return chain(r, (proj) => log(proj, { at: now.toISOString(), actor, shotId, action: 'shot.vfx_id', detail: `${before || '(none)'} → ${next ?? '(none)'}` }));
}

/**
 * Add one task to several shots. Shots that already have it, or are past
 * prep, are skipped and reported rather than failing the rest.
 */
export function addTaskToShots(
  p: Project,
  shotIds: readonly string[],
  kind: PrepTaskKind,
  actor: string,
  now: Date,
): { project: Project; added: string[]; skipped: { shotId: string; reason: string }[] } {
  let project = p;
  const added: string[] = [];
  const skipped: { shotId: string; reason: string }[] = [];
  for (const shotId of shotIds) {
    const r = addTask(project, shotId, kind, actor, now);
    if (r.ok) {
      project = r.project;
      added.push(shotId);
    } else skipped.push({ shotId, reason: r.reason });
  }
  return { project, added, skipped };
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

export interface QueueFilter {
  statuses?: readonly ShotStatus[];
  scene?: string;
  circledOnly?: boolean;
  task?: PrepTaskKind;
  search?: string;
}

export interface QueueRow {
  shot: HandoffShot;
  state: ShotState;
  status: ShotStatus;
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** The interactive queue (§3), sorted by scene then shot. */
export function queueRows(p: Project, filter: QueueFilter = {}): QueueRow[] {
  const needle = filter.search?.trim().toLowerCase();
  return p.handoff.shots
    .map((shot) => {
      const state = shotState(p, shot.shotId)!;
      return { shot, state, status: shotStatus(state) };
    })
    .filter((r) => !filter.statuses?.length || filter.statuses.includes(r.status))
    .filter((r) => !filter.scene || r.shot.scene === filter.scene)
    .filter((r) => !filter.circledOnly || r.shot.circled)
    .filter((r) => !filter.task || r.state.tasks.some((t) => t.kind === filter.task))
    .filter(
      (r) =>
        !needle ||
        [r.shot.shotId, r.state.vfxShotId, r.shot.scene, r.shot.setup, r.shot.take, r.shot.clip, r.shot.supervisorNotes, r.state.notes]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(needle)),
    )
    .sort((a, b) => collator.compare(a.shot.scene, b.shot.scene) || collator.compare(a.state.vfxShotId ?? a.shot.shotId, b.state.vfxShotId ?? b.shot.shotId));
}

export function scenesOf(p: Project): string[] {
  return [...new Set(p.handoff.shots.map((s) => s.scene))].sort(collator.compare);
}

export function statusCounts(p: Project): Record<ShotStatus, number> {
  const counts = Object.fromEntries(SHOT_STATUSES.map((s) => [s, 0])) as Record<ShotStatus, number>;
  for (const s of p.shots) counts[shotStatus(s)] += 1;
  return counts;
}
