import { app, dialog, ipcMain, nativeImage, net, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
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
import { FFMPEG_HELP, generateSequence } from './sequence';
import { probeProject } from './probe';
import { cachedResolver, type ResolvedTools } from './ffmpeg-tools';
import type { FrameCache } from './frame-cache';
import { viewerFrame, viewerSources } from './viewer';
import type { FfmpegInfo } from '../shared/bridge';
import { noteRecent, readSettings, updateSettings } from './settings';
import { join } from 'node:path';
import { engineInfo, rotoExport, sam2Files, rotoFrame, rotoMask, rotoRun, rotoSession, type RotoEnv } from './roto/api';
import { downloadModel, type FetchLike } from './roto/models';
import { ortCandidates } from './roto/sam2-ort';
import { verifyProject } from './verify';
import { registerKeyHandlers } from './key/ipc-key';
import { registerCleanPlateHandlers } from './cleanplate/ipc-cleanplate';
import { registerIsolateHandlers } from './isolate/ipc-isolate';
import { registerTextureHandlers } from './texture/ipc-texture';
import { trackCommand, trackFrame, trackSession, trackView, type CameraEnv } from './camera/api';
import { COMMAND_SPECS, type CameraCommand } from '../shared/camera/commands';
import { checkerboardPdf, checkerboardPixels } from '../shared/camera/calibration';
import { encodePng } from './roto/png';
import { resolveFrameUrl } from './frame-cache';
import { fetchAllowance, siteModelClient } from './ai/client';
import { ackAiRun, cancelAiRun, runAiTrack, type AiServiceDeps } from './ai/service';
import type { AiRunEvent } from '../shared/bridge';

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

/** Settings → bundled → PATH (ffmpeg-tools.ts), resolved once per Settings value. */
const tools = cachedResolver(() => ({ resourcesPath: process.resourcesPath, appPath: app.getAppPath(), packaged: app.isPackaged, platform: process.platform, arch: process.arch }));
const currentTools = async (): Promise<ResolvedTools> => tools.get((await readSettings()).ffmpegPath);
const ffmpegInfo = (t: ResolvedTools): FfmpegInfo =>
  t.ffmpeg ? { found: true, path: t.ffmpeg, version: t.ffmpegVersion, source: t.source, problem: null } : { found: false, path: null, version: null, source: null, problem: t.problem };

export function registerIpcHandlers(getWindow: () => BrowserWindow | null, isDevelopment: boolean, frameCache: FrameCache): void {
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
  handle('settings:set', z.object({ operatorName: z.string().max(200).optional(), ffmpegPath: z.string().max(4096).optional(), modelBaseUrl: z.union([z.literal(''), z.string().url().max(2048).startsWith('https://')]).optional() }).strict(), async (_e, patch) => {
    if (patch.ffmpegPath !== undefined) tools.reset();
    return updateSettings((s) => ({ ...s, ...patch }));
  });
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

  handle('ffmpeg:detect', none, async () => {
    tools.reset();
    return ffmpegInfo(await currentTools());
  });

  handle(
    'job:sequence',
    z.object({ jobId, text: projectText, shotId: z.string().min(1).max(200), projectKey: z.string().min(1).max(4200) }),
    async (event, input) => {
      if ((await capability()) !== 'full') return fail(READ_ONLY_REASON);
      const resolved = await currentTools();
      if (!resolved.ffmpeg) return fail(resolved.problem ?? FFMPEG_HELP);
      const signal = startJob(input.jobId);
      const progress = progressSender(event.sender, input.jobId, `Writing plates for ${input.shotId}`);
      try {
        const project = projectFrom(input.text);
        const root = await ensureOutputRoot(input.projectKey, project, false);
        if (!root) return fail('No output root was chosen, so nothing was written.');
        const result = await generateSequence({
          project,
          shotId: input.shotId,
          outputRoot: root,
          ffmpeg: resolved.ffmpeg,
          ffprobe: resolved.ffprobe,
          caps: resolved.caps,
          appVersion: app.getVersion(),
          signal,
          onProgress: (f, t) => progress(f, t, `${f} / ${t} frames`),
        });
        if (!result.ok) return fail(result.reason);
        return ok({ folder: result.folder, pattern: result.pattern, frames: result.frames, record: result.record, notes: result.notes, ...(result.probed ? { probed: result.probed } : {}) });
      } catch (error) {
        return fail(error);
      } finally {
        endJob(input.jobId);
      }
    },
  );

  // Read only, like verification: allowed in read-only licence mode.
  handle('job:probe', z.object({ jobId, text: projectText, shotIds: z.array(z.string().min(1).max(200)).max(10000).optional() }), async (event, input) => {
    const ffprobe = (await currentTools()).ffprobe;
    if (!ffprobe) return ok({ ffprobe: null, results: [] });
    const signal = startJob(input.jobId);
    const progress = progressSender(event.sender, input.jobId, 'Reading clips');
    try {
      const results = await probeProject(projectFrom(input.text), ffprobe, {
        ...(input.shotIds ? { shotIds: input.shotIds } : {}),
        signal,
        onProgress: (done, total, shotId) => progress(done, Math.max(total, 1), shotId),
      });
      return ok({ ffprobe, results });
    } catch (error) {
      return fail(error);
    } finally {
      endJob(input.jobId);
    }
  });

  // The viewer: read only, so allowed in read-only licence mode, like verification.
  // Frame requests arrive many times a second with the same project text; it is parsed once.
  let viewerCache: { text: string; project: Project } | null = null;
  const viewerProject = (text: string): Project => {
    if (viewerCache?.text !== text) viewerCache = { text, project: projectFrom(text) };
    return viewerCache.project;
  };
  const outputRootFor = async (projectKey: string) => (await readSettings()).outputRoots[projectKey] ?? null;
  const shotInput = { text: projectText, shotId: z.string().min(1).max(200), projectKey: z.string().min(1).max(4200) };
  handle('viewer:sources', z.object(shotInput), async (_e, input) => {
    try {
      return ok(await viewerSources(viewerProject(input.text), input.shotId, await outputRootFor(input.projectKey)));
    } catch (error) {
      return fail(error);
    }
  });
  handle(
    'viewer:frame',
    z.object({
      ...shotInput,
      layer: z.enum(['source', 'plates']),
      version: z.number().int().positive().max(999).optional(),
      frame: z.number().int().nonnegative().max(100_000_000),
      view: z.enum(['rec709', 'raw']),
      maxWidth: z.number().int().min(64).max(4096),
      prefetch: z.boolean().optional(),
    }),
    async (_e, input) => {
      try {
        const resolved = await currentTools();
        if (!resolved.ffmpeg) return fail(resolved.problem ?? FFMPEG_HELP);
        return ok(await viewerFrame(viewerProject(input.text), input, await outputRootFor(input.projectKey), { cache: frameCache, ffmpeg: resolved.ffmpeg, caps: resolved.caps }));
      } catch (error) {
        return fail(error);
      }
    },
  );

  // Paint-to-roto (addendum 04). Looking (session, frames, mattes) is allowed read-only, like the viewer;
  // running an engine, exporting and downloading a model are processing and need a licence.
  const rotoEnv = async (): Promise<RotoEnv> => {
    const t = await currentTools();
    const loc = { resourcesPath: process.resourcesPath, appPath: app.getAppPath(), packaged: app.isPackaged };
    return {
      ffmpeg: t.ffmpeg,
      caps: t.caps,
      cacheRoot: join(app.getPath('userData'), 'Roto Cache'),
      frameCache,
      userData: app.getPath('userData'),
      packaged: app.isPackaged,
      ort: ortCandidates(loc),
      workerFile: join(__dirname, 'roto-worker.js'),
      generator: `VC VFX ${app.getVersion()}`,
    };
  };
  handle('roto:session', z.object(shotInput), async (_e, input) => {
    try {
      return ok(await rotoSession(viewerProject(input.text), input.shotId, await outputRootFor(input.projectKey), await rotoEnv()));
    } catch (error) {
      return fail(error);
    }
  });
  handle('roto:frame', z.object({ ...shotInput, frame: z.number().int().nonnegative().max(100_000_000), maxWidth: z.number().int().min(64).max(4096), prefetch: z.boolean().optional() }), async (_e, input) => {
    try {
      return ok(await rotoFrame(viewerProject(input.text), input, await outputRootFor(input.projectKey), await rotoEnv()));
    } catch (error) {
      return fail(error);
    }
  });
  handle('roto:mask', z.object({ ...shotInput, partId: z.string().max(32).nullable(), frame: z.number().int().nonnegative().max(100_000_000), maxWidth: z.number().int().min(32).max(8192) }), async (_e, input) => {
    try {
      return ok(await rotoMask(viewerProject(input.text), input, await rotoEnv()));
    } catch (error) {
      return fail(error);
    }
  });
  handle(
    'job:roto-run',
    z.object({ ...shotInput, jobId, partId: z.string().min(1).max(32), from: z.number().int().nonnegative().max(100_000_000), directions: z.array(z.enum(['key', 'forward', 'backward'])).min(1).max(3) }),
    async (event, input) => {
      if ((await capability()) !== 'full') return fail(READ_ONLY_REASON);
      const signal = startJob(input.jobId);
      const progress = progressSender(event.sender, input.jobId, `Roto ${input.shotId}`);
      try {
        const results = await rotoRun(projectFrom(input.text), input, await outputRootFor(input.projectKey), await rotoEnv(), {
          signal,
          onProgress: (done, total, frame) => progress(done, total, frame !== undefined ? `frame ${frame}` : undefined),
        });
        return ok({ results });
      } catch (error) {
        return fail(error);
      } finally {
        endJob(input.jobId);
      }
    },
  );
  handle('job:roto-export', z.object({ ...shotInput, jobId, operator: z.string().min(1).max(200), exr: z.boolean() }), async (event, input) => {
    if ((await capability()) !== 'full') return fail(READ_ONLY_REASON);
    const signal = startJob(input.jobId);
    const progress = progressSender(event.sender, input.jobId, `Exporting mattes for ${input.shotId}`);
    try {
      const project = projectFrom(input.text);
      const root = await ensureOutputRoot(input.projectKey, project, false);
      if (!root) return fail('No output root was chosen, so nothing was written.');
      return ok(await rotoExport(project, input, root, await rotoEnv(), { signal, onProgress: (done, total) => progress(done, total, `${done} / ${total} frames`) }));
    } catch (error) {
      return fail(error);
    } finally {
      endJob(input.jobId);
    }
  });
  handle('job:roto-model', z.object({ jobId, action: z.enum(['status', 'download']) }), async (event, input) => {
    try {
      const env = await rotoEnv();
      if (input.action === 'download') {
        if ((await capability()) !== 'full') return fail(READ_ONLY_REASON);
        const signal = startJob(input.jobId);
        const progress = progressSender(event.sender, input.jobId, 'Downloading the SAM 2 model');
        try {
          const settings = await readSettings();
          await downloadModel({
            userData: env.userData,
            packaged: env.packaged,
            baseUrl: process.env['VCVFX_SAM2_URL'] || settings.modelBaseUrl || undefined,
            fetch: ((url: string, init?: { signal?: AbortSignal }) => net.fetch(url, init)) as unknown as FetchLike,
            signal,
            onProgress: (done, total, file) => progress(done, total, file),
          });
        } finally {
          endJob(input.jobId);
        }
      }
      return ok((await engineInfo(env)).find((e) => e.id === 'sam2')!);
    } catch (error) {
      return fail(error);
    }
  });

  // Green/blue-screen keying (addendum 09): the handlers live in key/ipc-key.ts, with the same rules as roto's.
  registerKeyHandlers({
    handle,
    viewerProject,
    projectFrom,
    outputRootFor,
    ensureOutputRoot,
    licensed: async () => (await capability()) === 'full',
    readOnlyReason: READ_ONLY_REASON,
    startJob,
    endJob,
    progress: (event, id, label) => progressSender(event.sender, id, label),
    env: async () => {
      const t = await currentTools();
      return { ffmpeg: t.ffmpeg, caps: t.caps, rotoCacheRoot: join(app.getPath('userData'), 'Roto Cache'), keyCacheRoot: join(app.getPath('userData'), 'Key Cache'), workerFile: join(__dirname, 'key-worker.js'), generator: `VC VFX ${app.getVersion()}` };
    },
    chooseImage: async () => {
      const window = parent();
      const options: Electron.OpenDialogOptions = {
        title: 'Choose a background plate or representative background frame',
        properties: ['openFile'],
        filters: [
          { name: 'Images', extensions: ['exr', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'dpx'] },
          { name: 'All files', extensions: ['*'] },
        ],
      };
      const choice = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      return choice.canceled ? null : (choice.filePaths[0] ?? null);
    },
  });

  // Clean plates (addendum 10): the handlers live in cleanplate/ipc-cleanplate.ts, with the key's rules.
  registerCleanPlateHandlers({
    handle,
    viewerProject,
    projectFrom,
    outputRootFor,
    ensureOutputRoot,
    licensed: async () => (await capability()) === 'full',
    readOnlyReason: READ_ONLY_REASON,
    startJob,
    endJob,
    progress: (event, id, label) => progressSender(event.sender, id, label),
    env: async () => {
      const t = await currentTools();
      return { ffmpeg: t.ffmpeg, caps: t.caps, rotoCacheRoot: join(app.getPath('userData'), 'Roto Cache'), cacheRoot: join(app.getPath('userData'), 'Clean Plate Cache'), workerFile: join(__dirname, 'cleanplate-worker.js'), generator: `VC VFX ${app.getVersion()}` };
    },
  });

  // Sky isolation and background removal (addendum 11): handlers in isolate/ipc-isolate.ts, with the clean plate's rules;
  // a subject's engines are roto's (Track, and SAM 2.1 when its model is installed).
  registerIsolateHandlers({
    handle,
    viewerProject,
    projectFrom,
    outputRootFor,
    ensureOutputRoot,
    licensed: async () => (await capability()) === 'full',
    readOnlyReason: READ_ONLY_REASON,
    startJob,
    endJob,
    progress: (event, id, label) => progressSender(event.sender, id, label),
    env: async () => {
      const t = await currentTools();
      return {
        ffmpeg: t.ffmpeg,
        caps: t.caps,
        rotoCacheRoot: join(app.getPath('userData'), 'Roto Cache'),
        cacheRoot: join(app.getPath('userData'), 'Isolate Cache'),
        workerFile: join(__dirname, 'isolate-worker.js'),
        generator: `VC VFX ${app.getVersion()}`,
        engines: async () => (await engineInfo(await rotoEnv())).map((e) => ({ id: e.id, label: e.label, available: e.available, reason: e.reason })),
        sam2: async () => sam2Files(await rotoEnv()),
      };
    },
  });

  // Texture extraction (addendum 12): handlers in texture/ipc-texture.ts, with the clean plate's rules. References are
  // chosen here (read only) and only ever read.
  registerTextureHandlers({
    handle,
    viewerProject,
    projectFrom,
    ensureOutputRoot,
    licensed: async () => (await capability()) === 'full',
    readOnlyReason: READ_ONLY_REASON,
    startJob,
    endJob,
    progress: (event, id, label) => progressSender(event.sender, id, label),
    chooseFiles: async (kind) => {
      const window = parent();
      const filters =
        kind === 'scan'
          ? [{ name: 'Point clouds, meshes, survey', extensions: ['e57', 'ply', 'las', 'obj', 'xyz', 'pts', 'csv', 'txt'] }]
          : [{ name: kind === 'panorama' ? 'Equirectangular panoramas' : 'Photographs', extensions: ['jpg', 'jpeg', 'png', 'tif', 'tiff', 'exr', 'hdr', 'dpx'] }];
      const options: Electron.OpenDialogOptions = {
        title: kind === 'photo' ? 'Add reference photos' : kind === 'panorama' ? 'Add the 360° panorama' : 'Add the LiDAR scan or mesh',
        properties: kind === 'photo' ? ['openFile', 'multiSelections'] : ['openFile'],
        filters: [...filters, { name: 'All files', extensions: ['*'] }],
      };
      const choice = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      return choice.canceled ? null : choice.filePaths;
    },
    env: async () => {
      const t = await currentTools();
      return {
        ffmpeg: t.ffmpeg,
        caps: t.caps,
        cacheRoot: join(app.getPath('userData'), 'Texture Cache'),
        workerFile: join(__dirname, 'texture-worker.js'),
        generator: `VC VFX ${app.getVersion()}`,
      };
    },
  });

  // Camera and 2D tracking (addendum 06). Looking is allowed read-only; commands that change the
  // track or write files need a licence (a report is a question, and allowed).
  const cameraEnv = async (): Promise<CameraEnv> => {
    const t = await currentTools();
    return {
      ffmpeg: t.ffmpeg,
      caps: t.caps,
      cacheRoot: join(app.getPath('userData'), 'Track Cache'),
      rotoCacheRoot: join(app.getPath('userData'), 'Roto Cache'),
      frameCache,
      workerFile: join(__dirname, 'camera-worker.js'),
      generator: `VC VFX ${app.getVersion()}`,
    };
  };
  const trackInput = { ...shotInput, workingWidth: z.number().int().min(256).max(8192).optional() };
  handle('track:session', z.object(trackInput), async (_e, input) => {
    try {
      return ok(await trackSession(viewerProject(input.text), input, await outputRootFor(input.projectKey), await cameraEnv()));
    } catch (error) {
      return fail(error);
    }
  });
  handle('track:frame', z.object({ ...trackInput, frame: z.number().int().nonnegative().max(100_000_000), maxWidth: z.number().int().min(64).max(4096), prefetch: z.boolean().optional() }), async (_e, input) => {
    try {
      return ok(await trackFrame(viewerProject(input.text), input, await outputRootFor(input.projectKey), await cameraEnv()));
    } catch (error) {
      return fail(error);
    }
  });
  handle('track:view', z.object({ ...trackInput, clouds: z.boolean().optional() }), async (_e, input) => {
    try {
      return ok(await trackView(viewerProject(input.text), input, await cameraEnv()));
    } catch (error) {
      return fail(error);
    }
  });
  const verbs = Object.keys(COMMAND_SPECS) as [string, ...string[]];
  handle(
    'job:track-command',
    z.object({ ...trackInput, jobId, operator: z.string().min(1).max(200), command: z.object({ verb: z.enum(verbs) }).passthrough().refine((c) => JSON.stringify(c).length < 2_000_000, 'Command too large') }),
    async (event, input) => {
      const verb = input.command.verb as keyof typeof COMMAND_SPECS;
      if (COMMAND_SPECS[verb].mutates && (await capability()) !== 'full') return fail(READ_ONLY_REASON);
      const signal = startJob(input.jobId);
      const progress = progressSender(event.sender, input.jobId, `Tracking ${input.shotId}`);
      try {
        const project = projectFrom(input.text);
        const exporting = verb === 'export_camera' || verb === 'track2d_export';
        const root = exporting ? await ensureOutputRoot(input.projectKey, project, false) : await outputRootFor(input.projectKey);
        if (exporting && !root) return fail('No output root was chosen, so nothing was written.');
        const outcome = await trackCommand(project, { shotId: input.shotId, projectKey: input.projectKey, operator: input.operator, command: input.command as unknown as CameraCommand, ...(input.workingWidth ? { workingWidth: input.workingWidth } : {}) }, root, await cameraEnv(), {
          signal,
          onProgress: (label, done, total) => progress(done, Math.max(1, total), label),
        });
        return ok(outcome);
      } catch (error) {
        return fail(error);
      } finally {
        endJob(input.jobId);
      }
    },
  );
  handle('track:choose-lidar', none, async () => {
    try {
      const window = parent();
      const options: Electron.OpenDialogOptions = {
        title: 'Import LiDAR, mesh or survey points',
        properties: ['openFile'],
        filters: [
          { name: 'Point clouds, meshes, survey', extensions: ['e57', 'ply', 'las', 'obj', 'xyz', 'pts', 'csv', 'txt'] },
          { name: 'All files', extensions: ['*'] },
        ],
      };
      const choice = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      return ok(choice.canceled ? null : (choice.filePaths[0] ?? null));
    } catch (error) {
      return fail(error);
    }
  });
  handle('track:calibration-target', z.object({ cols: z.number().int().min(3).max(40), rows: z.number().int().min(3).max(40), squareMm: z.number().min(2).max(500), marginMm: z.number().min(0).max(200) }), async (_e, input) => {
    try {
      const window = parent();
      const options: Electron.SaveDialogOptions = { title: 'Save calibration board', defaultPath: `checkerboard_${input.cols}x${input.rows}_${input.squareMm}mm.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] };
      const choice = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
      if (choice.canceled || !choice.filePath) return ok(null);
      await writeAtomic(choice.filePath, checkerboardPdf(input));
      const px = checkerboardPixels(input, 300);
      await writeAtomic(choice.filePath.replace(/\.pdf$/i, '') + '_300dpi.png', encodePng({ width: px.width, height: px.height, bitDepth: 8, data: px.data }, { text: { Comment: `Calibration board ${input.cols}x${input.rows} squares of ${input.squareMm} mm at 300 dpi` } }));
      return ok({ path: choice.filePath });
    } catch (error) {
      return fail(error);
    }
  });

  // The AI tracking assistant (addendum 07). The loop runs here beside the camera worker; the
  // project stays the renderer's, which applies every change the assistant asks for (and logs it).
  // Model turns go to vc-vfx.com with the account's token; frames go only where the artist
  // allowed it for this project on this computer.
  const site = { siteUrl: SITE_URL, token: cloud.accessToken };
  const aiModel = siteModelClient(site);
  const aiInput = z.object({
    ...trackInput,
    runId: z.string().min(1).max(100),
    operator: z.string().min(1).max(200),
    instruction: z.string().trim().min(1).max(4000),
    notes: z.array(z.string().max(500)).max(10).optional(),
    framesAllowed: z.boolean(),
    exportAllowed: z.boolean(),
    creditCap: z.number().min(1).max(400),
    maxTurns: z.number().int().min(1).max(80),
    focalRange: z.object({ min: z.number().positive().max(2000), max: z.number().positive().max(2000) }).nullable().optional(),
    conversationId: z.string().max(100).nullable().optional(),
  });
  handle('ai:track-run', aiInput, async (event, input) => {
    if ((await capability()) !== 'full') return fail(READ_ONLY_REASON);
    if (!isCloudConfigured()) return fail(cloud.NOT_CONFIGURED);
    try {
      const req = input;
      // The renderer's word is not enough to send footage: the stored per-project choice must agree.
      const framesAllowed = req.framesAllowed && Boolean((await readSettings()).aiFrames?.[req.projectKey]);
      const actor = `${req.operator} (AI assistant)`;
      const contents = event.sender;
      const rootFor = async (project: Project, exporting: boolean) => (exporting ? await ensureOutputRoot(req.projectKey, project, false) : await outputRootFor(req.projectKey));
      const deps: AiServiceDeps = {
        model: aiModel,
        canEdit: async () => (await capability()) === 'full',
        readOnlyReason: READ_ONLY_REASON,
        session: async (project, r) => trackSession(project, { shotId: r.shotId, ...(r.workingWidth ? { workingWidth: r.workingWidth } : {}) }, await outputRootFor(r.projectKey), await cameraEnv()),
        command: async (project, r, command, o) => {
          const exporting = command.verb === 'export_camera' || command.verb === 'track2d_export';
          const root = await rootFor(project, exporting);
          if (exporting && !root) return { ok: false, error: 'No output root was chosen, so nothing was written.' };
          return trackCommand(project, { shotId: r.shotId, projectKey: r.projectKey, operator: actor, command, ...(r.workingWidth ? { workingWidth: r.workingWidth } : {}) }, root, await cameraEnv(), { ...(o.signal ? { signal: o.signal } : {}), ...(o.onProgress ? { onProgress: o.onProgress } : {}) });
        },
        view: async (project, r, clouds) => trackView(project, { shotId: r.shotId, projectKey: r.projectKey, clouds }, await cameraEnv()),
        roto: async (project, r, partId, from, directions, signal) => rotoRun(project, { shotId: r.shotId, projectKey: r.projectKey, partId, from, directions }, await outputRootFor(r.projectKey), await rotoEnv(), { ...(signal ? { signal } : {}) }),
        frame: async (project, r, frame, maxWidth) => trackFrame(project, { text: serializeProject(project), shotId: r.shotId, projectKey: r.projectKey, frame, maxWidth }, await outputRootFor(r.projectKey), await cameraEnv()),
        image: async (vf, maxWidth, draw) => {
          const file = resolveFrameUrl(vf.url, frameCache.dir);
          if (!file) throw new Error('The frame is not in the cache.');
          let img = nativeImage.createFromPath(file);
          if (img.isEmpty()) throw new Error('The frame could not be decoded.');
          if (img.getSize().width > maxWidth) img = img.resize({ width: maxWidth, quality: 'good' });
          const size = img.getSize();
          if (draw) {
            const bitmap = img.toBitmap();
            draw(bitmap, size);
            img = nativeImage.createFromBitmap(bitmap, { width: size.width, height: size.height });
          }
          return { mediaType: 'image/jpeg', data: img.toJPEG(82).toString('base64'), width: size.width, height: size.height };
        },
        send: (e: AiRunEvent) => {
          if (!contents.isDestroyed()) contents.send('ai:event', e);
        },
      };
      return ok(await runAiTrack(input.text, { ...req, framesAllowed }, deps));
    } catch (error) {
      return fail(error);
    }
  });
  handle(
    'ai:track-ack',
    z.object({ runId: z.string().max(100), seq: z.number().int().positive(), ok: z.boolean(), text: projectText.optional(), error: z.string().max(2000).optional(), accepted: z.boolean().optional(), corners: z.array(z.tuple([z.number().finite(), z.number().finite()])).length(4).optional(), note: z.string().max(500).optional() }),
    async (_e, ack) => ackAiRun(ack),
  );
  handle('ai:track-cancel', z.string().max(100), async (_e, runId) => cancelAiRun(runId));
  handle('ai:allowance', none, async () => {
    try {
      if (!isCloudConfigured()) throw new Error(cloud.NOT_CONFIGURED);
      return ok(await fetchAllowance(site));
    } catch (error) {
      return fail(error);
    }
  });
  handle('ai:frames', z.object({ projectKey: z.string().min(1).max(4200), allowed: z.boolean().optional() }), async (_e, input) => {
    if (input.allowed !== undefined) await updateSettings((s) => ({ ...s, aiFrames: { ...(s.aiFrames ?? {}), [input.projectKey]: input.allowed! } }));
    return Boolean((await readSettings()).aiFrames?.[input.projectKey]);
  });

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
  handle('account:sign-in-password', z.object({ email: z.string().email().max(320), password: z.string().min(1).max(1024) }), async (_e, input) => {
    try {
      const status = await cloud.signInWithPassword(input.email, input.password);
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
