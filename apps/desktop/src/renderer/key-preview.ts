import { parseProject, shotState, backgroundReferences, keySubjectStale, type KeyRunResult } from '@vcvfx/domain';
import type { ApiResult, JobProgress } from '../shared/bridge';
import type { KeyBridge, KeyFrameView, KeySessionInfo, KeyShotInput } from '../shared/key/bridge-types';
import { analysisFrames, detectShotScreen, runKey, shotScreenModel, ShotKeyer, type KeyIO, type KeySettings } from '../shared/key/engine';
import { lumaWeights, resizeLinear, toDisplay, workingSpace, type LinearImage } from '../shared/key/linear';
import { runSubject, seedFromKey, seedFromOperator } from '../shared/key/subject-run';
import { TrackEngine } from '../shared/roto/track';
import { maskToPlane } from '../shared/roto/image';
import { estimateMatch, matchSamples } from '../shared/key/look';
import { sampleColour } from '../shared/key/screen';
import { greenScreenScene, type GreenScreenScene } from '../shared/key/synthetic';
import { frameView } from '../shared/key/view';
import { CancelledError } from '../shared/roto/engine';
import { resizePlane } from '../shared/roto/image';
import { viewerTimeline } from '../shared/viewer';

/**
 * Keying in the browser preview (addendum 09 §9). The preview has no media,
 * so the sample project's key shot is a synthetic green-screen shot rendered
 * in the page in linear ACEScg — a figure with fine hair, a fly-away halo and
 * a motion-blurred arm against an unevenly lit screen, with spill, and a
 * night-street background plate — and the same keyer the desktop runs keys
 * it here for real: auto key, eyedropper, mattes, despill against the
 * background, light wrap, match, processing with problem frames. Nothing
 * is written; exporting says it is the desktop app's. "Repair with roto"
 * seeds and links the repair here; painting it is the Roto tab's on the
 * desktop (the preview's Roto tab has its own demo shot).
 */

export const PREVIEW_KEY = { width: 480, height: 270 };
const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const fail = <T>(error: string): ApiResult<T> => ({ ok: false, error });
const LABEL = 'sample frames (synthetic green-screen shot, linear ACEScg)';

export interface KeyPreview extends KeyBridge {
  cancel(jobId: string): boolean;
}

export function createKeyPreview(options: { desktopOnly: (what: string) => string; progress: (p: JobProgress) => void }): KeyPreview {
  let scene: GreenScreenScene | null = null;
  const sceneFor = (frames: number) => {
    // The figure's trousers are a white suit lit by the screen's bounce, with a deep cast shadow beside it
    // (the astronaut problem, addendum 18): the hybrid key's subject prior and shadow pass have work to do.
    if (!scene || scene.frames !== frames) scene = greenScreenScene({ ...PREVIEW_KEY, frames, badFrame: Math.round(frames * 0.62), screenLitSuit: 0.4, castShadow: 0.6, travel: 0.2 });
    return scene;
  };
  const frames = new Map<number, LinearImage>();
  const jobs = new Map<string, AbortController>();
  const seeds = new Map<string, Float32Array>();
  /** The Auto subject segmentation's masks, by shot and frame, with the run's revision. */
  const subjects = new Map<string, { revision: number; masks: Map<number, Float32Array> }>();
  const keyers = new Map<string, ShotKeyer>();
  const space = workingSpace('acescg');
  const luma = lumaWeights('ap1');

  const context = (text: string, shotId: string) => {
    const parsed = parseProject(text);
    if (!parsed.ok) return { error: parsed.reason } as const;
    const project = parsed.project;
    const state = shotState(project, shotId);
    const timeline = viewerTimeline(project, shotId);
    if (!state) return { error: `No shot ${shotId}` } as const;
    if (project.handoffPath !== 'sample') return { error: options.desktopOnly('keying reads the frames on the drive.') } as const;
    if (!timeline) return { error: 'The frame range is unknown.' } as const;
    const plate = project.handoff.shots.find((s) => s.shotId === shotId)?.resolution ?? { width: 4096, height: 2160 };
    return { project, state, timeline, plate, scene: sceneFor(timeline.last - timeline.first + 1) } as const;
  };
  type Ctx = Exclude<ReturnType<typeof context>, { error: string }>;

  const io = (c: Ctx, signal?: AbortSignal): KeyIO => ({
    signal,
    frame: async (f) => {
      const index = Math.max(0, Math.min(c.scene.frames - 1, f - c.timeline.first));
      let img = frames.get(index);
      if (!img) {
        // Let the page breathe between frames.
        await new Promise((r) => setTimeout(r, 0));
        img = c.scene.render(index);
        frames.set(index, img);
        if (frames.size > 20) frames.delete(frames.keys().next().value!);
      }
      return img;
    },
    roto: async (partId, f, w, h) => {
      const seed = seeds.get(`${partId}|${f}`);
      if (!seed) return null;
      return w === PREVIEW_KEY.width && h === PREVIEW_KEY.height ? seed : resizePlane(seed, PREVIEW_KEY.width, PREVIEW_KEY.height, w, h);
    },
    subject: async (f, w, h) => {
      const doc = c.state.key;
      if (!doc || doc.subject.source !== 'auto' || !doc.subject.run || keySubjectStale(doc)) return null;
      const hit = subjects.get(c.state.shotId);
      const m = hit && hit.revision === doc.subject.run.revision ? hit.masks.get(f) : undefined;
      const conf = doc.subject.run.frames.find((r) => r.frame === f)?.confidence;
      if (!m || conf === undefined) return null;
      // The preview's segmentation is Track's: it only makes the core solid (see subject.ts `removes`).
      return { matte: w === PREVIEW_KEY.width && h === PREVIEW_KEY.height ? m : resizePlane(m, PREVIEW_KEY.width, PREVIEW_KEY.height, w, h), confidence: conf, removes: !doc.subject.run.engine.startsWith('track') };
    },
    background: async (w, h) => {
      const bg = c.state.key?.despill.background;
      if (!bg || bg.kind === 'none') return null;
      if (bg.kind === 'frame' && bg.frame !== null) return resizeLinear(c.scene.render(Math.max(0, Math.min(c.scene.frames - 1, bg.frame - c.timeline.first))), w, h);
      return resizeLinear(c.scene.background, w, h);
    },
  });

  const settingsOf = (c: Ctx): KeySettings | string => {
    const doc = c.state.key;
    if (!doc?.screen) return 'Pick the screen colour first: Auto key, or the eyedropper.';
    return { screen: doc.screen, params: doc.params, links: doc.links, despill: doc.despill, lightWrap: doc.lightWrap, subject: { source: doc.subject.source, partId: doc.subject.partId, marginPx: doc.subject.marginPx, outside: doc.subject.outside } };
  };

  const keyerFor = async (c: Ctx, s: KeySettings): Promise<ShotKeyer> => {
    const key = JSON.stringify([c.state.shotId, s, c.scene.frames, c.state.key?.subject.run?.at ?? null]);
    let k = keyers.get(key);
    if (!k) {
      k = new ShotKeyer(s, await shotScreenModel(io(c), s, c.timeline.first, c.timeline.last));
      keyers.set(key, k);
      while (keyers.size > 4) keyers.delete(keyers.keys().next().value!);
    }
    return k;
  };
  const pxScale = (c: Ctx) => c.plate.width / PREVIEW_KEY.width;

  const job = async <T>(jobId: string, label: string, fn: (signal: AbortSignal, progress: (done: number, total: number, frame?: number) => void) => Promise<T>): Promise<ApiResult<T>> => {
    const controller = new AbortController();
    jobs.set(jobId, controller);
    try {
      return ok(await fn(controller.signal, (done, total, frame) => options.progress({ jobId, label, done, total, ...(frame !== undefined ? { detail: `frame ${frame}` } : {}) })));
    } catch (error) {
      return fail(error instanceof CancelledError ? 'Cancelled' : (error as Error).message);
    } finally {
      jobs.delete(jobId);
    }
  };

  const session = (input: KeyShotInput): KeySessionInfo => {
    const c = context(input.text, input.shotId);
    const base: KeySessionInfo = { available: false, reason: null, frames: '', plate: null, working: null, first: 0, last: 0, encoding: { label: space.label, linear: true, note: null }, background: { available: false, label: '', reason: null }, references: [], exportable: false, fileBackground: false, sample: true };
    if ('error' in c) return { ...base, reason: c.error ?? null };
    const references = backgroundReferences(c.project, input.shotId);
    if (!c.state.tasks.some((t) => t.kind === 'key')) return { ...base, references, reason: 'This shot has no Green/blue-screen key task. Add it to key the shot.' };
    const bg = c.state.key?.despill.background;
    return {
      ...base,
      available: true,
      frames: LABEL,
      plate: c.plate,
      working: PREVIEW_KEY,
      first: c.timeline.first,
      last: c.timeline.last,
      references,
      subjectEngines: { sam2: { available: false, reason: options.desktopOnly('SAM 2 runs with its model on disk.'), label: 'SAM 2.1' }, track: { available: true } },
      background: bg && bg.kind !== 'none' ? { available: true, label: bg.kind === 'frame' ? `frame ${bg.frame}` : `${bg.label || 'background'} (sample: a night street)`, reason: null } : { available: false, label: '', reason: null },
    };
  };

  return {
    cancel(jobId) {
      const j = jobs.get(jobId);
      j?.abort();
      return Boolean(j);
    },

    keySession: async (input) => ok(session(input)),

    keyDetect: async (input) => {
      const c = context(input.text, input.shotId);
      if ('error' in c) return fail(c.error ?? 'Unavailable');
      return job(input.jobId, `Detecting the screen of ${input.shotId}`, async (signal) => {
        const d = await detectShotScreen(io(c, signal), analysisFrames(c.timeline.first, c.timeline.last, 3), input.kind);
        return { kind: d.kind, rgb: d.rgb, coverage: Math.round(d.coverage * 1000) / 1000, frames: d.frames };
      });
    },

    keyFrame: async (input): Promise<ApiResult<KeyFrameView>> => {
      const c = context(input.text, input.shotId);
      if ('error' in c) return fail(c.error ?? 'Unavailable');
      const s = settingsOf(c);
      if (typeof s === 'string') return fail(s);
      try {
        const k = await keyerFor(c, s);
        const frame = Math.max(c.timeline.first, Math.min(c.timeline.last, Math.round(input.frame)));
        const i = io(c);
        const img = await i.frame(frame);
        const out = await k.keyAt(i, frame, img, { pxScale: pxScale(c), luma, foreground: true, wrapPreview: input.wrap });
        return ok(frameView(frame, img, out, space, { wrap: input.wrap, match: input.match ? (c.state.key?.match.suggestion ?? null) : null, viewLabel: 'Sample frames: linear ACEScg → Rec.709 (approx.), for viewing' }));
      } catch (error) {
        return fail((error as Error).message);
      }
    },

    keySample: async (input) => {
      const c = context(input.text, input.shotId);
      if ('error' in c) return fail(c.error ?? 'Unavailable');
      const img = await io(c).frame(input.frame);
      const sc = pxScale(c);
      return ok({ rgb: sampleColour(img, input.x / sc, input.y / sc, Math.max(1, input.radius / sc)) });
    },

    keyProcess: async (input) => {
      const c = context(input.text, input.shotId);
      if ('error' in c) return fail(c.error ?? 'Unavailable');
      const s = settingsOf(c);
      if (typeof s === 'string') return fail(s);
      return job(input.jobId, `Keying ${input.shotId}`, async (signal, progress): Promise<{ result: KeyRunResult }> => {
        const k = await keyerFor(c, s);
        const first = Math.max(c.timeline.first, input.first ?? c.timeline.first);
        const last = Math.min(c.timeline.last, input.last ?? c.timeline.last);
        const result = await runKey({ ...io(c, signal), progress }, k, { first, last }, { pxScale: pxScale(c), luma, revision: c.state.key!.revision }, () => undefined);
        return { result };
      });
    },

    keyMatch: async (input) => {
      const c = context(input.text, input.shotId);
      if ('error' in c) return fail(c.error ?? 'Unavailable');
      const s = settingsOf(c);
      if (typeof s === 'string') return fail(s);
      const k = await keyerFor(c, s);
      const i = io(c);
      const img = await i.frame(input.frame);
      const out = await k.keyAt(i, input.frame, img, { pxScale: pxScale(c), luma, foreground: true });
      if (!out.background) return fail('Choose a background reference first (step 5).');
      const sm = matchSamples(out.fg!, out.alpha, out.background, 8);
      const m = estimateMatch(sm.fg, sm.bg, luma);
      return ok({ gain: m.gain, offset: m.offset, exposureStops: Math.round(m.exposureStops * 1000) / 1000, samples: m.samples, confidence: m.confidence, frame: input.frame });
    },

    keySeedRoto: async (input) => {
      const c = context(input.text, input.shotId);
      if ('error' in c) return fail(c.error ?? 'Unavailable');
      const s = settingsOf(c);
      if (typeof s === 'string') return fail(s);
      const k = await keyerFor(c, s);
      const i = io(c);
      const img = await i.frame(input.frame);
      const out = await k.keyAt(i, input.frame, img, { pxScale: pxScale(c), luma, foreground: false });
      seeds.set(`${input.partId}|${input.frame}`, out.alpha);
      return ok({ confidence: Math.max(0.3, out.confidence) });
    },

    keySubject: async (input) => {
      const c = context(input.text, input.shotId);
      if ('error' in c) return fail(c.error ?? 'Unavailable');
      const s = settingsOf(c);
      if (typeof s === 'string') return fail(s);
      const doc = c.state.key!;
      if (doc.subject.source !== 'auto') return fail('Set the subject to Auto first.');
      if (doc.subject.engine === 'sam2') return fail(options.desktopOnly('SAM 2 runs with its model on disk.'));
      return job(input.jobId, `Finding the subject in ${input.shotId}`, async (signal, progress) => {
        const { width: w, height: h } = PREVIEW_KEY;
        const i = io(c, signal);
        const from = Math.max(c.timeline.first, Math.min(c.timeline.last, doc.subject.seed.frame ?? Math.round((c.timeline.first + c.timeline.last) / 2)));
        let seed = seedFromOperator(doc.subject.seed.box, doc.subject.seed.points, pxScale(c), w, h);
        if (!seed) {
          const plain: KeySettings = { ...s, subject: { source: 'none', partId: null, marginPx: 12, outside: true } };
          const k = new ShotKeyer(plain, await shotScreenModel(i, plain, c.timeline.first, c.timeline.last));
          const out = await k.keyAt(i, from, await i.frame(from), { pxScale: pxScale(c), luma, foreground: false });
          seed = seedFromKey(out.alpha, w, h);
          if (!seed) throw new Error(`The key finds nothing solid on frame ${from} to start the subject from. Draw a box round the subject.`);
        }
        const masks = new Map<number, Float32Array>();
        const frames = await runSubject(new TrackEngine(), seed, from, { first: c.timeline.first, last: c.timeline.last }, {
          signal,
          frame: async (f) => {
            const img = await i.frame(f);
            return { width: img.width, height: img.height, data: toDisplay(img.data, img.width * img.height, space) };
          },
          put: async (f, m) => void masks.set(f, maskToPlane(m)),
          progress,
        });
        subjects.set(c.state.shotId, { revision: doc.subject.revision, masks });
        return { run: { engine: `track@${new TrackEngine().version}`, revision: doc.subject.revision, seedFrame: from, seededBy: seed.seededBy, first: c.timeline.first, last: c.timeline.last, frames, fallback: doc.subject.engine === 'auto' ? 'SAM 2 is the desktop app’s; the Track engine was used' : null } };
      });
    },

    keyExport: async () => fail(options.desktopOnly('the key is written into the shot package on disk.')),
    keyChooseBackground: async () => fail(options.desktopOnly('a background file is chosen from disk; the preview uses its sample background plate.')),
  };
}
