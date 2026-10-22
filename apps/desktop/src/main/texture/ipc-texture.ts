import type { IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { TEXTURE_REFERENCE_KINDS, type Project, type TextureReferenceKind } from '@vcvfx/domain';
import type { ApiResult } from '../../shared/bridge';
import { textureBuild, textureExport, textureImage, textureIngest, textureScan, textureSession, type TextureEnv } from './api';

/**
 * Texture extraction's IPC handlers (addendum 12), registered by ipc.ts with
 * its own helpers so the validation, licence and job rules are the clean
 * plate's and the isolation's: looking (the session, a picture, the scan) is
 * allowed read-only; ingesting, building and exporting are processing and
 * need a licence. Every argument is validated with zod; the project arrives
 * as text and is re-parsed by the domain.
 */

export interface TextureIpcDeps {
  handle<S extends z.ZodTypeAny, R>(channel: string, schema: S, fn: (event: IpcMainInvokeEvent, input: z.infer<S>) => Promise<R>): void;
  viewerProject(text: string): Project;
  projectFrom(text: string): Project;
  ensureOutputRoot(projectKey: string, project: Project, ask: boolean): Promise<string | null>;
  licensed(): Promise<boolean>;
  readOnlyReason: string;
  startJob(jobId: string): AbortSignal;
  endJob(jobId: string): void;
  progress(event: IpcMainInvokeEvent, jobId: string, label: string): (done: number, total: number, detail?: string) => void;
  /** The open dialog for references of a kind (read only); null when cancelled. */
  chooseFiles(kind: TextureReferenceKind): Promise<string[] | null>;
  env(): Promise<TextureEnv>;
}

const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const fail = (error: unknown): ApiResult<never> => ({ ok: false, error: error instanceof Error ? error.message : String(error) });

export function registerTextureHandlers(d: TextureIpcDeps): void {
  const jobId = z.string().min(1).max(100);
  const shot = { text: z.string().min(2).max(256 * 1024 * 1024), shotId: z.string().min(1).max(200), projectKey: z.string().min(1).max(4200) };
  const kind = z.enum(TEXTURE_REFERENCE_KINDS);
  const request = z.union([
    z.object({ kind: z.literal('reference'), id: z.string().min(1).max(32), maxWidth: z.number().int().min(64).max(4096) }),
    z.object({ kind: z.literal('texture'), regionId: z.string().min(1).max(32), stage: z.enum(['original', 'delit', 'tiled']), maxWidth: z.number().int().min(64).max(4096) }),
  ]);
  const source = z.object({ path: z.string().min(1).max(4096), from: z.enum(['disk', 'handoff', 'sample']) });

  d.handle('texture:session', z.object(shot), async (_e, input) => {
    try {
      return ok(await textureSession(d.viewerProject(input.text), input.shotId, await d.env()));
    } catch (error) {
      return fail(error);
    }
  });
  d.handle('texture:choose', z.object({ kind }), async (_e, input) => {
    try {
      return ok(await d.chooseFiles(input.kind));
    } catch (error) {
      return fail(error);
    }
  });
  d.handle('texture:image', z.object({ ...shot, request }), async (_e, input) => {
    try {
      return ok(await textureImage(d.viewerProject(input.text), input, await d.env()));
    } catch (error) {
      return fail(error);
    }
  });
  d.handle('texture:scan', z.object(shot), async (_e, input) => {
    try {
      return ok(await textureScan(d.viewerProject(input.text), input, await d.env()));
    } catch (error) {
      return fail(error);
    }
  });
  d.handle('job:texture-ingest', z.object({ ...shot, jobId, kind, sources: z.array(source).min(1).max(200) }), async (event, input) => {
    if (!(await d.licensed())) return fail(d.readOnlyReason);
    const signal = d.startJob(input.jobId);
    const progress = d.progress(event, input.jobId, `Reading references for ${input.shotId}`);
    try {
      return ok(await textureIngest(d.projectFrom(input.text), input.shotId, input.kind, input.sources, await d.env(), { signal, onProgress: progress }));
    } catch (error) {
      return fail(error);
    } finally {
      d.endJob(input.jobId);
    }
  });
  d.handle('job:texture-build', z.object({ ...shot, jobId }), async (event, input) => {
    if (!(await d.licensed())) return fail(d.readOnlyReason);
    const signal = d.startJob(input.jobId);
    const progress = d.progress(event, input.jobId, `Building the textures of ${input.shotId}`);
    try {
      const result = await textureBuild(d.projectFrom(input.text), input, await d.env(), { signal, onProgress: (done, total) => progress(done, total) });
      return ok({ result });
    } catch (error) {
      return fail(error);
    } finally {
      d.endJob(input.jobId);
    }
  });
  d.handle('job:texture-export', z.object({ ...shot, jobId, operator: z.string().min(1).max(200) }), async (event, input) => {
    if (!(await d.licensed())) return fail(d.readOnlyReason);
    const signal = d.startJob(input.jobId);
    const progress = d.progress(event, input.jobId, `Exporting the textures of ${input.shotId}`);
    try {
      const project = d.projectFrom(input.text);
      const root = await d.ensureOutputRoot(input.projectKey, project, false);
      if (!root) return fail('No output root was chosen, so nothing was written.');
      return ok(await textureExport(project, input, root, await d.env(), { signal, onProgress: (done, total) => progress(done, total) }));
    } catch (error) {
      return fail(error);
    } finally {
      d.endJob(input.jobId);
    }
  });
}
