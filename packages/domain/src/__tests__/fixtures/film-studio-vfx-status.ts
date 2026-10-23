// @ts-nocheck — Film Studio compiles without noUncheckedIndexedAccess; checked there, not here.
/*
 * VENDORED, TEST-ONLY. A verbatim copy of VC Film Studio's reader for the
 * VFX status report, so a drift between what VC VFX writes and what Film
 * Studio accepts fails CI here (addendum 19).
 *
 *   source: github.com/kshank999-wq/VC_Film_Studio, lib/vfx-status.ts
 *   branch: main at f58a891 (readyFor: where each shot goes once it is ready)
 *
 * Do not edit by hand: when Film Studio changes its reader, copy it again and
 * update the commit above. The demo reports beside it
 * (film-studio-vc-vfx-status*.json) are Film Studio's tools/fixtures from the
 * same commit.
 */

/**
 * The VFX status report from VC VFX, the desktop app that prepares shots for
 * a visual effects company: what has been processed, what has not, what is
 * ready to hand out, and what is working and what is not.
 *
 * VC VFX writes 'vc-film-studio.vfx-status/1' (docs/VFX_STATUS.md is the
 * contract, field by field) and either sends it with an upload key or the
 * data desk imports the file. This module reads it, says whether each shot is
 * ready to hand off, sorts the shots into the sections the printed log uses,
 * and works out what changed since the report before. It touches no database.
 *
 * ---------------------------------------------------------------------------
 * STRICT ABOUT WHAT IT KNOWS, QUIET ABOUT WHAT IT DOES NOT
 *
 * Every field the contract names is checked, and a report that gets one wrong
 * is refused with the path to the field — a status board built on a
 * half-read report would say a shot is ready when nobody knows that. A field
 * the contract does NOT name is left alone and kept: the whole report is
 * stored as it came, so a newer VC VFX that adds something never breaks an
 * older Film Studio. The same stance as VC VFX's own handoff parser.
 *
 * Task kinds are the one open list: VC VFX grows new prep operations, and a
 * kind this file has never heard of arrives with its own label and is shown
 * by it. Shot status keys and task states are closed — a new one is a new
 * version of the format, because the readiness rule is built on them.
 *
 * ---------------------------------------------------------------------------
 * READY TO HAND OFF, EXACTLY
 *
 * A shot is ready to hand off when ALL of these hold:
 *   · the shot itself is approved (a named person, VC VFX's shot approval);
 *   · it is packaged, and VC VFX still says packaged — a shot reopened after
 *     packaging goes back to prep, and its package is then out of date;
 *   · every task on it is approved, and none needs correction;
 *   · where the package records the task versions it was made from, every
 *     task is still at that version;
 *   · it has not been delivered yet. A delivered shot has been handed off and
 *     is counted as delivered, not as ready.
 *
 * Film Studio works this out from the shot's own fields and never takes the
 * report's word for it: VC VFX's summary count is compared, not copied.
 *
 * Pure.
 */

export const VFX_STATUS_FORMAT = 'vc-film-studio.vfx-status/1';
/** A report is tens of kilobytes; a few thousand shots with problems is a few megabytes. */
export const MAX_STATUS_BYTES = 10 * 1024 * 1024;
export const MAX_SHOTS = 5000;

/* ------------------------------------------------------ the vocabulary --- */

/** VC VFX's shot status (its status.ts), in its order. Closed. */
export const SHOT_STATUSES = [
  'not_started', 'ready_for_prep', 'processing', 'needs_review',
  'needs_correction', 'prep_approved', 'packaged', 'delivered',
] as const;
export type ShotStatusKey = (typeof SHOT_STATUSES)[number];

export const SHOT_STATUS_LABELS: Record<ShotStatusKey, string> = {
  not_started: 'Not Started',
  ready_for_prep: 'Ready for Prep',
  processing: 'Processing',
  needs_review: 'Needs Review',
  needs_correction: 'Needs Correction',
  prep_approved: 'Prep Approved',
  packaged: 'Packaged',
  delivered: 'Delivered',
};

/** VC VFX's per-task state (its tasks.ts). Closed. */
export const TASK_STATES = ['pending', 'processing', 'needs_review', 'needs_correction', 'approved'] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TASK_STATE_LABELS: Record<TaskState, string> = {
  pending: 'Pending',
  processing: 'Processing',
  needs_review: 'Needs Review',
  needs_correction: 'Needs Correction',
  approved: 'Approved',
};

/**
 * The prep operations VC VFX knows today, in its order (the order tasks are
 * shown and run in), with the short name its printed shot list uses. Open: a
 * kind not listed here is shown by the label the report gives it, after these.
 */
export const TASK_KINDS: { key: string; short: string }[] = [
  { key: 'sequence_conversion', short: 'Plates' },
  { key: 'roto', short: 'Roto' },
  { key: 'key', short: 'Key' },
  { key: 'despill', short: 'Despill' },
  { key: 'clean_plate', short: 'Clean plate' },
  { key: 'track_2d', short: '2D track' },
  { key: 'camera_track', short: 'Camera track' },
  { key: 'sky_replacement', short: 'Sky' },
  { key: 'background_removal', short: 'BG removal' },
  { key: 'texture_extraction', short: 'Textures' },
  { key: 'lighting_analysis', short: 'Lighting' },
  { key: 'composite', short: 'Comp' },
];
const KIND_ORDER = new Map(TASK_KINDS.map((k, i) => [k.key, i]));

/** "Roto", or the report's own label for a kind this file does not know. */
export const taskShort = (t: Pick<VfxTask, 'kind' | 'label'>): string =>
  TASK_KINDS.find((k) => k.key === t.kind)?.short ?? t.label;

/** Known kinds in VC VFX's order, then the rest alphabetically. */
export function sortKinds(kinds: Iterable<string>): string[] {
  return [...new Set(kinds)].sort((a, b) =>
    (KIND_ORDER.get(a) ?? 99) - (KIND_ORDER.get(b) ?? 99) || a.localeCompare(b));
}

export const SEVERITIES = ['info', 'warn', 'error'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const SOURCE_CHECKS = ['unchecked', 'verified', 'mismatch', 'missing'] as const;
export type SourceCheck = (typeof SOURCE_CHECKS)[number];
/** Where the operator says a shot goes once it is ready: a VFX company by name, or the software it is opened in (Nuke…). */
export const READY_FOR_KINDS = ['vendor', 'software'] as const;
export type ReadyForKind = (typeof READY_FOR_KINDS)[number];
export type ReadyFor = { kind: ReadyForKind; name: string };

/** "Framestore (VFX company)", "Nuke (software)". */
export const readyForText = (rf: ReadyFor) => `${rf.name} (${rf.kind === 'vendor' ? 'VFX company' : 'software'})`;

/* ------------------------------------------------------------ the shape --- */

export type Approval = { by: string; at: string };

export type Confidence = {
  frames: number;
  mean: number;
  min: number;
  low: number | null;
  flagged: number | null;
  reviewed: number | null;
};

export type VfxTask = {
  kind: string;
  label: string;
  state: TaskState;
  version: number;
  approval: Approval | null;
  notes: string;
  confidence: Confidence | null;
  problems: number;
  exported: boolean;
  exportVersion: number | null;
};

export type Problem = { task: string | null; severity: Severity; text: string; frames: number[] };

export type VfxShot = {
  handoffShotId: string;
  vfxShotId: string | null;
  scene: string;
  setup: string | null;
  take: string | null;
  circled: boolean;
  cameraRoll: string | null;
  clip: string | null;
  unit: string | null;
  shootDay: string | null;
  shootDate: string | null;
  frames: { in: number; out: number; handles: number; count: number; rangeFrom: 'handoff' | 'probe' | null } | null;
  frameRate: number | null;
  timecodeIn: string | null;
  timecodeOut: string | null;
  camera: { body: string | null; lens: string | null; focalLengthMm: number | null } | null;
  pixelAspect: number | null;
  status: { key: ShotStatusKey; label: string };
  source: { verified: SourceCheck; at: string | null };
  plates: { version: number; frames: number; format: string; bitDepth: number | null; colour: string; writtenAt: string | null } | null;
  tasks: VfxTask[];
  approval: Approval | null;
  packaged: { version: number; at: string; folder: string | null; taskVersions: Record<string, number> | null } | null;
  delivered: { at: string; to: string | null } | null;
  /** Where it goes when ready, as the VC VFX operator picked for this shot; null when not said (or a VC VFX before it). */
  readyFor: ReadyFor | null;
  problems: Problem[];
  supervisorNotes: string | null;
  notes: string | null;
};

export type VfxStatusDoc = {
  generatedAt: string;
  generator: { app: string; version: string };
  operator: string | null;
  project: {
    name: string;
    productionCompany: string | null;
    origin: { format: string | null; tool: string | null; productionCode: string | null; dayNumber: number | null; dayDate: string | null } | null;
  };
  /** Which Film Studio production VC VFX was told this is for, when it was told. */
  filmStudio: { production: string | null; productionId: string | null } | null;
  shots: VfxShot[];
  /** What VC VFX counted. Compared with Film Studio's own count, never used in its place. */
  claimed: { readyToHandOff: number | null } | null;
  /** The whole report, unknown fields and all, kept as it came. */
  raw: Record<string, unknown>;
};

/* ------------------------------------------------------------ reading it --- */

type Issues = string[];
const MAX_ISSUES = 12;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const show = (v: unknown) => {
  if (v === undefined) return 'missing';
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 40 ? `${s.slice(0, 40)}…` : s;
};

/**
 * A small reader that collects what is wrong with the path to it, rather
 * than stopping at the first thing — a report with three bad fields should
 * say so once, not over three exports.
 */
class Reader {
  issues: Issues = [];
  bad(path: string, what: string, v: unknown) {
    if (this.issues.length < MAX_ISSUES) this.issues.push(`${path} should be ${what} (it is ${show(v)})`);
  }
  str(o: Record<string, unknown>, k: string, path: string, opts: { max?: number; required?: boolean } = {}): string | null {
    const v = o[k];
    if (v === undefined || v === null) {
      if (opts.required) this.bad(`${path}.${k}`, 'text', v);
      return null;
    }
    if (typeof v !== 'string') { this.bad(`${path}.${k}`, 'text', v); return null; }
    const s = v.trim();
    if (!s) { if (opts.required) this.bad(`${path}.${k}`, 'text that is not blank', v); return null; }
    if (opts.max && s.length > opts.max) { this.bad(`${path}.${k}`, `at most ${opts.max} characters`, v); return null; }
    return s;
  }
  int(o: Record<string, unknown>, k: string, path: string, opts: { min?: number; required?: boolean } = {}): number | null {
    const v = o[k];
    if (v === undefined || v === null) {
      if (opts.required) this.bad(`${path}.${k}`, 'a whole number', v);
      return null;
    }
    const min = opts.min ?? 0;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min) {
      this.bad(`${path}.${k}`, `a whole number of at least ${min}`, v);
      return null;
    }
    return v;
  }
  num(o: Record<string, unknown>, k: string, path: string, lo: number, hi: number): number | null {
    const v = o[k];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) {
      this.bad(`${path}.${k}`, `a number from ${lo} to ${hi}`, v);
      return null;
    }
    return v;
  }
  bool(o: Record<string, unknown>, k: string, path: string, fallback: boolean): boolean {
    const v = o[k];
    if (v === undefined || v === null) return fallback;
    if (typeof v !== 'boolean') { this.bad(`${path}.${k}`, 'true or false', v); return fallback; }
    return v;
  }
  instant(o: Record<string, unknown>, k: string, path: string, required = false): string | null {
    const v = o[k];
    if (v === undefined || v === null) {
      if (required) this.bad(`${path}.${k}`, 'a date and time (ISO 8601)', v);
      return null;
    }
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) || Number.isNaN(Date.parse(v))) {
      this.bad(`${path}.${k}`, 'a date and time (ISO 8601)', v);
      return null;
    }
    return new Date(v).toISOString();
  }
  date(o: Record<string, unknown>, k: string, path: string): string | null {
    const v = o[k];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
      this.bad(`${path}.${k}`, 'a date, YYYY-MM-DD', v);
      return null;
    }
    return v;
  }
  timecode(o: Record<string, unknown>, k: string, path: string): string | null {
    const v = o[k];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string' || !/^\d{2}:\d{2}:\d{2}[:;]\d{2}$/.test(v)) {
      this.bad(`${path}.${k}`, 'a timecode, HH:MM:SS:FF', v);
      return null;
    }
    return v;
  }
  oneOf<T extends string>(o: Record<string, unknown>, k: string, path: string, list: readonly T[], fallback: T | null): T | null {
    const v = o[k];
    if ((v === undefined || v === null) && fallback !== null) return fallback;
    if (typeof v !== 'string' || !list.includes(v as T)) {
      this.bad(`${path}.${k}`, `one of ${list.join(', ')}`, v);
      return null;
    }
    return v as T;
  }
  /** An object, null, or absent (both of the latter are null). */
  obj(o: Record<string, unknown>, k: string, path: string, required = false): Record<string, unknown> | null {
    const v = o[k];
    if (v === undefined || v === null) {
      if (required) this.bad(`${path}.${k}`, 'an object', v);
      return null;
    }
    if (!isObj(v)) { this.bad(`${path}.${k}`, 'an object', v); return null; }
    return v;
  }
  approval(o: Record<string, unknown>, k: string, path: string): Approval | null {
    const a = this.obj(o, k, path);
    if (!a) return null;
    const by = this.str(a, 'by', `${path}.${k}`, { required: true, max: 120 });
    const at = this.instant(a, 'at', `${path}.${k}`, true);
    return by && at ? { by, at } : null;
  }
}

const KIND_RE = /^[a-z][a-z0-9_]{0,39}$/;

function readTask(r: Reader, t: unknown, path: string): VfxTask | null {
  if (!isObj(t)) { r.bad(path, 'an object', t); return null; }
  const kind = r.str(t, 'kind', path, { required: true, max: 40 });
  if (kind && !KIND_RE.test(kind)) r.bad(`${path}.kind`, 'a task kind like "roto" (lower case, letters, digits and _)', kind);
  const label = r.str(t, 'label', path, { required: true, max: 80 });
  const state = r.oneOf(t, 'state', path, TASK_STATES, null);
  const version = r.int(t, 'version', path, { min: 1, required: true });
  let approval = r.approval(t, 'approval', path);
  /* Approval and state travel together in VC VFX: approving sets both, and
     any change of state clears the approval. An approved task with nobody
     named is refused — "approved" with no one behind it is exactly the claim
     this board must not repeat. An approval left on a task that is no longer
     approved is stale, and dropped. */
  if (state === 'approved' && !approval && !isObj(t.approval)) {
    r.bad(`${path}.approval`, 'who approved it and when — an approved task needs both', t.approval);
  }
  if (state && state !== 'approved') approval = null;
  let confidence: Confidence | null = null;
  const c = r.obj(t, 'confidence', path);
  if (c) {
    const frames = r.int(c, 'frames', `${path}.confidence`, { required: true });
    const mean = r.num(c, 'mean', `${path}.confidence`, 0, 1);
    const min = r.num(c, 'min', `${path}.confidence`, 0, 1);
    if (mean === null) r.bad(`${path}.confidence.mean`, 'a number from 0 to 1', c.mean);
    if (min === null) r.bad(`${path}.confidence.min`, 'a number from 0 to 1', c.min);
    if (frames !== null && mean !== null && min !== null) {
      confidence = {
        frames, mean, min,
        low: r.int(c, 'low', `${path}.confidence`),
        flagged: r.int(c, 'flagged', `${path}.confidence`),
        reviewed: r.int(c, 'reviewed', `${path}.confidence`),
      };
    }
  }
  const notes = r.str(t, 'notes', path, { max: 4000 }) ?? '';
  const problems = r.int(t, 'problems', path) ?? 0;
  const exported = r.bool(t, 'exported', path, false);
  const exportVersion = r.int(t, 'exportVersion', path, { min: 1 });
  if (!kind || !label || !state || version === null) return null;
  return { kind, label, state, version, approval, notes, confidence, problems, exported, exportVersion };
}

function readShot(r: Reader, s: unknown, path: string): VfxShot | null {
  if (!isObj(s)) { r.bad(path, 'an object', s); return null; }
  const handoffShotId = r.str(s, 'handoffShotId', path, { required: true, max: 80 });
  const scene = r.str(s, 'scene', path, { required: true, max: 40 });

  const st = r.obj(s, 'status', path, true);
  const statusKey = st ? r.oneOf(st, 'key', `${path}.status`, SHOT_STATUSES, null) : null;
  const statusLabel = st ? r.str(st, 'label', `${path}.status`, { max: 60 }) : null;

  const src = r.obj(s, 'source', path);
  const source = {
    verified: (src ? r.oneOf(src, 'verified', `${path}.source`, SOURCE_CHECKS, 'unchecked') : 'unchecked') ?? 'unchecked',
    at: src ? r.instant(src, 'at', `${path}.source`) : null,
  };

  const f = r.obj(s, 'frames', path);
  let frames: VfxShot['frames'] = null;
  if (f) {
    const fin = r.int(f, 'in', `${path}.frames`, { required: true });
    const fout = r.int(f, 'out', `${path}.frames`, { required: true });
    const handles = r.int(f, 'handles', `${path}.frames`) ?? 0;
    const count = r.int(f, 'count', `${path}.frames`);
    const rangeFrom = f.rangeFrom === undefined || f.rangeFrom === null ? null
      : r.oneOf(f, 'rangeFrom', `${path}.frames`, ['handoff', 'probe'] as const, null);
    if (fin !== null && fout !== null && fout < fin) r.bad(`${path}.frames.out`, `not before frames.in (${fin})`, fout);
    if (fin !== null && fout !== null && fout >= fin) {
      frames = { in: fin, out: fout, handles, count: count ?? fout - fin + 1, rangeFrom };
    }
  }

  const cam = r.obj(s, 'camera', path);
  const camera = cam ? {
    body: r.str(cam, 'body', `${path}.camera`, { max: 80 }),
    lens: r.str(cam, 'lens', `${path}.camera`, { max: 80 }),
    focalLengthMm: r.num(cam, 'focalLengthMm', `${path}.camera`, 1, 2000),
  } : null;

  const p = r.obj(s, 'plates', path);
  let plates: VfxShot['plates'] = null;
  if (p) {
    const version = r.int(p, 'version', `${path}.plates`, { min: 1, required: true });
    const pframes = r.int(p, 'frames', `${path}.plates`, { required: true });
    const format = r.str(p, 'format', `${path}.plates`, { required: true, max: 20 });
    const colour = r.str(p, 'colour', `${path}.plates`, { max: 300 }) ?? '';
    if (version !== null && pframes !== null && format) {
      plates = {
        version, frames: pframes, format,
        bitDepth: r.int(p, 'bitDepth', `${path}.plates`, { min: 1 }),
        colour, writtenAt: r.instant(p, 'writtenAt', `${path}.plates`),
      };
    }
  }

  const tasks: VfxTask[] = [];
  if (s.tasks !== undefined && s.tasks !== null && !Array.isArray(s.tasks)) r.bad(`${path}.tasks`, 'a list', s.tasks);
  const rawTasks = Array.isArray(s.tasks) ? s.tasks : [];
  if (rawTasks.length > 32) r.bad(`${path}.tasks`, 'at most 32 tasks', `${rawTasks.length} tasks`);
  rawTasks.slice(0, 32).forEach((t, i) => {
    const task = readTask(r, t, `${path}.tasks[${i}]`);
    if (!task) return;
    if (tasks.some((x) => x.kind === task.kind)) r.bad(`${path}.tasks[${i}].kind`, 'a kind not already on this shot', task.kind);
    else tasks.push(task);
  });

  const pk = r.obj(s, 'packaged', path);
  let packaged: VfxShot['packaged'] = null;
  if (pk) {
    const version = r.int(pk, 'version', `${path}.packaged`, { min: 1, required: true });
    const at = r.instant(pk, 'at', `${path}.packaged`, true);
    let taskVersions: Record<string, number> | null = null;
    const tv = r.obj(pk, 'taskVersions', `${path}.packaged`);
    if (tv) {
      taskVersions = {};
      for (const [k, v] of Object.entries(tv)) {
        if (typeof v === 'number' && Number.isInteger(v) && v >= 1) taskVersions[k] = v;
        else r.bad(`${path}.packaged.taskVersions.${k}`, 'a version number of at least 1', v);
      }
    }
    if (version !== null && at) packaged = { version, at, folder: r.str(pk, 'folder', `${path}.packaged`, { max: 500 }), taskVersions };
  }

  const dv = r.obj(s, 'delivered', path);
  let delivered: VfxShot['delivered'] = null;
  if (dv) {
    const at = r.instant(dv, 'at', `${path}.delivered`, true);
    if (at) delivered = { at, to: r.str(dv, 'to', `${path}.delivered`, { max: 200 }) };
  }

  const rf = r.obj(s, 'readyFor', path);
  let readyFor: ReadyFor | null = null;
  if (rf) {
    const kind = r.oneOf(rf, 'kind', `${path}.readyFor`, READY_FOR_KINDS, null);
    const forName = r.str(rf, 'name', `${path}.readyFor`, { required: true, max: 120 });
    if (kind && forName) readyFor = { kind, name: forName };
  }

  const problems: Problem[] = [];
  if (s.problems !== undefined && s.problems !== null && !Array.isArray(s.problems)) r.bad(`${path}.problems`, 'a list', s.problems);
  (Array.isArray(s.problems) ? s.problems : []).slice(0, 500).forEach((x, i) => {
    const pp = `${path}.problems[${i}]`;
    if (!isObj(x)) { r.bad(pp, 'an object', x); return; }
    const severity = r.oneOf(x, 'severity', pp, SEVERITIES, null);
    const text = r.str(x, 'text', pp, { required: true, max: 2000 });
    const task = r.str(x, 'task', pp, { max: 40 });
    let fr: number[] = [];
    if (x.frames !== undefined && x.frames !== null) {
      if (!Array.isArray(x.frames) || x.frames.some((n) => typeof n !== 'number' || !Number.isInteger(n) || n < 0)) {
        r.bad(`${pp}.frames`, 'a list of frame numbers', x.frames);
      } else fr = (x.frames as number[]).slice(0, 10000);
    }
    if (severity && text) problems.push({ task, severity, text, frames: fr });
  });

  if (!handoffShotId || !scene || !statusKey) return null;
  return {
    handoffShotId,
    vfxShotId: r.str(s, 'vfxShotId', path, { max: 80 }),
    scene,
    setup: r.str(s, 'setup', path, { max: 20 }),
    take: r.str(s, 'take', path, { max: 20 }),
    circled: r.bool(s, 'circled', path, false),
    cameraRoll: r.str(s, 'cameraRoll', path, { max: 40 }),
    clip: r.str(s, 'clip', path, { max: 80 }),
    unit: r.str(s, 'unit', path, { max: 40 }),
    shootDay: r.str(s, 'shootDay', path, { max: 60 }),
    shootDate: r.date(s, 'shootDate', path),
    frames,
    frameRate: r.num(s, 'frameRate', path, 1, 1000),
    timecodeIn: r.timecode(s, 'timecodeIn', path),
    timecodeOut: r.timecode(s, 'timecodeOut', path),
    camera,
    pixelAspect: r.num(s, 'pixelAspect', path, 0.25, 4),
    status: { key: statusKey, label: statusLabel ?? SHOT_STATUS_LABELS[statusKey] },
    source,
    plates,
    tasks: tasks.sort((a, b) => (KIND_ORDER.get(a.kind) ?? 99) - (KIND_ORDER.get(b.kind) ?? 99) || a.kind.localeCompare(b.kind)),
    approval: r.approval(s, 'approval', path),
    packaged,
    delivered,
    readyFor,
    problems,
    supervisorNotes: r.str(s, 'supervisorNotes', path, { max: 4000 }),
    notes: r.str(s, 'notes', path, { max: 4000 }),
  };
}

/**
 * A shot as stored (vfx_shot.data), read back through the same checks.
 *
 * What is stored was written by this module — but the upload function takes
 * the plan from whoever holds a key, and a page must not trust a shape it
 * did not check. A stored shot that no longer reads is shown as unreadable
 * rather than taking the board down with it.
 */
export function readStoredShot(v: unknown): VfxShot | null {
  const r = new Reader();
  const s = readShot(r, v, 'shot');
  return r.issues.length ? null : s;
}

const AGAIN = ' Export it again from VC VFX; if it happens again, send the file to whoever looks after VC VFX.';

/**
 * The report, checked. Refuses what is not a VC VFX status report at all, and
 * a report with any field the contract names in the wrong shape — saying
 * which, so the person at the desk can pass it on.
 */
export function readVfxStatus(text: string): { ok: true; doc: VfxStatusDoc } | { ok: false; why: string; issues: string[] } {
  if (text.length > MAX_STATUS_BYTES) {
    return { ok: false, why: 'That is far too large to be a VFX status report from VC VFX.', issues: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, why: 'That is not a VFX status report: it is not JSON. In VC VFX use Reports → Send to VC Film Studio, or Export status for VC Film Studio.', issues: [] };
  }
  if (!isObj(parsed)) return { ok: false, why: 'That is not a VFX status report from VC VFX.', issues: [] };
  const root = parsed;
  if (root.format !== VFX_STATUS_FORMAT) {
    return {
      ok: false,
      issues: [],
      why: typeof root.format === 'string' && root.format.startsWith('vc-film-studio.vfx-status/')
        ? 'This report is from a newer VC VFX than this Film Studio understands. Nothing was changed — Film Studio will be updated to read it; until then keep working from VC VFX’s own report.'
        : 'That is not a VFX status report from VC VFX. In VC VFX use Reports → Export status for VC Film Studio.',
    };
  }

  const r = new Reader();
  const generatedAt = r.instant(root, 'generatedAt', 'report', true);
  const gen = r.obj(root, 'generator', 'report', true);
  const app = gen ? r.str(gen, 'app', 'report.generator', { required: true, max: 40 }) : null;
  const version = gen ? r.str(gen, 'version', 'report.generator', { required: true, max: 20 }) : null;
  const operator = r.str(root, 'operator', 'report', { max: 120 });
  const proj = r.obj(root, 'project', 'report', true);
  const name = proj ? r.str(proj, 'name', 'report.project', { required: true, max: 200 }) : null;
  const org = proj ? r.obj(proj, 'origin', 'report.project') : null;
  const day = org ? r.obj(org, 'day', 'report.project.origin') : null;
  const fs = r.obj(root, 'filmStudio', 'report');

  if (!Array.isArray(root.shots)) r.bad('report.shots', 'a list of shots', root.shots);
  const rawShots = Array.isArray(root.shots) ? root.shots : [];
  if (Array.isArray(root.shots) && rawShots.length === 0) r.bad('report.shots', 'at least one shot', 'an empty list');
  if (rawShots.length > MAX_SHOTS) r.bad('report.shots', `at most ${MAX_SHOTS} shots`, `${rawShots.length} shots`);
  const shots: VfxShot[] = [];
  const seen = new Set<string>();
  rawShots.slice(0, MAX_SHOTS).forEach((s, i) => {
    const shot = readShot(r, s, `shots[${i}]`);
    if (!shot) return;
    if (seen.has(shot.handoffShotId)) r.bad(`shots[${i}].handoffShotId`, 'unique in the report', shot.handoffShotId);
    seen.add(shot.handoffShotId);
    shots.push(shot);
  });

  const sum = r.obj(root, 'summary', 'report');
  const claimedReady = sum ? r.int(sum, 'readyToHandOff', 'report.summary') : null;
  const productionCompany = proj ? r.str(proj, 'productionCompany', 'report.project', { max: 200 }) : null;
  const origin = org ? {
    format: r.str(org, 'format', 'report.project.origin', { max: 80 }),
    tool: r.str(org, 'tool', 'report.project.origin', { max: 80 }),
    productionCode: r.str(org, 'productionCode', 'report.project.origin', { max: 40 }),
    dayNumber: day ? r.int(day, 'number', 'report.project.origin.day') : null,
    dayDate: day ? r.date(day, 'date', 'report.project.origin.day') : null,
  } : null;
  const filmStudio = fs ? {
    production: r.str(fs, 'production', 'report.filmStudio', { max: 200 }),
    productionId: r.str(fs, 'productionId', 'report.filmStudio', { max: 60 }),
  } : null;

  if (r.issues.length) {
    const more = r.issues.length >= MAX_ISSUES ? ' (and more)' : '';
    return {
      ok: false,
      issues: r.issues,
      why: `This VFX status report could not be read: ${r.issues[0]}${r.issues.length > 1 ? `, and ${r.issues.length - 1} other field${r.issues.length > 2 ? 's' : ''}${more}` : ''}. Nothing was changed.${AGAIN}`,
    };
  }

  return {
    ok: true,
    doc: {
      generatedAt: generatedAt!,
      generator: { app: app!, version: version! },
      operator,
      project: { name: name!, productionCompany, origin },
      filmStudio,
      shots,
      claimed: sum ? { readyToHandOff: claimedReady } : null,
      raw: root,
    },
  };
}

/* ----------------------------------------------------------- readiness --- */

/** The sections of the board and the printed log, in the order they print. */
export const BUCKETS = ['ready', 'review', 'correction', 'progress', 'not_started', 'delivered'] as const;
export type Bucket = (typeof BUCKETS)[number];

export const BUCKET_TITLES: Record<Bucket, string> = {
  ready: 'Ready to hand off',
  review: 'In review',
  correction: 'Needs correction',
  progress: 'In progress',
  not_started: 'Not started',
  delivered: 'Delivered',
};

export type Readiness = {
  ready: boolean;
  delivered: boolean;
  bucket: Bucket;
  /** What stands between the shot and the vendor, in words; empty when ready or delivered. */
  why: string[];
};

const vtag = (n: number) => `v${String(n).padStart(3, '0')}`;

/** "Key", "Key and Despill", "Plates, Roto and Sky". */
export function listWords(names: string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

const STATE_VERB: Record<Exclude<TaskState, 'approved'>, [string, string]> = {
  needs_correction: ['needs correction', 'need correction'],
  needs_review: ['needs review', 'need review'],
  processing: ['is being worked on', 'are being worked on'],
  pending: ['not started', 'not started'],
};

/** See the header for the rule, word for word. */
export function readiness(s: VfxShot): Readiness {
  const delivered = s.status.key === 'delivered' || s.delivered !== null;
  if (delivered) return { ready: false, delivered: true, bucket: 'delivered', why: [] };

  const why: string[] = [];
  const corrections = s.tasks.filter((t) => t.state === 'needs_correction');
  /* Said once per state, worst first — "Key and Despill need review" — and
     the shot-level reasons only once the tasks are all done: "not packaged"
     under three pending tasks is true and tells nobody anything. */
  if (s.tasks.length === 0) why.push('no prep tasks on it yet');
  for (const state of ['needs_correction', 'needs_review', 'processing', 'pending'] as const) {
    const names = s.tasks.filter((t) => t.state === state).map(taskShort);
    if (names.length) why.push(`${listWords(names)} ${STATE_VERB[state][names.length === 1 ? 0 : 1]}`);
  }
  if (why.length === 0) {
    if (!s.approval) why.push('the shot is not approved');
    if (!s.packaged) {
      why.push('not packaged');
    } else if (s.status.key !== 'packaged') {
      why.push(`package ${vtag(s.packaged.version)} is out of date — the shot went back into prep`);
    } else if (s.packaged.taskVersions) {
      for (const t of s.tasks) {
        const at = s.packaged.taskVersions[t.kind];
        if (at === undefined) why.push(`${taskShort(t)} is not in package ${vtag(s.packaged.version)}`);
        else if (at !== t.version) why.push(`packaged with ${taskShort(t)} ${vtag(at)}; it is now ${vtag(t.version)}`);
      }
    }
  } else if (s.packaged && s.status.key !== 'packaged') {
    /* Worth saying even with work open: a package exists and is stale. */
    why.push(`package ${vtag(s.packaged.version)} is out of date — the shot went back into prep`);
  }

  const ready = why.length === 0;
  let bucket: Bucket;
  if (ready) bucket = 'ready';
  else if (corrections.length || s.status.key === 'needs_correction') bucket = 'correction';
  else if (s.status.key === 'needs_review') bucket = 'review';
  else if (s.status.key === 'not_started' || s.status.key === 'ready_for_prep') bucket = 'not_started';
  else bucket = 'progress';
  return { ready, delivered: false, bucket, why };
}

/** The name a shot goes by: its VFX shot number once VC VFX has one, else the handoff's id. */
export const shotName = (s: Pick<VfxShot, 'vfxShotId' | 'handoffShotId'>) => s.vfxShotId ?? s.handoffShotId;

/** "14 / B / 3" — scene, setup, take as the slate had them. */
export const slateOf = (s: Pick<VfxShot, 'scene' | 'setup' | 'take'>) =>
  [s.scene, s.setup, s.take].filter(Boolean).join(' / ');

/** "Roto v002 · Ada Renke 14 Oct" — who approved what, short. */
export const approvalWords = (a: Approval | null) => (a ? `${a.by}, ${a.at.slice(0, 10)}` : null);

/* -------------------------------------------------------------- counting --- */

export type Summary = {
  shots: number;
  ready: number;
  delivered: number;
  review: number;
  correction: number;
  progress: number;
  notStarted: number;
  /** Problems across every shot not yet delivered, by severity. */
  problems: { info: number; warn: number; error: number };
  byStatus: Record<string, number>;
  byTaskState: Record<string, number>;
};

export function summarise(shots: VfxShot[]): Summary {
  const out: Summary = {
    shots: shots.length, ready: 0, delivered: 0, review: 0, correction: 0, progress: 0, notStarted: 0,
    problems: { info: 0, warn: 0, error: 0 },
    byStatus: Object.fromEntries(SHOT_STATUSES.map((k) => [k, 0])),
    byTaskState: Object.fromEntries(TASK_STATES.map((k) => [k, 0])),
  };
  for (const s of shots) {
    const r = readiness(s);
    if (r.bucket === 'ready') out.ready += 1;
    else if (r.bucket === 'delivered') out.delivered += 1;
    else if (r.bucket === 'review') out.review += 1;
    else if (r.bucket === 'correction') out.correction += 1;
    else if (r.bucket === 'progress') out.progress += 1;
    else out.notStarted += 1;
    out.byStatus[s.status.key] = (out.byStatus[s.status.key] ?? 0) + 1;
    for (const t of s.tasks) out.byTaskState[t.state] = (out.byTaskState[t.state] ?? 0) + 1;
    if (!r.delivered) for (const p of s.problems) out.problems[p.severity] += 1;
  }
  return out;
}

export type Tone = 'ok' | 'warn' | 'bad';

/**
 * The sentence at the top of the page: what can go to the vendor, and what
 * is holding the rest. Leads with what is wrong when something is.
 */
export function vfxSays(sum: Summary | null): { tone: Tone; text: string } {
  if (!sum || sum.shots === 0) {
    return { tone: 'warn', text: 'Nothing from VC VFX yet. When VC VFX sends its status, or the data desk imports one, every VFX shot shows here with what is ready to hand off.' };
  }
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts: string[] = [];
  if (sum.correction) parts.push(`${plural(sum.correction, 'shot needs', 'shots need')} correction`);
  if (sum.review) parts.push(`${sum.review} in review`);
  if (sum.progress) parts.push(`${sum.progress} in progress`);
  if (sum.notStarted) parts.push(`${sum.notStarted} not started`);
  const lead = sum.ready
    ? `${plural(sum.ready, 'shot is', 'shots are')} ready to hand off`
    : 'No shot is ready to hand off yet';
  const tail = sum.delivered ? ` ${plural(sum.delivered, 'shot has', 'shots have')} been delivered.` : '';
  if (!parts.length) return { tone: 'ok', text: `${lead}.${tail}` };
  return { tone: sum.correction || sum.problems.error ? 'bad' : 'warn', text: `${lead}; ${parts.join(', ')}.${tail}` };
}

/* --------------------------------------------- since the report before --- */

export type Change = {
  shot: string;
  handoffShotId: string;
  kind: 'ready' | 'delivered' | 'regressed' | 'reopened' | 'problem' | 'added' | 'removed' | 'status';
  text: string;
};

const problemKey = (p: Problem) => `${p.task ?? ''}|${p.severity}|${p.text}`;

/**
 * What changed between two reports, said shot by shot: shots that became
 * ready or were delivered, shots that went backwards, work reopened, new
 * problems, and shots that joined or left the report. Problems are matched
 * on their task, severity and words, so the same problem reported twice is
 * not new.
 */
export function diffReports(before: VfxShot[], after: VfxShot[]): Change[] {
  const was = new Map(before.map((s) => [s.handoffShotId, s]));
  const out: Change[] = [];
  for (const s of after) {
    const name = shotName(s);
    const prev = was.get(s.handoffShotId);
    const now = readiness(s);
    if (!prev) {
      out.push({ shot: name, handoffShotId: s.handoffShotId, kind: 'added', text: `${name} is new in this report — ${s.status.label}.` });
      continue;
    }
    const then = readiness(prev);
    if (now.delivered && !then.delivered) {
      out.push({ shot: name, handoffShotId: s.handoffShotId, kind: 'delivered', text: `${name} was delivered${s.delivered?.to ? ` to ${s.delivered.to}` : ''}.` });
    } else if (now.ready && !then.ready) {
      out.push({ shot: name, handoffShotId: s.handoffShotId, kind: 'ready', text: `${name} became ready to hand off.` });
    } else if ((then.ready || then.delivered) && !now.ready && !now.delivered) {
      out.push({ shot: name, handoffShotId: s.handoffShotId, kind: 'regressed', text: `${name} is no longer ready: ${now.why[0] ?? s.status.label}.` });
    } else if (prev.status.key !== s.status.key) {
      out.push({ shot: name, handoffShotId: s.handoffShotId, kind: 'status', text: `${name}: ${prev.status.label} → ${s.status.label}.` });
    }
    /* Where it goes: a change of company or of software is news to whoever was waiting for it. */
    const goes = (x: VfxShot) => (x.readyFor ? readyForText(x.readyFor) : null);
    if (goes(prev) !== goes(s) && !now.delivered) {
      out.push({ shot: name, handoffShotId: s.handoffShotId, kind: 'status',
        text: s.readyFor ? `${name} is now for ${goes(s)}${prev.readyFor ? `, not ${goes(prev)}` : ''}.` : `${name} no longer says where it goes (was ${goes(prev)}).` });
    }
    for (const t of s.tasks) {
      const pt = prev.tasks.find((x) => x.kind === t.kind);
      if (pt && pt.state === 'approved' && t.state !== 'approved') {
        out.push({ shot: name, handoffShotId: s.handoffShotId, kind: 'reopened',
          text: `${name}: ${taskShort(t)} was approved and is now ${TASK_STATE_LABELS[t.state].toLowerCase()}${t.version > pt.version ? ` (${vtag(pt.version)} → ${vtag(t.version)})` : ''}.` });
      }
    }
    const had = new Set(prev.problems.map(problemKey));
    const fresh = s.problems.filter((p) => !had.has(problemKey(p)));
    if (fresh.length) {
      const worst = fresh.find((p) => p.severity === 'error') ?? fresh.find((p) => p.severity === 'warn') ?? fresh[0];
      out.push({ shot: name, handoffShotId: s.handoffShotId, kind: 'problem',
        text: `${name}: ${fresh.length === 1 ? 'a new problem' : `${fresh.length} new problems`} — ${worst.text}` });
    }
  }
  const still = new Set(after.map((s) => s.handoffShotId));
  for (const s of before) {
    if (!still.has(s.handoffShotId)) {
      out.push({ shot: shotName(s), handoffShotId: s.handoffShotId, kind: 'removed', text: `${shotName(s)} is not in this report any more.` });
    }
  }
  const ORDER: Change['kind'][] = ['regressed', 'reopened', 'problem', 'ready', 'delivered', 'status', 'added', 'removed'];
  return out.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}

/* ------------------------------------------------------------- the table --- */

/** "0.91 mean · 0.62 min · 4 low" — how sure VC VFX was of a task, short. */
export function confidenceWords(c: Confidence | null): string | null {
  if (!c || !c.frames) return null;
  const low = c.low ? ` · ${c.low} low` : '';
  return `${c.mean.toFixed(2)} mean · ${c.min.toFixed(2)} min${low}`;
}

export const CSV_COLUMNS: { key: string; label: string }[] = [
  { key: 'shot', label: 'VFX shot' },
  { key: 'handoff', label: 'Handoff shot' },
  { key: 'scene', label: 'Scene' },
  { key: 'setup', label: 'Setup' },
  { key: 'take', label: 'Take' },
  { key: 'day', label: 'Shoot day' },
  { key: 'status', label: 'Status' },
  { key: 'section', label: 'Section' },
  { key: 'ready', label: 'Ready to hand off' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'approval', label: 'Shot approved' },
  { key: 'package', label: 'Package' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'readyFor', label: 'Ready for' },
  { key: 'problems', label: 'Problems' },
  { key: 'why', label: 'What is holding it' },
];

/** One row per shot, for the CSV and the reports page. */
export function shotRow(s: VfxShot, dayLabel: string | null = null): Record<string, string | number | null> {
  const r = readiness(s);
  return {
    shot: shotName(s),
    handoff: s.handoffShotId,
    scene: s.scene,
    setup: s.setup,
    take: s.take,
    day: dayLabel ?? s.shootDate ?? s.shootDay,
    status: s.status.label,
    section: BUCKET_TITLES[r.bucket],
    ready: r.ready ? 'Yes' : r.delivered ? 'Delivered' : 'No',
    tasks: s.tasks.map((t) => `${taskShort(t)}: ${TASK_STATE_LABELS[t.state]} ${vtag(t.version)}${t.approval ? ` (${t.approval.by})` : ''}`).join('; '),
    approval: approvalWords(s.approval),
    package: s.packaged ? `${vtag(s.packaged.version)} ${s.packaged.at.slice(0, 10)}` : null,
    delivered: s.delivered ? `${s.delivered.at.slice(0, 10)}${s.delivered.to ? ` to ${s.delivered.to}` : ''}` : null,
    readyFor: s.readyFor ? readyForText(s.readyFor) : null,
    problems: s.problems.map((p) => `[${p.severity}] ${p.text}`).join('; ') || null,
    why: r.why.join('; ') || null,
  };
}

/* ------------------------------------------------------ the page's sort --- */

export const SORTS = ['shot', 'scene', 'status', 'problems', 'day'] as const;
export type SortKey = (typeof SORTS)[number];

/** "10" before "9" is wrong for scene numbers: compare the number, then the letters. */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

export function sortShots(shots: VfxShot[], by: SortKey): VfxShot[] {
  const rank = (s: VfxShot) => BUCKETS.indexOf(readiness(s).bucket);
  const severity = (s: VfxShot) => s.problems.filter((p) => p.severity === 'error').length * 1000 + s.problems.length;
  const copy = [...shots];
  copy.sort((a, b) => {
    switch (by) {
      case 'scene': return naturalCompare(slateOf(a), slateOf(b)) || naturalCompare(shotName(a), shotName(b));
      case 'status': return rank(a) - rank(b) || naturalCompare(shotName(a), shotName(b));
      case 'problems': return severity(b) - severity(a) || naturalCompare(shotName(a), shotName(b));
      case 'day': return naturalCompare(a.shootDate ?? a.shootDay ?? '~', b.shootDate ?? b.shootDay ?? '~') || naturalCompare(shotName(a), shotName(b));
      default: return naturalCompare(shotName(a), shotName(b));
    }
  });
  return copy;
}
