import { app, dialog, net, safeStorage, type BrowserWindow } from 'electron';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FILM_STUDIO_DEFAULT_URL, buildFilmStudioStatus, vfxStatusCsv, type Project } from '@vcvfx/domain';
import type { FilmStudioInfo } from '../shared/bridge';
import { writeAtomic } from './atomic';
import { filmStudioOrigin, keyHint, sendFilmStudioStatus, uploadKeyProblem, type FetchLike } from './film-studio-send';
import { safeFileName } from './paths';
import { readSettings, updateSettings } from './settings';

/**
 * VC Film Studio from the desktop (addendum 19): the upload key, the send,
 * and the exported file.
 *
 * The key is a credential for one Film Studio production. It lives here, in
 * the main process, encrypted with the OS keychain through Electron's
 * safeStorage (the way cloud.ts keeps the sign-in), in its own file in
 * userData — never in settings.json, never in the project file, never in the
 * log, never in an answer to the renderer, which only learns whether there
 * is one and its last four characters.
 */

const keyPath = () => join(app.getPath('userData'), 'film-studio-key.bin');
const PLAIN = 'plain:';

async function readKey(): Promise<{ key: string; encrypted: boolean } | null> {
  try {
    const raw = await readFile(keyPath());
    if (raw.length === 0) return null;
    const asText = raw.toString('utf8');
    if (asText.startsWith(PLAIN)) return { key: asText.slice(PLAIN.length), encrypted: false };
    return { key: safeStorage.decryptString(raw), encrypted: true };
  } catch {
    return null;
  }
}

async function storeKey(key: string | null): Promise<void> {
  if (key === null) {
    await rm(keyPath(), { force: true });
    return;
  }
  await mkdir(app.getPath('userData'), { recursive: true });
  // Where the OS offers no keychain (some Linux desktops), it is kept as text in VC VFX's own settings folder, and Settings says so.
  if (safeStorage.isEncryptionAvailable()) await writeFile(keyPath(), safeStorage.encryptString(key), { mode: 0o600 });
  else await writeFile(keyPath(), `${PLAIN}${key}`, { encoding: 'utf8', mode: 0o600 });
}

export async function filmStudioInfo(): Promise<FilmStudioInfo> {
  const settings = await readSettings();
  const stored = await readKey();
  return {
    url: settings.filmStudioUrl || FILM_STUDIO_DEFAULT_URL,
    defaultUrl: FILM_STUDIO_DEFAULT_URL,
    hasKey: stored !== null,
    keyHint: stored ? keyHint(stored.key) : null,
    encrypted: stored ? stored.encrypted : safeStorage.isEncryptionAvailable(),
    autoSend: Boolean(settings.filmStudioAutoSend),
    available: true,
    reason: null,
  };
}

/** Set the address, store or remove the key, or the automatic send. Refuses what cannot work, saying why. */
export async function configureFilmStudio(input: { url?: string; key?: string; clearKey?: boolean; autoSend?: boolean }): Promise<FilmStudioInfo> {
  let url: string | undefined;
  if (input.url !== undefined) {
    if (input.url.trim() === '') url = '';
    else {
      const o = filmStudioOrigin(input.url);
      if (!o.ok) throw new Error(o.reason);
      url = o.origin === FILM_STUDIO_DEFAULT_URL ? '' : o.origin;
    }
  }
  if (input.key !== undefined && input.key.trim()) {
    const problem = uploadKeyProblem(input.key);
    if (problem) throw new Error(problem);
  }
  if (url !== undefined || input.autoSend !== undefined) {
    await updateSettings((s) => ({ ...s, ...(url !== undefined ? { filmStudioUrl: url } : {}), ...(input.autoSend !== undefined ? { filmStudioAutoSend: input.autoSend } : {}) }));
  }
  if (input.clearKey) await storeKey(null);
  else if (input.key !== undefined && input.key.trim()) await storeKey(input.key.trim());
  return filmStudioInfo();
}

const statusOf = (project: Project, operator: string) => buildFilmStudioStatus(project, { generatedAt: new Date(), appVersion: app.getVersion(), operator });

/** Electron's own fetch: the system's proxy and certificates, as the browser would. */
const electronFetch: FetchLike = async (url, init) => {
  const r = await net.fetch(url, init);
  return { status: r.status, text: () => r.text() };
};

export async function sendStatus(project: Project, operator: string, fetchImpl: FetchLike = electronFetch) {
  const stored = await readKey();
  if (!stored) throw new Error('No upload key yet. Make one on Film Studio’s data desk (From VC VFX → Send from VC VFX) and paste it into Settings → VC Film Studio. Until then, export the report and import it there.');
  const settings = await readSettings();
  const origin = filmStudioOrigin(settings.filmStudioUrl || FILM_STUDIO_DEFAULT_URL);
  if (!origin.ok) throw new Error(origin.reason);
  const doc = statusOf(project, operator);
  return sendFilmStudioStatus({ origin: origin.origin, key: stored.key, body: JSON.stringify(doc), shots: doc.shots.length, readyToHandOff: doc.summary.readyToHandOff, fetch: fetchImpl });
}

/** Save the document (for Film Studio's data desk) or the CSV. Null when cancelled. */
export async function exportStatus(parent: BrowserWindow | null, project: Project, operator: string, format: 'json' | 'csv'): Promise<{ path: string } | null> {
  const doc = statusOf(project, operator);
  const stamp = doc.generatedAt.slice(0, 10);
  const base = `${safeFileName(project.handoff.project)} - VFX status ${stamp}`;
  const options = format === 'json'
    ? { title: 'Export for VC Film Studio', defaultPath: `${base}.json`, filters: [{ name: 'VC Film Studio VFX status', extensions: ['json'] }] }
    : { title: 'Export VFX status as CSV', defaultPath: `${base}.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }] };
  const choice = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
  if (choice.canceled || !choice.filePath) return null;
  await writeAtomic(choice.filePath, format === 'json' ? `${JSON.stringify(doc, null, 2)}\n` : vfxStatusCsv(doc));
  return { path: choice.filePath };
}

export { statusOf as filmStudioStatusOf };
