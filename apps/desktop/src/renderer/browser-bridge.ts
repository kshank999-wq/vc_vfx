import { PROJECT_EXTENSION, parseProject, shotListHtml, type QueueFilter } from '@vcvfx/domain';
import type { ApiResult, ExternalLink, LicenceStanding, MenuCommand, OpenedFile, Settings, VcvfxApi } from '../shared/bridge';

/**
 * The bridge for the browser preview at vc-vfx.com/preview
 * (docs/deployment.md, "Browser preview").
 *
 * It implements the same `VcvfxApi` the preload does, so the renderer runs
 * unchanged. What a browser can honestly do, it does: open a handoff or a
 * project through a file picker, keep projects in this browser (memory, and
 * localStorage when it is there), download a project file the desktop app
 * opens, and print the shot list through the browser's print dialog.
 *
 * What needs the disk, ffmpeg or a licence — verifying sources against the
 * camera media, writing plates, packaging — answers with a plain
 * "available in the desktop app" message instead of failing silently.
 *
 * The licence standing is `active`: the preview is reached through an
 * administrator's sign-in, and its purpose is to try the whole interface,
 * the approval flow included. Nothing it does leaves the browser.
 */

export const DESKTOP_ONLY = 'Available in the desktop app';
const desktopOnly = (what: string): string => `${DESKTOP_ONLY}: ${what} Download VC VFX from vc-vfx.com/download.`;

/** Paths the preview gives its projects: shown as "<name>.vcvfx", stored under this prefix. */
export const BROWSER_PREFIX = 'browser/';
const STORAGE_PROJECTS = 'vcvfx-preview:projects';
const STORAGE_SETTINGS = 'vcvfx-preview:settings';
const RECENT_MAX = 6;
const SITE_URL = 'https://vc-vfx.com';

const LINKS: Record<ExternalLink, string> = {
  site: SITE_URL,
  subscribe: `${SITE_URL}/#pricing`,
  account: `${SITE_URL}/account`,
  ffmpeg: 'https://ffmpeg.org/download.html',
};

const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const fail = <T>(error: string): ApiResult<T> => ({ ok: false, error });

/** localStorage can be missing or throw (private windows, blocked site data); it is only ever a convenience. */
const readStore = <T>(key: string): T | null => {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};
const writeStore = (key: string, value: unknown): void => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Full or blocked: the project stays in memory for this tab.
  }
};

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;
const safeName = (s: string): string => s.replace(/[^\w .()-]+/g, '_').trim() || 'Project';

/** `NightShift_handoff.json` → `NightShift_handoff.vcvfx`; falls back to the project title. */
const projectFileName = (text: string, suggested: string | undefined): string => {
  if (suggested) return `${safeName(baseName(suggested).replace(/\.[^.]+$/, ''))}.${PROJECT_EXTENSION}`;
  const parsed = parseProject(text);
  if (parsed.ok) {
    const from = parsed.project.handoffPath && parsed.project.handoffPath !== 'sample' ? baseName(parsed.project.handoffPath) : parsed.project.handoff.project;
    return `${safeName(from.replace(/\.json$/i, ''))}.${PROJECT_EXTENSION}`;
  }
  return `Project.${PROJECT_EXTENSION}`;
};

/** Asks for one file. Resolves null when the picker is cancelled. Must be called from a user gesture. */
const pickFile = (accept: string): Promise<File | null> =>
  new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    let settled = false;
    const done = (file: File | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => done(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => done(null));
    document.body.appendChild(input);
    input.click();
  });

const download = (fileName: string, text: string): void => {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
};

/**
 * The print window: same origin, written by script, with no script of its
 * own — the preview's policy is `script-src 'self'`, so the shot list must
 * not need one (the domain's HTML has none).
 */
const printHtml = (html: string): ApiResult<{ path: string | null }> => {
  const w = window.open('', '_blank');
  if (!w) return fail('The browser blocked the print window. Allow pop-ups for this site and try again.');
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 100);
  return ok({ path: null });
};

export interface BrowserBridge extends VcvfxApi {
  /** Sends a menu command, as the desktop's menu bar would (the preview has none). */
  command(command: MenuCommand): void;
}

export function createBrowserBridge(): BrowserBridge {
  const projects = new Map<string, string>(Object.entries(readStore<Record<string, string>>(STORAGE_PROJECTS) ?? {}));
  const stored = readStore<Partial<Settings>>(STORAGE_SETTINGS);
  let settings: Settings = {
    operatorName: stored?.operatorName ?? '',
    ffmpegPath: '',
    outputRoots: {},
    recent: (stored?.recent ?? []).filter((p) => projects.has(p)),
  };
  const persist = () => {
    writeStore(STORAGE_PROJECTS, Object.fromEntries(projects));
    writeStore(STORAGE_SETTINGS, { operatorName: settings.operatorName, recent: settings.recent });
  };
  const remember = (path: string, text: string) => {
    projects.set(path, text);
    settings = { ...settings, recent: [path, ...settings.recent.filter((p) => p !== path)].slice(0, RECENT_MAX) };
    for (const p of [...projects.keys()]) if (!settings.recent.includes(p)) projects.delete(p);
    persist();
  };

  const menuListeners = new Set<(command: MenuCommand) => void>();
  const command = (c: MenuCommand) => menuListeners.forEach((l) => l(c));
  let started = false;

  // The desktop's accelerators live on its menu bar; here they are keys.
  const onKey = (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    const c: MenuCommand | null =
      key === 'o' ? (e.shiftKey ? 'open-project' : 'open-handoff') : key === 's' ? (e.shiftKey ? 'save-as' : 'save') : key === 'p' && !e.shiftKey ? 'print' : null;
    if (!c) return;
    e.preventDefault();
    command(c);
  };

  const standing = (): LicenceStanding => ({ status: 'active', expiresAt: null, checkedAt: new Date().toISOString() });

  return {
    command,

    appInfo: async () => ({ version: `preview ${typeof __PREVIEW_BUILD__ === 'string' ? __PREVIEW_BUILD__ : ''}`.trim(), siteUrl: SITE_URL, cloudConfigured: false, platform: 'browser' }),

    openHandoffDialog: async (): Promise<ApiResult<OpenedFile | null>> => {
      const file = await pickFile('.json,application/json');
      return ok(file ? { path: file.name, text: await file.text() } : null);
    },
    openProjectDialog: async (): Promise<ApiResult<OpenedFile | null>> => {
      const file = await pickFile(`.${PROJECT_EXTENSION},.json,application/json`);
      if (!file) return ok(null);
      const path = `${BROWSER_PREFIX}${file.name}`;
      const text = await file.text();
      remember(path, text);
      return ok({ path, text });
    },
    openProjectPath: async (path) => {
      const text = projects.get(path);
      return text === undefined ? fail(`${baseName(path)} is no longer in this browser.`) : ok({ path, text });
    },
    saveProject: async ({ path, text, suggestedPath, saveAs }) => {
      // Save As is the download: a file the desktop app opens. Everything else
      // — the first save, File › Save, autosave — stays in this browser.
      const fileName = path && !saveAs ? baseName(path) : projectFileName(text, suggestedPath ?? (path ? baseName(path) : undefined));
      const target = path && !saveAs ? path : `${BROWSER_PREFIX}${fileName}`;
      if (saveAs) download(fileName, text);
      remember(target, text);
      return ok({ path: target });
    },
    setDocumentState: async () => undefined,

    getSettings: async () => settings,
    setSettings: async (patch) => {
      settings = { ...settings, ...(patch.operatorName !== undefined ? { operatorName: patch.operatorName } : {}) };
      persist();
      return settings;
    },
    chooseOutputRoot: async () => fail(desktopOnly('outputs are written to a folder on disk.')),

    printShotList: async ({ text, filter }: { text: string; filter: QueueFilter; mode: 'print' | 'pdf' }) => {
      const parsed = parseProject(text);
      if (!parsed.ok) return fail(parsed.reason);
      // Export PDF is the same window: the browser's dialog saves as PDF.
      return printHtml(shotListHtml(parsed.project, new Date(), filter));
    },

    verifySources: async () => fail(desktopOnly('verifying sources reads the camera media on the drive and checks its sha256.')),
    packageShot: async () => fail(desktopOnly('packaging writes and checksums a vendor package on disk.')),
    // Reported as present so the plate action reaches generateSequence and its message, not an install hint.
    detectFfmpeg: async () => ({ found: true, path: null, version: null }),
    generateSequence: async () => fail(desktopOnly('plates are written by ffmpeg on your computer.')),
    cancelJob: async () => undefined,
    onProgress: () => () => undefined,
    revealPath: async () => undefined,

    accountStatus: async () => ({ configured: false, signedIn: false, email: null, displayName: null }),
    requestSignInCode: async () => fail(desktopOnly('signing in activates a licence on a computer.')),
    verifySignInCode: async () => fail(desktopOnly('signing in activates a licence on a computer.')),
    signOut: async () => undefined,
    licenceStanding: async () => standing(),
    activateLicence: async () => fail(desktopOnly('a licence is activated on a computer.')),

    openExternal: async (link) => {
      window.open(LINKS[link], '_blank', 'noopener');
    },
    onMenu: (listener) => {
      menuListeners.add(listener);
      if (menuListeners.size === 1) window.addEventListener('keydown', onKey);
      if (!started) {
        // Start where the desktop would leave the operator: the last project
        // kept in this browser, or the sample so there is a queue to try.
        started = true;
        const last = settings.recent[0];
        setTimeout(() => command(last ? `open-recent:${last}` : 'open-sample'), 0);
      }
      return () => {
        menuListeners.delete(listener);
        if (menuListeners.size === 0) window.removeEventListener('keydown', onKey);
      };
    },
  };
}
