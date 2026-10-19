/**
 * Prep operations a shot can request (master spec §2, §4–§14).
 *
 * The order here is the MVP priority order (§20) and is the order tasks are
 * shown and run in. `available` marks the operations this release performs
 * itself; the rest are tracked, reviewed and approved in the queue but the
 * work is done in another application and recorded here.
 */

export const PREP_TASK_KINDS = [
  'sequence_conversion',
  'roto',
  'key',
  'despill',
  'clean_plate',
  'track_2d',
  'camera_track',
  'sky_replacement',
  'background_removal',
  'texture_extraction',
  'lighting_analysis',
  'composite',
] as const;
export type PrepTaskKind = (typeof PREP_TASK_KINDS)[number];

export interface PrepTaskInfo {
  label: string;
  /** Short form for the printable shot list (§3). */
  short: string;
  /** Package folder the task's deliverables land in (§17). */
  folder: string;
  available: boolean;
}

export const PREP_TASKS: Record<PrepTaskKind, PrepTaskInfo> = {
  sequence_conversion: { label: 'Image-sequence conversion', short: 'Plates', folder: '01_PLATES', available: true },
  roto: { label: 'Paint-to-roto', short: 'Roto', folder: '02_MATTES_ROTO', available: false },
  key: { label: 'Green/blue-screen key', short: 'Key', folder: '03_KEYS', available: false },
  despill: { label: 'Despill and background match', short: 'Despill', folder: '03_KEYS', available: false },
  clean_plate: { label: 'Clean plate', short: 'Clean plate', folder: '04_CLEAN_PLATES', available: false },
  track_2d: { label: '2D / planar track', short: '2D Track', folder: '05_TRACKS_2D', available: false },
  camera_track: { label: 'Camera track / matchmove', short: 'Cam Track', folder: '06_CAMERA_TRACK', available: false },
  sky_replacement: { label: 'Sky isolation / replacement prep', short: 'Sky', folder: '02_MATTES_ROTO', available: false },
  background_removal: { label: 'Background removal', short: 'BG Removal', folder: '02_MATTES_ROTO', available: false },
  texture_extraction: { label: 'Texture extraction', short: 'Textures', folder: '07_TEXTURES_REFERENCES', available: false },
  lighting_analysis: { label: 'Lighting and lens analysis', short: 'Lighting', folder: '09_PROJECT_DATA', available: false },
  composite: { label: 'Prep composite', short: 'Comp', folder: '09_PROJECT_DATA', available: false },
};

/** Per-task state. Approval is a separate, explicit act (§15.6). */
export const TASK_STATES = ['pending', 'processing', 'needs_review', 'needs_correction', 'approved'] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TASK_STATE_LABELS: Record<TaskState, string> = {
  pending: 'Pending',
  processing: 'Processing',
  needs_review: 'Needs Review',
  needs_correction: 'Needs Correction',
  approved: 'Approved',
};

export function sortTaskKinds(kinds: readonly PrepTaskKind[]): PrepTaskKind[] {
  return [...kinds].sort((a, b) => PREP_TASK_KINDS.indexOf(a) - PREP_TASK_KINDS.indexOf(b));
}
