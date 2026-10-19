import {
  approveShot,
  approveTask,
  markDelivered,
  markPackaged,
  reopenShot,
  setTaskState,
  type PrepTaskKind,
  type Project,
  type Result,
  type TaskState,
} from '@vcvfx/domain';

/**
 * Whether an action is allowed, asked of the domain itself by dry-running the
 * mutation. The interface never re-implements a rule: a disabled button shows
 * the domain's own `Result.reason`.
 */
export type Allowed = { allowed: true } | { allowed: false; reason: string };

const DRY_RUN_NAME = 'dry-run';
const from = (r: Result): Allowed => (r.ok ? { allowed: true } : { allowed: false, reason: r.reason });

export const canApproveShot = (p: Project, shotId: string, now: Date): Allowed => {
  // Approving twice comes back ok-and-unchanged; that is not something to offer.
  if (p.shots.find((s) => s.shotId === shotId)?.approval) return { allowed: false, reason: 'This shot is already approved.' };
  return from(approveShot(p, shotId, DRY_RUN_NAME, now));
};

export const canApproveTask = (p: Project, shotId: string, kind: PrepTaskKind, now: Date): Allowed => from(approveTask(p, shotId, kind, DRY_RUN_NAME, now));
export const canSetTask = (p: Project, shotId: string, kind: PrepTaskKind, state: Exclude<TaskState, 'approved'>, now: Date): Allowed =>
  from(setTaskState(p, shotId, kind, state, DRY_RUN_NAME, now));
export const canPackage = (p: Project, shotId: string, now: Date): Allowed => from(markPackaged(p, shotId, DRY_RUN_NAME, now));
export const canDeliver = (p: Project, shotId: string, now: Date): Allowed => from(markDelivered(p, shotId, DRY_RUN_NAME, now));
export const canReopen = (p: Project, shotId: string, now: Date): Allowed => {
  const stage = p.shots.find((s) => s.shotId === shotId)?.stage;
  if (stage === 'prep') return { allowed: false, reason: 'The shot is already in prep.' };
  return from(reopenShot(p, shotId, DRY_RUN_NAME, now));
};

export const READ_ONLY_TITLE = 'Read-only mode: an active subscription is needed to change work, run ffmpeg or write packages.';
