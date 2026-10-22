import type { IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import type { Project } from '@vcvfx/domain';
import type { ApiResult } from '../../shared/bridge';
import { compExport, compFrameView, compRender, compSession, type CompEnv } from './api';

/**
 * The compositor's IPC handlers (addendum 13), registered by ipc.ts with its
 * own helpers so the validation, licence and job rules are the other
 * modules': looking (the session, a preview frame) is allowed read-only;
 * rendering and exporting are processing and need a licence. Every argument
 * is validated with zod; the project arrives as text and is re-parsed by the
 * domain.
 */

export interface CompIpcDeps {
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
  env(): Promise<CompEnv>;
}

const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const fail = (error: unknown): ApiResult<never> => ({ ok: false, error: error instanceof Error ? error.message : String(error) });

export function registerCompHandlers(d: CompIpcDeps): void {
  const jobId = z.string().min(1).max(100);
  const shot = { text: z.string().min(2).max(256 * 1024 * 1024), shotId: z.string().min(1).max(200), projectKey: z.string().min(1).max(4200) };
  const node = z.string().regex(/^n[0-9]{1,6}$/).nullable();

  d.handle('comp:session', z.object(shot), async (_e, input) => {
    try {
      return ok(await compSession(d.viewerProject(input.text), input.shotId, await d.outputRootFor(input.projectKey), await d.env()));
    } catch (error) {
      return fail(error);
    }
  });
  d.handle('comp:frame', z.object({ ...shot, frame: z.number().int().nonnegative().max(100_000_000), a: node, b: node, scale: z.number().min(0.05).max(1) }), async (_e, input) => {
    try {
      return ok(await compFrameView(d.viewerProject(input.text), input, await d.outputRootFor(input.projectKey), await d.env()));
    } catch (error) {
      return fail(error);
    }
  });
  const job = (channel: string, verb: string, fn: typeof compRender | typeof compExport) =>
    d.handle(channel, z.object({ ...shot, jobId, operator: z.string().min(1).max(200) }), async (event, input) => {
      if (!(await d.licensed())) return fail(d.readOnlyReason);
      const signal = d.startJob(input.jobId);
      const progress = d.progress(event, input.jobId, `${verb} the comp of ${input.shotId}`);
      try {
        const project = d.projectFrom(input.text);
        const root = await d.ensureOutputRoot(input.projectKey, project, false);
        if (!root) return fail('No output root was chosen, so nothing was written.');
        return ok(await fn(project, input, root, await d.env(), { signal, onProgress: (done, total, f) => progress(done, total, f !== undefined ? `frame ${f}` : undefined) }));
      } catch (error) {
        return fail(error);
      } finally {
        d.endJob(input.jobId);
      }
    });
  job('job:comp-render', 'Rendering', compRender);
  job('job:comp-export', 'Exporting', compExport);
}
