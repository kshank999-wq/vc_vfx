/** Shot status model (master spec §16). */

export const SHOT_STATUSES = [
  'not_started',
  'ready_for_prep',
  'processing',
  'needs_review',
  'needs_correction',
  'prep_approved',
  'packaged',
  'delivered',
] as const;
export type ShotStatus = (typeof SHOT_STATUSES)[number];

export const SHOT_STATUS_LABELS: Record<ShotStatus, string> = {
  not_started: 'Not Started',
  ready_for_prep: 'Ready for Prep',
  processing: 'Processing',
  needs_review: 'Needs Review',
  needs_correction: 'Needs Correction',
  prep_approved: 'Prep Approved',
  packaged: 'Packaged',
  delivered: 'Delivered',
};

export function shotStatusRank(s: ShotStatus): number {
  return SHOT_STATUSES.indexOf(s);
}
