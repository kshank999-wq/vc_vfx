import { cleanPlateTaskVersion, parseProject, shotState, type CleanPlateRunResult } from '@vcvfx/domain';
import type { ApiResult, JobProgress } from '../shared/bridge';
import type { CleanPlateBridge, CleanPlateFrameView, CleanPlateSessionInfo, CleanPlateShotInput } from '../shared/cleanplate/bridge-types';
import { ShotCleaner, removalHole, runCleanPlate, type CleanPlateIO, type CleanPlateSettings } from '../shared/cleanplate/engine';
import { cleanPlateScene, type CleanPlateScene } from '../shared/cleanplate/synthetic';
import { cachedPlate, frameView, type CachedPlate } from '../shared/cleanplate/view';
import { lumaWeights, workingSpace, type LinearImage } from '../shared/key/linear';
import { CancelledError } from '../shared/roto/engine';
import { resizePlane } from '../shared/roto/image';
import { viewerTimeline } from '../shared/viewer';

/**
 * Clean plates in the browser preview (addendum 10 §9). The preview has no
 * media, so the sample project's clean-plate shot is a synthetic one rendered
 * in the page in linear ACEScg — a brick wall seen by a camera that pans,
 * zooms and rolls, a crew member walking across it, and a light stand that
 * never moves — and the same engine the desktop runs builds its clean plates
 * here for real: alignment, temporal reconstruction, patches, confidence and
 * the unresolved area. Its two subjects come already rotoscoped (the
 * desktop's are painted in the Roto tab). Nothing is written; exporting says
 * it is the desktop app's.
 */

export const PREVIEW_CLEANPLATE = { width: 480, height: 270 };
/** The subjects of the sample shot, as roto parts (ids from their names). */
export const PREVIEW_SUBJECTS = [
  { id: 'crew_member', name: 'Crew member' },
  { id: 'light_stand', name: 'Light stand' },
] as const;
const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const fail = <T>(error: string): ApiResult<T> => ({ ok: false, error });
const LABEL = 'sample frames (synthetic panning shot, linear ACEScg)';
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

export interface CleanPlatePreview extends CleanPlateBridge {
  cancel(jobId: string): boolean;
}

export function createCleanPlatePreview(options: { desktopOnly: (what: string) => string; progress: (p: JobProgress) => void; size?: { width: number; height: number } }): CleanPlatePreview {
  const size = options.size ?? PREVIEW_CLEANPLATE;
  let scene: CleanPlateScene | null = null;
  const sceneFor = (frames: number) => {
    if (!scene || scene.frames !== frames) scene = cleanPlateScene({ ...size, frames, noise: 0.002, pan: 0.32 * size.width });
    return scene;
  };
  const frames = new Map<number, LinearImage>();
  const jobs = new Map<string, AbortController>();
  /** Built plates for review: per shot, task version and settings revision. */
  const built = new Map<string, { revision: number; still: number | null; frames: Map<number, CachedPlate> }>();
  const space = workingSpace('acescg');
  const luma = lumaWeights('ap1');

  const context = (text: string, shotId: string) => {
    const parsed = parseProject(text);
    if (!parsed.ok) return { error: parsed.reason } as const;
    const project = parsed.project;
    const state = shotState(project, shotId);
    const timeline = viewerTimeline(project, shotId);
    if (!state) return { error: `No shot ${shotId}` } as const;
    if (project.handoffPath !== 'sample') return { error: options.desktopOnly('clean plates read the frames on the drive.') } as const;
    if (!timeline) return { error: 'The frame range is unknown.' } as const;
    const plate = project.handoff.shots.find((s) => s.shotId === shotId)?.resolution ?? { width: 3840, height: 2160 };
    return { project, state, timeline, plate, scene: sceneFor(timeline.last - timeline.first + 1) } as const;
  };
  type Ctx = Exclude<ReturnType<typeof context>, { error: string }>;

  const io = (c: Ctx, signal?: AbortSignal): CleanPlateIO => ({
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
      const index = Math.max(0, Math.min(c.scene.frames - 1, f - c.timeline.first));
      const m = partId === 'crew_member' ? c.scene.crew(index) : partId === 'light_stand' ? c.scene.stand(index) : null;
      if (!m) return null;
      return w === size.width && h === size.height ? m : resizePlane(m, size.width, size.height, w, h);
    },
  });

  const settingsOf = (c: Ctx): CleanPlateSettings | string => {
    const doc = c.state.cleanPlate;
    if (!doc || !doc.remove.some((r) => r.enabled)) return 'Choose what to remove first (step 1): a roto part or a box.';
    return { remove: doc.remove, mode: doc.mode, alignment: doc.alignment, referenceFrame: doc.referenceFrame, params: doc.params, guidance: doc.guidance };
  };
  const pxScale = (c: Ctx) => c.plate.width / size.width;
  const keyOf = (c: Ctx) => `${c.state.shotId}|v${cleanPlateTaskVersion(c.state)}`;

  const job = async <T>(jobId: string, label: string, fn: (signal: AbortSignal, progress: (done: number, total: number, frame?: number) => void) => Promise<T>): Promise<ApiResult<T>> => {
    const controller = new AbortController();
    jobs.set(jobId, controller);
    // At most a few progress reports a second: each one re-renders the app, which would otherwise cost more than the work.
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

  const session = (input: CleanPlateShotInput): CleanPlateSessionInfo => {
    const c = context(input.text, input.shotId);
    const base: CleanPlateSessionInfo = { available: false, reason: null, frames: '', plate: null, working: null, first: 0, last: 0, encoding: { label: space.label, linear: true, note: null }, exportable: false, sample: true };
    if ('error' in c) return { ...base, reason: c.error ?? null };
    if (!c.state.tasks.some((t) => t.kind === 'clean_plate')) return { ...base, reason: 'This shot has no Clean plate task. Add it to build a clean plate.' };
    return { ...base, available: true, frames: LABEL, plate: c.plate, working: size, first: c.timeline.first, last: c.timeline.last, sampleSubjects: PREVIEW_SUBJECTS.map((s) => ({ name: s.name })) };
  };

  return {
    cancel(jobId) {
      const j = jobs.get(jobId);
      j?.abort();
      return Boolean(j);
    },

    cleanPlateSession: async (input) => ok(session(input)),

    cleanPlateFrame: async (input): Promise<ApiResult<CleanPlateFrameView>> => {
      const c = context(input.text, input.shotId);
      if ('error' in c) return fail(c.error ?? 'Unavailable');
      try {
        const frame = Math.max(c.timeline.first, Math.min(c.timeline.last, Math.round(input.frame)));
        const i = io(c);
        const img = await i.frame(frame);
        const s = settingsOf(c);
        const hole = typeof s === 'string' ? null : await removalHole(s, i, frame, img.width, img.height, pxScale(c));
        const b = built.get(keyOf(c)) ?? null;
        const cached = b ? (b.frames.get(b.still ?? frame) ?? null) : null;
        return ok(frameView(frame, img, hole, cached, space, { built: b && b.revision === c.state.cleanPlate?.revision ? 'current' : 'stale', stillFrame: cached ? (b?.still ?? null) : null, viewLabel: 'Sample frames: linear ACEScg → Rec.709 (approx.), for viewing' }));
      } catch (error) {
        return fail((error as Error).message);
      }
    },

    cleanPlateBuild: async (input) => {
      const c = context(input.text, input.shotId);
      if ('error' in c) return fail(c.error ?? 'Unavailable');
      const s = settingsOf(c);
      if (typeof s === 'string') return fail(s);
      return job(input.jobId, `Building the clean plate of ${input.shotId}`, async (signal, progress): Promise<{ result: CleanPlateRunResult }> => {
        const cleaner = new ShotCleaner(s, { first: c.timeline.first, last: c.timeline.last }, { pxScale: pxScale(c), luma, alignWidth: 400 });
        const plates = new Map<number, CachedPlate>();
        const { analysis, ...result } = await runCleanPlate({ ...io(c, signal), progress }, cleaner, { revision: c.state.cleanPlate!.revision }, (out) => void plates.set(out.frame, cachedPlate(out, space)));
        built.set(keyOf(c), { revision: result.revision, still: analysis.mode === 'still' ? analysis.reference : null, frames: plates });
        return { result };
      });
    },

    cleanPlateExport: async () => fail(options.desktopOnly('the clean plate is written into the shot package on disk.')),
  };
}
