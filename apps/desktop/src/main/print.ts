import { BrowserWindow, dialog } from 'electron';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shotListHtml, type Project, type QueueFilter } from '@vcvfx/domain';
import { writeAtomic } from './atomic';
import { safeFileName } from './paths';

/**
 * The printable shot list (master spec §3). The HTML comes from the domain,
 * generated here from a re-validated project — the renderer never hands
 * markup to a window that will be printed. The offscreen window is
 * sandboxed with no preload.
 */

const withDocument = async <T>(html: string, action: (w: BrowserWindow) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), 'vcvfx-print-'));
  const file = join(dir, 'shot-list.html');
  await writeFile(file, html, 'utf8');
  const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, javascript: false } });
  try {
    await window.loadFile(file);
    return await action(window);
  } finally {
    window.destroy();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
};

export async function printShotList(parent: BrowserWindow | null, project: Project, filter: QueueFilter, mode: 'print' | 'pdf'): Promise<{ path: string | null } | null> {
  const html = shotListHtml(project, new Date(), filter);
  if (mode === 'pdf') {
    const suggested = `${safeFileName(project.handoff.project)} - VFX Shot List.pdf`;
    const options = { defaultPath: suggested, filters: [{ name: 'PDF', extensions: ['pdf'] }] };
    const choice = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
    if (choice.canceled || !choice.filePath) return null;
    const pdf = await withDocument(html, (w) => w.webContents.printToPDF({ landscape: true, printBackground: true, pageSize: 'A4', preferCSSPageSize: true }));
    await writeAtomic(choice.filePath, pdf);
    return { path: choice.filePath };
  }
  await withDocument(
    html,
    (w) =>
      new Promise<void>((resolvePromise, reject) =>
        w.webContents.print({ landscape: true, printBackground: true }, (success, reason) =>
          success || reason === 'cancelled' ? resolvePromise() : reject(new Error(reason)),
        ),
      ),
  );
  return { path: null };
}
