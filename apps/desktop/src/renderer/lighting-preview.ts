import { LIGHTING_TASK, estimateSpec, lightingDoc, lightingFrames, newCamTrackDocument, parseProject, shotState, type LightingReferenceInput, type LightingReferenceKind, type Project } from '@vcvfx/domain';
import type { ApiResult, JobProgress } from '../shared/bridge';
import { lumaWeights, toDisplay, workingSpace, type LinearImage } from '../shared/key/linear';
import { CancelledError } from '../shared/roto/engine';
import { analyseLighting } from '../shared/lighting/analyse';
import type { LightingBridge, LightingFrameView, LightingReferenceView, LightingSessionInfo, LightingShotInput } from '../shared/lighting/bridge-types';
import { matchScore, relight, relightModel, rigBall, type RelightModel } from '../shared/lighting/relight';
import { silhouetteNormals } from '../shared/lighting/shading';
import { STUDIO_SCENE, renderChromeBall, renderEquirect, renderGreyBall, renderScene, type SyntheticScene, type SyntheticShot } from '../shared/lighting/synthetic';
import { viewerTimeline } from '../shared/viewer';

/**
 * The lighting analysis in the browser preview (addendum 14 §6). The preview
 * has no media, so the sample's storeroom shot (040_010, once the Lighting
 * task is added) is a synthetic shot rendered in the page with known lights —
 * a warm soft key from frame right, a cool fill from the left, a rim from
 * behind, a tungsten practical on the back wall, an even ambient — on a grey
 * subject with its matte, standing on a floor it shadows; and, to add as
 * references, a chrome ball and a grey ball photographed at the subject and
 * the equirectangular HDRI one would shoot there. The camera is the shot's
 * from the handoff (focal length, the ALEXA 35's film back). The same engine
 * the desktop runs analyses it here. Nothing is written: exporting and the AI
 * review say they are the desktop app's.
 */

export const PREVIEW_LIGHTING = { width: 480, height: 270, analysis: 320 };
export const LIGHTING_SAMPLE_SHOT = '040_010';
const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const fail = <T>(error: string): ApiResult<T> => ({ ok: false, error });
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

const SAMPLE_REFS: { kind: LightingReferenceKind; name: string; size: number }[] = [
  { kind: 'chrome_ball', name: 'storeroom_chromeball.exr', size: 200 },
  { kind: 'grey_ball', name: 'storeroom_greyball.exr', size: 200 },
  { kind: 'hdri', name: 'storeroom_360_hdri.exr', size: 512 },
];

export interface LightingPreview extends LightingBridge {
  cancel(jobId: string): boolean;
}

export function createLightingPreview(options: { desktopOnly: (what: string) => string; progress: (p: JobProgress) => void; scene?: Partial<SyntheticScene> }): LightingPreview {
  const space = workingSpace('acescg');
  const luma = lumaWeights('ap1');
  const jobs = new Map<string, AbortController>();
  let shotCache: { key: string; shot: SyntheticShot; analysis: SyntheticShot; scene: SyntheticScene } | null = null;
  const refs = new Map<string, LinearImage>();
  const models = new Map<string, RelightModel | null>();

  /** The shot's camera from the handoff: its focal length and the database's film back for its body. */
  const cameraOf = (project: Project, shotId: string) => {
    const shot = project.handoff.shots.find((s) => s.shotId === shotId)!;
    const cam = newCamTrackDocument(project, shotId).camera;
    return { focalMm: shot.camera.focalLengthMm ?? 35, filmBackMm: cam?.filmBackMm ?? null, label: cam?.label ?? null };
  };
  const sceneFor = (project: Project, shotId: string): SyntheticScene => {
    const c = cameraOf(project, shotId);
    // The handoff gives no white balance for this shot: the sample is rendered unbalanced, as the analysis then assumes.
    return { ...STUDIO_SCENE, focalMm: c.focalMm, filmBackMm: c.filmBackMm?.width ?? 36, whiteBalanceK: null, ...(options.scene ?? {}) };
  };
  const shots = async (project: Project, shotId: string) => {
    const scene = sceneFor(project, shotId);
    const key = JSON.stringify(scene);
    if (shotCache?.key !== key) {
      await breathe();
      const shot = renderScene(scene);
      await breathe();
      const k = PREVIEW_LIGHTING.analysis / scene.width;
      const analysis = renderScene({ ...scene, width: Math.round(scene.width * k), height: Math.round(scene.height * k), samples: Math.min(scene.samples, 14) });
      shotCache = { key, shot, analysis, scene };
      refs.clear();
      models.clear();
    }
    return shotCache!;
  };
  const refImage = async (project: Project, shotId: string, name: string): Promise<LinearImage> => {
    const hit = refs.get(name);
    if (hit) return hit;
    const { scene } = await shots(project, shotId);
    await breathe();
    const spec = SAMPLE_REFS.find((r) => r.name === name);
    if (!spec) throw new Error(`No sample reference ${name}`);
    const img = spec.kind === 'chrome_ball' ? renderChromeBall(scene, spec.size).image : spec.kind === 'grey_ball' ? renderGreyBall(scene, spec.size).image : renderEquirect(scene, spec.size, 30);
    refs.set(name, img);
    return img;
  };

  const context = (text: string, shotId: string) => {
    const parsed = parseProject(text);
    if (!parsed.ok) return { error: parsed.reason } as const;
    const project = parsed.project;
    const state = shotState(project, shotId);
    if (!state) return { error: `No shot ${shotId}` } as const;
    if (project.handoffPath !== 'sample') return { error: options.desktopOnly('the analysis reads the frames on the drive.') } as const;
    const timeline = viewerTimeline(project, shotId);
    if (!timeline) return { error: 'The frame range is unknown.' } as const;
    return { project, state, timeline, doc: lightingDoc(state) } as const;
  };

  const job = async <T>(jobId: string, label: string, fn: (signal: AbortSignal, progress: (done: number, total: number) => void) => Promise<T>): Promise<ApiResult<T>> => {
    const controller = new AbortController();
    jobs.set(jobId, controller);
    try {
      return ok(await fn(controller.signal, (done, total) => options.progress({ jobId, label, done, total })));
    } catch (error) {
      return fail(error instanceof CancelledError || controller.signal.aborted ? 'Cancelled' : (error as Error).message);
    } finally {
      jobs.delete(jobId);
    }
  };

  return {
    cancel(jobId) {
      const j = jobs.get(jobId);
      j?.abort();
      return Boolean(j);
    },

    lightingSession: async (input: LightingShotInput) => {
      const c = context(input.text, input.shotId);
      const base: LightingSessionInfo = {
        available: false,
        reason: null,
        exportable: false,
        fromDisk: false,
        frames: '',
        plate: null,
        first: 0,
        last: 0,
        fps: 24,
        analysisWidth: PREVIEW_LIGHTING.analysis,
        encoding: { label: space.label, linear: true, note: null },
        camera: { focal: null, filmBack: null, solve: null, whiteBalance: null, iris: null },
        subject: { source: 'none', label: 'none' },
        sky: { source: 'none', label: 'none' },
        handoff: [],
        references: [],
        ai: { available: false, reason: options.desktopOnly('the AI review sends a frame to vc-vfx.com from the app, signed in.') },
      };
      if ('error' in c) return ok({ ...base, reason: c.error ?? null });
      if (!c.state.tasks.some((t) => t.kind === LIGHTING_TASK)) return ok({ ...base, reason: 'This shot has no Lighting and lens analysis task. Add it to work on it here.' });
      if (input.shotId !== LIGHTING_SAMPLE_SHOT) return ok({ ...base, reason: `The browser preview analyses the sample’s storeroom shot (${LIGHTING_SAMPLE_SHOT}); open the app for this one.` });
      const cam = cameraOf(c.project, input.shotId);
      return ok({
        ...base,
        available: true,
        frames: 'sample frames (synthetic studio shot, linear ACEScg)',
        plate: { width: PREVIEW_LIGHTING.width, height: PREVIEW_LIGHTING.height },
        first: c.timeline.first,
        last: c.timeline.last,
        fps: c.timeline.frameRate,
        camera: { focal: `${cam.focalMm} mm (metadata)`, filmBack: cam.filmBackMm ? `${+cam.filmBackMm.width.toFixed(2)} × ${+cam.filmBackMm.height.toFixed(2)} mm (${cam.label ?? 'database'})` : null, solve: 'the sample’s camera height and tilt (as from a camera track)', whiteBalance: null, iris: null },
        subject: { source: 'sample', label: 'Sample subject matte (as from Roto)' },
        sky: { source: 'none', label: 'Indoors: no sky' },
        references: (c.doc?.references ?? []).map((r) => ({ id: r.id, onDisk: true, changed: false })),
        sample: { refs: SAMPLE_REFS.map((r) => ({ kind: r.kind, name: r.name })), ballFrame: null },
      });
    },

    lightingIngest: async (input) => {
      const c = context(input.text, input.shotId);
      if ('error' in c) return fail(c.error ?? 'Unavailable');
      return job(input.jobId, 'Reading the sample references', async (): Promise<LightingReferenceInput[]> => {
        const out: LightingReferenceInput[] = [];
        for (const src of input.sources) {
          if (src.from !== 'sample') throw new Error(options.desktopOnly('references are read from the drive.'));
          const spec = SAMPLE_REFS.find((r) => r.name === src.path && r.kind === input.kind);
          if (!spec) throw new Error(`No sample ${input.kind} called ${src.path}`);
          const img = await refImage(c.project, input.shotId, spec.name);
          // The sample's balls are photographed centred, filling 84 % of the frame: their circles are known.
          const circle = spec.kind === 'hdri' ? null : { cx: img.width / 2, cy: img.height / 2, r: img.width * 0.42 };
          out.push({ kind: spec.kind, name: spec.name, from: 'sample', path: spec.name, frame: null, circle, headingDeg: null, format: 'exr', checksum: null, bytes: null, width: img.width, height: img.height, encoding: 'acescg' });
        }
        return out;
      });
    },

    lightingImage: async (input) => {
      const c = context(input.text, input.shotId);
      if ('error' in c) return fail(c.error ?? 'Unavailable');
      const r = c.doc?.references.find((x) => x.id === input.id);
      if (!r) return fail(`No reference ${input.id}`);
      try {
        const img = await refImage(c.project, input.shotId, r.path);
        return ok({ width: img.width, height: img.height, rgb: toDisplay(img.data, img.width * img.height, space), label: `Sample ${r.kind === 'hdri' ? 'HDRI' : 'ball'} (synthetic, linear ACEScg) → Rec.709 (approx.), for viewing` } satisfies LightingReferenceView);
      } catch (error) {
        return fail((error as Error).message);
      }
    },

    lightingFrame: async (input) => {
      const started = Date.now();
      const c = context(input.text, input.shotId);
      if ('error' in c) return fail(c.error ?? 'Unavailable');
      try {
        const { shot, scene } = await shots(c.project, input.shotId);
        const img = shot.image;
        const n = img.width * img.height;
        const a = c.doc?.analysis ?? null;
        const key = JSON.stringify([a?.at ?? null, a?.revision ?? null]);
        let model = models.get(key);
        if (model === undefined) {
          model = null;
          if (a) {
            const fb = a.lens.filmBackMm ?? { width: 36, height: 24 };
            const focalPx = a.lens.focalMm ? (a.lens.focalMm.value / fb.width) * img.width : 0.9 * img.width;
            const field = silhouetteNormals(shot.matte, img.width, img.height, 0.5, { focalPx, cx: img.width / 2, cy: img.height / 2 });
            if (field) model = relightModel(img, field.normals, field.mask, { pitchDeg: a.tilt.pitchDeg, rollDeg: a.tilt.rollDeg }, a.lights.map(estimateSpec), a.whiteBalance.source === 'assumed' ? null : a.whiteBalance.kelvin, luma);
          }
          models.set(key, model);
          while (models.size > 4) models.delete(models.keys().next().value!);
        }
        const rig = input.request.rig;
        let relit: Uint8ClampedArray | null = null;
        let ball: LightingFrameView['ball'] = null;
        let match: number | null = null;
        if (rig) {
          if (model) {
            relit = toDisplay(relight(model, rig).data, n, space);
            match = matchScore(model, rig);
          }
          const b = rigBall(rig, { pitchDeg: a?.tilt.pitchDeg ?? scene.pitchDeg, rollDeg: a?.tilt.rollDeg ?? 0 }, a && a.whiteBalance.source !== 'assumed' ? a.whiteBalance.kelvin : null, 160);
          ball = { size: 160, rgb: toDisplay(b.image.data, 160 * 160, space), alpha: Uint8Array.from(b.alpha, (v) => Math.round(v * 255)) };
        }
        return ok({
          frame: Math.max(c.timeline.first, Math.min(c.timeline.last, Math.round(input.request.frame))),
          width: img.width,
          height: img.height,
          rgb: toDisplay(img.data, n, space),
          relit,
          mask: Uint8Array.from(shot.matte, (v) => (v >= 0.5 ? 255 : 0)),
          ball,
          match,
          built: a ? (a.revision === c.doc!.revision ? 'current' : 'stale') : 'none',
          label: 'sample frames (synthetic, linear ACEScg) → Rec.709 (approx.), for viewing',
          ms: Date.now() - started,
        } satisfies LightingFrameView);
      } catch (error) {
        return fail((error as Error).message);
      }
    },

    lightingAnalyse: async (input) => {
      const c = context(input.text, input.shotId);
      if ('error' in c) return fail(c.error ?? 'Unavailable');
      if (input.shotId !== LIGHTING_SAMPLE_SHOT) return fail(options.desktopOnly('the analysis reads the frames on the drive.'));
      return job(input.jobId, `Analysing the lighting of ${input.shotId}`, async (signal, progress) => {
        const { analysis, scene } = await shots(c.project, input.shotId);
        const doc = c.doc;
        const cam = cameraOf(c.project, input.shotId);
        const frames = lightingFrames(doc, c.timeline.first, c.timeline.last);
        const balls = async (kind: 'chrome_ball' | 'grey_ball') =>
          Promise.all(
            (doc?.references ?? [])
              .filter((r) => r.kind === kind)
              .map(async (r) => {
                if (!r.circle) throw new Error(`${r.name}: mark the ball’s circle first (step 1).`);
                return { id: r.id, image: await refImage(c.project, input.shotId, r.path), circle: r.circle, inPlate: false };
              }),
          );
        const h = doc?.references.find((r) => r.kind === 'hdri');
        const out = await analyseLighting({
          frame: analysis.image,
          frameNumber: frames[0]!,
          frames: frames.slice(0, 1),
          luma,
          gamut: 'ap1',
          subject: doc?.settings.subject === 'none' ? null : { matte: analysis.matte, source: 'sample' },
          sky: null,
          camera: { focalMm: cam.focalMm, focalSource: 'metadata', filmBackMm: cam.filmBackMm, filmBackSource: cam.filmBackMm ? 'database' : 'nominal', pitchDeg: scene.pitchDeg, rollDeg: scene.rollDeg, k1: null, k1Source: null, iris: null, focusDistance: null, subjectDistanceM: doc?.settings.subjectDistanceM ?? 3, subjectDistanceSource: 'setting' },
          ground: { heightM: scene.cameraHeightM, source: 'sample' },
          whiteBalance: doc?.settings.whiteBalanceK ? { kelvin: doc.settings.whiteBalanceK, source: 'artist' } : { kelvin: null, source: 'assumed' },
          references: { chrome: await balls('chrome_ball'), grey: await balls('grey_ball'), hdri: h ? { id: h.id, image: await refImage(c.project, input.shotId, h.path), headingDeg: h.headingDeg } : null },
          revision: doc?.revision ?? 0,
          signal,
          progress,
          yieldNow: breathe,
        });
        return { analysis: out.analysis };
      });
    },

    lightingExport: async () => fail(options.desktopOnly('the Unreal script, the USD, the rig file and the report are written into the shot package on disk.')),
  };
}
