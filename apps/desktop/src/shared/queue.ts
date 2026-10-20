import { formatRange, outputFor, planFor, PREP_TASKS, type HandoffShot, type Project, type ShotState } from '@vcvfx/domain';

/** Display helpers shared by the queue and the detail panel. Pure. */

/** Delivered frames with handles, or "—" while the range is unknown (not in the handoff, clip not yet read). */
export function deliveredRange(p: Project, shot: HandoffShot): string {
  const plan = planFor(p, shot);
  return plan ? formatRange(plan.deliveredIn, plan.deliveredOut) : '—';
}

export function requiredPrep(p: Project, shot: HandoffShot, state: ShotState): string {
  const out = outputFor(p.handoff, shot);
  return state.tasks.map((t) => (t.kind === 'sequence_conversion' ? out.format.toUpperCase() : PREP_TASKS[t.kind].short)).join(' + ') || '—';
}

/** The key settings use for a project's output root: its file, or its handoff until first saved. */
export function projectKey(projectPath: string | null, handoffPath: string): string {
  return projectPath ?? `handoff:${handoffPath}`;
}
