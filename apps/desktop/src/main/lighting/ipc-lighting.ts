import type { IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { LIGHTING_EXPORT_FORMATS, LIGHTING_REFERENCE_KINDS, LightSpecSchema, type LightingReferenceKind, type Project } from '@vcvfx/domain';
import type { ApiResult } from '../../shared/bridge';
import { lightingAiReview, lightingAnalyse, lightingExport, lightingFrameView, lightingImage, lightingIngest, lightingSession, type LightingEnv } from './api';

/**
 * The lighting analysis' IPC handlers (addendum 14), registered by ipc.ts
 * with its own helpers so the validation, licence and job rules are the other
 * modules': looking (the session, a frame, a reference) is allowed
 * read-only; ingesting, analysing and exporting are processing and need a
 * licence; the AI review needs the account and the per-project consent too.
 * Every argument is validated with zod; the project arrives as text and is
 * re-parsed by the domain.
 */

export interface LightingIpcDeps {
  handle<S extends z.ZodTypeAny, R>(channel: string, schema: S, fn: (event: IpcMainInvokeEvent, input: z.infer<S>) => Promise<R>): void;
  viewerProject(text: string): Project;
  projectFrom(text: string): Project;
  outputRootFor(projectKey: string): Promise<string | null>;
  ensureOutputRoot(projectKey: string, project: Project, ask: boolean): Promise<string | null>;
  licensed(): Promise<boolean>;
  readOnlyReason: string;
  startJob(jobId: string): AbortSignal;
  endJob(jobId: string): void;
  progress(event: IpcMainInvokeEvent, jobId: string, label: string): (done: number, total: number, detail?: string) => void;
  chooseFiles(kind: LightingReferenceKind): Promise<string[] | null>;
  env(): Promise<LightingEnv>;
}

const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const fail = (error: unknown): ApiResult<never> => ({ ok: false, error: error instanceof Error ? error.message : String(error) });

export function registerLightingHandlers(d: LightingIpcDeps): void {
  const jobId = z.string().min(1).max(100);
  const shot = { text: z.string().min(2).max(256 * 1024 * 1024), shotId: z.string().min(1).max(200), projectKey: z.string().min(1).max(4200) };
  const kind = z.enum(LIGHTING_REFERENCE_KINDS);
  const source = z.object({ path: z.string().max(4096), from: z.enum(['disk', 'handoff', 'texture', 'sample', 'plate']) });

  d.handle('lighting:session', z.object(shot), async (_e, input) => {
    try {
      return ok(await lightingSession(d.viewerProject(input.text), input.shotId, input.projectKey, await d.outputRootFor(input.projectKey), await d.env()));
    } catch (error) {
      return fail(error);
    }
  });
  d.handle('lighting:choose', z.object({ kind }), async (_e, input) => {
    try {
      return ok(await d.chooseFiles(input.kind));
    } catch (error) {
      return fail(error);
    }
  });
  d.handle('lighting:frame', z.object({ ...shot, request: z.object({ frame: z.number().int().nonnegative().max(100_000_000), maxWidth: z.number().int().min(64).max(4096), rig: z.array(LightSpecSchema).max(24).nullable() }) }), async (_e, input) => {
    try {
      return ok(await lightingFrameView(d.viewerProject(input.text), input, await d.outputRootFor(input.projectKey), await d.env()));
    } catch (error) {
      return fail(error);
    }
  });
  d.handle('lighting:image', z.object({ ...shot, id: z.string().min(1).max(32), maxWidth: z.number().int().min(64).max(4096) }), async (_e, input) => {
    try {
      return ok(await lightingImage(d.viewerProject(input.text), input, await d.outputRootFor(input.projectKey), await d.env()));
    } catch (error) {
      return fail(error);
    }
  });
  d.handle('job:lighting-ingest', z.object({ ...shot, jobId, kind, sources: z.array(source).min(1).max(16), frame: z.number().int().nonnegative().nullable().optional() }), async (event, input) => {
    if (!(await d.licensed())) return fail(d.readOnlyReason);
    const signal = d.startJob(input.jobId);
    const progress = d.progress(event, input.jobId, `Reading references for ${input.shotId}`);
    try {
      return ok(await lightingIngest(d.projectFrom(input.text), input.shotId, input.kind, input.sources, input.frame ?? null, await d.env(), { signal, onProgress: progress }));
    } catch (error) {
      return fail(error);
    } finally {
      d.endJob(input.jobId);
    }
  });
  d.handle('job:lighting-analyse', z.object({ ...shot, jobId }), async (event, input) => {
    if (!(await d.licensed())) return fail(d.readOnlyReason);
    const signal = d.startJob(input.jobId);
    const progress = d.progress(event, input.jobId, `Analysing the lighting of ${input.shotId}`);
    try {
      return ok({ analysis: await lightingAnalyse(d.projectFrom(input.text), input, await d.outputRootFor(input.projectKey), await d.env(), { signal, onProgress: (done, total) => progress(done, total) }) });
    } catch (error) {
      return fail(error);
    } finally {
      d.endJob(input.jobId);
    }
  });
  d.handle('job:lighting-export', z.object({ ...shot, jobId, operator: z.string().min(1).max(200), formats: z.array(z.enum(LIGHTING_EXPORT_FORMATS)).min(1).max(5) }), async (event, input) => {
    if (!(await d.licensed())) return fail(d.readOnlyReason);
    const signal = d.startJob(input.jobId);
    const progress = d.progress(event, input.jobId, `Exporting the light rig of ${input.shotId}`);
    try {
      const project = d.projectFrom(input.text);
      const root = await d.ensureOutputRoot(input.projectKey, project, false);
      if (!root) return fail('No output root was chosen, so nothing was written.');
      return ok(await lightingExport(project, input, root, await d.env(), { signal, onProgress: (done, total) => progress(done, total) }));
    } catch (error) {
      return fail(error);
    } finally {
      d.endJob(input.jobId);
    }
  });
  d.handle('job:lighting-ai-review', z.object({ ...shot, jobId, note: z.string().max(1000).optional() }), async (event, input) => {
    if (!(await d.licensed())) return fail(d.readOnlyReason);
    const signal = d.startJob(input.jobId);
    d.progress(event, input.jobId, `Asking the AI assistant about ${input.shotId}`)(0, 1);
    try {
      return ok({ review: await lightingAiReview(d.projectFrom(input.text), input, await d.outputRootFor(input.projectKey), await d.env(), { signal }) });
    } catch (error) {
      return fail(error);
    } finally {
      d.endJob(input.jobId);
    }
  });
}
