import { shotState, shotStatus, type PrepTaskKind, type Project, type ShotStatus, type TaskState } from '@vcvfx/domain';

/**
 * The module tabs of the top toolbar (addendum 08). Each module is one big
 * screen for one kind of work on the current shot; Shots is the overview.
 * A module tied to a prep task greys out (but still opens, offering to add
 * the task) when the shot does not have that task.
 */

export const MODULE_IDS = ['shots', 'plates', 'roto', 'key', 'cleanplate', 'isolate', 'camera', 'track2d', 'deliver'] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

export interface ModuleInfo {
  id: ModuleId;
  label: string;
  /** The prep task this module works on; null for Shots and Deliver. */
  task: PrepTaskKind | null;
  /** Further tasks it works on (Sky & BG: background removal beside the sky). */
  also?: readonly PrepTaskKind[];
  /** One line for the "What's here" strip and the tab's tooltip. */
  blurb: string;
}

export const MODULES: Record<ModuleId, ModuleInfo> = {
  shots: { id: 'shots', label: 'Shots', task: null, blurb: 'Every shot from the handoff, with what each one needs and how far it has got.' },
  plates: { id: 'plates', label: 'Plates', task: 'sequence_conversion', blurb: 'Turn the camera files into clean, numbered image sequences, and check them frame by frame.' },
  roto: { id: 'roto', label: 'Roto', task: 'roto', blurb: 'Paint over the subject once; the matte is carried through the shot for you to check.' },
  key: { id: 'key', label: 'Key', task: 'key', blurb: 'Pull a green- or blue-screen key in one click, repair it with roto, despill it against the background.' },
  cleanplate: { id: 'cleanplate', label: 'Clean Plate', task: 'clean_plate', blurb: 'Remove a crew member, a rig or a passer-by: the background is rebuilt from the frames that see it.' },
  isolate: { id: 'isolate', label: 'Sky & BG', task: 'sky_replacement', also: ['background_removal'], blurb: 'Separate the sky, or a subject from its background: matte, foreground and plate, kept consistent through the shot.' },
  camera: { id: 'camera', label: 'Camera Track', task: 'camera_track', blurb: 'Work out how the camera moved, for 3D; align it to a LiDAR scan if you have one.' },
  track2d: { id: 'track2d', label: '2D Track', task: 'track_2d', blurb: 'Pin a flat surface (a screen, a sign) or a point through the shot for a replacement.' },
  deliver: { id: 'deliver', label: 'Deliver', task: null, blurb: 'Verify the sources, approve, write the vendor package and print the shot list.' },
};

/** What a module's tab shows for a shot: its task's state, or the shot's for Deliver. */
export type ModuleStatus =
  | { kind: 'none' }
  | { kind: 'missing'; reason: string }
  | { kind: 'task'; state: TaskState }
  | { kind: 'shot'; status: ShotStatus };

export function moduleStatus(project: Project, shotId: string | null, id: ModuleId): ModuleStatus {
  if (!shotId || id === 'shots') return { kind: 'none' };
  const state = shotState(project, shotId);
  if (!state) return { kind: 'none' };
  if (id === 'deliver') return { kind: 'shot', status: shotStatus(state) };
  const kinds = moduleTasks(id);
  const records = state.tasks.filter((t) => kinds.includes(t.kind));
  if (!records.length) return { kind: 'missing', reason: `${state.vfxShotId ?? shotId} has no ${MODULES[id].label} task. Open the tab to add it.` };
  // Two tasks in one tab (Sky & BG): the one further from done speaks for the tab.
  const order: TaskState[] = ['needs_correction', 'pending', 'processing', 'needs_review', 'approved'];
  const worst = records.reduce((a, b) => (order.indexOf(b.state) < order.indexOf(a.state) ? b : a));
  return { kind: 'task', state: worst.state };
}

/** Every prep task a module works on. */
export function moduleTasks(id: ModuleId): PrepTaskKind[] {
  const m = MODULES[id];
  return m.task ? [m.task, ...(m.also ?? [])] : [];
}

/** The module a double-click opens: the last one used if the shot has its task, else the shot's first task module. */
export function moduleToOpen(project: Project, shotId: string, last: ModuleId | null): ModuleId {
  if (last && last !== 'shots' && moduleStatus(project, shotId, last).kind !== 'missing') return last;
  const order: ModuleId[] = ['plates', 'roto', 'track2d', 'camera', 'key', 'cleanplate', 'isolate'];
  return order.find((m) => moduleStatus(project, shotId, m).kind === 'task') ?? 'deliver';
}

/** The module a ⌘/Ctrl+digit selects (1 = Shots … 9 = Deliver). */
export function moduleForDigit(key: string): ModuleId | null {
  const n = Number(key);
  return Number.isInteger(n) && n >= 1 && n <= MODULE_IDS.length ? MODULE_IDS[n - 1]! : null;
}

/** The menu command that switches to a module (the desktop's View menu). */
export const moduleCommand = (id: ModuleId) => `show-${id}` as const;

/** Per-viewer conveniences (remembered tab, dismissed hints): never anything that must persist. */
export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function writePref(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // private window, blocked storage: the default is fine
  }
}

export const PREF = {
  tourDone: 'vcvfx.tour.done',
  whatsHereHidden: 'vcvfx.whatshere.hidden',
  stepsCollapsed: 'vcvfx.layout.steps',
  infoCollapsed: 'vcvfx.layout.info',
  aiOpen: 'vcvfx.ai.open',
} as const;
