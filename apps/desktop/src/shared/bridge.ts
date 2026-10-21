import type { AgentEvent, StopReason } from './ai/agent';
import type { FinishReport, QuadProposal } from './ai/tools';
import type { KeyBridge } from './key/bridge-types';
import type { AiAllowance, ColorEncodingId, LicenseStatus, PlateRecordInput, ProbedMediaInput, QueueFilter, RotoDirection, RotoEngineId, RotoExportInput, RotoPropagationResult, ViewTransformId } from '@vcvfx/domain';

/**
 * The contract between the renderer and the main process.
 *
 * The preload implements it with one explicit IPC channel per method — there
 * is no generic `invoke(channel)` escape hatch — and the renderer reaches it
 * as `window.vcvfx`. Project data crosses as serialized text, and main
 * re-validates it with the domain's `parseProject` before it acts on it.
 */

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface OpenedFile {
  path: string;
  text: string;
}

export interface AppInfo {
  version: string;
  siteUrl: string;
  cloudConfigured: boolean;
  platform: string;
}

export interface Settings {
  /** Used for the log and as the approver default when nobody is signed in. */
  operatorName: string;
  /** Explicit ffmpeg binary; empty means "look on PATH". */
  ffmpegPath: string;
  /** Output root per project key (project path, or `handoff:<path>` before the first save). */
  outputRoots: Record<string, string>;
  recent: string[];
  /** Where the SAM 2 model is downloaded from; empty means the default (addendum 04). */
  modelBaseUrl?: string;
  /** Projects (by key) whose frames the AI assistant may see (addendum 07 §7). */
  aiFrames?: Record<string, boolean>;
}

export interface AccountStatus {
  configured: boolean;
  signedIn: boolean;
  email: string | null;
  displayName: string | null;
}

export interface LicenceStanding {
  status: LicenseStatus;
  expiresAt: string | null;
  checkedAt: string;
}

export type VerifyOutcome = 'verified' | 'mismatch' | 'missing' | 'unchecked';

export interface VerifyResult {
  shotId: string;
  result: VerifyOutcome;
  detail: string;
}

export interface JobProgress {
  jobId: string;
  label: string;
  done: number;
  total: number;
  detail?: string;
}

export interface FfmpegInfo {
  found: boolean;
  path: string | null;
  version: string | null;
  /** Where it came from: the path in Settings, the copy bundled with VC VFX, or PATH. */
  source?: 'settings' | 'bundled' | 'path' | null;
  /** Why none was found, when none was. */
  problem?: string | null;
}

export interface PackageOutcome {
  /** The project after `markPackaged`, serialized. */
  text: string;
  folder: string;
  version: number;
  files: number;
}

export interface SequenceOutcome {
  folder: string;
  pattern: string;
  frames: number;
  /** The clip as read when its range was unknown; the renderer records it with `setProbedMedia`. */
  probed?: ProbedMediaInput;
  /** What was written and exactly how; the renderer records it with `recordPlates`. */
  record?: PlateRecordInput;
  notes?: string[];
}

export interface ProbeResult {
  shotId: string;
  media?: ProbedMediaInput;
  error?: string;
}

export interface ProbeOutcome {
  /** The ffprobe that ran, or null when none was found (then `results` is empty). */
  ffprobe: string | null;
  results: ProbeResult[];
}

/** What the viewer can show for a shot. */
export interface ViewerSources {
  source: {
    available: boolean;
    /** Why not, in words, when not. */
    reason: string | null;
    encoding: ColorEncodingId | null;
  };
  /** Plate versions found in the shot's 01_PLATES, newest last. */
  plates: { version: number; format: string; first: number; last: number; count: number; encoding: ColorEncodingId | null }[];
  /** Set by the browser preview: the frames are stand-ins, not this shot's media. */
  sample?: boolean;
}

export type ViewerLayer = 'source' | 'plates';

export interface ViewerFrameRequest {
  text: string;
  shotId: string;
  projectKey: string;
  layer: ViewerLayer;
  /** Plate version, for `plates`. */
  version?: number;
  /** Delivered frame number. */
  frame: number;
  view: ViewTransformId;
  /** Longest edge wanted, in pixels (the cache keeps one file per size). */
  maxWidth: number;
  /** A neighbour fetched ahead of need: queued behind anything the viewer is waiting for. */
  prefetch?: boolean;
}

export interface ViewerFrame {
  /** `vcvfx-frame://cache/<sha256>.jpg` on the desktop; a bundled asset in the browser preview. */
  url: string;
  frame: number;
  /** The view transform as applied, e.g. "ARRI LogC4 → Rec.709 (approx.)". */
  viewLabel: string;
}

// ---------------------------------------------------------------------------
// Paint-to-roto (addendum 04)
// ---------------------------------------------------------------------------

export interface RotoEngineInfo {
  id: RotoEngineId;
  label: string;
  version: string;
  available: boolean;
  /** Why not, in words, when not. */
  reason: string | null;
  /** For an engine that needs a model download. */
  model?: { label: string; approxBytes: number; present: boolean; pinned: boolean; downloadable: boolean };
}

export interface RotoSession {
  available: boolean;
  reason: string | null;
  /** What the frames are: "plates v001", "source", "sample frames". */
  frames: string;
  /** Plate resolution: strokes are stored in these pixels. */
  plate: { width: number; height: number } | null;
  /** The resolution the engines work at. */
  working: { width: number; height: number } | null;
  first: number;
  last: number;
  engines: RotoEngineInfo[];
  /** Mattes can be written to a package from here (not in the browser preview). */
  exportable: boolean;
  sample?: boolean;
}

export interface RotoMaskData {
  width: number;
  height: number;
  /** 0 … 255 per pixel. */
  alpha: Uint8Array;
}

export interface RotoShotInput {
  text: string;
  shotId: string;
  projectKey: string;
}

export interface RotoRunRequest extends RotoShotInput {
  jobId: string;
  partId: string;
  /** The key frame to start from. */
  from: number;
  directions: RotoDirection[];
}

export interface RotoExportRequest extends RotoShotInput {
  jobId: string;
  operator: string;
  /** Also write half-float EXR beside each PNG. */
  exr: boolean;
}

export interface RotoExportOutcome {
  /** What was written; the renderer records it with `recordRotoExport`. */
  record: RotoExportInput;
  folder: string;
  files: number;
}

// ---------------------------------------------------------------------------
// Camera tracking and 2D tracking (addendum 06)
// ---------------------------------------------------------------------------

export interface TrackSessionInfo {
  available: boolean;
  reason: string | null;
  /** What the frames are: "plates v001", "source", "sample frames". */
  frames: string;
  /** Plate resolution: tracks and corners are in these pixels. */
  plate: { width: number; height: number } | null;
  /** The resolution tracking works at. */
  working: { width: number; height: number } | null;
  first: number;
  last: number;
  fps: number;
  /** Exports can be written to a package from here (not in the browser preview). */
  exportable: boolean;
  /** LiDAR files can be chosen from disk (the preview offers its bundled scan). */
  lidarFromDisk: boolean;
  sample?: boolean;
}

/** The large data the Track workspace draws: feature tracks, the active solve, point clouds. */
export interface TrackViewData {
  tracks: { first: number; last: number; ids: Int32Array; start: Int32Array; length: Int32Array; offset: Int32Array; xy: Float32Array } | null;
  solve: {
    number: number;
    frames: { frame: number; solved: boolean; rms: number; tracks: number; keyframe: boolean }[];
    /** World → camera per frame (CV convention), 9 and 3 per frame. */
    R: Float64Array;
    t: Float64Array;
    trackIds: Int32Array;
    /** Solve-world positions (NaN when not triangulated). */
    X: Float64Array;
    trackRms: Float32Array;
    intrinsics: { f: number; cx: number; cy: number; k1: number; k2: number; k3: number; p1: number; p2: number };
  } | null;
  /** Downsampled clouds in their files' coordinates, relative to `origin`. */
  clouds: { id: string; origin: [number, number, number]; positions: Float32Array; colors: Uint8Array | null }[];
}

export interface TrackShotInput extends RotoShotInput {
  /** Where the working size comes from (the camera track's tracker settings), so the viewer and the worker agree. */
  workingWidth?: number;
}

export interface TrackCommandRequest extends TrackShotInput {
  jobId: string;
  operator: string;
  /** A CameraCommand (shared/camera/commands.ts), validated by its verb in main. */
  command: { verb: string } & Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The AI tracking assistant (addendum 07)
// ---------------------------------------------------------------------------

export interface AiRunRequest extends TrackShotInput {
  runId: string;
  operator: string;
  instruction: string;
  /** Facts for the briefing: what the artist has drawn or selected. */
  notes?: string[];
  framesAllowed: boolean;
  exportAllowed: boolean;
  /** Credits this run may spend. */
  creditCap: number;
  maxTurns: number;
  focalRange?: { min: number; max: number } | null;
  /** Continue a conversation main still holds (a follow-up instruction). */
  conversationId?: string | null;
}

export interface AiRunResult {
  reason: StopReason;
  message: string;
  report: FinishReport | null;
  text: string | null;
  credits: number;
  turns: number;
  created2d: string[];
  /** For a follow-up instruction in the same conversation. */
  conversationId: string;
}

/** What main tells the panel while a run goes: the loop's events, plus requests to apply ops and to confirm a proposal. */
export type AiRunEvent = { runId: string } & (
  | Exclude<AgentEvent, { type: 'done' }>
  | { type: 'apply'; seq: number; ops: unknown[] }
  | { type: 'confirm'; seq: number; proposal: QuadProposal }
  | { type: 'progress'; label: string; done: number; total: number }
);

/** The panel's answer to `apply` (the project afterwards, or the refusal) or `confirm`. */
export interface AiAck {
  runId: string;
  seq: number;
  ok: boolean;
  /** The project after the ops, serialized. */
  text?: string;
  error?: string;
  accepted?: boolean;
  corners?: [number, number][];
  note?: string;
}

export type AiAllowanceInfo = AiAllowance & { licensed?: boolean };

export type ExternalLink = 'site' | 'subscribe' | 'account' | 'ffmpeg';

export const MENU_COMMANDS = [
  'open-handoff',
  'open-project',
  'open-sample',
  'save',
  'save-as',
  'print',
  'export-pdf',
  'verify',
  'settings',
  'account',
  'next-shot',
  'previous-shot',
  // View › the module tabs (addendum 08), and Help › Show the tour.
  'show-shots',
  'show-plates',
  'show-roto',
  'show-key',
  'show-camera',
  'show-track2d',
  'show-deliver',
  'show-tour',
] as const;
export type MenuCommand = (typeof MENU_COMMANDS)[number] | `open-recent:${string}`;

/** The key's methods (addendum 09) are optional, like the AI assistant's: a host may not offer them. */
export interface VcvfxApi extends Partial<KeyBridge> {
  appInfo(): Promise<AppInfo>;

  openHandoffDialog(): Promise<ApiResult<OpenedFile | null>>;
  openProjectDialog(): Promise<ApiResult<OpenedFile | null>>;
  openProjectPath(path: string): Promise<ApiResult<OpenedFile>>;
  /** Writes atomically. With no path, or `saveAs`, asks first; null means cancelled. */
  saveProject(input: { path: string | null; text: string; suggestedPath?: string; saveAs?: boolean }): Promise<ApiResult<{ path: string } | null>>;
  setDocumentState(input: { path: string | null; title: string; dirty: boolean }): Promise<void>;

  getSettings(): Promise<Settings>;
  setSettings(patch: { operatorName?: string; ffmpegPath?: string }): Promise<Settings>;
  chooseOutputRoot(input: { projectKey: string; text: string }): Promise<ApiResult<string | null>>;

  printShotList(input: { text: string; filter: QueueFilter; mode: 'print' | 'pdf' }): Promise<ApiResult<{ path: string | null } | null>>;

  verifySources(input: { jobId: string; text: string }): Promise<ApiResult<VerifyResult[]>>;
  packageShot(input: { jobId: string; text: string; shotId: string; projectKey: string; operator: string }): Promise<ApiResult<PackageOutcome>>;
  detectFfmpeg(): Promise<FfmpegInfo>;
  generateSequence(input: { jobId: string; text: string; shotId: string; projectKey: string }): Promise<ApiResult<SequenceOutcome>>;
  /**
   * Read source clips with ffprobe (frame count, timecode, rate, resolution):
   * by default every shot whose range is unknown. Optional, because only the
   * desktop has ffprobe; the renderer skips probing when it is absent.
   */
  probeSources?(input: { jobId: string; text: string; shotIds?: string[] }): Promise<ApiResult<ProbeOutcome>>;
  /** What there is to look at for a shot: the source, and plate versions on disk. */
  viewerSources(input: { text: string; shotId: string; projectKey: string }): Promise<ApiResult<ViewerSources>>;
  /** One frame for the viewer, extracted and cached by main; display transform for viewing only. */
  viewerFrame(input: ViewerFrameRequest): Promise<ApiResult<ViewerFrame>>;
  /** Paint-to-roto: whether it can run on this shot, at what sizes, with which engines. */
  rotoSession(input: RotoShotInput): Promise<ApiResult<RotoSession>>;
  /** A frame to paint on (plates when there are some, else the source), for display. */
  rotoFrame(input: RotoShotInput & { frame: number; maxWidth: number; prefetch?: boolean }): Promise<ApiResult<ViewerFrame>>;
  /** Segment a key frame and/or propagate from it, as a cancellable job. The renderer records the results with `recordPropagation`. */
  rotoRun(input: RotoRunRequest): Promise<ApiResult<{ results: RotoPropagationResult[] }>>;
  /** One part's matte on a frame (partId null: the combined subject matte), refined, for the overlay. Null when there is none. */
  rotoMask(input: RotoShotInput & { partId: string | null; frame: number; maxWidth: number }): Promise<ApiResult<RotoMaskData | null>>;
  /** Write the versioned matte sequences and their metadata into the shot package. */
  rotoExport(input: RotoExportRequest): Promise<ApiResult<RotoExportOutcome>>;
  /** The SAM 2 model: its status, or download it (a job with progress). */
  rotoModel(input: { jobId: string; action: 'status' | 'download' }): Promise<ApiResult<RotoEngineInfo>>;
  /** Camera / 2D tracking: whether it can run on this shot, at what sizes and frames. */
  trackSession(input: TrackShotInput): Promise<ApiResult<TrackSessionInfo>>;
  /** A frame for the Track workspace (plates when there are some, else the source), for display. */
  trackFrame(input: TrackShotInput & { frame: number; maxWidth: number; prefetch?: boolean }): Promise<ApiResult<ViewerFrame>>;
  /** Feature tracks, the active solve and LiDAR clouds for drawing. */
  trackView(input: TrackShotInput & { clouds?: boolean }): Promise<ApiResult<TrackViewData>>;
  /** Run one camera-tracking command (a job with progress). The renderer applies the outcome's ops with `applyOps`. */
  trackCommand(input: TrackCommandRequest): Promise<ApiResult<{ ok: true; summary: string; data: Record<string, unknown>; ops: unknown[] } | { ok: false; error: string }>>;
  /** Choose a LiDAR / survey file (read only). Null when cancelled. */
  chooseLidarFile(): Promise<ApiResult<string | null>>;
  /** Save a printable calibration checkerboard (PDF and PNG). */
  saveCalibrationTarget(input: { cols: number; rows: number; squareMm: number; marginMm: number }): Promise<ApiResult<{ path: string } | null>>;
  /** Run the AI tracking assistant on a shot (desktop only; the preview runs a scripted demo instead). Resolves when the run ends. */
  aiTrackRun?(input: AiRunRequest): Promise<ApiResult<AiRunResult>>;
  aiTrackAck?(ack: AiAck): Promise<void>;
  aiTrackCancel?(runId: string): Promise<void>;
  onAiEvent?(listener: (event: AiRunEvent) => void): () => void;
  /** This month's AI credits from vc-vfx.com. */
  aiAllowance?(): Promise<ApiResult<AiAllowanceInfo>>;
  /** Whether the assistant may see frames of this project (a per-project, per-computer choice); `allowed` sets it. */
  aiFrames?(input: { projectKey: string; allowed?: boolean }): Promise<boolean>;
  cancelJob(jobId: string): Promise<void>;
  onProgress(listener: (progress: JobProgress) => void): () => void;
  revealPath(path: string): Promise<void>;

  accountStatus(): Promise<AccountStatus>;
  requestSignInCode(email: string): Promise<ApiResult<null>>;
  verifySignInCode(email: string, code: string): Promise<ApiResult<AccountStatus>>;
  signInWithPassword(email: string, password: string): Promise<ApiResult<AccountStatus>>;
  signOut(): Promise<void>;
  licenceStanding(recheck: boolean): Promise<LicenceStanding | null>;
  activateLicence(): Promise<ApiResult<{ message: string }>>;

  openExternal(link: ExternalLink): Promise<void>;
  onMenu(listener: (command: MenuCommand) => void): () => void;
}
