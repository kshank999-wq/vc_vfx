import { DEFAULT_ISOLATE_PARAMS, ISOLATE_TASK, isolateDoc, isolateSeedProblem, isolateTaskVersion, parseProject, shotState, type IsolateRunResult, type IsolateTarget } from '@vcvfx/domain';
import type { ApiResult, JobProgress } from '../shared/bridge';
import type { IsolateBridge, IsolateFrameView, IsolateSessionInfo, IsolateShotInput } from '../shared/isolate/bridge-types';
import { ShotIsolator, runIsolate, type IsolateIO, type IsolateSettings } from '../shared/isolate/engine';
import { skyScene, type SkyScene } from '../shared/isolate/synthetic';
import { cachedMatte, cachedPlate, frameView, type CachedMatte, type CachedPlate } from '../shared/isolate/view';
import { workingSpace, type LinearImage } from '../shared/key/linear';
import { CancelledError } from '../shared/roto/engine';
import { resizePlane } from '../shared/roto/image';
import { viewerTimeline } from '../shared/viewer';

/**
 * Sky isolation and background removal in the browser preview (addendum 11
 * §9). The preview has no media, so the sample project's sky shot (030_010)
 * is a synthetic one rendered in the page in linear ACEScg — a sky over a
 * skyline, a bare tree, a power line, a runner crossing a roof and a bird,
 * seen by a panning camera — and the same engine the desktop runs builds its
 * mattes, foregrounds and plates here for real. The runner comes already
 * rotoscoped (the desktop's subjects are painted in the Roto tab), and a box
 * or paint seeds it as well. Nothing is written; exporting says it is the
 * desktop app's.
 */

export const PREVIEW_ISOLATE = { width: 480, height: 270 };
/** The sample's subject, as a roto part (its id from its name). */
export const PREVIEW_SUBJECT = { id: 'runner', name: 'Runner' } as const;
const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const fail = <T>(error: string): ApiResult<T> => ({ ok: false, error });
const LABEL = 'sample frames (synthetic rooftop pan, linear ACEScg)';
const breathe = () =>
  new Promise<void>((r) => {
    if (typeof MessageChannel === 'undefined') return void setTimeout(r, 0);
    const c = new MessageChannel();
    c.port1.onmessage = () => {
      c.port1.close();
      r();
    };
    c.port2.postMessage(0);
  });

export interface IsolatePreview extends IsolateBridge {
  cancel(jobId: string): boolean;
}

export function createIsolatePreview(options: { desktopOnly: (what: string) => string; progress: (p: JobProgress) => void; size?: { width: number; height: number } }): IsolatePreview {
  const size = options.size ?? PREVIEW_ISOLATE;
  let scene: SkyScene | null = null;
  const sceneFor = (frames: number) => {
    if (!scene || scene.frames !== frames) scene = skyScene({ ...size, frames, noise: 0.002, pan: 0.22 * size.width });
    return scene;
  };
  const frames = new Map<number, LinearImage>();
  const jobs = new Map<string, AbortController>();
  /** Built results for review: per shot, target, task version and settings revision. */
  const built = new Map<string, { revision: number; mattes: Map<number, CachedMatte>; plates: Map<number, CachedPlate> }>();
  const space = workingSpace('acescg');

  const context = (text: string, shotId: string) => {
    const parsed = parseProject(text);
    if (!parsed.ok) return { error: parsed.reason } as const;
    const project = parsed.project;
    const state = shotState(project, shotId);
    const timeline = viewerTimeline(project, shotId);
    if (!state) return { error: `No shot ${shotId}` } as const;
    if (project.handoffPath !== 'sample') return { error: options.desktopOnly('isolation reads the frames on the drive.') } as const;
    if (!timeline) return { error: 'The frame range is unknown.' } as const;
    const plate = project.handoff.shots.find((s) => s.shotId === shotId)?.resolution ?? { width: 3840, height: 2160 };
    return { project, state, timeline, plate, scene: sceneFor(timeline.last - timeline.first + 1) } as const;
  };
  type Ctx = Exclude<ReturnType<typeof context>, { error: string }>;

  const io = (c: Ctx, signal?: AbortSignal): IsolateIO => ({
    signal,
    frame: async (f) => {
      const index = Math.max(0, Math.min(c.scene.frames - 1, f - c.timeline.first));
      let img = frames.get(index);
      if (!img) {
        // Let the page breathe between frames (a message, not a timer: timers are throttled in a background tab).
        await breathe();
        img = c.scene.render(index);
        frames.set(index, img);
        if (frames.size > 64) frames.delete(frames.keys().next().value!);
      }
      return img;
    },
    roto: async (partId, f, w, h) => {
      if (partId !== PREVIEW_SUBJECT.id) return null;
      const m = c.scene.runner(Math.max(0, Math.min(c.scene.frames - 1, f - c.timeline.first)));
      return w === size.width && h === size.height ? m : resizePlane(m, size.width, size.height, w, h);
    },
  });

  const settingsOf = (c: Ctx, target: IsolateTarget): IsolateSettings | string => {
    const doc = isolateDoc(c.state, target);
    const problem = isolateSeedProblem(doc, target);
    if (problem) return problem;
    if (!doc) return { target, seed: { mode: 'auto', frame: null, rect: null, partId: null }, engine: 'track', keyFrames: [], params: { ...DEFAULT_ISOLATE_PARAMS } };
    return { target, seed: doc.seed, engine: doc.engine, keyFrames: doc.keyFrames, params: doc.params };
  };
  const pxScale = (c: Ctx) => c.plate.width / size.width;
  const keyOf = (c: Ctx, target: IsolateTarget) => `${c.state.shotId}|${target}|v${isolateTaskVersion(c.state, target)}`;

  const job = async <T>(jobId: string, label: string, fn: (signal: AbortSignal, progress: (done: number, total: number, frame?: number) => void) => Promise<T>): Promise<ApiResult<T>> => {
    const controller = new AbortController();
    jobs.set(jobId, controller);
    // At most a few progress reports a second: each one re-renders the app (as the clean plate's preview).
    let last = 0;
    const report = (done: number, total: number, frame?: number) => {
      const now = Date.now();
      if (done < total && now - last < 150) return;
      last = now;
      options.progress({ jobId, label, done, total, ...(frame !== undefined ? { detail: `frame ${frame}` } : {}) });
    };
    try {
      return ok(await fn(controller.signal, report));
    } catch (error) {
      return fail(error instanceof CancelledError ? 'Cancelled' : (error as Error).message);
    } finally {
      jobs.delete(jobId);
    }
  };

  const session = (input: IsolateShotInput): IsolateSessionInfo => {
    const c = context(input.text, input.shotId);
    const engines = [
      { id: 'track' as const, label: 'Track (classical)', available: true, reason: null },
      { id: 'sam2' as const, label: 'SAM 2.1 (AI)', available: false, reason: 'SAM 2.1 runs in the desktop app, once its model is downloaded (Roto).' },
    ];
    const base: IsolateSessionInfo = { available: false, reason: null, frames: '', plate: null, working: null, first: 0, last: 0, encoding: { label: space.label, linear: true, note: null }, exportable: false, engines: input.target === 'background' ? engines : engines.slice(0, 1), sample: true };
    if ('error' in c) return { ...base, reason: c.error ?? null };
    if (!c.state.tasks.some((t) => t.kind === ISOLATE_TASK[input.target])) return { ...base, reason: `This shot has no ${input.target === 'sky' ? 'Sky isolation' : 'Background removal'} task. Add it to work on it here.` };
    return { ...base, available: true, frames: LABEL, plate: c.plate, working: size, first: c.timeline.first, last: c.timeline.last, ...(input.target === 'background' ? { sampleSubjects: [{ name: PREVIEW_SUBJECT.name }] } : {}) };
  };

  return {
    cancel(jobId) {
      const j = jobs.get(jobId);
      j?.abort();
      return Boolean(j);
    },

    isolateSession: async (input) => ok(session(input)),

    isolateFrame: async (input): Promise<ApiResult<IsolateFrameView>> => {
      const c = context(input.text, input.shotId);
      if ('error' in c) return fail(c.error ?? 'Unavailable');
      try {
        const frame = Math.max(c.timeline.first, Math.min(c.timeline.last, Math.round(input.frame)));
        const img = await io(c).frame(frame);
        const b = built.get(keyOf(c, input.target)) ?? null;
        const doc = isolateDoc(c.state, input.target);
        return ok(frameView(frame, img, b?.mattes.get(frame) ?? null, b?.plates.get(frame) ?? null, space, { built: b && b.revision === (doc?.revision ?? 0) ? 'current' : 'stale', viewLabel: 'Sample frames: linear ACEScg → Rec.709 (approx.), for viewing' }));
      } catch (error) {
        return fail((error as Error).message);
      }
    },

    isolateBuild: async (input) => {
      const c = context(input.text, input.shotId);
      if ('error' in c) return fail(c.error ?? 'Unavailable');
      const s = settingsOf(c, input.target);
      if (typeof s === 'string') return fail(s);
      if (s.engine === 'sam2') return fail(options.desktopOnly('SAM 2.1 runs on your machine; choose Track here.'));
      const what = input.target === 'sky' ? 'the sky' : 'the subject';
      return job(input.jobId, `Isolating ${what} of ${input.shotId}`, async (signal, progress): Promise<{ result: IsolateRunResult }> => {
        const isolator = new ShotIsolator(s, { first: c.timeline.first, last: c.timeline.last }, { pxScale: pxScale(c), space, alignWidth: 400 });
        const mattes = new Map<number, CachedMatte>();
        const plates = new Map<number, CachedPlate>();
        const { analysis: _analysis, ...result } = await runIsolate(
          { ...io(c, signal), progress },
          isolator,
          { revision: isolateDoc(c.state, input.target)?.revision ?? 0 },
          (m) => void mattes.set(m.frame, cachedMatte(m, space)),
          (p) => void plates.set(p.frame, cachedPlate(p, space)),
        );
        built.set(keyOf(c, input.target), { revision: result.revision, mattes, plates });
        return { result };
      });
    },

    isolateExport: async () => fail(options.desktopOnly('the matte, foreground and plate are written into the shot package on disk.')),
  };
}
