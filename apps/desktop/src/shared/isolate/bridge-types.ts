import type { IsolateExportInput, IsolateMetrics, IsolateRunResult, IsolateTarget } from '@vcvfx/domain';

/**
 * Sky isolation and background removal's part of the renderer ↔ main
 * contract (addendum 11). Kept here so bridge.ts only names these; the
 * preload, ipc and the browser preview implement them.
 */

export interface IsolateShotInput {
  text: string;
  shotId: string;
  projectKey: string;
  target: IsolateTarget;
}

export interface IsolateEngineChoice {
  id: 'track' | 'sam2';
  label: string;
  available: boolean;
  reason: string | null;
}

export interface IsolateSessionInfo {
  available: boolean;
  reason: string | null;
  /** What the frames are: "plates v001", "source", "sample frames". */
  frames: string;
  /** Plate resolution: boxes and strokes are in these pixels. */
  plate: { width: number; height: number } | null;
  /** The resolution the review build works at. */
  working: { width: number; height: number } | null;
  first: number;
  last: number;
  encoding: { label: string; linear: boolean; note: string | null };
  /** Written into the package from here (not in the browser preview). */
  exportable: boolean;
  /** Segmentation engines for a subject (Track always; SAM 2.1 when its model is installed). */
  engines: IsolateEngineChoice[];
  /** The preview's synthetic shot comes with its subject already rotoscoped. */
  sampleSubjects?: { name: string }[];
  sample?: boolean;
}

/** One frame for the viewer, at most the working size: 8-bit display pictures and masks. */
export interface IsolateFrameView {
  frame: number;
  width: number;
  height: number;
  /** The frame through the viewer's display transform (RGB). */
  source: Uint8ClampedArray;
  /** The matte (foreground alpha) 0 … 255; null before a build. */
  matte: Uint8Array | null;
  /** The isolated foreground, unpremultiplied, display RGB (shown over a checkerboard with the matte). */
  foreground: Uint8ClampedArray | null;
  /** The sky / background plate, display RGB. */
  plate: Uint8ClampedArray | null;
  /** Per-pixel confidence of the matte, 0 … 255. */
  confidence: Uint8Array | null;
  /** 255 on the edge band that was unmixed. */
  band: Uint8Array | null;
  /** 255 where the plate behind the foreground was never seen (filled). */
  unresolved: Uint8Array | null;
  /** current: built with the current settings; stale: built, settings changed since; none. */
  built: 'current' | 'stale' | 'none';
  metrics: IsolateMetrics | null;
  viewLabel: string;
}

export interface IsolateExportOutcome {
  /** What was written; the renderer records it with `recordIsolateExport`. */
  record: IsolateExportInput;
  folder: string;
  files: number;
}

export interface IsolateBridge {
  isolateSession(input: IsolateShotInput): Promise<import('../bridge').ApiResult<IsolateSessionInfo>>;
  isolateFrame(input: IsolateShotInput & { frame: number; maxWidth: number }): Promise<import('../bridge').ApiResult<IsolateFrameView>>;
  /** Analyse and build the shot (a job); the renderer records the result with `recordIsolateRun`. */
  isolateBuild(input: IsolateShotInput & { jobId: string }): Promise<import('../bridge').ApiResult<{ result: IsolateRunResult }>>;
  /** Write the versioned matte, foreground, plate and manifests into the shot package (a job). */
  isolateExport(input: IsolateShotInput & { jobId: string; operator: string }): Promise<import('../bridge').ApiResult<IsolateExportOutcome>>;
}
