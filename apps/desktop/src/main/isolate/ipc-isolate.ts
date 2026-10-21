import type { IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { ISOLATE_TARGETS, type Project } from '@vcvfx/domain';
import type { ApiResult } from '../../shared/bridge';
import { isolateBuild, isolateExport, isolateFrameView, isolateSession, type IsolateEnv } from './api';

/**
 * Sky isolation and background removal's IPC handlers (addendum 11),
 * registered by ipc.ts with its own helpers so the validation, licence and
 * job rules are the clean plate's: looking (the session, a review frame) is
 * allowed read-only; building and exporting are processing and need a
 * licence. Every argument is validated with zod; the project arrives as text
 * and is re-parsed by the domain.
 */

export interface IsolateIpcDeps {
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
  env(): Promise<IsolateEnv>;
}

const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const fail = (error: unknown): ApiResult<never> => ({ ok: false, error: error instanceof Error ? error.message : String(error) });

export function registerIsolateHandlers(d: IsolateIpcDeps): void {
  const jobId = z.string().min(1).max(100);
  const shot = { text: z.string().min(2).max(256 * 1024 * 1024), shotId: z.string().min(1).max(200), projectKey: z.string().min(1).max(4200), target: z.enum(ISOLATE_TARGETS) };
  const frame = z.number().int().nonnegative().max(100_000_000);
  const what = (t: string) => (t === 'sky' ? 'the sky' : 'the subject');

  d.handle('isolate:session', z.object(shot), async (_e, input) => {
    try {
      return ok(await isolateSession(d.viewerProject(input.text), input.shotId, input.target, await d.outputRootFor(input.projectKey), await d.env()));
    } catch (error) {
      return fail(error);
    }
  });
  d.handle('isolate:frame', z.object({ ...shot, frame, maxWidth: z.number().int().min(64).max(4096) }), async (_e, input) => {
    try {
      return ok(await isolateFrameView(d.viewerProject(input.text), input, await d.outputRootFor(input.projectKey), await d.env()));
    } catch (error) {
      return fail(error);
    }
  });
  d.handle('job:isolate-build', z.object({ ...shot, jobId }), async (event, input) => {
    if (!(await d.licensed())) return fail(d.readOnlyReason);
    const signal = d.startJob(input.jobId);
    const progress = d.progress(event, input.jobId, `Isolating ${what(input.target)} of ${input.shotId}`);
    try {
      const result = await isolateBuild(d.projectFrom(input.text), input, await d.outputRootFor(input.projectKey), await d.env(), { signal, onProgress: (done, total, f) => progress(done, total, f !== undefined ? `frame ${f}` : undefined) });
      return ok({ result });
    } catch (error) {
      return fail(error);
    } finally {
      d.endJob(input.jobId);
    }
  });
  d.handle('job:isolate-export', z.object({ ...shot, jobId, operator: z.string().min(1).max(200) }), async (event, input) => {
    if (!(await d.licensed())) return fail(d.readOnlyReason);
    const signal = d.startJob(input.jobId);
    const progress = d.progress(event, input.jobId, `Exporting ${what(input.target)} of ${input.shotId}`);
    try {
      const project = d.projectFrom(input.text);
      const root = await d.ensureOutputRoot(input.projectKey, project, false);
      if (!root) return fail('No output root was chosen, so nothing was written.');
      return ok(await isolateExport(project, input, root, await d.env(), { signal, onProgress: (done, total) => progress(done, total) }));
    } catch (error) {
      return fail(error);
    } finally {
      d.endJob(input.jobId);
    }
  });
}
