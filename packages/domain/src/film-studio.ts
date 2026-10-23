import { versionTag } from './frames.js';
import { outputFor } from './handoff.js';
import { shotFolderSegments } from './package.js';
import { handoffShot, planFor, shotPixelAspect, shotState, shotStatus, shotTiming, type Project, type Result, type ShotState, type TaskRecord } from './project.js';
import { SHOT_STATUSES, SHOT_STATUS_LABELS, type ShotStatus } from './status.js';
import { PREP_TASKS, TASK_STATES, type PrepTaskKind, type TaskState } from './tasks.js';
import { LOW_CONFIDENCE, frameConfidence } from './roto.js';
import { keyConfidenceSummary } from './key.js';
import { cleanPlateConfidenceSummary } from './cleanplate.js';
import { isolateConfidenceSummary } from './isolate.js';
import { activeSolve } from './camtrack.js';
import { compContext, compDoc, validateCompGraph } from './comp.js';

/**
 * The VFX status report for VC Film Studio (addendum 19): what has been
 * processed, what has not, what is ready to hand off to the VFX company, and
 * what is working and what is not — the whole project in one document,
 * `vc-film-studio.vfx-status/1`.
 *
 * VC Film Studio's `docs/VFX_STATUS.md` is the contract, field by field, and
 * its `lib/vfx-status.ts` the reader that enforces it. A vendored copy of that
 * reader runs over this module's output in the tests
 * (`__tests__/fixtures/film-studio-vfx-status.ts`), so a drift between the two
 * fails CI here before Film Studio refuses a report on set.
 *
 * ---------------------------------------------------------------------------
 * READY TO HAND OFF, EXACTLY (the same rule as Film Studio's, word for word)
 *
 *   · the shot itself is approved (a named person, `approveShot`);
 *   · it is packaged, and still packaged — a shot reopened after packaging
 *     goes back to prep, and its package is then out of date;
 *   · every task on it is approved, and none needs correction;
 *   · every task is still at the version that was packaged
 *     (`packagedTaskVersions`, recorded by `markPackaged` from format 12);
 *   · it has not been delivered. A delivered shot is counted as delivered.
 *
 * `readiness` below is a port of Film Studio's function, applied to the
 * document's own shot, so the two can never disagree: what VC VFX prints is
 * what Film Studio works out from what VC VFX sent.
 *
 * Pure. Nothing here touches the network; the desktop's main process sends.
 */

export const VFX_STATUS_FORMAT = 'vc-film-studio.vfx-status/1';
/** Film Studio's production site; the upload goes to `<this>/api/vfx/status`. */
export const FILM_STUDIO_DEFAULT_URL = 'https://www.vcfilmstudio.com';
export const FILM_STUDIO_STATUS_PATH = '/api/vfx/status';
/** Film Studio's upload keys start with this; a VC DIT key (`vcdit_`) opens a different door. */
export const FILM_STUDIO_KEY_PREFIX = 'vcvfx_';

/* ------------------------------------------------------------ the shape --- */

export interface VfxStatusApproval {
  by: string;
  at: string;
}

export interface VfxStatusConfidence {
  frames: number;
  mean: number;
  min: number;
  low?: number;
  flagged?: number;
  reviewed?: number;
}

export interface VfxStatusTask {
  kind: string;
  label: string;
  state: TaskState;
  version: number;
  approval: VfxStatusApproval | null;
  notes?: string;
  confidence?: VfxStatusConfidence;
  problems: number;
  exported: boolean;
  exportVersion?: number;
}

export type VfxStatusSeverity = 'info' | 'warn' | 'error';

export interface VfxStatusProblem {
  task: string | null;
  severity: VfxStatusSeverity;
  text: string;
  frames?: number[];
}

export interface VfxStatusShot {
  handoffShotId: string;
  vfxShotId?: string;
  scene: string;
  setup?: string;
  take?: string;
  circled: boolean;
  cameraRoll?: string;
  clip?: string;
  unit?: string;
  shootDay?: string;
  shootDate?: string;
  frames?: { in: number; out: number; handles: number; count: number; rangeFrom: 'handoff' | 'probe' };
  frameRate?: number;
  timecodeIn?: string;
  timecodeOut?: string;
  camera?: { body?: string; lens?: string; focalLengthMm?: number };
  pixelAspect?: number;
  status: { key: ShotStatus; label: string };
  source: { verified: ShotState['sourceVerified']; at?: string };
  plates?: { version: number; frames: number; format: string; bitDepth?: number; colour?: string; writtenAt?: string };
  tasks: VfxStatusTask[];
  approval: VfxStatusApproval | null;
  packaged?: { version: number; at: string; folder?: string; taskVersions?: Record<string, number> };
  delivered?: { at: string; to?: string };
  problems: VfxStatusProblem[];
  supervisorNotes?: string;
  notes?: string;
}

export interface VfxStatusSummary {
  shots: number;
  byStatus: Record<string, number>;
  byTaskState: Record<string, number>;
  readyToHandOff: number;
}

export interface VfxStatusDocument {
  format: typeof VFX_STATUS_FORMAT;
  generatedAt: string;
  generator: { app: string; version: string };
  operator?: string;
  project: {
    name: string;
    productionCompany?: string;
    origin?: { format?: string; tool?: string; productionCode?: string; day?: { number?: number; date?: string } };
  };
  filmStudio?: { production: string };
  shots: VfxStatusShot[];
  summary: VfxStatusSummary;
}

export interface VfxStatusInput {
  generatedAt: Date;
  appVersion: string;
  operator: string;
}

/* ------------------------------------------------- writing within limits --- */

/**
 * Film Studio refuses a report with a text field longer than the contract
 * allows (`shots[3].scene should be at most 40 characters`) — the whole
 * report, not just the field. Long free text is shortened here with an
 * ellipsis instead; identities (shot ids) are short by construction.
 */
const text = (v: string | null | undefined, max: number): string | undefined => {
  const s = (v ?? '').trim();
  if (!s) return undefined;
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
};
/** Only the defined keys, so the JSON says nothing rather than `null` where VC VFX does not know. */
const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
const approvalOf = (a: { by: string; at: string } | null): VfxStatusApproval | null => (a ? { by: text(a.by, 120) ?? 'Unknown', at: new Date(a.at).toISOString() } : null);

/** The date inside a shoot-day label: "Day 003 · 2026-09-16" → 2026-09-16. */
export function dateInShootDay(label: string | undefined): string | undefined {
  const m = /(\d{4}-\d{2}-\d{2})/.exec(label ?? '');
  return m && !Number.isNaN(Date.parse(m[1]!)) ? m[1] : undefined;
}

/** The time of the shot's last log entry with one of these actions, or undefined. */
function lastLogAt(p: Project, shotId: string, actions: (a: string) => boolean): string | undefined {
  for (let i = p.log.length - 1; i >= 0; i -= 1) {
    const l = p.log[i]!;
    if (l.shotId === shotId && actions(l.action)) return new Date(l.at).toISOString();
  }
  return undefined;
}

/* ------------------------------------------------------- per task facts --- */

const isolateOf = (s: ShotState, kind: PrepTaskKind) => (kind === 'sky_replacement' ? s.isolate?.sky : kind === 'background_removal' ? s.isolate?.background : null) ?? null;

/** The versions of a task's work exported to the package, newest last. */
function exportVersions(s: ShotState, t: TaskRecord): number[] {
  const versions = (list: readonly { version: number | null }[] | undefined) => (list ?? []).map((e) => e.version).filter((v): v is number => typeof v === 'number');
  switch (t.kind) {
    case 'sequence_conversion':
      return s.plates.map((r) => r.version);
    case 'roto':
      return versions(s.roto?.exports);
    case 'key':
      return versions(s.key?.exports);
    case 'despill': {
      // Despill is approved as the key's export with the despilled foreground (approveTask).
      const keyVersion = s.tasks.find((x) => x.kind === 'key')?.version ?? 1;
      return (s.key?.exports ?? []).filter((e) => e.despill && e.version === keyVersion).length ? [t.version] : [];
    }
    case 'clean_plate':
      return versions(s.cleanPlate?.exports);
    case 'track_2d':
      return versions(s.track2d?.exports);
    case 'camera_track':
      return versions(s.camtrack?.exports);
    case 'sky_replacement':
    case 'background_removal':
      return versions(isolateOf(s, t.kind)?.exports);
    case 'texture_extraction':
      return versions(s.texture?.exports);
    case 'lighting_analysis':
      return versions(s.lighting?.exports);
    case 'composite':
      return versions(compDoc(s)?.exports);
  }
}

/** Confidence, where VC VFX measures one, in the contract's shape (counts, not frame lists). */
function confidenceOf(s: ShotState, kind: PrepTaskKind): VfxStatusConfidence | undefined {
  const round = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;
  const shape = (c: { frames: number; mean: number; min: number }, low: number, flagged: number, reviewed: number): VfxStatusConfidence | undefined =>
    c.frames > 0 ? { frames: c.frames, mean: round(c.mean), min: round(c.min), low, flagged, reviewed } : undefined;
  switch (kind) {
    case 'roto': {
      if (!s.roto) return undefined;
      const conf = [...frameConfidence(s.roto, null).values()];
      if (!conf.length) return undefined;
      const values = conf.map((v) => v.confidence);
      return shape(
        { frames: conf.length, mean: values.reduce((a, b) => a + b, 0) / values.length, min: Math.min(...values) },
        conf.filter((v) => v.confidence < LOW_CONFIDENCE).length,
        conf.filter((v) => v.flagged).length,
        conf.filter((v) => v.reviewed).length,
      );
    }
    case 'key':
    case 'despill': {
      const c = keyConfidenceSummary(s.key);
      return shape(c, c.low.length, c.flagged.length, c.reviewed);
    }
    case 'clean_plate': {
      const c = cleanPlateConfidenceSummary(s.cleanPlate);
      return shape(c, c.lowFrames.length, c.flagged.length, c.reviewed);
    }
    case 'sky_replacement':
    case 'background_removal': {
      const c = isolateConfidenceSummary(isolateOf(s, kind));
      return shape(c, c.lowFrames.length, c.flagged.length, c.reviewed);
    }
    case 'track_2d': {
      const conf = (s.track2d?.tracks ?? []).flatMap((t) => t.frames.filter((f) => f.status !== 'key').map((f) => f.confidence));
      if (!conf.length) return undefined;
      return { frames: conf.length, mean: round(conf.reduce((a, b) => a + b, 0) / conf.length), min: round(Math.min(...conf)), low: conf.filter((c) => c < LOW_CONFIDENCE).length };
    }
    case 'camera_track': {
      // One number for the whole solve: its own confidence, over the frames it solved.
      const solve = activeSolve(s.camtrack);
      if (!solve || solve.stats.framesSolved === 0) return undefined;
      return { frames: solve.stats.framesSolved, mean: round(solve.stats.confidence), min: round(solve.stats.confidence) };
    }
    default:
      return undefined;
  }
}

/* -------------------------------------------------- what is not working --- */

const MAX_PROBLEM_FRAMES = 500;
const framesWords = (frames: readonly number[]) => (frames.length <= 8 ? frames.join(', ') : `${frames.slice(0, 8).join(', ')} and ${frames.length - 8} more`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What is not working on a shot, each a sentence somebody can act on: what is
 * wrong, where, and what to do. Work a named person has approved is not
 * second-guessed here — its review is over — but a source that no longer
 * matches the DIT's checksum is always said.
 */
export function shotProblems(p: Project, shotId: string): VfxStatusProblem[] {
  const shot = handoffShot(p, shotId);
  const s = shotState(p, shotId);
  if (!shot || !s) return [];
  const out: VfxStatusProblem[] = [];
  const add = (task: PrepTaskKind | null, severity: VfxStatusSeverity, words: string, frames: readonly number[] = []) =>
    out.push(defined({ task, severity, text: text(words, 2000)!, frames: frames.length ? [...new Set(frames)].sort((a, b) => a - b).slice(0, MAX_PROBLEM_FRAMES) : undefined }));

  if (s.sourceVerified === 'mismatch') add(null, 'error', 'The source does not match the DIT’s checksum: the camera file on this drive is not the one that was shot. Copy the take again from the camera original or the DIT’s other copy, then run Verify sources.');
  if (s.sourceVerified === 'missing') add(null, 'error', 'The source file is missing from the drive. Reconnect the drive or copy the take again, then run Verify sources.');
  if (s.sourceVerified === 'unchecked' && shot.checksums.length && s.stage !== 'delivered') add(null, 'info', 'The source has not been verified against the DIT’s checksum yet. Run Verify sources on the Deliver tab.');

  if (s.reviewMarks.length && !s.approval) {
    const noted = s.reviewMarks.filter((m) => m.note).slice(0, 3).map((m) => `${m.frame}: ${m.note}`);
    add(null, 'warn', `${plural(s.reviewMarks.length, 'frame')} marked for correction in review${noted.length ? ` (${noted.join('; ')})` : ''}. Correct them, then clear the marks.`, s.reviewMarks.map((m) => m.frame));
  }

  const open = (kind: PrepTaskKind) => {
    const t = s.tasks.find((x) => x.kind === kind);
    return t !== undefined && t.state !== 'approved';
  };
  const label = (kind: PrepTaskKind) => PREP_TASKS[kind].short;
  const review = (kind: PrepTaskKind, problems: readonly number[], flagged: readonly number[], what: string, where: string) => {
    const unflagged = problems.filter((f) => !flagged.includes(f));
    if (flagged.length) add(kind, 'warn', `${label(kind)}: ${plural(flagged.length, 'frame')} flagged for another look (${framesWords(flagged)}). Correct them in ${where}, or clear the flag once they are right.`, flagged);
    if (unflagged.length) add(kind, 'warn', `${label(kind)}: ${plural(unflagged.length, `${what} frame`)} not yet reviewed (${framesWords(unflagged)}). Look at them in ${where}; correct them or mark them reviewed.`, unflagged);
  };

  if (s.roto && open('roto')) {
    const conf = [...frameConfidence(s.roto, null).entries()].sort((a, b) => a[0] - b[0]);
    review('roto', conf.filter(([, v]) => v.confidence < LOW_CONFIDENCE && !v.reviewed && !v.key).map(([f]) => f), conf.filter(([, v]) => v.flagged).map(([f]) => f), 'low-confidence', 'Roto');
  }
  if (s.key && (open('key') || open('despill'))) {
    const c = keyConfidenceSummary(s.key);
    review(open('key') ? 'key' : 'despill', c.problems, c.flagged, 'problem', 'Key');
  }
  if (s.cleanPlate && open('clean_plate')) {
    const c = cleanPlateConfidenceSummary(s.cleanPlate);
    review('clean_plate', c.problems, c.flagged, 'problem', 'Clean Plate');
  }
  for (const kind of ['sky_replacement', 'background_removal'] as const) {
    const doc = isolateOf(s, kind);
    if (!doc || !open(kind)) continue;
    const c = isolateConfidenceSummary(doc);
    review(kind, c.problems, c.flagged, 'problem', 'Sky & BG');
  }
  if (s.camtrack && open('camera_track')) {
    for (const w of activeSolve(s.camtrack)?.stats.warnings ?? []) add('camera_track', 'warn', `${label('camera_track')}: ${w}`);
  }
  const comp = compDoc(s);
  if (comp && comp.nodes.length && open('composite')) {
    for (const x of validateCompGraph(comp, compContext(s))) {
      add('composite', x.severity === 'warning' ? 'warn' : x.severity, `${label('composite')}: ${x.message}`);
    }
  }
  const plateTask = s.tasks.find((t) => t.kind === 'sequence_conversion');
  const plates = plateTask ? s.plates.find((r) => r.version === plateTask.version) : undefined;
  if (plates && plateTask && plateTask.state !== 'approved') {
    for (const n of plates.notes) add('sequence_conversion', 'info', `Plates ${versionTag(plates.version)}: ${n}`);
  }
  if (!s.approval) {
    let par: ReturnType<typeof shotPixelAspect> | null = null;
    try {
      par = shotPixelAspect(p, shotId);
    } catch {
      par = null;
    }
    for (const w of par?.warnings ?? []) add(null, 'info', `Pixel aspect: ${w}`);
  }
  return out;
}

/* ------------------------------------------------------------- one shot --- */

export function statusShot(p: Project, shotId: string): VfxStatusShot {
  const shot = handoffShot(p, shotId);
  const s = shotState(p, shotId);
  if (!shot || !s) throw new Error(`No shot ${shotId}`);
  const status = shotStatus(s);
  const plan = planFor(p, shot);
  const timing = shotTiming(p, shot);
  const problems = shotProblems(p, shotId);
  const plateTask = s.tasks.find((t) => t.kind === 'sequence_conversion');
  const plates = plateTask ? s.plates.find((r) => r.version === plateTask.version) : undefined;
  const output = outputFor(p.handoff, shot);
  let pixelAspect: number | undefined;
  try {
    pixelAspect = shotPixelAspect(p, shotId).value;
  } catch {
    pixelAspect = undefined;
  }

  const tasks: VfxStatusTask[] = s.tasks.map((t) => {
    const exported = exportVersions(s, t);
    return defined({
      kind: t.kind,
      label: text(PREP_TASKS[t.kind].label, 80)!,
      state: t.state,
      version: t.version,
      // Approval and state travel together: approving sets both, any other state clears it.
      approval: t.state === 'approved' ? approvalOf(t.approval) : null,
      notes: text(t.notes, 4000),
      confidence: confidenceOf(s, t.kind),
      problems: problems.filter((x) => x.task === t.kind).length,
      exported: exported.includes(t.version),
      exportVersion: exported.length ? Math.max(...exported) : undefined,
    });
  });

  const packagedAt = s.packageVersion > 0 ? (lastLogAt(p, shotId, (a) => a === 'shot.packaged') ?? new Date(p.updatedAt).toISOString()) : undefined;
  const name = s.vfxShotId ?? shot.shotId;
  const delivered = status === 'delivered' ? { at: lastLogAt(p, shotId, (a) => a === 'shot.delivered') ?? new Date(p.updatedAt).toISOString(), to: text(s.deliveredTo, 200) } : undefined;

  return defined({
    handoffShotId: text(shot.shotId, 80)!,
    vfxShotId: text(s.vfxShotId, 80),
    scene: text(shot.scene, 40)!,
    setup: text(shot.setup, 20),
    take: text(shot.take, 20),
    circled: shot.circled,
    cameraRoll: text(shot.cameraRoll, 40),
    clip: text(shot.clip, 80),
    unit: text(shot.unit, 40),
    shootDay: text(shot.shootDay, 60),
    shootDate: (p.handoff.origin?.day?.date && dateInShootDay(p.handoff.origin.day.date)) || dateInShootDay(shot.shootDay),
    frames: plan && timing ? { in: plan.deliveredIn, out: plan.deliveredOut, handles: plan.handles, count: plan.frameCount, rangeFrom: timing.from } : undefined,
    frameRate: timing?.frameRate ?? shot.frameRate,
    timecodeIn: timing?.timecodeIn ?? shot.timecodeIn,
    timecodeOut: shot.timecodeOut,
    camera: shot.camera.body || shot.camera.lens || shot.camera.focalLengthMm
      ? defined({ body: text(shot.camera.body, 80), lens: text(shot.camera.lens, 80), focalLengthMm: shot.camera.focalLengthMm && shot.camera.focalLengthMm >= 1 && shot.camera.focalLengthMm <= 2000 ? shot.camera.focalLengthMm : undefined })
      : undefined,
    pixelAspect,
    status: { key: status, label: SHOT_STATUS_LABELS[status] },
    source: defined({ verified: s.sourceVerified, at: lastLogAt(p, shotId, (a) => /^source\.(verified|mismatch|missing|unchecked)$/.test(a)) }),
    plates: plates
      ? defined({ version: plates.version, frames: plates.frames, format: text(plates.format, 20) ?? output.format, bitDepth: plates.bitDepth, colour: text(`${plates.color.summary}${plates.color.lookApplied ? '' : ', no look baked'}`, 300), writtenAt: new Date(plates.writtenAt).toISOString() })
      : undefined,
    tasks,
    approval: approvalOf(s.approval),
    packaged: packagedAt
      ? defined({
          version: s.packageVersion,
          at: packagedAt,
          folder: text(shotFolderSegments(p.handoff.project, shot.scene, name).join('/'), 500),
          taskVersions: s.packagedTaskVersions ?? undefined,
        })
      : undefined,
    delivered: delivered ? defined(delivered) : undefined,
    problems,
    supervisorNotes: text(shot.supervisorNotes, 4000),
    notes: text(s.notes, 4000),
  });
}

/* ----------------------------------------------------------- the report --- */

/**
 * The whole project as a `vc-film-studio.vfx-status/1` document. Every send
 * is the whole project; Film Studio keeps every report and shows the newest
 * by `generatedAt`.
 */
export function buildFilmStudioStatus(p: Project, input: VfxStatusInput): VfxStatusDocument {
  const h = p.handoff;
  // The handoff's order is the queue's (scene, then shot), as the printed log reads.
  const shots = h.shots.map((s) => statusShot(p, s.shotId));
  const byStatus = Object.fromEntries(SHOT_STATUSES.map((k) => [k, 0])) as Record<string, number>;
  const byTaskState = Object.fromEntries(TASK_STATES.map((k) => [k, 0])) as Record<string, number>;
  for (const s of shots) {
    byStatus[s.status.key] = (byStatus[s.status.key] ?? 0) + 1;
    for (const t of s.tasks) byTaskState[t.state] = (byTaskState[t.state] ?? 0) + 1;
  }
  const origin = h.origin
    ? defined({
        format: text(h.origin.format, 80),
        tool: text(h.origin.tool, 80),
        productionCode: text(h.origin.productionCode, 40),
        day: h.origin.day
          ? defined({
              number: typeof h.origin.day.number === 'number' && Number.isInteger(h.origin.day.number) && h.origin.day.number >= 0 ? h.origin.day.number : undefined,
              date: h.origin.day.date && /^\d{4}-\d{2}-\d{2}$/.test(h.origin.day.date) && !Number.isNaN(Date.parse(h.origin.day.date)) ? h.origin.day.date : undefined,
            })
          : undefined,
      })
    : undefined;
  const production = text(p.filmStudioProduction, 200);
  return defined({
    format: VFX_STATUS_FORMAT,
    generatedAt: input.generatedAt.toISOString(),
    generator: { app: 'VC VFX', version: text(input.appVersion, 20) ?? '0' },
    operator: text(input.operator, 120),
    project: defined({ name: text(h.project, 200)!, productionCompany: text(h.productionCompany, 200), origin }),
    filmStudio: production ? { production } : undefined,
    shots,
    summary: { shots: shots.length, byStatus, byTaskState, readyToHandOff: shots.filter((s) => readiness(s).ready).length },
  }) as VfxStatusDocument;
}

/* ----------------------------------------------------------- readiness --- */
/*
 * A port of VC Film Studio's lib/vfx-status.ts `readiness` (branch
 * claude/vfx-status, 618a180), applied to the document's shot. Kept word for
 * word — the reasons included — so the paper VC VFX prints says what Film
 * Studio's board says. The tests run both over every state and compare.
 */

/** The sections of the printed log, in the order they print. */
export const STATUS_BUCKETS = ['ready', 'review', 'correction', 'progress', 'not_started', 'delivered'] as const;
export type StatusBucket = (typeof STATUS_BUCKETS)[number];

export const STATUS_BUCKET_TITLES: Record<StatusBucket, string> = {
  ready: 'Ready to hand off',
  review: 'In review',
  correction: 'Needs correction',
  progress: 'In progress',
  not_started: 'Not started',
  delivered: 'Delivered',
};

export interface HandoffReadiness {
  ready: boolean;
  delivered: boolean;
  bucket: StatusBucket;
  /** What stands between the shot and the vendor, in words; empty when ready or delivered. */
  why: string[];
}

/** Film Studio's short names (its TASK_KINDS); a kind it does not know goes by its label. */
const STATUS_TASK_SHORT: Record<string, string> = {
  sequence_conversion: 'Plates',
  roto: 'Roto',
  key: 'Key',
  despill: 'Despill',
  clean_plate: 'Clean plate',
  track_2d: '2D track',
  camera_track: 'Camera track',
  sky_replacement: 'Sky',
  background_removal: 'BG removal',
  texture_extraction: 'Textures',
  lighting_analysis: 'Lighting',
  composite: 'Comp',
};
export const statusTaskShort = (t: Pick<VfxStatusTask, 'kind' | 'label'>): string => STATUS_TASK_SHORT[t.kind] ?? t.label;

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

/** Whether a shot of the document is ready to hand off, its section, and what holds it. */
export function readiness(s: VfxStatusShot): HandoffReadiness {
  const delivered = s.status.key === 'delivered' || s.delivered != null;
  if (delivered) return { ready: false, delivered: true, bucket: 'delivered', why: [] };

  const why: string[] = [];
  const corrections = s.tasks.filter((t) => t.state === 'needs_correction');
  if (s.tasks.length === 0) why.push('no prep tasks on it yet');
  for (const state of ['needs_correction', 'needs_review', 'processing', 'pending'] as const) {
    const names = s.tasks.filter((t) => t.state === state).map(statusTaskShort);
    if (names.length) why.push(`${listWords(names)} ${STATE_VERB[state][names.length === 1 ? 0 : 1]}`);
  }
  if (why.length === 0) {
    if (!s.approval) why.push('the shot is not approved');
    if (!s.packaged) {
      why.push('not packaged');
    } else if (s.status.key !== 'packaged') {
      why.push(`package ${versionTag(s.packaged.version)} is out of date — the shot went back into prep`);
    } else if (s.packaged.taskVersions) {
      for (const t of s.tasks) {
        const at = s.packaged.taskVersions[t.kind];
        if (at === undefined) why.push(`${statusTaskShort(t)} is not in package ${versionTag(s.packaged.version)}`);
        else if (at !== t.version) why.push(`packaged with ${statusTaskShort(t)} ${versionTag(at)}; it is now ${versionTag(t.version)}`);
      }
    }
  } else if (s.packaged && s.status.key !== 'packaged') {
    why.push(`package ${versionTag(s.packaged.version)} is out of date — the shot went back into prep`);
  }

  const ready = why.length === 0;
  let bucket: StatusBucket;
  if (ready) bucket = 'ready';
  else if (corrections.length || s.status.key === 'needs_correction') bucket = 'correction';
  else if (s.status.key === 'needs_review') bucket = 'review';
  else if (s.status.key === 'not_started' || s.status.key === 'ready_for_prep') bucket = 'not_started';
  else bucket = 'progress';
  return { ready, delivered: false, bucket, why };
}

/** The readiness of one shot of a project, as Film Studio will see it. */
export function handoffReadiness(p: Project, shotId: string): HandoffReadiness {
  return readiness(statusShot(p, shotId));
}

export interface StatusCounts {
  shots: number;
  ready: number;
  review: number;
  correction: number;
  progress: number;
  notStarted: number;
  delivered: number;
  problems: Record<VfxStatusSeverity, number>;
}

export function statusCountsOf(doc: Pick<VfxStatusDocument, 'shots'>): StatusCounts {
  const out: StatusCounts = { shots: doc.shots.length, ready: 0, review: 0, correction: 0, progress: 0, notStarted: 0, delivered: 0, problems: { info: 0, warn: 0, error: 0 } };
  for (const s of doc.shots) {
    const r = readiness(s);
    if (r.bucket === 'ready') out.ready += 1;
    else if (r.bucket === 'review') out.review += 1;
    else if (r.bucket === 'correction') out.correction += 1;
    else if (r.bucket === 'progress') out.progress += 1;
    else if (r.bucket === 'not_started') out.notStarted += 1;
    else out.delivered += 1;
    if (!r.delivered) for (const x of s.problems) out.problems[x.severity] += 1;
  }
  return out;
}

/** The sentence at the top of the page (Film Studio's `vfxSays`): what can go to the vendor, and what holds the rest. */
export function statusSays(c: StatusCounts): { tone: 'ok' | 'warn' | 'bad'; text: string } {
  if (c.shots === 0) return { tone: 'warn', text: 'No shots in this project.' };
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  const parts: string[] = [];
  if (c.correction) parts.push(`${n(c.correction, 'shot needs', 'shots need')} correction`);
  if (c.review) parts.push(`${c.review} in review`);
  if (c.progress) parts.push(`${c.progress} in progress`);
  if (c.notStarted) parts.push(`${c.notStarted} not started`);
  const lead = c.ready ? `${n(c.ready, 'shot is', 'shots are')} ready to hand off` : 'No shot is ready to hand off yet';
  const tail = c.delivered ? ` ${n(c.delivered, 'shot has', 'shots have')} been delivered.` : '';
  if (!parts.length) return { tone: 'ok', text: `${lead}.${tail}` };
  return { tone: c.correction || c.problems.error ? 'bad' : 'warn', text: `${lead}; ${parts.join(', ')}.${tail}` };
}

/* ------------------------------------------------------ project changes --- */

/** Name the Film Studio production this project reports to (empty: none). Logged. */
export function setFilmStudioProduction(p: Project, production: string, actor: string, now: Date): Result {
  const next = production.trim().slice(0, 200);
  if (next === p.filmStudioProduction) return { ok: true, project: p };
  const at = now.toISOString();
  return {
    ok: true,
    project: { ...p, filmStudioProduction: next, updatedAt: at, log: [...p.log, { at, actor, shotId: null, action: 'filmstudio.production', detail: `${p.filmStudioProduction || '(none)'} → ${next || '(none)'}` }] },
  };
}

/** How a send to Film Studio went, as the project log keeps it. Never carries the key. */
export type StatusSendOutcome =
  | { kind: 'sent'; url: string; shots: number; readyToHandOff: number; says: string; warnings: string[]; stale: boolean; report: string | null; production: string | null }
  | { kind: 'refused'; url: string; shots: number; status: number; error: string; issues: string[] }
  | { kind: 'not_sent'; url: string; shots: number; error: string };

/** Log a send — who, when, the counts, and Film Studio's answer — so the project says what Film Studio was told. */
export function recordStatusSend(p: Project, outcome: StatusSendOutcome, actor: string, now: Date): Project {
  const at = now.toISOString();
  const detail =
    outcome.kind === 'sent'
      ? `${outcome.url}: ${plural(outcome.shots, 'shot')}, ${outcome.readyToHandOff} ready to hand off. Film Studio: ${outcome.says}${outcome.stale ? ' (a newer report was already there)' : ''}${outcome.warnings.length ? ` Warnings: ${outcome.warnings.join(' ')}` : ''}`
      : outcome.kind === 'refused'
        ? `${outcome.url}: ${plural(outcome.shots, 'shot')}; refused (${outcome.status}): ${outcome.error}${outcome.issues.length ? ` — ${outcome.issues.join('; ')}` : ''}`
        : `${outcome.url}: ${plural(outcome.shots, 'shot')}; not sent: ${outcome.error}`;
  const action = outcome.kind === 'sent' ? 'filmstudio.sent' : outcome.kind === 'refused' ? 'filmstudio.refused' : 'filmstudio.not_sent';
  return { ...p, updatedAt: at, log: [...p.log, { at, actor, shotId: null, action, detail: detail.slice(0, 4000) }] };
}

/** The last send recorded in the log, for "last sent …" lines. */
export function lastStatusSend(p: Project): { at: string; actor: string; action: string; detail: string } | null {
  for (let i = p.log.length - 1; i >= 0; i -= 1) {
    const l = p.log[i]!;
    if (l.action === 'filmstudio.sent' || l.action === 'filmstudio.refused' || l.action === 'filmstudio.not_sent') return l;
  }
  return null;
}

