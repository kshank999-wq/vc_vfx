import type { LicenseStatus, QueueFilter } from '@vcvfx/domain';

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
}

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
] as const;
export type MenuCommand = (typeof MENU_COMMANDS)[number] | `open-recent:${string}`;

export interface VcvfxApi {
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
  cancelJob(jobId: string): Promise<void>;
  onProgress(listener: (progress: JobProgress) => void): () => void;
  revealPath(path: string): Promise<void>;

  accountStatus(): Promise<AccountStatus>;
  requestSignInCode(email: string): Promise<ApiResult<null>>;
  verifySignInCode(email: string, code: string): Promise<ApiResult<AccountStatus>>;
  signOut(): Promise<void>;
  licenceStanding(recheck: boolean): Promise<LicenceStanding | null>;
  activateLicence(): Promise<ApiResult<{ message: string }>>;

  openExternal(link: ExternalLink): Promise<void>;
  onMenu(listener: (command: MenuCommand) => void): () => void;
}
