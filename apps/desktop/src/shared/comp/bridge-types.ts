import type { CompExportInput, CompRenderInput, CompSource } from '@vcvfx/domain';
import type { CompPicture } from './view';

/**
 * The compositor's part of the renderer ↔ main contract (addendum 13).
 * Kept here so bridge.ts only names these; the preload, ipc and the browser
 * preview implement them.
 */

export interface CompShotInput {
  text: string;
  shotId: string;
  projectKey: string;
}

export interface CompSessionInfo {
  available: boolean;
  reason: string | null;
  /** What the plate is: "plates v001", "source", "sample frames". */
  frames: string;
  plate: { width: number; height: number } | null;
  first: number;
  last: number;
  fps: number;
  encoding: { label: string; linear: boolean; note: string | null };
  /** Rendering and exporting write into the shot package (not in the browser preview). */
  exportable: boolean;
  /** Module outputs the graph's nodes read, and whether each can be read here. */
  sources: { node: string; source: CompSource; ok: boolean; label: string; reason: string | null }[];
  sample?: boolean;
}

/** The viewer's two nodes on one frame, at the proxy scale. */
export interface CompFrameView {
  frame: number;
  width: number;
  height: number;
  a: CompPicture | null;
  b: CompPicture | null;
  /** Why a node could not be shown (the node and the reason). */
  errors: { a: string | null; b: string | null };
  /** Milliseconds this request took, nodes computed and taken from the cache. */
  ms: number;
  computed: number;
  cached: number;
  viewLabel: string;
}

export interface CompFrameRequest extends CompShotInput {
  frame: number;
  a: string | null;
  b: string | null;
  /** 1: plate resolution; 0.25: a quarter-size proxy. */
  scale: number;
}

export interface CompRenderOutcome {
  record: CompRenderInput;
  folder: string;
  files: number;
}

export interface CompExportOutcome {
  record: CompExportInput;
  folder: string;
  files: number;
}

export interface CompBridge {
  compSession(input: CompShotInput): Promise<import('../bridge').ApiResult<CompSessionInfo>>;
  compFrame(input: CompFrameRequest): Promise<import('../bridge').ApiResult<CompFrameView>>;
  /** Render the Write node's versioned EXR sequence (and the review encode) into 08_PREVIEWS (a job). */
  compRender(input: CompShotInput & { jobId: string; operator: string }): Promise<import('../bridge').ApiResult<CompRenderOutcome>>;
  /** Write the graph, the Nuke script, the graph manifest, baked nodes and the README into 09_PROJECT_DATA (a job). */
  compExport(input: CompShotInput & { jobId: string; operator: string }): Promise<import('../bridge').ApiResult<CompExportOutcome>>;
}
