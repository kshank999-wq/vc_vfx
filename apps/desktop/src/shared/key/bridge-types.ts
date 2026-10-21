import type { BgMatchInput, KeyExportInput, KeyMetrics, KeyRunResult, ScreenKind } from '@vcvfx/domain';

/**
 * The key's part of the renderer ↔ main contract (addendum 09). Kept here so
 * bridge.ts only names these; the preload, ipc and the browser preview
 * implement them.
 */

export interface KeyShotInput {
  text: string;
  shotId: string;
  projectKey: string;
}

export interface KeySessionInfo {
  available: boolean;
  reason: string | null;
  /** What the frames are: "plates v001", "source", "sample frames". */
  frames: string;
  /** Plate resolution: boxes and samples are in these pixels. */
  plate: { width: number; height: number } | null;
  /** The resolution the review key works at. */
  working: { width: number; height: number } | null;
  first: number;
  last: number;
  /** The encoding the key works in, e.g. "ACEScg (linear AP1)", and whether it is linear. */
  encoding: { label: string; linear: boolean; note: string | null };
  /** The background reference: whether it can be read, and what it is. */
  background: { available: boolean; label: string; reason: string | null };
  /** Background plates the handoff names for the shot (paths relative to the handoff). */
  references: string[];
  /** A key can be written into the package from here (not in the browser preview). */
  exportable: boolean;
  /** Files can be chosen from disk for the background. */
  fileBackground: boolean;
  sample?: boolean;
}

/** One frame keyed for review, at most `maxWidth` wide: 8-bit display images and masks. */
export interface KeyFrameView {
  frame: number;
  width: number;
  height: number;
  /** The plate through the viewer's display transform (RGB, 3 per pixel). */
  source: Uint8ClampedArray;
  /** The despilled premultiplied foreground over a neutral checker (RGB). */
  premult: Uint8ClampedArray;
  /** The foreground over the background reference (with light wrap and match when asked), or null without one (RGB). */
  comp: Uint8ClampedArray | null;
  /** 0…255 per pixel. */
  alpha: Uint8Array;
  core: Uint8Array;
  /** Where the garbage mattes keep (255) and drop (0); null without garbage mattes. */
  garbage: Uint8Array | null;
  holdout: Uint8Array | null;
  repair: Uint8Array | null;
  /** Spill removed, scaled for display; null without despill. */
  spill: Uint8Array | null;
  confidence: number;
  metrics: KeyMetrics;
  /** The screen colour used at the centre (linear), and the per-frame gain applied. */
  screen: [number, number, number];
  viewLabel: string;
}

export interface KeyDetectResult {
  kind: ScreenKind;
  rgb: [number, number, number];
  coverage: number;
  frames: number[];
}

export interface KeyExportOptions {
  foreground: boolean;
  core: boolean;
  edge: boolean;
  alphaExr: boolean;
}

export interface KeyExportOutcome {
  /** What was written; the renderer records it with `recordKeyExport`. */
  record: KeyExportInput;
  folder: string;
  files: number;
}

export interface KeyBridge {
  /** Whether keying can run on this shot, at what sizes, in which encoding, with what background. */
  keySession(input: KeyShotInput): Promise<import('../bridge').ApiResult<KeySessionInfo>>;
  /** Detect the screen colour on frames spread over the shot (a job). */
  keyDetect(input: KeyShotInput & { jobId: string; kind: ScreenKind | null }): Promise<import('../bridge').ApiResult<KeyDetectResult>>;
  /** One frame keyed with the project's current key settings, for the viewer. */
  keyFrame(input: KeyShotInput & { frame: number; maxWidth: number; wrap: boolean; match: boolean }): Promise<import('../bridge').ApiResult<KeyFrameView>>;
  /** The linear colour under the eyedropper (plate pixels). */
  keySample(input: KeyShotInput & { frame: number; x: number; y: number; radius: number }): Promise<import('../bridge').ApiResult<{ rgb: [number, number, number] }>>;
  /** Key frames first…last (default: the whole shot) as a job; the renderer records the result with `recordKeyRun`. */
  keyProcess(input: KeyShotInput & { jobId: string; first?: number; last?: number }): Promise<import('../bridge').ApiResult<{ result: KeyRunResult }>>;
  /** Estimate the suggested background match on a frame; the renderer records it with `recordBgMatch`. */
  keyMatch(input: KeyShotInput & { frame: number }): Promise<import('../bridge').ApiResult<BgMatchInput>>;
  /** Write the current key of `frame` as a roto part's matte (Repair with roto); then the renderer calls `startKeyRepair`. */
  keySeedRoto(input: KeyShotInput & { partId: string; frame: number }): Promise<import('../bridge').ApiResult<{ confidence: number }>>;
  /** Write the versioned key into the shot package (a job). */
  keyExport(input: KeyShotInput & { jobId: string; operator: string; options: KeyExportOptions }): Promise<import('../bridge').ApiResult<KeyExportOutcome>>;
  /** Choose a background image from disk (read only). Null when cancelled. */
  keyChooseBackground(): Promise<import('../bridge').ApiResult<string | null>>;
}
