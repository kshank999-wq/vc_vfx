import { app, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { PROJECT_EXTENSION, parseProject, serializeProject, type Project } from '@vcvfx/domain';
import type { ApiResult, ExternalLink } from '../shared/bridge';
import { writeAtomic } from './atomic';
import * as cloud from './cloud';
import { SITE_URL, isCloudConfigured } from './config';
import { cancelJob, endJob, progressSender, startJob } from './jobs';
import { activateLicence, capability, licenceStanding, READ_ONLY_REASON } from './license';
import { buildMenu } from './menu';
import { packageShot, sourceFiles } from './package-shot';
import { defaultProjectPath, isInside, outputRootProblem, withProjectExtension } from './paths';
import { printShotList } from './print';
import { FFMPEG_HELP, detectFfmpeg, generateSequence } from './sequence';
import { noteRecent, readSettings, updateSettings } from './settings';
import { verifyProject } from './verify';

/**
 * IPC handlers. Every argument from the renderer is validated here with zod,
 * and every project that arrives as text is re-parsed with the domain before
 * anything acts on it. Capability (licence) is enforced here too, not only in
 * the interface: packaging and ffmpeg refuse in read-only mode.
 */

const MAX_HANDOFF_BYTES = 64 * 1024 * 1024;

const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const fail = (error: unknown): ApiResult<never> => ({ ok: false, error: error instanceof Error ? error.message : String(error) });

const jobId = z.string().min(1).max(100);
const projectText = z.string().min(2).max(256 * 1024 * 1024);
const filterSchema = z
  .object({
    statuses: z.array(z.string()).optional(),
    scene: z.string().optional(),
    circledOnly: z.boolean().optional(),
    task: z.string().optional(),
    search: z.string().optional(),
  })
  .strict();

function projectFrom(text: string): Project {
  const parsed = parseProject(text);
  if (!parsed.ok) throw new Error(`The project could not be read: ${parsed.reason}`);
  return parsed.project;
}

type Handler<A extends unknown[], R> = (event: IpcMainInvokeEvent, ...args: A) => Promise<R>;
function handle<S extends z.ZodTypeAny, R>(channel: string, schema: S, fn: (event: IpcMainInvokeEvent, input: z.infer<S>) => Promise<R>): void {
  const handler: Handler<[unknown], R | ApiResult<never>> = async (event, raw) => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return fail(`Invalid request to ${channel}: ${parsed.error.issues[0]?.message ?? 'bad input'}`);
    return fn(event, parsed.data);
  };
  ipcMain.handle(channel, handler);
}

const none = z.undefined().or(z.null()).optional();

export function registerIpcHandlers(getWindow: () => BrowserWindow | null, isDevelopment: boolean): void {
  const parent = () => getWindow() ?? undefined;
  const refreshMenu = () => void buildMenu(getWindow, isDevelopment);

  async function ensureOutputRoot(projectKey: string, project: Project, ask: boolean): Promise<string | null> {
    const settings = await readSettings();
    const stored = settings.outputRoots[projectKey];
    if (stored && !ask) return stored;
    const window = parent();
    const options: Electron.OpenDialogOptions = {
      title: 'Choose the output root for this project’s VFX packages',
      buttonLabel: 'Use This Folder',
      properties: ['openDirectory', 'createDirectory'],
      ...(stored ? { defaultPath: stored } : {}),
    };
    const choice = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    const root = choice.filePaths[0];
    if (choice.canceled || !root) return null;
    const problem = outputRootProblem(root, sourceFiles(project));
    if (problem) throw new Error(problem);
    await updateSettings((s) => ({ ...s, outputRoots: { ...s.outputRoots, [projectKey]: root } }));
    return root;
  }

  async function readProjectFile(path: string) {
    const text = await readFile(path, 'utf8');
    projectFrom(text);
    await noteRecent(path);
    refreshMenu();
    return { path, text };
  }

  handle('app:info', none, async () => ({ version: app.getVersion(), siteUrl: SITE_URL, cloudConfigured: isCloudConfigured(), platform: process.platform }));

  handle('file:open-handoff', none, async () => {
    try {
      const window = parent();
      const options: Electron.OpenDialogOptions = { title: 'Open VCDIT Handoff', properties: ['openFile'], filters: [{ name: 'VCDIT handoff', extensions: ['json'] }] };
      const choice = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      const path = choice.filePaths[0];
      if (choice.canceled || !path) return ok(null);
      if ((await stat(path)).size > MAX_HANDOFF_BYTES) throw new Error('That file is too large to be a VCDIT handoff.');
      return ok({ path, text: await readFile(path, 'utf8') });
    } catch (error) {
      return fail(error);
    }
  });

  handle('file:open-project-dialog', none, async () => {
    try {
      const window = parent();
      const options: Electron.OpenDialogOptions = { title: 'Open Project', properties: ['openFile'], filters: [{ name: 'VC VFX project', extensions: [PROJECT_EXTENSION] }] };
      const choice = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      const path = choice.filePaths[0];
      if (choice.canceled || !path) return ok(null);
      return ok(await readProjectFile(path));
    } catch (error) {
      return fail(error);
    }
  });

  handle('file:open-project-path', z.string().min(1).max(4096), async (_e, path) => {
    try {
      return ok(await readProjectFile(path));
    } catch (error) {
      return fail(error);
    }
  });

  handle(
    'file:save-project',
    z.object({ path: z.string().max(4096).nullable(), text: projectText, suggestedPath: z.string().max(4096).optional(), saveAs: z.boolean().optional() }),
    async (_e, input) => {
      try {
        const project = projectFrom(input.text);
        let target = input.path;
        if (!target || input.saveAs) {
          const window = parent();
          const options: Electron.SaveDialogOptions = {
            title: 'Save VC VFX Project',
            defaultPath: input.suggestedPath ?? target ?? defaultProjectPath(project.handoffPath, app.getPath('documents'), project.handoff.project),
            filters: [{ name: 'VC VFX project', extensions: [PROJECT_EXTENSION] }],
          };
          const choice = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
          if (choice.canceled || !choice.filePath) return ok(null);
          target = withProjectExtension(choice.filePath);
        }
        const sources = sourceFiles(project);
        if (sources.some((s) => s === target || isInside(target!, dirname(s)))) {
          throw new Error('Projects are never saved inside a source media folder. Choose another location (beside the handoff is fine).');
        }
        await writeAtomic(target, serializeProject(project));
        if (target !== input.path) {
          await noteRecent(target);
          refreshMenu();
        }
        return ok({ path: target });
      } catch (error) {
        return fail(error);
      }
    },
  );

  handle('window:document-state', z.object({ path: z.string().nullable(), title: z.string().max(500), dirty: z.boolean() }), async (_e, input) => {
    const window = getWindow();
    if (!window) return;
    window.setTitle(`${input.title}${input.dirty ? ' •' : ''} — VC VFX`);
    if (process.platform === 'darwin') {
      window.setRepresentedFilename(input.path ?? '');
      window.setDocumentEdited(input.dirty);
    }
  });

  handle('settings:get', none, async () => readSettings());
  handle('settings:set', z.object({ operatorName: z.string().max(200).optional(), ffmpegPath: z.string().max(4096).optional() }).strict(), async (_e, patch) =>
    updateSettings((s) => ({ ...s, ...patch })),
  );
  handle('settings:choose-output-root', z.object({ projectKey: z.string().min(1).max(4200), text: projectText }), async (_e, input) => {
    try {
      return ok(await ensureOutputRoot(input.projectKey, projectFrom(input.text), true));
    } catch (error) {
      return fail(error);
    }
  });

  handle('print:shot-list', z.object({ text: projectText, filter: filterSchema, mode: z.enum(['print', 'pdf']) }), async (_e, input) => {
    try {
      return ok(await printShotList(getWindow(), projectFrom(input.text), input.filter as never, input.mode));
    } catch (error) {
      return fail(error);
    }
  });

  handle('job:verify', z.object({ jobId, text: projectText }), async (event, input) => {
    const signal = startJob(input.jobId);
    const progress = progressSender(event.sender, input.jobId, 'Verifying sources');
    try {
      const results = await verifyProject(projectFrom(input.text), {
        signal,
        onProgress: (p) => progress(p.bytesDone, Math.max(p.bytesTotal, 1), p.file ? `${p.shotId} · ${p.file}` : p.shotId),
      });
      return ok(results);
    } catch (error) {
      return fail(error);
    } finally {
      endJob(input.jobId);
    }
  });

  handle(
    'job:package',
    z.object({ jobId, text: projectText, shotId: z.string().min(1).max(200), projectKey: z.string().min(1).max(4200), operator: z.string().min(1).max(200) }),
    async (event, input) => {
      if ((await capability()) !== 'full') return fail(READ_ONLY_REASON);
      const signal = startJob(input.jobId);
      const progress = progressSender(event.sender, input.jobId, `Packaging ${input.shotId}`);
      try {
        const project = projectFrom(input.text);
        const root = await ensureOutputRoot(input.projectKey, project, false);
        if (!root) return fail('No output root was chosen, so nothing was written.');
        const result = await packageShot({
          project,
          shotId: input.shotId,
          outputRoot: root,
          operator: input.operator,
          appVersion: app.getVersion(),
          now: new Date(),
          signal,
          onProgress: (done, total, file) => progress(done, total, file),
        });
        if (!result.ok) return fail(result.reason);
        return ok({ text: serializeProject(result.project), folder: result.folder, version: result.version, files: result.files.length });
      } catch (error) {
        return fail(error);
      } finally {
        endJob(input.jobId);
      }
    },
  );

  handle('ffmpeg:detect', none, async () => detectFfmpeg((await readSettings()).ffmpegPath));

  handle(
    'job:sequence',
    z.object({ jobId, text: projectText, shotId: z.string().min(1).max(200), projectKey: z.string().min(1).max(4200) }),
    async (event, input) => {
      if ((await capability()) !== 'full') return fail(READ_ONLY_REASON);
      const ffmpeg = await detectFfmpeg((await readSettings()).ffmpegPath);
      if (!ffmpeg.found || !ffmpeg.path) return fail(FFMPEG_HELP);
      const signal = startJob(input.jobId);
      const progress = progressSender(event.sender, input.jobId, `Writing plates for ${input.shotId}`);
      try {
        const project = projectFrom(input.text);
        const root = await ensureOutputRoot(input.projectKey, project, false);
        if (!root) return fail('No output root was chosen, so nothing was written.');
        const result = await generateSequence({ project, shotId: input.shotId, outputRoot: root, ffmpeg: ffmpeg.path, signal, onProgress: (f, t) => progress(f, t, `${f} / ${t} frames`) });
        if (!result.ok) return fail(result.reason);
        return ok({ folder: result.folder, pattern: result.pattern, frames: result.frames });
      } catch (error) {
        return fail(error);
      } finally {
        endJob(input.jobId);
      }
    },
  );

  handle('job:cancel', jobId, async (_e, id) => cancelJob(id));
  handle('shell:reveal', z.string().min(1).max(4096), async (_e, path) => shell.showItemInFolder(path));

  handle('account:status', none, async () => cloud.accountStatus().catch(() => ({ configured: isCloudConfigured(), signedIn: false, email: null, displayName: null })));
  handle('account:request-code', z.string().email().max(320), async (_e, email) => {
    try {
      await cloud.requestSignInCode(email);
      return ok(null);
    } catch (error) {
      return fail(error);
    }
  });
  handle('account:verify-code', z.object({ email: z.string().email().max(320), code: z.string().regex(/^\d{6,10}$/, 'Enter the code from the email') }), async (_e, input) => {
    try {
      const status = await cloud.verifySignInCode(input.email, input.code);
      void licenceStanding(true);
      return ok(status);
    } catch (error) {
      return fail(error);
    }
  });
  handle('account:sign-out', none, async () => cloud.signOut());
  handle('licence:standing', z.boolean(), async (_e, recheck) => licenceStanding(recheck));
  handle('licence:activate', none, async () => {
    try {
      const outcome = await activateLicence();
      return outcome.activated ? ok({ message: outcome.message }) : fail(outcome.message);
    } catch (error) {
      return fail(error);
    }
  });

  const LINKS: Record<ExternalLink, string> = {
    site: SITE_URL,
    subscribe: `${SITE_URL}/#pricing`,
    account: `${SITE_URL}/account`,
    ffmpeg: 'https://ffmpeg.org/download.html',
  };
  handle('shell:open-external', z.enum(['site', 'subscribe', 'account', 'ffmpeg']), async (_e, link) => {
    await shell.openExternal(LINKS[link]);
  });
}
