import { BrowserWindow, dialog } from 'electron';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shotListHtml, vfxStatusReportHtml, type Project, type QueueFilter, type VfxStatusDocument } from '@vcvfx/domain';
import { writeAtomic } from './atomic';
import { safeFileName } from './paths';

/**
 * The printable shot list (master spec §3) and the VFX status report
 * (addendum 19). The HTML comes from the domain,
 * generated here from a re-validated project — the renderer never hands
 * markup to a window that will be printed. The offscreen window is
 * sandboxed with no preload.
 */

const withDocument = async <T>(html: string, action: (w: BrowserWindow) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), 'vcvfx-print-'));
  const file = join(dir, 'document.html');
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

/** Print a landscape document, or save it as a PDF where the operator chooses. */
async function printOrSave(parent: BrowserWindow | null, html: string, mode: 'print' | 'pdf', suggested: string): Promise<{ path: string | null } | null> {
  if (mode === 'pdf') {
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

export async function printShotList(parent: BrowserWindow | null, project: Project, filter: QueueFilter, mode: 'print' | 'pdf'): Promise<{ path: string | null } | null> {
  return printOrSave(parent, shotListHtml(project, new Date(), filter), mode, `${safeFileName(project.handoff.project)} - VFX Shot List.pdf`);
}

/** The VFX status log: the very document that would be sent to VC Film Studio, printed. */
export async function printVfxStatus(parent: BrowserWindow | null, project: Project, doc: VfxStatusDocument, mode: 'print' | 'pdf'): Promise<{ path: string | null } | null> {
  const html = vfxStatusReportHtml(doc, project.handoff.vfxSupervisor ? { supervisor: project.handoff.vfxSupervisor } : {});
  return printOrSave(parent, html, mode, `${safeFileName(project.handoff.project)} - VFX Status ${doc.generatedAt.slice(0, 10)}.pdf`);
}
