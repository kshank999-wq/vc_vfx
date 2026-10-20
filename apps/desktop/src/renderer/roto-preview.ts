import { combineAlpha, editsMatte, parseProject, rivalFrames, rotoPart, rotoTaskVersion, shotState, type RotoPropagationResult } from '@vcvfx/domain';
import type { ApiResult, JobProgress, RotoEngineInfo, RotoMaskData, RotoRunRequest, RotoSession, RotoShotInput, ViewerFrame } from '../shared/bridge';
import { CancelledError, runRoto } from '../shared/roto/engine';
import { resizeMask, type Mask, type RGBImage } from '../shared/roto/image';
import { refineMatte } from '../shared/roto/refine';
import { SAM2_VERSION } from '../shared/roto/sam2';
import { figureScene, type SyntheticScene } from '../shared/roto/synthetic';
import { TRACK_VERSION, TrackEngine } from '../shared/roto/track';
import { viewerTimeline } from '../shared/viewer';

/**
 * Paint-to-roto in the browser preview (addendum 04). The preview has no
 * media, so the sample project's roto shot is a synthetic one — a figure
 * walking across a wall, rendered frame by frame — and the Track engine runs
 * here, in the page, on its frames for real: paint, propagate, review,
 * correct. Mattes stay in memory. What needs the disk (exporting mattes) or
 * the AI model (SAM 2) says it is the desktop app's.
 */

export const PREVIEW_ROTO_SIZE = { width: 640, height: 338 };
const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const fail = <T>(error: string): ApiResult<T> => ({ ok: false, error });

export interface RotoPreview {
  session(input: RotoShotInput): Promise<ApiResult<RotoSession>>;
  frame(input: RotoShotInput & { frame: number; maxWidth: number }): Promise<ApiResult<ViewerFrame>>;
  run(input: RotoRunRequest): Promise<ApiResult<{ results: RotoPropagationResult[] }>>;
  mask(input: RotoShotInput & { partId: string | null; frame: number; maxWidth: number }): Promise<ApiResult<RotoMaskData | null>>;
  engines(): RotoEngineInfo[];
  cancel(jobId: string): void;
}

export function createRotoPreview(options: { desktopOnly: (what: string) => string; progress: (p: JobProgress) => void }): RotoPreview {
  let scene: SyntheticScene | null = null;
  const sceneFor = (frames: number) => {
    if (!scene || scene.frames !== frames) scene = figureScene({ ...PREVIEW_ROTO_SIZE, frames });
    return scene;
  };
  const rendered = new Map<number, RGBImage>();
  const render = (s: SyntheticScene, index: number): RGBImage => {
    const hit = rendered.get(index);
    if (hit) return hit;
    const img = s.render(Math.max(0, Math.min(s.frames - 1, index)));
    rendered.set(index, img);
    if (rendered.size > 48) rendered.delete(rendered.keys().next().value!);
    return img;
  };
  const urls = new Map<number, string>();
  const masks = new Map<string, Mask>();
  const jobs = new Map<string, AbortController>();

  const engines = (): RotoEngineInfo[] => [
    { id: 'track', label: 'Track (classical)', version: TRACK_VERSION, available: true, reason: null },
    {
      id: 'sam2',
      label: 'SAM 2.1 (AI)',
      version: SAM2_VERSION,
      available: false,
      reason: options.desktopOnly('the SAM 2 model is downloaded and runs on your computer.'),
      model: { label: 'SAM 2.1 Hiera Tiny (ONNX)', approxBytes: 156_000_000, present: false, pinned: false, downloadable: false },
    },
  ];

  const context = (text: string, shotId: string) => {
    const parsed = parseProject(text);
    if (!parsed.ok) return { error: parsed.reason } as const;
    const project = parsed.project;
    const state = shotState(project, shotId);
    const timeline = viewerTimeline(project, shotId);
    if (!state) return { error: `No shot ${shotId}` } as const;
    if (project.handoffPath !== 'sample') return { error: options.desktopOnly('roto is painted on the frames on the drive.') } as const;
    if (!timeline) return { error: 'The frame range is unknown.' } as const;
    return { project, state, timeline, scene: sceneFor(timeline.last - timeline.first + 1) } as const;
  };
  const key = (shotId: string, partId: string, version: number, frame: number) => `${shotId}|${partId}|${version}|${frame}`;
  const getMask = (shotId: string, partId: string, version: number, frame: number): Mask | null => {
    for (let v = version; v >= 1; v -= 1) {
      const m = masks.get(key(shotId, partId, v, frame));
      if (m) return m;
    }
    return null;
  };

  return {
    engines,

    async session({ text, shotId }) {
      const c = context(text, shotId);
      if ('error' in c) return ok({ available: false, reason: c.error ?? null, frames: '', plate: null, working: null, first: 0, last: 0, engines: engines(), exportable: false });
      if (!c.state.tasks.some((t) => t.kind === 'roto')) {
        return ok({ available: false, reason: 'This shot has no Paint-to-roto task. Add it to paint roto.', frames: '', plate: null, working: null, first: 0, last: 0, engines: engines(), exportable: false, sample: true });
      }
      const shot = c.project.handoff.shots.find((s) => s.shotId === shotId);
      const plate = shot?.resolution ?? { width: 4096, height: 2160 };
      return ok({ available: true, reason: null, frames: 'sample frames (synthetic roto shot)', plate, working: PREVIEW_ROTO_SIZE, first: c.timeline.first, last: c.timeline.last, engines: engines(), exportable: false, sample: true });
    },

    async frame({ text, shotId, frame }) {
      const c = context(text, shotId);
      if ('error' in c) return fail(c.error ?? 'Unavailable');
      const f = Math.min(c.timeline.last, Math.max(c.timeline.first, Math.round(frame)));
      const index = f - c.timeline.first;
      let url = urls.get(index);
      if (!url) {
        const img = render(c.scene, index);
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const g = canvas.getContext('2d');
        if (!g) return fail('This browser cannot draw the sample frames.');
        const rgba = new ImageData(img.width, img.height);
        for (let i = 0; i < img.width * img.height; i += 1) {
          rgba.data[4 * i] = img.data[3 * i]!;
          rgba.data[4 * i + 1] = img.data[3 * i + 1]!;
          rgba.data[4 * i + 2] = img.data[3 * i + 2]!;
          rgba.data[4 * i + 3] = 255;
        }
        g.putImageData(rgba, 0, 0);
        url = await new Promise<string>((resolve) => canvas.toBlob((b) => resolve(b ? URL.createObjectURL(b) : canvas.toDataURL('image/png')), 'image/png'));
        urls.set(index, url);
      }
      return ok({ url, frame: f, viewLabel: 'Sample frames (synthetic roto shot)' });
    },

    async run(input) {
      const c = context(input.text, input.shotId);
      if ('error' in c) return fail(c.error ?? 'Unavailable');
      const part = rotoPart(c.state.roto, input.partId);
      if (!part || !part.keyFrames.some((k) => k.frame === input.from)) return fail(`Frame ${input.from} is not a key frame. Paint it first.`);
      if (part.engine.id !== 'track') return fail(options.desktopOnly('the SAM 2 model runs on your computer.'));
      const version = rotoTaskVersion(c.state);
      const plate = c.project.handoff.shots.find((s) => s.shotId === input.shotId)?.resolution ?? { width: 4096, height: 2160 };
      const controller = new AbortController();
      jobs.set(input.jobId, controller);
      const label = `Roto ${input.shotId}`;
      try {
        const results = await runRoto(
          new TrackEngine(),
          {
            partId: part.id,
            from: input.from,
            directions: input.directions,
            first: c.timeline.first,
            last: c.timeline.last,
            keyFrames: part.keyFrames.map((k) => ({ frame: k.frame, strokes: k.strokes, correction: editsMatte(part, k.frame) })),
            scale: PREVIEW_ROTO_SIZE.width / plate.width,
            smoothing: part.refine.temporalSmoothing,
            settings: part.engine.settings,
            rivals: rivalFrames(part, input.from),
          },
          {
            frame: async (f) => {
              // Let the page breathe between frames.
              await new Promise((r) => setTimeout(r, 0));
              return render(c.scene, f - c.timeline.first);
            },
            getMask: async (f) => getMask(input.shotId, part.id, version, f),
            putMask: async (f, m) => void masks.set(key(input.shotId, part.id, version, f), m),
            signal: controller.signal,
            progress: (done, total, frame) => options.progress({ jobId: input.jobId, label, done, total, detail: `frame ${frame}` }),
          },
        );
        return ok({ results });
      } catch (error) {
        return fail(error instanceof CancelledError ? 'Cancelled' : (error as Error).message);
      } finally {
        jobs.delete(input.jobId);
      }
    },

    async mask({ text, shotId, partId, frame, maxWidth }) {
      const c = context(text, shotId);
      if ('error' in c) return fail(c.error ?? 'Unavailable');
      const doc = c.state.roto;
      if (!doc) return ok(null);
      const version = rotoTaskVersion(c.state);
      const plate = c.project.handoff.shots.find((s) => s.shotId === shotId)?.resolution ?? { width: 4096, height: 2160 };
      const refined = new Map<string, Mask>();
      for (const p of doc.parts) {
        if (partId && p.id !== partId) continue;
        if (!p.frames.some((f) => f.frame === frame)) continue;
        const m = getMask(shotId, p.id, version, frame);
        if (m) refined.set(p.id, refineMatte(m, p.refine, { pxScale: plate.width / m.width, guide: null, upscaled: false }));
      }
      let out: Mask | null = partId ? (refined.get(partId) ?? null) : null;
      if (!partId) {
        const any = [...refined.values()][0];
        if (any) out = { width: any.width, height: any.height, data: combineAlpha(doc, any.width * any.height, (id) => refined.get(id)?.data ?? null) };
      }
      if (!out) return ok(null);
      const w = Math.min(out.width, Math.max(32, Math.round(maxWidth)));
      const sized = w === out.width ? out : resizeMask(out, w, Math.max(1, Math.round((out.height * w) / out.width)));
      return ok({ width: sized.width, height: sized.height, alpha: sized.data });
    },

    cancel(jobId) {
      jobs.get(jobId)?.abort();
    },
  };
}
