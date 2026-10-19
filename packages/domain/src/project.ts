import { z } from 'zod';
import { HandoffSchema, type Handoff, type HandoffShot } from './handoff.js';
import { PREP_TASK_KINDS, PREP_TASKS, TASK_STATE_LABELS, TASK_STATES, sortTaskKinds, type PrepTaskKind, type TaskState } from './tasks.js';
import { SHOT_STATUSES, type ShotStatus } from './status.js';

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
export const PROJECT_VERSION = 1;
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

export const ShotStateSchema = z.object({
  shotId: z.string(),
  tasks: z.array(TaskRecordSchema),
  approval: ApprovalSchema.nullable().default(null),
  /** Explicit stages past approval. */
  stage: z.enum(['prep', 'packaged', 'delivered']).default('prep'),
  packageVersion: z.number().int().nonnegative().default(0),
  notes: z.string().default(''),
  sourceVerified: z.enum(['unchecked', 'verified', 'mismatch', 'missing']).default('unchecked'),
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
  shots: z.array(ShotStateSchema),
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
  }));
  return log(
    { format: PROJECT_FORMAT, version: PROJECT_VERSION, createdAt: at, updatedAt: at, handoffPath, handoff, shots, log: [] },
    { at, actor, shotId: null, action: 'project.created', detail: `${shots.length} shots from ${handoffPath}` },
  );
}

export function parseProject(text: string): { ok: true; project: Project } | { ok: false; reason: string } {
  try {
    const parsed = ProjectSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return { ok: false, reason: parsed.error.issues[0]?.message ?? 'Not a VCVFX project' };
    if (parsed.data.version > PROJECT_VERSION) return { ok: false, reason: 'This project was saved by a newer VC VFX. Update to open it.' };
    return { ok: true, project: parsed.data };
  } catch (e) {
    return { ok: false, reason: `Not valid JSON: ${(e as Error).message}` };
  }
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
        [r.shot.shotId, r.shot.scene, r.shot.setup, r.shot.take, r.shot.clip, r.shot.supervisorNotes, r.state.notes]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(needle)),
    )
    .sort((a, b) => collator.compare(a.shot.scene, b.shot.scene) || collator.compare(a.shot.shotId, b.shot.shotId));
}

export function scenesOf(p: Project): string[] {
  return [...new Set(p.handoff.shots.map((s) => s.scene))].sort(collator.compare);
}

export function statusCounts(p: Project): Record<ShotStatus, number> {
  const counts = Object.fromEntries(SHOT_STATUSES.map((s) => [s, 0])) as Record<ShotStatus, number>;
  for (const s of p.shots) counts[shotStatus(s)] += 1;
  return counts;
}
