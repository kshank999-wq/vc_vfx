import type { IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import type { Project } from '@vcvfx/domain';
import type { ApiResult } from '../../shared/bridge';
import { keyDetect, keyExport, keyFrameView, keyMatch, keyProcess, keySample, keySeedRoto, keySession, keySubject, type KeyEnv } from './api';

/**
 * The key's IPC handlers (addendum 09), registered by ipc.ts with its own
 * helpers so the validation, licence and job rules are the same as roto's:
 * looking (session, review frames, samples, detection, the match
 * suggestion) is allowed read-only; processing the shot, seeding a repair
 * and exporting are processing and need a licence. Every argument is validated with zod; the project arrives as text
 * and is re-parsed by the domain.
 */

export interface KeyIpcDeps {
  handle<S extends z.ZodTypeAny, R>(channel: string, schema: S, fn: (event: IpcMainInvokeEvent, input: z.infer<S>) => Promise<R>): void;
  /** Parse once per text (frame requests repeat it). */
  viewerProject(text: string): Project;
  projectFrom(text: string): Project;
  outputRootFor(projectKey: string): Promise<string | null>;
  ensureOutputRoot(projectKey: string, project: Project, ask: boolean): Promise<string | null>;
  licensed(): Promise<boolean>;
  readOnlyReason: string;
  startJob(jobId: string): AbortSignal;
  endJob(jobId: string): void;
  progress(event: IpcMainInvokeEvent, jobId: string, label: string): (done: number, total: number, detail?: string) => void;
  env(): Promise<KeyEnv>;
  chooseImage(): Promise<string | null>;
}

const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const fail = (error: unknown): ApiResult<never> => ({ ok: false, error: error instanceof Error ? error.message : String(error) });

export function registerKeyHandlers(d: KeyIpcDeps): void {
  const jobId = z.string().min(1).max(100);
  const shot = { text: z.string().min(2).max(256 * 1024 * 1024), shotId: z.string().min(1).max(200), projectKey: z.string().min(1).max(4200) };
  const frame = z.number().int().nonnegative().max(100_000_000);

  d.handle('key:session', z.object(shot), async (_e, input) => {
    try {
      return ok(await keySession(d.viewerProject(input.text), input.shotId, await d.outputRootFor(input.projectKey), await d.env()));
    } catch (error) {
      return fail(error);
    }
  });
  d.handle('key:frame', z.object({ ...shot, frame, maxWidth: z.number().int().min(64).max(4096), wrap: z.boolean(), match: z.boolean() }), async (_e, input) => {
    try {
      return ok(await keyFrameView(d.viewerProject(input.text), input, await d.outputRootFor(input.projectKey), await d.env()));
    } catch (error) {
      return fail(error);
    }
  });
  d.handle('key:sample', z.object({ ...shot, frame, x: z.number().finite(), y: z.number().finite(), radius: z.number().min(0).max(500) }), async (_e, input) => {
    try {
      return ok(await keySample(d.viewerProject(input.text), input, await d.outputRootFor(input.projectKey), await d.env()));
    } catch (error) {
      return fail(error);
    }
  });
  d.handle('key:match', z.object({ ...shot, frame }), async (_e, input) => {
    try {
      return ok(await keyMatch(d.viewerProject(input.text), input, await d.outputRootFor(input.projectKey), await d.env()));
    } catch (error) {
      return fail(error);
    }
  });
  // Detection only looks (like the review key): allowed read-only.
  d.handle('job:key-detect', z.object({ ...shot, jobId, kind: z.enum(['green', 'blue']).nullable() }), async (_e, input) => {
    const signal = d.startJob(input.jobId);
    try {
      return ok(await keyDetect(d.projectFrom(input.text), input, await d.outputRootFor(input.projectKey), await d.env(), { signal }));
    } catch (error) {
      return fail(error);
    } finally {
      d.endJob(input.jobId);
    }
  });
  d.handle('job:key-process', z.object({ ...shot, jobId, first: frame.optional(), last: frame.optional() }), async (event, input) => {
    if (!(await d.licensed())) return fail(d.readOnlyReason);
    const signal = d.startJob(input.jobId);
    const progress = d.progress(event, input.jobId, `Keying ${input.shotId}`);
    try {
      const result = await keyProcess(d.projectFrom(input.text), input, await d.outputRootFor(input.projectKey), await d.env(), { signal, onProgress: (done, total, f) => progress(done, total, f !== undefined ? `frame ${f}` : undefined) });
      return ok({ result });
    } catch (error) {
      return fail(error);
    } finally {
      d.endJob(input.jobId);
    }
  });
  // The Auto subject segmentation is processing (it writes masks for the key): it needs a licence.
  d.handle('job:key-subject', z.object({ ...shot, jobId }), async (event, input) => {
    if (!(await d.licensed())) return fail(d.readOnlyReason);
    const signal = d.startJob(input.jobId);
    const progress = d.progress(event, input.jobId, `Finding the subject in ${input.shotId}`);
    try {
      const run = await keySubject(d.projectFrom(input.text), input, await d.outputRootFor(input.projectKey), await d.env(), { signal, onProgress: (done, total, f) => progress(done, total, f !== undefined ? `frame ${f}` : undefined) });
      return ok({ run });
    } catch (error) {
      return fail(error);
    } finally {
      d.endJob(input.jobId);
    }
  });
  d.handle('key:seed-roto', z.object({ ...shot, partId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/), frame }), async (_e, input) => {
    if (!(await d.licensed())) return fail(d.readOnlyReason);
    try {
      return ok(await keySeedRoto(d.projectFrom(input.text), input, await d.outputRootFor(input.projectKey), await d.env()));
    } catch (error) {
      return fail(error);
    }
  });
  d.handle(
    'job:key-export',
    z.object({ ...shot, jobId, operator: z.string().min(1).max(200), options: z.object({ foreground: z.boolean(), core: z.boolean(), edge: z.boolean(), alphaExr: z.boolean() }).strict() }),
    async (event, input) => {
      if (!(await d.licensed())) return fail(d.readOnlyReason);
      const signal = d.startJob(input.jobId);
      const progress = d.progress(event, input.jobId, `Exporting the key of ${input.shotId}`);
      try {
        const project = d.projectFrom(input.text);
        const root = await d.ensureOutputRoot(input.projectKey, project, false);
        if (!root) return fail('No output root was chosen, so nothing was written.');
        return ok(await keyExport(project, input, root, await d.env(), { signal, onProgress: (done, total) => progress(done, total, `${done} / ${total} frames`) }));
      } catch (error) {
        return fail(error);
      } finally {
        d.endJob(input.jobId);
      }
    },
  );
  d.handle('key:choose-background', z.undefined().or(z.null()).optional(), async () => {
    try {
      return ok(await d.chooseImage());
    } catch (error) {
      return fail(error);
    }
  });
}
