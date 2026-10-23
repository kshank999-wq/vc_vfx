import {
  shotPixelAspect,
  CAMERA_DB,
  CAMERA_EXPORT_FORMATS,
  SCENE_UNITS,
  TRACK2D_EXPORT_FORMATS,
  camtrackLocked,
  camtrackTaskVersion,
  findCamera,
  handoffShot,
  matchCamera,
  newCamTrackDocument,
  rotoLocked,
  shotState,
  track2dLocked,
  track2dTaskVersion,
  type CamTrackDocument,
  type Project,
  type Result,
  type RotoDirection,
  type RotoPropagationResult,
} from '@vcvfx/domain';
import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { TrackSessionInfo, TrackViewData } from '../bridge';
import { applySim, type Similarity } from '../camera/align';
import type { CameraCommand, CommandOutcome, Rect } from '../camera/commands';
import type { AiOp } from './ops';
import { rmsTarget } from './prompt';

/**
 * The AI tracking assistant's tools (addendum 07 §3): a curated, described
 * subset of the camera command layer (shared/camera/commands.ts), so the
 * assistant and the artist use the same verbs and every change it makes is a
 * command in the shot's log. Each tool has a strict JSON schema; results are
 * compact summaries and top-N lists — never thousands of numbers — to keep
 * the model's reading (and the artist's bill) small.
 *
 * Tools run through a `TrackHost`: the desktop main process (worker-thread
 * commands, ops applied by the renderer) or the browser preview (the page's
 * dispatcher). The host always works on the project as it stands now.
 */

// ---------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------

export interface FrameImage {
  mediaType: 'image/jpeg' | 'image/png';
  /** Base64. */
  data: string;
  width: number;
  height: number;
}

export interface QuadProposal {
  name: string;
  frame: number;
  /** Plate pixels: top-left, top-right, bottom-right, bottom-left. */
  corners: [number, number][];
  reason: string;
}

export interface TrackHost {
  readonly shotId: string;
  /** The project as it stands (after every op applied so far). */
  project(): Project;
  /** Apply ops through the domain and the log, as the artist's commands are. */
  apply(ops: readonly AiOp[]): Promise<Result>;
  session(): Promise<TrackSessionInfo>;
  /** Run one camera command against the current project. Does not apply its ops. */
  command(command: CameraCommand, signal?: AbortSignal): Promise<CommandOutcome>;
  view(options?: { clouds?: boolean }): Promise<TrackViewData>;
  /** Propagate a roto part from a key frame (the roto Track engine); absent where roto cannot run. */
  roto?(partId: string, from: number, directions: RotoDirection[], signal?: AbortSignal): Promise<RotoPropagationResult[]>;
  /** A frame downscaled to at most `maxWidth`, with an optional overlay; absent unless frames may be seen. */
  frameImage?(frame: number, maxWidth: number, overlay: 'none' | 'tracks' | 'errors'): Promise<FrameImage>;
  /** Ask the artist to confirm (or adjust) corners the assistant proposed. */
  confirmQuad?(proposal: QuadProposal): Promise<{ accepted: boolean; corners?: [number, number][]; note?: string }>;
}

/** One command the assistant ran, as the panel lists it (the same words as the shot's log). */
export interface CommandEntry {
  verb: string;
  ok: boolean;
  summary: string;
}

export interface FinishReport {
  summary: string;
  actions: string[];
  finalStats: { rmsPx?: number; focalMm?: number; framesSolved?: number; framesTotal?: number; tracks?: number; meanConfidence2d?: number };
  targetsMet: boolean;
  concerns: string[];
  framesToCheck: { frame: number; reason: string }[];
  nextSteps: string[];
}

/** What a run allows and remembers between tool calls. */
export interface ToolContext {
  framesAllowed: boolean;
  exportAllowed: boolean;
  maxImages: number;
  imagesUsed: number;
  /** A focal range the artist or the assistant gave (mm), checked after each solve. */
  focalRange: { min: number; max: number } | null;
  /** 2D tracks this run created (the panel's Undo removes them). */
  created2d: string[];
  /** Each command run, for the live list. */
  onCommand?: (entry: CommandEntry) => void;
  signal?: AbortSignal;
}

export type ToolContent = string | ({ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg' | 'image/png'; data: string } })[];

export interface ToolOutcome {
  ok: boolean;
  content: ToolContent;
  /** One line for the panel. */
  summary: string;
  report?: FinishReport;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

type Schema = { type: string; description?: string; enum?: readonly (string | number)[]; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: false; items?: Schema };

const obj = (properties: Record<string, Schema>, required: string[] = [], description?: string): Schema => ({ type: 'object', ...(description ? { description } : {}), properties, required, additionalProperties: false });
const num = (description: string): Schema => ({ type: 'number', description });
const int = (description: string): Schema => ({ type: 'integer', description });
const str = (description: string): Schema => ({ type: 'string', description });
const bool = (description: string): Schema => ({ type: 'boolean', description });
const oneOf = (values: readonly string[], description: string): Schema => ({ type: 'string', enum: values, description });
const list = (items: Schema, description: string): Schema => ({ type: 'array', items, description });
const xy = (what: string) => obj({ x: num('x in plate pixels'), y: num('y in plate pixels') }, ['x', 'y'], what);
const box = (what: string): Record<string, Schema> => ({ x0: num(`${what}: left, plate pixels`), y0: num(`${what}: top`), x1: num(`${what}: right`), y1: num(`${what}: bottom`) });
const xyz = (what: string) => obj({ x: num('x'), y: num('y'), z: num('z') }, ['x', 'y', 'z'], what);

interface ToolSpec {
  name: string;
  description: string;
  schema: Schema;
  /** Offered only when the artist allowed frames. */
  frames?: boolean;
}

const SPECS: ToolSpec[] = [
  {
    name: 'add_correspondence',
    description: 'Tie a LiDAR scan or survey point to a solved feature track (or to a pixel on a frame), as the artist does with Pick correspondence. Use only points you have good reason to believe are the same physical feature: a named survey point, or a candidate from list_lidar_candidates. Needs at least three for align_to_lidar.',
    schema: obj(
      {
        lidar_id: str('Id of the imported LiDAR/survey file (from get_shot_context)'),
        track_id: int('Feature track id to tie (preferred)'),
        frame: int('Frame of the pixel, when not tying a track'),
        x: num('Pixel x on that frame (plate pixels)'),
        y: num('Pixel y on that frame (plate pixels)'),
        survey_point: str('Name of a named survey point in that file (instead of point)'),
        point: xyz('The scan point, in the file’s own coordinates and units'),
        name: str('Label for the correspondence'),
      },
      ['lidar_id'],
    ),
  },
  {
    name: 'align_to_lidar',
    description: 'Align the active solve to a LiDAR scan or survey: "similarity" fits scale, rotation and translation to the correspondences (robust to one wrong pick with five or more); "icp" then refines it onto the scan surface. Call after at least three correspondences exist; follow with solve_with_lidar for a constrained solve.',
    schema: obj({ method: oneOf(['similarity', 'icp'], 'similarity first; icp only to refine an existing similarity'), lidar_id: str('Which file (default: the first imported)') }, ['method']),
  },
  {
    name: 'auto_track',
    description: 'Detect corner features and track them through the whole shot (pyramidal Lucas–Kanade with forward–backward checks), replacing the existing tracks unless replace_existing is false. The first step on a shot with no tracks, and after changing exclusions. Roto parts and rectangles excluded by exclude_moving_objects / exclude_region are respected.',
    schema: obj({
      max_features: int('Features to keep per frame (100–2000; about 300 for HD, 500–800 for UHD). Omit to keep the current setting'),
      min_distance_px: num('Minimum spacing between features in plate pixels. Omit to keep the current setting'),
      replace_existing: bool('true (default) replaces the tracks; false adds to them'),
    }),
  },
  {
    name: 'create_exclusion_matte',
    description: 'Make a roto matte of a moving object (actor, car, screen content) from a box around it on one frame, carry it through the shot with the roto Track engine, and exclude it from camera tracking. Needs the shot to have a Paint-to-roto task. Use when moving things pull features off the set; re-run auto_track afterwards.',
    schema: obj(
      { name: str('Name for the roto part, e.g. "actor" or "car"'), frame: int('A frame where the object is clearly visible'), ...box('Box around the object on that frame'), direction: oneOf(['both', 'forward', 'backward'], 'Which way to carry the matte from the frame') },
      ['name', 'frame', 'x0', 'y0', 'x1', 'y1', 'direction'],
    ),
  },
  {
    name: 'delete_tracks',
    description: 'Delete feature tracks by id, by solve error above a threshold, by length below a minimum, or inside a rectangle on a frame (criteria combine with OR). Deleting by error needs a solve. Re-solve afterwards. Refuses to delete more than 40% of the tracks unless allow_large is true.',
    schema: obj({
      ids: list(int('track id'), 'Track ids to delete'),
      error_above_px: num('Delete tracks whose solve RMS is above this many pixels'),
      shorter_than_frames: int('Delete tracks shorter than this many frames'),
      region: obj({ frame: int('Frame the rectangle is on'), ...box('Rectangle') }, ['frame', 'x0', 'y0', 'x1', 'y1'], 'Delete tracks inside this rectangle on this frame'),
      allow_large: bool('Allow deleting more than 40% of the tracks'),
    }),
  },
  {
    name: 'detect_features',
    description: 'Detect new features on one frame — optionally only inside a rectangle — and track them both ways through the shot, adding them to the existing tracks. Use to fill thin coverage in a region or a stretch of frames.',
    schema: obj({ frame: int('Frame to detect on'), count: int('How many features (10–400, default 60)'), region: obj(box('Region'), ['x0', 'y0', 'x1', 'y1'], 'Restrict detection to this rectangle (plate pixels)'), min_distance_px: num('Minimum spacing between features, plate pixels') }, ['frame']),
  },
  {
    name: 'exclude_moving_objects',
    description: 'Keep features off moving objects by excluding existing roto parts (their mattes, frame by frame) from tracking. Re-run auto_track afterwards for it to take effect.',
    schema: obj({ roto_part_ids: list(str('roto part id'), 'Roto part ids from get_shot_context') }, ['roto_part_ids']),
  },
  {
    name: 'exclude_region',
    description: 'Exclude (or, with mode "include", restrict tracking to) a fixed rectangle for the whole shot — for static areas that should not be tracked, such as a burnt-in overlay, a monitor or empty sky. For things that move, use create_exclusion_matte.',
    schema: obj({ ...box('Rectangle'), mode: oneOf(['exclude', 'include'], 'exclude this area, or track only inside it'), replace_existing: bool('Replace the existing rectangles instead of adding') }, ['x0', 'y0', 'x1', 'y1', 'mode']),
  },
  {
    name: 'export',
    description: 'Write the camera track (or the 2D tracks) into the shot package for the downstream applications. Only when the briefing says exporting is allowed; the export is put up for review, never approved.',
    schema: obj({ what: oneOf(['camera', 'tracks_2d'], 'What to export'), formats: list({ type: 'string', enum: [...CAMERA_EXPORT_FORMATS, ...TRACK2D_EXPORT_FORMATS.filter((f) => !(CAMERA_EXPORT_FORMATS as readonly string[]).includes(f))] }, 'Formats (omit for all)') }, ['what']),
  },
  {
    name: 'finish',
    description: 'End the run with the report the artist reads. Call exactly once, last. Numbers must be those of the active solve (or 2D track) as the tools reported them; the report is checked against the shot and refused if it disagrees.',
    schema: obj(
      {
        summary: str('Two or three plain sentences: the outcome'),
        actions: list(str('one action'), 'What you did, in order'),
        final_stats: obj({ rms_px: num('Active solve RMS'), focal_mm: num('Solved focal length, mm'), frames_solved: int('Frames solved'), frames_total: int('Frames in the shot'), tracks: int('Tracks used'), mean_confidence_2d: num('2D track mean confidence 0–1') }, [], 'Final numbers (omit what does not apply)'),
        targets_met: bool('Whether the targets in the briefing were met'),
        concerns: list(str('one concern'), 'What a supervisor should know'),
        frames_to_check: list(obj({ frame: int('frame'), reason: str('why') }, ['frame', 'reason']), 'Frames a person should look at, and why'),
        next_steps: list(str('one suggestion'), 'Suggested next steps'),
      },
      ['summary', 'actions', 'final_stats', 'targets_met', 'concerns', 'frames_to_check', 'next_steps'],
    ),
  },
  {
    name: 'get_frame_image',
    description: 'See one frame of the shot, downscaled (at most 1024 px wide), optionally with the feature tracks drawn on it ("tracks") or coloured by solve error ("errors"). Use sparingly: to find a surface to track, to see what moves, or to check a problem frame. The reply says how image pixels map to plate pixels.',
    frames: true,
    schema: obj({ frame: int('Frame number'), max_width: int('Longest edge in pixels (256–1024, default 1024)'), overlay: oneOf(['none', 'tracks', 'errors'], 'What to draw on the frame') }, ['frame', 'overlay']),
  },
  {
    name: 'get_shot_context',
    description: 'The shot as it stands: frame range and plate size, the camera and lens (and what the handoff says about them), tracks, solves, exclusions, LiDAR and correspondences, roto parts, 2D tracks, task states and locks, the RMS targets and what this run may do. Call first.',
    schema: obj({}),
  },
  {
    name: 'get_solve_report',
    description: 'The active solve in detail: RMS and focal, per-frame error summarised (worst frames, spikes, unsolved and thin frames), the worst tracks, warnings (nodal, degenerate, few tracks, focal outside the expected range), LiDAR residuals, and whether the targets are met. Call after every solve.',
    schema: obj({ worst_n: int('How many worst tracks to list (default 10, at most 40)'), from_frame: int('Only frames from'), to_frame: int('Only frames to') }),
  },
  {
    name: 'get_track_stats',
    description: 'The feature tracks summarised: count, lengths, per-frame coverage (frames below a healthy count, as ranges), how evenly features spread over the frame (3 × 3 grid on the first, middle and last frames), and track errors when there is a solve. Call before solving and when coverage is in doubt.',
    schema: obj({}),
  },
  {
    name: 'list_lidar_candidates',
    description: 'Candidate correspondences for LiDAR alignment: named survey points, the existing correspondences with residuals, and — when the solve is already aligned — the scan point nearest each well-solved track. Without an alignment or named points there are no trustworthy automatic candidates: then ask the artist to pick at least three correspondences.',
    schema: obj({ lidar_id: str('Which file (default: the first imported)'), max: int('How many candidates (default 12, at most 40)') }),
  },
  {
    name: 'planar_track',
    description: 'Track a flat surface (screen, sign, poster, wall) with the planar tracker. Either track an existing 2D track the artist drew (track_id, from its key frame), or propose a new surface with its four corners — the artist confirms or adjusts your corners before anything is tracked.',
    schema: obj(
      {
        track_id: str('An existing 2D track (from get_shot_context) to track from its key frame'),
        name: str('Name for a new surface, e.g. "laptop screen"'),
        frame: int('Key frame: where the corners are'),
        corners: obj({ tl: xy('top-left corner'), tr: xy('top-right corner'), br: xy('bottom-right corner'), bl: xy('bottom-left corner') }, ['tl', 'tr', 'br', 'bl'], 'Corners of a new surface, clockwise from top-left, plate pixels'),
        direction: oneOf(['both', 'forward', 'backward'], 'Which way to track from the key frame'),
        reason: str('For a new surface: one line the artist sees with the proposal'),
      },
      ['frame', 'direction'],
    ),
  },
  {
    name: 'remove_correspondence',
    description: 'Remove a LiDAR correspondence (for example one whose residual shows a wrong pick).',
    schema: obj({ id: str('Correspondence id') }, ['id']),
  },
  {
    name: 'search_cameras',
    description: 'Search the camera database (bodies and recording modes with film back sizes) by make, model or mode. Use to find the ids for set_camera when the shot’s camera is not set or looks wrong.',
    schema: obj({ query: str('e.g. "Alexa 35", "Venice 2 6K", "Komodo"') }, ['query']),
  },
  {
    name: 'select_solve',
    description: 'Make an earlier solve the active one — for example when a later attempt came out worse.',
    schema: obj({ number: int('Solve number') }, ['number']),
  },
  {
    name: 'set_camera',
    description: 'Set the camera body and recording mode (which fixes the film back) from the database, or type a film back in millimetres. The film back turns the solved focal length into millimetres.',
    schema: obj({ camera_id: str('Camera id from search_cameras'), mode_id: str('Recording mode id'), film_back_width_mm: num('Film back width, mm (instead of a database camera)'), film_back_height_mm: num('Film back height, mm') }),
  },
  {
    name: 'set_coordinate_system',
    description: 'Scene units and up axis for exports, origin at a track, ground plane from three tracks, scale from two tracks a known distance apart. Use when the artist asked for it or LiDAR is not available to give real scale.',
    schema: obj({
      units: oneOf(SCENE_UNITS, 'Scene units'),
      up_axis: oneOf(['y', 'z'], 'Up axis in exports'),
      origin_track_id: int('Track at the origin'),
      ground_track_ids: obj({ a: int('track'), b: int('track'), c: int('track') }, ['a', 'b', 'c'], 'Three tracks on the ground'),
      scale: obj({ track_a: int('track'), track_b: int('track'), distance: num('Real distance between them, in the scene units') }, ['track_a', 'track_b', 'distance'], 'Scale from a known distance'),
    }),
  },
  {
    name: 'set_lens_constraints',
    description: 'What the solve may assume about the lens: the focal length known (held), approximate (refined from a start) or unknown (searched), an expected range, and whether to refine distortion (k1/k2; k3 and tangential only with strong evidence).',
    schema: obj(
      {
        focal_mode: oneOf(['known', 'approx', 'unknown'], 'How far to trust the focal length'),
        focal_mm: num('Focal length in mm (needed for known and approx)'),
        focal_min_mm: num('Expected range: low end, mm'),
        focal_max_mm: num('Expected range: high end, mm'),
        refine_distortion: bool('Refine k1/k2 in the solve'),
        refine_k3: bool('Also refine k3'),
        refine_tangential: bool('Also refine p1/p2'),
        k1: num('Set k1 (when known from a lens profile)'),
        k2: num('Set k2'),
      },
      ['focal_mode'],
    ),
  },
  {
    name: 'solve',
    description: 'Solve the camera from the feature tracks with the current camera and lens settings. Each solve is numbered and becomes the active one. Read get_solve_report afterwards.',
    schema: obj({ loss: oneOf(['huber', 'cauchy'], 'Robust loss: huber (default); cauchy when many outliers remain'), nodal: oneOf(['auto', 'force', 'off'], 'Rotation-only (tripod) handling: auto-detect (default), force or off') }),
  },
  {
    name: 'solve_with_lidar',
    description: 'Re-solve with the LiDAR correspondences as constraints (bundle adjustment in the scan’s coordinates). Needs an aligned solve (align_to_lidar similarity) and at least three correspondences.',
    schema: obj({}),
  },
  {
    name: 'track_features',
    description: 'Track features with fresh detections over a frame range and add them to the existing tracks — for stretches of the shot where coverage is thin.',
    schema: obj({ from_frame: int('First frame'), to_frame: int('Last frame (may be before from_frame to track backwards)') }, ['from_frame', 'to_frame']),
  },
];

/** The tools for a run, in a fixed order (the cached prefix must not change within a run). */
export function agentTools(options: { framesAllowed: boolean }): BetaTool[] {
  return SPECS.filter((s) => !s.frames || options.framesAllowed).map((s) => ({ name: s.name, description: s.description, input_schema: s.schema as BetaTool['input_schema'], strict: true }));
}

export const TOOL_NAMES = SPECS.map((s) => s.name);

/** Check an input against a tool's schema (the subset used here). Returns a problem, or null. */
export function schemaProblem(schema: Schema, value: unknown, path = 'input'): string | null {
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${path} must be an object`;
      const v = value as Record<string, unknown>;
      for (const r of schema.required ?? []) if (v[r] === undefined) return `${path}.${r} is required`;
      for (const [k, x] of Object.entries(v)) {
        const p = schema.properties?.[k];
        if (!p) return `${path}.${k} is not a parameter of this tool`;
        if (x === undefined || x === null) continue;
        const e = schemaProblem(p, x, `${path}.${k}`);
        if (e) return e;
      }
      return null;
    }
    case 'array':
      if (!Array.isArray(value)) return `${path} must be an array`;
      if (value.length > 500) return `${path} has too many items`;
      for (let i = 0; i < value.length; i += 1) {
        const e = schema.items ? schemaProblem(schema.items, value[i], `${path}[${i}]`) : null;
        if (e) return e;
      }
      return null;
    case 'string':
      if (typeof value !== 'string') return `${path} must be a string`;
      if (value.length > 4000) return `${path} is too long`;
      if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of ${schema.enum.join(', ')}`;
      return null;
    case 'integer':
      return Number.isInteger(value) ? null : `${path} must be an integer`;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : `${path} must be a number`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${path} must be true or false`;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const json = (v: unknown) => JSON.stringify(v);

/** "1001–1012, 1020" from sorted frame numbers. */
export function frameRanges(frames: readonly number[], max = 12): string {
  if (!frames.length) return 'none';
  const out: string[] = [];
  let a = frames[0]!;
  let b = a;
  for (let i = 1; i <= frames.length; i += 1) {
    const f = frames[i];
    if (f !== undefined && f === b + 1) {
      b = f;
      continue;
    }
    out.push(a === b ? `${a}` : `${a}–${b}`);
    if (f !== undefined) a = b = f;
  }
  return out.length > max ? `${out.slice(0, max).join(', ')} … (${out.length - max} more)` : out.join(', ');
}

const fail = (content: string, summary = content): ToolOutcome => ({ ok: false, content, summary: summary.slice(0, 200) });
const done = (summary: string, data: unknown): ToolOutcome => ({ ok: true, content: data === undefined ? summary : `${summary}\n${json(data)}`, summary });

function doc(host: TrackHost): CamTrackDocument {
  const p = host.project();
  return shotState(p, host.shotId)?.camtrack ?? newCamTrackDocument(p, host.shotId);
}

/** Run a command and apply its ops; the outcome, or why not. */
async function run(host: TrackHost, ctx: ToolContext, command: CameraCommand): Promise<{ ok: true; summary: string; data: Record<string, unknown> } | { ok: false; error: string }> {
  if (ctx.signal?.aborted) return { ok: false, error: 'Cancelled' };
  const out = await host.command(command, ctx.signal);
  if (!out.ok) {
    ctx.onCommand?.({ verb: command.verb, ok: false, summary: out.error });
    return { ok: false, error: out.error };
  }
  const applied = await host.apply(out.ops);
  if (!applied.ok) {
    ctx.onCommand?.({ verb: command.verb, ok: false, summary: applied.reason });
    return { ok: false, error: `The project refused the change: ${applied.reason}` };
  }
  ctx.onCommand?.({ verb: command.verb, ok: true, summary: out.summary });
  return { ok: true, summary: out.summary, data: out.data };
}

async function applyOps(host: TrackHost, ctx: ToolContext, verb: string, ops: AiOp[], summary: string): Promise<string | null> {
  const r = await host.apply(ops);
  ctx.onCommand?.({ verb, ok: r.ok, summary: r.ok ? summary : r.reason });
  return r.ok ? null : r.reason;
}

const rectOf = (i: { x0: number; y0: number; x1: number; y1: number }): Rect => ({ x0: Math.min(i.x0, i.x1), y0: Math.min(i.y0, i.y1), x1: Math.max(i.x0, i.x1), y1: Math.max(i.y0, i.y1) });

/** Per-frame counts of tracks present. */
function coverage(t: NonNullable<TrackViewData['tracks']>): number[] {
  const n = t.last - t.first + 1;
  const diff = new Int32Array(n + 1);
  for (let i = 0; i < t.ids.length; i += 1) {
    const a = t.start[i]! - t.first;
    const b = a + t.length[i]!;
    if (b <= 0 || a >= n) continue;
    diff[Math.max(0, a)]! += 1;
    diff[Math.min(n, b)]! -= 1;
  }
  const out: number[] = [];
  let c = 0;
  for (let k = 0; k < n; k += 1) {
    c += diff[k]!;
    out.push(c);
  }
  return out;
}

function grid3(t: NonNullable<TrackViewData['tracks']>, frame: number, plate: { width: number; height: number }): number[][] {
  const g = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < t.ids.length; i += 1) {
    const s = t.start[i]!;
    if (frame < s || frame >= s + t.length[i]!) continue;
    const o = (t.offset[i]! + frame - s) * 2;
    const cx = clamp(Math.floor((t.xy[o]! / plate.width) * 3), 0, 2);
    const cy = clamp(Math.floor((t.xy[o + 1]! / plate.height) * 3), 0, 2);
    g[cy]![cx]! += 1;
  }
  return g;
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

type In = Record<string, unknown>;
type Executor = (host: TrackHost, ctx: ToolContext, input: In) => Promise<ToolOutcome>;

const EXECUTORS: Record<string, Executor> = {
  async get_shot_context(host, ctx) {
    const p = host.project();
    const s = shotState(p, host.shotId);
    if (!s) return fail(`No shot ${host.shotId}`);
    const session = await host.session();
    const d = doc(host);
    const shot = handoffShot(p, host.shotId);
    const cam = shot?.camera;
    const task = (kind: string) => {
      const t = s.tasks.find((x) => x.kind === kind);
      return t ? { state: t.state, version: t.version } : null;
    };
    const plate = session.plate;
    const data = {
      shot: { id: host.shotId, name: s.vfxShotId ?? host.shotId, stage: s.stage, frames: session.available ? { first: session.first, last: session.last, count: session.last - session.first + 1 } : null, fps: session.fps, plate, working: session.working, frameSource: session.frames, sample: Boolean(session.sample), unavailable: session.available ? undefined : session.reason },
      tasks: {
        camera_track: task('camera_track') && { ...task('camera_track'), locked: camtrackLocked(s), exportVersion: camtrackTaskVersion(s) },
        track_2d: task('track_2d') && { ...task('track_2d'), locked: track2dLocked(s), exportVersion: track2dTaskVersion(s) },
        roto: task('roto') && { ...task('roto'), locked: rotoLocked(s) },
      },
      handoffCamera: cam ? { body: cam.body, sensorMode: cam.sensorMode, filmBackMm: cam.filmBackMm, lens: cam.lens, focalMm: cam.focalLengthMm } : null,
      // Addendum 17: the plate's pixel aspect, which the solve models (fx = f / a) and every export declares.
      pixelAspect: (() => {
        const par = shotPixelAspect(p, host.shotId);
        return { value: par.value, source: par.source, warnings: par.warnings };
      })(),
      camera: d.camera ? { label: d.camera.label, cameraId: d.camera.cameraId, modeId: d.camera.modeId, filmBackMm: d.camera.filmBackMm, verified: d.camera.verified, source: d.camera.source } : null,
      lens: { name: d.lens.name, focalMm: d.lens.focalMm, focalMode: d.lens.focalMode, distortion: { k1: d.lens.distortion.k1, k2: d.lens.distortion.k2 }, refine: d.lens.refine, profile: d.lens.profileId },
      trackSettings: { maxFeatures: d.trackSettings.maxFeatures, workingWidth: d.trackSettings.workingWidth, minDistance: d.trackSettings.minDistance },
      tracks: d.trackSet ? { count: d.trackSet.tracks, meanLength: d.trackSet.meanLength, minPerFrame: d.trackSet.minPerFrame, medianPerFrame: d.trackSet.medianPerFrame, deletedSoFar: d.trackSet.deleted } : null,
      solves: d.solves.slice(-6).map((x) => ({ number: x.number, rmsPx: r3(x.stats.rms), frames: `${x.stats.framesSolved}/${x.stats.framesTotal}`, tracks: x.stats.tracksUsed, focalMm: x.intrinsics.focalMm === null ? null : r2(x.intrinsics.focalMm), focalPx: r1(x.intrinsics.focalPx), confidence: r2(x.stats.confidence), nodal: x.stats.nodal, warnings: x.stats.warnings.length, lidar: x.constraint !== 'none', by: x.by })),
      activeSolve: d.activeSolve,
      exclusions: { rotoParts: d.masks.excludeRotoParts, rects: d.masks.rects.length },
      lidar: d.lidar.map((l) => ({ id: l.id, name: l.name, format: l.format, points: l.points, units: l.units, up: l.up, survey: l.survey, namedPoints: l.named.length })),
      correspondences: d.correspondences.map((c) => ({ id: c.id, name: c.name, lidarId: c.lidarId, target: c.target.kind === 'track' ? `track ${c.target.trackId}` : `pixel on ${c.target.frame}`, residualPx: c.residualPx, residualMm: c.residualMm })),
      alignment: d.alignment ? { method: d.alignment.method, solve: d.alignment.solve, rmsMm: d.alignment.rmsMm, rmsPx: d.alignment.rmsPx, confidence: r2(d.alignment.confidence) } : null,
      coords: { units: d.coords.units, upAxis: d.coords.upAxis, origin: d.coords.origin.kind, ground: Boolean(d.coords.ground), scale: Boolean(d.coords.scale) },
      rotoParts: (s.roto?.parts ?? []).map((x) => ({ id: x.id, name: x.name, keyFrames: x.keyFrames.map((k) => k.frame), matteFrames: x.frames.length })),
      tracks2d: (s.track2d?.tracks ?? []).map((t) => ({ id: t.id, name: t.name, kind: t.kind, keys: t.keys.map((k) => k.frame), tracked: t.frames.filter((f) => f.status === 'tracked').length, lost: t.frames.filter((f) => f.status === 'lost').length })),
      targets: plate ? { rmsGoodPx: rmsTarget(plate.width).good, rmsAcceptablePx: rmsTarget(plate.width).acceptable, minTracksPerFrame: 20 } : null,
      run: { framesAllowed: ctx.framesAllowed, exportAllowed: ctx.exportAllowed, imagesLeft: ctx.framesAllowed ? ctx.maxImages - ctx.imagesUsed : 0, roto: Boolean(host.roto) },
    };
    return done(`Shot ${data.shot.name}: ${data.tracks ? `${data.tracks.count} tracks` : 'no tracks'}, ${d.solves.length} solve${d.solves.length === 1 ? '' : 's'}${d.activeSolve ? ` (active ${d.activeSolve})` : ''}`, data);
  },

  async search_cameras(host, _ctx, i) {
    const q = String(i['query'] ?? '').toLowerCase();
    const extra = host.project().customCameras;
    const words = q.split(/[^a-z0-9.]+/).filter(Boolean);
    const scored = [...extra, ...CAMERA_DB]
      .map((c) => {
        const hay = `${c.make} ${c.model} ${c.id} ${c.modes.map((m) => m.name).join(' ')}`.toLowerCase();
        return { c, s: words.filter((w) => hay.includes(w)).length };
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 5);
    const best = matchCamera({ body: String(i['query'] ?? '') }, extra);
    const bodies = [...(best ? [best.camera] : []), ...scored.map((x) => x.c)].filter((c, k, a) => a.findIndex((y) => y.id === c.id) === k).slice(0, 5);
    if (!bodies.length) return done(`No camera matched “${i['query']}”. Type the film back instead (set_camera with film_back_width_mm and film_back_height_mm).`, undefined);
    return done(
      `${bodies.length} camera${bodies.length === 1 ? '' : 's'} for “${i['query']}”`,
      bodies.map((c) => ({ id: c.id, name: `${c.make} ${c.model}`, modes: c.modes.slice(0, 12).map((m) => ({ id: m.id, name: m.name, filmBackMm: m.filmBackMm, px: m.px, verified: m.verified })) })),
    );
  },

  async set_camera(host, ctx, i) {
    const w = i['film_back_width_mm'] as number | undefined;
    const h = i['film_back_height_mm'] as number | undefined;
    let command: CameraCommand;
    if (w !== undefined || h !== undefined) {
      if (w === undefined || h === undefined) return fail('A typed film back needs both film_back_width_mm and film_back_height_mm.');
      command = { verb: 'set_camera', filmBackMm: { width: w, height: h } };
    } else {
      const id = i['camera_id'] as string | undefined;
      if (!id) return fail('Give camera_id (from search_cameras) or a film back.');
      const body = findCamera(id, host.project().customCameras);
      if (!body) return fail(`No camera ${id}; use search_cameras.`);
      const mode = i['mode_id'] as string | undefined;
      if (mode && !body.modes.some((m) => m.id === mode)) return fail(`${body.make} ${body.model} has no mode ${mode}; its modes are ${body.modes.map((m) => m.id).join(', ')}`);
      command = { verb: 'set_camera', cameraId: id, ...(mode ? { modeId: mode } : {}) };
    }
    const r = await run(host, ctx, command);
    return r.ok ? done(r.summary, undefined) : fail(r.error);
  },

  async set_lens_constraints(host, ctx, i) {
    const mode = i['focal_mode'] as 'known' | 'approx' | 'unknown';
    const lo = i['focal_min_mm'] as number | undefined;
    const hi = i['focal_max_mm'] as number | undefined;
    if ((lo === undefined) !== (hi === undefined)) return fail('Give both ends of the focal range, or neither.');
    if (lo !== undefined && hi !== undefined) {
      if (!(lo > 0 && hi >= lo)) return fail('The focal range must be positive, low end first.');
      ctx.focalRange = { min: lo, max: hi };
    }
    let focal = i['focal_mm'] as number | undefined;
    if (mode !== 'unknown' && focal === undefined) focal = ctx.focalRange ? (ctx.focalRange.min + ctx.focalRange.max) / 2 : (doc(host).lens.focalMm ?? undefined);
    if (mode !== 'unknown' && !(focal && focal > 0 && focal < 2000)) return fail('A known or approximate focal length needs focal_mm.');
    const refine: Partial<Record<'k1k2' | 'k3' | 'p1p2', boolean>> = {};
    if (i['refine_distortion'] !== undefined) refine.k1k2 = Boolean(i['refine_distortion']);
    if (i['refine_k3'] !== undefined) refine.k3 = Boolean(i['refine_k3']);
    if (i['refine_tangential'] !== undefined) refine.p1p2 = Boolean(i['refine_tangential']);
    const distortion: Partial<Record<'k1' | 'k2', number>> = {};
    if (typeof i['k1'] === 'number') distortion.k1 = clamp(i['k1'] as number, -2, 2);
    if (typeof i['k2'] === 'number') distortion.k2 = clamp(i['k2'] as number, -2, 2);
    const r = await run(host, ctx, { verb: 'set_lens', focalMode: mode, ...(focal ? { focalMm: r2(focal) } : {}), ...(Object.keys(refine).length ? { refine } : {}), ...(Object.keys(distortion).length ? { distortion } : {}) });
    if (!r.ok) return fail(r.error);
    return done(`${r.summary}${ctx.focalRange ? `; expected range ${ctx.focalRange.min}–${ctx.focalRange.max} mm (checked after each solve)` : ''}`, undefined);
  },

  async auto_track(host, ctx, i) {
    const settings: { maxFeatures?: number; minDistance?: number } = {};
    if (typeof i['max_features'] === 'number') settings.maxFeatures = Math.round(clamp(i['max_features'] as number, 100, 2000));
    if (typeof i['min_distance_px'] === 'number') settings.minDistance = r1(clamp(i['min_distance_px'] as number, 3, 200));
    if (Object.keys(settings).length) {
      const s = await run(host, ctx, { verb: 'set_track_settings', ...settings });
      if (!s.ok) return fail(s.error);
    }
    const r = await run(host, ctx, { verb: 'auto_track', append: i['replace_existing'] === false });
    if (!r.ok) return fail(r.error);
    const dd = r.data;
    return done(r.summary, { tracks: dd['tracks'], meanLength: r1(Number(dd['meanLength'])), minPerFrame: dd['minPerFrame'], medianPerFrame: dd['medianPerFrame'] });
  },

  async detect_features(host, ctx, i) {
    if (typeof i['min_distance_px'] === 'number') {
      const s = await run(host, ctx, { verb: 'set_track_settings', minDistance: r1(clamp(i['min_distance_px'] as number, 3, 200)) });
      if (!s.ok) return fail(s.error);
    }
    const region = i['region'] as Rect | undefined;
    const r = await run(host, ctx, { verb: 'detect_features', frame: i['frame'] as number, maxFeatures: Math.round(clamp((i['count'] as number | undefined) ?? 60, 10, 400)), ...(region ? { region: rectOf(region) } : {}) });
    return r.ok ? done(r.summary, { added: r.data['added'], total: r.data['total'] }) : fail(r.error);
  },

  async track_features(host, ctx, i) {
    const r = await run(host, ctx, { verb: 'track_features', from: i['from_frame'] as number, to: i['to_frame'] as number });
    return r.ok ? done(r.summary, { added: r.data['added'], total: r.data['total'] }) : fail(r.error);
  },

  async get_track_stats(host) {
    const [v, session] = await Promise.all([host.view(), host.session()]);
    const t = v.tracks;
    if (!t || !t.ids.length) return done('There are no tracks yet: auto_track first.', undefined);
    const plate = session.plate ?? { width: 1, height: 1 };
    const lengths = Array.from(t.length);
    const cov = coverage(t);
    const med = median(cov);
    const thin = Math.max(12, Math.round(0.35 * med));
    const thinFrames = cov.flatMap((c, k) => (c < thin ? [t.first + k] : []));
    const mid = Math.round((t.first + t.last) / 2);
    const sorted = [...lengths].sort((a, b) => a - b);
    let errors: Record<string, unknown> | undefined;
    if (v.solve) {
      const e = Array.from(v.solve.trackRms).filter((x) => Number.isFinite(x) && x > 0);
      errors = { solve: v.solve.number, medianTrackRmsPx: r3(median(e)), above1px: e.filter((x) => x > 1).length, above2px: e.filter((x) => x > 2).length, worstPx: r2(Math.max(0, ...e)) };
    }
    const data = {
      tracks: t.ids.length,
      length: { min: sorted[0], median: median(lengths), mean: r1(lengths.reduce((a, b) => a + b, 0) / lengths.length), p90: sorted[Math.floor(0.9 * (sorted.length - 1))], under5Frames: lengths.filter((l) => l < 5).length },
      perFrame: { min: Math.min(...cov), median: med, max: Math.max(...cov), thinThreshold: thin, thinFrames: frameRanges(thinFrames) },
      spread3x3: { [t.first]: grid3(t, t.first, plate), [mid]: grid3(t, mid, plate), [t.last]: grid3(t, t.last, plate) },
      errors,
    };
    return done(`${t.ids.length} tracks; ${Math.min(...cov)}–${Math.max(...cov)} per frame (median ${med})${thinFrames.length ? `; thin on ${frameRanges(thinFrames, 4)}` : ''}`, data);
  },

  async delete_tracks(host, ctx, i) {
    const ids = (i['ids'] as number[] | undefined) ?? [];
    const errAbove = i['error_above_px'] as number | undefined;
    const shorter = i['shorter_than_frames'] as number | undefined;
    const region = i['region'] as (Rect & { frame: number }) | undefined;
    if (!ids.length && errAbove === undefined && shorter === undefined && !region) return fail('Give at least one criterion: ids, error_above_px, shorter_than_frames or region.');
    if (errAbove !== undefined && !(errAbove > 0)) return fail('error_above_px must be positive.');
    // Predict how many would go, to refuse a sweeping deletion.
    const v = await host.view();
    const t = v.tracks;
    if (t && t.ids.length && !i['allow_large']) {
      const rms = new Map<number, number>();
      if (v.solve) v.solve.trackIds.forEach((id, k) => rms.set(id, v.solve!.trackRms[k]!));
      const want = new Set(ids);
      const rr = region ? rectOf(region) : null;
      let n = 0;
      for (let k = 0; k < t.ids.length; k += 1) {
        const id = t.ids[k]!;
        let hit = want.has(id) || (shorter !== undefined && t.length[k]! < shorter) || (errAbove !== undefined && (rms.get(id) ?? 0) > errAbove);
        if (!hit && rr && region) {
          const s = t.start[k]!;
          if (region.frame >= s && region.frame < s + t.length[k]!) {
            const o = (t.offset[k]! + region.frame - s) * 2;
            hit = t.xy[o]! >= rr.x0 && t.xy[o]! <= rr.x1 && t.xy[o + 1]! >= rr.y0 && t.xy[o + 1]! <= rr.y1;
          }
        }
        if (hit) n += 1;
      }
      if (n > 0.4 * t.ids.length) return fail(`That would delete about ${n} of ${t.ids.length} tracks (over 40%). Use a narrower criterion, or allow_large if you are sure.`);
    }
    const r = await run(host, ctx, { verb: 'delete_tracks', ...(ids.length ? { ids } : {}), ...(errAbove !== undefined ? { maxErrorPx: errAbove } : {}), ...(shorter !== undefined ? { minLength: shorter } : {}), ...(region ? { region: { ...rectOf(region), frame: region.frame } } : {}) });
    return r.ok ? done(r.summary, { deleted: r.data['deleted'], remaining: r.data['remaining'] }) : fail(r.error);
  },

  async exclude_moving_objects(host, ctx, i) {
    const want = (i['roto_part_ids'] as string[]) ?? [];
    const parts = shotState(host.project(), host.shotId)?.roto?.parts ?? [];
    const missing = want.filter((id) => !parts.some((p) => p.id === id));
    if (missing.length) return fail(`No roto part ${missing.join(', ')}. Parts on this shot: ${parts.map((p) => `${p.id} (${p.name})`).join(', ') || 'none'}.`);
    const current = doc(host).masks.excludeRotoParts;
    const r = await run(host, ctx, { verb: 'set_masks', excludeRotoParts: [...new Set([...current, ...want])] });
    return r.ok ? done(`${r.summary}. Re-run auto_track for it to take effect.`, undefined) : fail(r.error);
  },

  async exclude_region(host, ctx, i) {
    const rect = { ...rectOf(i as unknown as Rect), mode: i['mode'] as 'include' | 'exclude' };
    const rects = i['replace_existing'] ? [rect] : [...doc(host).masks.rects, rect];
    const r = await run(host, ctx, { verb: 'set_masks', rects });
    return r.ok ? done(`${r.summary}. Re-run auto_track for it to take effect.`, undefined) : fail(r.error);
  },

  async create_exclusion_matte(host, ctx, i) {
    if (!host.roto) return fail('Roto cannot run here, so no matte can be made. Use exclude_region for a fixed area, or ask the artist to paint the object in the Roto tab.');
    const p0 = host.project();
    const s0 = shotState(p0, host.shotId);
    if (!s0) return fail(`No shot ${host.shotId}`);
    const locked = rotoLocked(s0);
    if (locked) return fail(`${locked} (The matte is kept as a roto part, so the shot needs a Paint-to-roto task the artist can review.)`);
    const session = await host.session();
    const plate = session.plate;
    if (!plate) return fail('The shot has no frames to work on.');
    const name = String(i['name']).trim().slice(0, 64) || 'moving object';
    const frame = i['frame'] as number;
    const b = rectOf(i as unknown as Rect);
    const bx0 = clamp(b.x0, 0, plate.width - 1);
    const bx1 = clamp(b.x1, 0, plate.width - 1);
    const by0 = clamp(b.y0, 0, plate.height - 1);
    const by1 = clamp(b.y1, 0, plate.height - 1);
    if (bx1 - bx0 < 8 || by1 - by0 < 8) return fail('The box is too small (under 8 px).');
    const before = new Set((s0.roto?.parts ?? []).map((x) => x.id));
    const e1 = await applyOps(host, ctx, 'roto.part_added', [{ op: 'roto_part', input: { name } }], `Roto part ${name} for a tracking exclusion`);
    if (e1) return fail(e1);
    const part = shotState(host.project(), host.shotId)?.roto?.parts.find((x) => !before.has(x.id));
    if (!part) return fail('The roto part could not be created.');
    // Include: a zig-zag filling the box's middle; exclude: a ring just outside it.
    const radius = Math.round(clamp(Math.min(bx1 - bx0, by1 - by0) / 8, 3, 120));
    const inset = radius * 1.5;
    const zig: [number, number][] = [];
    for (let y = by0 + inset, k = 0; y <= by1 - inset; y += radius * 1.5, k += 1) zig.push(k % 2 ? [bx1 - inset, y] : [bx0 + inset, y], k % 2 ? [bx0 + inset, y] : [bx1 - inset, y]);
    if (!zig.length) zig.push([(bx0 + bx1) / 2, (by0 + by1) / 2]);
    const m = radius * 2.5;
    const ex0 = clamp(bx0 - m, 0, plate.width - 1);
    const ex1 = clamp(bx1 + m, 0, plate.width - 1);
    const ey0 = clamp(by0 - m, 0, plate.height - 1);
    const ey1 = clamp(by1 + m, 0, plate.height - 1);
    const ring: [number, number][] = [[ex0, ey0], [ex1, ey0], [ex1, ey1], [ex0, ey1], [ex0, ey0]];
    const e2 = await applyOps(
      host,
      ctx,
      'roto.stroke',
      [
        { op: 'roto_stroke', partId: part.id, frame, stroke: { mode: 'include', radius, points: zig } },
        { op: 'roto_stroke', partId: part.id, frame, stroke: { mode: 'exclude', radius: Math.max(3, Math.round(radius / 2)), points: ring } },
      ],
      `${name} frame ${frame}: include and exclude strokes from a box`,
    );
    if (e2) return fail(e2);
    const dir = i['direction'] as string;
    const directions: RotoDirection[] = ['key', ...(dir === 'backward' ? [] : (['forward'] as RotoDirection[])), ...(dir === 'forward' ? [] : (['backward'] as RotoDirection[]))];
    let results: RotoPropagationResult[];
    try {
      results = await host.roto(part.id, frame, directions, ctx.signal);
    } catch (error) {
      ctx.onCommand?.({ verb: 'roto.run', ok: false, summary: (error as Error).message });
      return fail(`The matte could not be propagated: ${(error as Error).message}`);
    }
    const frames = results.flatMap((r) => r.frames);
    const e3 = await applyOps(host, ctx, 'roto.propagated', results.map((result) => ({ op: 'roto_propagation' as const, result })), `${name}: ${frames.length} frames`);
    if (e3) return fail(e3);
    const r = await run(host, ctx, { verb: 'set_masks', excludeRotoParts: [...new Set([...doc(host).masks.excludeRotoParts, part.id])] });
    if (!r.ok) return fail(r.error);
    const conf = frames.map((f) => f.confidence);
    const low = frames.filter((f) => f.confidence < 0.6).map((f) => f.frame).sort((a, b) => a - b);
    return done(`Matte ${part.id} over ${frames.length} frames (mean confidence ${r2(conf.reduce((a, b) => a + b, 0) / Math.max(1, conf.length))}); excluded from tracking. Re-run auto_track.`, { partId: part.id, frames: frames.length, minConfidence: r2(Math.min(1, ...conf)), lowConfidenceFrames: frameRanges(low) });
  },

  async solve(host, ctx, i) {
    const prev = doc(host).solves.find((x) => x.number === doc(host).activeSolve);
    const nodal = i['nodal'] as string | undefined;
    const r = await run(host, ctx, { verb: 'solve', ...(i['loss'] ? { loss: i['loss'] as 'huber' | 'cauchy' } : {}), ...(nodal === 'force' ? { nodal: true } : nodal === 'off' ? { nodal: false } : {}) });
    if (!r.ok) return fail(r.error);
    const dd = r.data;
    const focalMm = dd['focalMm'] as number | null;
    const notes: string[] = [];
    if (prev) notes.push(`previous active solve ${prev.number}: RMS ${r3(prev.stats.rms)} px → ${r3(Number(dd['rms']))} px`);
    if (ctx.focalRange && focalMm !== null && (focalMm < ctx.focalRange.min || focalMm > ctx.focalRange.max)) notes.push(`focal ${r2(focalMm)} mm is outside the expected ${ctx.focalRange.min}–${ctx.focalRange.max} mm`);
    return done(r.summary, { solve: dd['solve'], rmsPx: r3(Number(dd['rms'])), frames: `${dd['framesSolved']}/${dd['framesTotal']}`, tracks: dd['tracks'], focalMm: focalMm === null ? null : r2(focalMm), focalPx: r1(Number(dd['focalPx'])), confidence: r2(Number(dd['confidence'])), nodal: dd['nodal'], warnings: (dd['warnings'] as string[]).slice(0, 6), notes });
  },

  async get_solve_report(host, ctx, i) {
    const worst = Math.round(clamp((i['worst_n'] as number | undefined) ?? 10, 1, 40));
    const from = i['from_frame'] as number | undefined;
    const to = i['to_frame'] as number | undefined;
    const r = await run(host, ctx, { verb: 'get_report', worst, ...(from !== undefined && to !== undefined ? { frames: [Math.min(from, to), Math.max(from, to)] as [number, number] } : {}) });
    if (!r.ok) return fail(r.error);
    const session = await host.session();
    const dd = r.data as { solve: number; stats: { rms: number; medianError: number; framesSolved: number; framesTotal: number; tracksUsed: number; tracksTotal: number; nodal: boolean; confidence: number; minTracksPerFrame: number; warnings: string[] }; intrinsics: { focalPx: number; focalMm: number | null; k1: number; k2: number }; perFrame: { frame: number; solved: boolean; rmsPx: number; tracks: number }[]; worstTracks: { id: number; rmsPx: number; length: number }[]; correspondences: { id: string; name: string; residualPx: number | null; residualMm: number | null }[]; alignment: unknown };
    const solved = dd.perFrame.filter((f) => f.solved);
    const med = median(solved.map((f) => f.rmsPx));
    const spikeAt = Math.max(2 * med, med + 0.5);
    const target = rmsTarget(session.plate?.width ?? 1920);
    const warnings = [...dd.stats.warnings.slice(0, 8)];
    if (ctx.focalRange && dd.intrinsics.focalMm !== null && (dd.intrinsics.focalMm < ctx.focalRange.min || dd.intrinsics.focalMm > ctx.focalRange.max)) warnings.push(`Focal ${r2(dd.intrinsics.focalMm)} mm is outside the expected ${ctx.focalRange.min}–${ctx.focalRange.max} mm`);
    const thinFrames = solved.filter((f) => f.tracks < 20).map((f) => f.frame);
    const unsolved = dd.perFrame.filter((f) => !f.solved).map((f) => f.frame);
    const data = {
      solve: dd.solve,
      rmsPx: r3(dd.stats.rms),
      medianErrorPx: r3(dd.stats.medianError),
      frames: `${dd.stats.framesSolved}/${dd.stats.framesTotal}`,
      tracks: `${dd.stats.tracksUsed}/${dd.stats.tracksTotal}`,
      focalMm: dd.intrinsics.focalMm === null ? null : r2(dd.intrinsics.focalMm),
      focalPx: r1(dd.intrinsics.focalPx),
      distortion: { k1: Number(dd.intrinsics.k1.toFixed(5)), k2: Number(dd.intrinsics.k2.toFixed(5)) },
      confidence: r2(dd.stats.confidence),
      nodal: dd.stats.nodal,
      minTracksPerFrame: dd.stats.minTracksPerFrame,
      perFrame: {
        medianRmsPx: r3(med),
        worst: [...solved].sort((a, b) => b.rmsPx - a.rmsPx).slice(0, 8).map((f) => ({ frame: f.frame, rmsPx: r3(f.rmsPx), tracks: f.tracks })),
        spikes: frameRanges(solved.filter((f) => f.rmsPx > spikeAt).map((f) => f.frame)),
        unsolved: frameRanges(unsolved),
        under20Tracks: frameRanges(thinFrames),
      },
      worstTracks: dd.worstTracks.map((t) => ({ id: t.id, rmsPx: r3(t.rmsPx), length: t.length })),
      warnings,
      lidar: dd.correspondences.length ? { correspondences: dd.correspondences, alignment: dd.alignment } : null,
      targets: { goodPx: target.good, acceptablePx: target.acceptable, rmsMet: dd.stats.rms <= target.good, rmsAcceptable: dd.stats.rms <= target.acceptable, allFramesSolved: unsolved.length === 0, coverageMet: thinFrames.length === 0 },
    };
    return done(r.summary, data);
  },

  async select_solve(host, ctx, i) {
    const r = await run(host, ctx, { verb: 'select_solve', number: i['number'] as number });
    return r.ok ? done(r.summary, undefined) : fail(r.error);
  },

  async list_lidar_candidates(host, _ctx, i) {
    const d = doc(host);
    if (!d.lidar.length) return done('No LiDAR or survey file is imported on this shot. Ask the artist to import one (LiDAR › Import…).', undefined);
    const ref = d.lidar.find((l) => l.id === i['lidar_id']) ?? d.lidar[0]!;
    const max = Math.round(clamp((i['max'] as number | undefined) ?? 12, 1, 40));
    const named = ref.named.slice(0, max).map((p) => ({ name: p.name, point: p.X.map(r3) }));
    const existing = d.correspondences.filter((c) => c.lidarId === ref.id).map((c) => ({ id: c.id, name: c.name, target: c.target.kind === 'track' ? `track ${c.target.trackId}` : `pixel on ${c.target.frame}`, residualPx: c.residualPx, residualMm: c.residualMm }));
    let nearest: { trackId: number; trackRmsPx: number; point: number[]; distance: number }[] = [];
    let note = '';
    if (d.alignment && d.alignment.lidarId === ref.id && d.alignment.solve === d.activeSolve) {
      const v = await host.view({ clouds: true });
      const cloud = v.clouds.find((c) => c.id === ref.id);
      if (v.solve && cloud) {
        const T: Similarity = { s: d.alignment.transform.s, R: [...d.alignment.transform.R], t: [...d.alignment.transform.t] };
        const cands = Array.from(v.solve.trackIds, (id, k) => ({ id, k, e: v.solve!.trackRms[k]! }))
          .filter((x) => Number.isFinite(v.solve!.X[3 * x.k]!) && x.e > 0)
          .sort((a, b) => a.e - b.e)
          .slice(0, max);
        const P = cloud.positions;
        nearest = cands.map((c) => {
          const X = applySim(T, [v.solve!.X[3 * c.k]!, v.solve!.X[3 * c.k + 1]!, v.solve!.X[3 * c.k + 2]!]);
          let best = Infinity;
          let bi = 0;
          for (let j = 0; j < P.length; j += 3) {
            const dx = P[j]! + cloud.origin[0] - X[0]!;
            const dy = P[j + 1]! + cloud.origin[1] - X[1]!;
            const dz = P[j + 2]! + cloud.origin[2] - X[2]!;
            const q = dx * dx + dy * dy + dz * dz;
            if (q < best) {
              best = q;
              bi = j;
            }
          }
          return { trackId: c.id, trackRmsPx: r3(c.e), point: [P[bi]! + cloud.origin[0], P[bi + 1]! + cloud.origin[1], P[bi + 2]! + cloud.origin[2]].map(r3), distance: r3(Math.sqrt(best)) };
        });
        note = `Nearest scan points to the best-solved tracks under the current alignment; distances in ${ref.units}. Small distances are refinements of the alignment, not independent evidence.`;
      }
    } else if (!named.length) note = 'The solve is not aligned to this scan and it has no named points, so there are no trustworthy automatic candidates. Ask the artist to pick at least three correspondences (Pick correspondence), then align.';
    return done(`${ref.name}: ${named.length} named point${named.length === 1 ? '' : 's'}, ${existing.length} correspondence${existing.length === 1 ? '' : 's'}${nearest.length ? `, ${nearest.length} nearest-point candidates` : ''}`, { lidarId: ref.id, units: ref.units, named, existing, nearest, note });
  },

  async add_correspondence(host, ctx, i) {
    const d = doc(host);
    const ref = d.lidar.find((l) => l.id === i['lidar_id']);
    if (!ref) return fail(`No LiDAR ${String(i['lidar_id'])}; imported: ${d.lidar.map((l) => l.id).join(', ') || 'none'}`);
    let point: [number, number, number] | null = null;
    let name = i['name'] as string | undefined;
    if (typeof i['survey_point'] === 'string') {
      const np = ref.named.find((p) => p.name.toLowerCase() === (i['survey_point'] as string).toLowerCase());
      if (!np) return fail(`${ref.name} has no point named ${i['survey_point']}`);
      point = [np.X[0]!, np.X[1]!, np.X[2]!];
      name ??= np.name;
    } else if (i['point']) {
      const q = i['point'] as { x: number; y: number; z: number };
      point = [q.x, q.y, q.z];
    }
    if (!point) return fail('Give the scan point (point) or a survey_point name.');
    const target = i['track_id'] !== undefined ? { trackId: i['track_id'] as number } : i['frame'] !== undefined && i['x'] !== undefined && i['y'] !== undefined ? { frame: i['frame'] as number, x: i['x'] as number, y: i['y'] as number } : null;
    if (!target) return fail('Give a track_id, or a frame with x and y.');
    const r = await run(host, ctx, { verb: 'add_correspondence', lidarId: ref.id, point, ...target, ...(name ? { name } : {}) });
    return r.ok ? done(r.summary, { id: r.data['id'] }) : fail(r.error);
  },

  async remove_correspondence(host, ctx, i) {
    const r = await run(host, ctx, { verb: 'remove_correspondence', id: String(i['id']) });
    return r.ok ? done(r.summary, undefined) : fail(r.error);
  },

  async align_to_lidar(host, ctx, i) {
    const r = await run(host, ctx, { verb: 'align_to_lidar', method: i['method'] as 'similarity' | 'icp', ...(i['lidar_id'] ? { lidarId: String(i['lidar_id']) } : {}) });
    if (!r.ok) return fail(r.error);
    const dd = r.data;
    return done(r.summary, { scale: Number(Number(dd['scale']).toFixed(5)), rmsMm: dd['rmsMm'] === null ? null : r1(Number(dd['rmsMm'])), rmsPx: dd['rmsPx'] === null ? null : r2(Number(dd['rmsPx'])), confidence: r2(Number(dd['confidence'])), correspondences: dd['correspondences'] });
  },

  async solve_with_lidar(host, ctx) {
    const r = await run(host, ctx, { verb: 'solve', useLidar: true });
    if (!r.ok) return fail(r.error);
    const d = doc(host);
    return done(r.summary, { solve: r.data['solve'], rmsPx: r3(Number(r.data['rms'])), lidarRmsMm: d.alignment?.rmsMm === null || d.alignment?.rmsMm === undefined ? null : r1(d.alignment.rmsMm), correspondences: d.correspondences.map((c) => ({ id: c.id, name: c.name, residualPx: c.residualPx, residualMm: c.residualMm })) });
  },

  async set_coordinate_system(host, ctx, i) {
    const g = i['ground_track_ids'] as { a: number; b: number; c: number } | undefined;
    const sc = i['scale'] as { track_a: number; track_b: number; distance: number } | undefined;
    const r = await run(host, ctx, {
      verb: 'set_coordinate_system',
      ...(i['units'] ? { units: i['units'] as (typeof SCENE_UNITS)[number] } : {}),
      ...(i['up_axis'] ? { upAxis: i['up_axis'] as 'y' | 'z' } : {}),
      ...(i['origin_track_id'] !== undefined ? { origin: { trackId: i['origin_track_id'] as number } } : {}),
      ...(g ? { ground: [g.a, g.b, g.c] as [number, number, number] } : {}),
      ...(sc ? { scale: { trackIds: [sc.track_a, sc.track_b] as [number, number], distance: sc.distance } } : {}),
    });
    return r.ok ? done(r.summary, undefined) : fail(r.error);
  },

  async planar_track(host, ctx, i) {
    const frame = i['frame'] as number;
    const dir = i['direction'] as 'both' | 'forward' | 'backward';
    const direction = dir === 'both' ? 'around' : dir;
    let trackId = i['track_id'] as string | undefined;
    if (trackId) {
      const t = shotState(host.project(), host.shotId)?.track2d?.tracks.find((x) => x.id === trackId);
      if (!t) return fail(`No 2D track ${trackId}`);
      if (!t.keys.some((k) => k.frame === frame)) return fail(`Frame ${frame} is not a key of ${t.name}; its keys are ${t.keys.map((k) => k.frame).join(', ') || 'none'}`);
    } else {
      const c = i['corners'] as { tl: { x: number; y: number }; tr: { x: number; y: number }; br: { x: number; y: number }; bl: { x: number; y: number } } | undefined;
      const name = String(i['name'] ?? '').trim().slice(0, 64);
      if (!c || !name) return fail('A new surface needs a name and its four corners (or give the track_id of one the artist drew).');
      if (!host.confirmQuad) return fail('Proposed corners need the artist’s confirmation, which is not available here. Ask the artist to draw the surface (2D / planar › New planar).');
      let corners: [number, number][] = [[c.tl.x, c.tl.y], [c.tr.x, c.tr.y], [c.br.x, c.br.y], [c.bl.x, c.bl.y]];
      const answer = await host.confirmQuad({ name, frame, corners, reason: String(i['reason'] ?? '') });
      if (!answer.accepted) {
        ctx.onCommand?.({ verb: 'track2d_create', ok: false, summary: `Declined by the artist${answer.note ? `: ${answer.note}` : ''}` });
        return { ok: true, content: `The artist declined the proposed corners for ${name}${answer.note ? `: “${answer.note}”` : ''}. Nothing was tracked.`, summary: 'Proposal declined' };
      }
      if (answer.corners?.length === 4) corners = answer.corners;
      const before = new Set((shotState(host.project(), host.shotId)?.track2d?.tracks ?? []).map((t) => t.id));
      const created = await run(host, ctx, { verb: 'track2d_create', name, kind: 'planar', frame, points: corners });
      if (!created.ok) return fail(created.error);
      trackId = shotState(host.project(), host.shotId)?.track2d?.tracks.find((t) => !before.has(t.id))?.id;
      if (!trackId) return fail('The 2D track could not be created.');
      ctx.created2d.push(trackId);
    }
    const r = await run(host, ctx, { verb: 'track2d_track', trackId, from: frame, direction });
    if (!r.ok) return fail(r.error);
    const t = shotState(host.project(), host.shotId)?.track2d?.tracks.find((x) => x.id === trackId);
    const frames = t?.frames ?? [];
    const lowest = [...frames].filter((f) => f.status !== 'key').sort((a, b) => a.confidence - b.confidence).slice(0, 5).map((f) => ({ frame: f.frame, confidence: r2(f.confidence), status: f.status }));
    return done(r.summary, { trackId, frames: r.data['frames'], lost: r.data['lost'], meanConfidence: r2(Number(r.data['meanConfidence'])), lostFrames: frameRanges(frames.filter((f) => f.status === 'lost').map((f) => f.frame)), lowest });
  },

  async export(host, ctx, i) {
    if (!ctx.exportAllowed) return fail('Exporting was not allowed for this run. Say in the report that the work is ready to export.');
    const formats = (i['formats'] as string[] | undefined) ?? [];
    if (i['what'] === 'tracks_2d') {
      const fs = formats.filter((f) => (TRACK2D_EXPORT_FORMATS as readonly string[]).includes(f)) as (typeof TRACK2D_EXPORT_FORMATS)[number][];
      const r = await run(host, ctx, { verb: 'track2d_export', ...(fs.length ? { formats: fs } : {}) });
      return r.ok ? done(r.summary, undefined) : fail(r.error);
    }
    const fs = formats.filter((f) => (CAMERA_EXPORT_FORMATS as readonly string[]).includes(f)) as (typeof CAMERA_EXPORT_FORMATS)[number][];
    const r = await run(host, ctx, { verb: 'export_camera', ...(fs.length ? { formats: fs } : {}) });
    return r.ok ? done(r.summary, undefined) : fail(r.error);
  },

  async get_frame_image(host, ctx, i) {
    if (!ctx.framesAllowed || !host.frameImage) return fail('Frames of this project may not be sent. Work from the numbers, or ask the artist.');
    if (ctx.imagesUsed >= ctx.maxImages) return fail(`The run’s ${ctx.maxImages} frame images are used up. Work from the numbers.`);
    const session = await host.session();
    if (!session.available || !session.plate) return fail(session.reason ?? 'No frames.');
    const frame = Math.round(clamp(i['frame'] as number, session.first, session.last));
    const maxWidth = Math.round(clamp((i['max_width'] as number | undefined) ?? 1024, 256, 1024));
    const overlay = (i['overlay'] as 'none' | 'tracks' | 'errors' | undefined) ?? 'none';
    const img = await host.frameImage(frame, maxWidth, overlay);
    ctx.imagesUsed += 1;
    const k = session.plate.width / img.width;
    ctx.onCommand?.({ verb: 'frame_image', ok: true, summary: `Frame ${frame} sent to the model at ${img.width}×${img.height}${overlay !== 'none' ? ` with ${overlay}` : ''}` });
    return {
      ok: true,
      summary: `Looked at frame ${frame}`,
      content: [
        { type: 'text', text: `Frame ${frame} at ${img.width}×${img.height} (plate ${session.plate.width}×${session.plate.height}: plate pixel = image pixel × ${r3(k)}).${overlay === 'tracks' ? ' Tracks drawn as small crosses.' : overlay === 'errors' ? ' Tracks coloured by solve error: green < 0.5 px, amber ≈ 1 px, red > 2 px.' : ''} ${ctx.maxImages - ctx.imagesUsed} image(s) left this run.` },
        { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } },
      ],
    };
  },

  async finish(host, _ctx, i) {
    const fs = (i['final_stats'] ?? {}) as Record<string, number | undefined>;
    const d = doc(host);
    const active = d.solves.find((x) => x.number === d.activeSolve);
    const problems: string[] = [];
    if (fs['rms_px'] !== undefined) {
      if (!active) problems.push('the report gives an RMS but there is no active solve');
      else if (Math.abs(fs['rms_px'] - active.stats.rms) > Math.max(0.02, 0.05 * active.stats.rms)) problems.push(`the active solve (${active.number}) has RMS ${r3(active.stats.rms)} px, not ${fs['rms_px']}`);
    }
    if (fs['frames_solved'] !== undefined && active && fs['frames_solved'] !== active.stats.framesSolved) problems.push(`the active solve has ${active.stats.framesSolved} frames solved, not ${fs['frames_solved']}`);
    if (fs['focal_mm'] !== undefined && active?.intrinsics.focalMm != null && Math.abs(fs['focal_mm'] - active.intrinsics.focalMm) > Math.max(0.05, 0.01 * active.intrinsics.focalMm)) problems.push(`the active solve’s focal is ${r2(active.intrinsics.focalMm)} mm, not ${fs['focal_mm']}`);
    if (i['targets_met'] === true && active) {
      const session = await host.session();
      const t = rmsTarget(session.plate?.width ?? 1920);
      if (active.stats.rms > t.acceptable) problems.push(`targets_met is true but the RMS ${r3(active.stats.rms)} px is above the acceptable ${t.acceptable} px`);
      if (active.stats.framesSolved < active.stats.framesTotal) problems.push(`targets_met is true but ${active.stats.framesTotal - active.stats.framesSolved} frames are unsolved`);
    }
    if (problems.length) return fail(`The report disagrees with the shot: ${problems.join('; ')}. Correct it and call finish again.`, 'Report refused: numbers disagree with the shot');
    const report: FinishReport = {
      summary: String(i['summary'] ?? ''),
      actions: ((i['actions'] as string[]) ?? []).slice(0, 30),
      finalStats: {
        ...(fs['rms_px'] !== undefined ? { rmsPx: fs['rms_px'] } : {}),
        ...(fs['focal_mm'] !== undefined ? { focalMm: fs['focal_mm'] } : {}),
        ...(fs['frames_solved'] !== undefined ? { framesSolved: fs['frames_solved'] } : {}),
        ...(fs['frames_total'] !== undefined ? { framesTotal: fs['frames_total'] } : {}),
        ...(fs['tracks'] !== undefined ? { tracks: fs['tracks'] } : {}),
        ...(fs['mean_confidence_2d'] !== undefined ? { meanConfidence2d: fs['mean_confidence_2d'] } : {}),
      },
      targetsMet: Boolean(i['targets_met']),
      concerns: ((i['concerns'] as string[]) ?? []).slice(0, 20),
      framesToCheck: ((i['frames_to_check'] as { frame: number; reason: string }[]) ?? []).slice(0, 30),
      nextSteps: ((i['next_steps'] as string[]) ?? []).slice(0, 20),
    };
    return { ok: true, content: 'Report delivered to the artist. The run is over; do not call more tools.', summary: 'Report', report };
  },
};

/** Run one tool call. Never throws: a failure is an error result the model can read. */
export async function executeTool(host: TrackHost, ctx: ToolContext, name: string, input: unknown): Promise<ToolOutcome> {
  const spec = SPECS.find((s) => s.name === name);
  if (!spec || (spec.frames && !ctx.framesAllowed)) return fail(`There is no tool called ${name}.`);
  const problem = schemaProblem(spec.schema, input);
  if (problem) return fail(`Invalid input: ${problem}. ${JSON.stringify({ INVALID_INPUT: input }).slice(0, 500)}`, `Invalid input to ${name}`);
  try {
    return await EXECUTORS[name]!(host, ctx, input as In);
  } catch (error) {
    const message = (error as Error).message || String(error);
    return fail(message === 'Cancelled' ? 'Cancelled by the artist.' : `The tool failed: ${message}`);
  }
}
