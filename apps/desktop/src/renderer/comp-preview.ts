import { COMP_SOURCE_LABELS, DEFAULT_KEY_PARAMS, DespillSchema, LightWrapSchema, compDoc, compSourceOf, parseProject, shotState, type CompSource, type KeyScreen } from '@vcvfx/domain';
import type { ApiResult } from '../shared/bridge';
import type { CompBridge, CompFrameView, CompSessionInfo, CompShotInput } from '../shared/comp/bridge-types';
import { CompEvaluator, type CompIO } from '../shared/comp/evaluate';
import { fromLinear, fromMatte, fromPremult, resizeRGBA, type RGBA } from '../shared/comp/image';
import { compPicture } from '../shared/comp/view';
import { analysisFrames, detectShotScreen, shotScreenModel, ShotKeyer, type KeyIO, type KeySettings } from '../shared/key/engine';
import { lumaWeights, workingSpace, type LinearImage } from '../shared/key/linear';
import { greenScreenScene, type GreenScreenScene } from '../shared/key/synthetic';
import { viewerTimeline } from '../shared/viewer';

/**
 * The compositor in the browser preview (addendum 13 §8). The preview has no
 * media, so the sample project's key shot (010_020) is the synthetic
 * green-screen shot the Key tab keys — a figure with fine hair against an
 * unevenly lit screen, and a night-street background plate — and the graph
 * is evaluated here, in the page, by the same evaluator the desktop runs.
 * Module nodes are the modules' own results made here: the Keyer is the key
 * engine with the Key tab's settings (or its Auto key when none are made),
 * the Roto node the sample's matte; the background reference is the night
 * street. Nothing is written: rendering and exporting say they are the
 * desktop app's.
 */

export const PREVIEW_COMP = { width: 480, height: 270 };
const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const fail = <T>(error: string): ApiResult<T> => ({ ok: false, error });
const LABEL = 'sample frames (synthetic green-screen shot, linear ACEScg)';
const AVAILABLE: readonly CompSource[] = ['plate', 'background', 'key_foreground', 'key_alpha', 'roto'];

export function createCompPreview(options: { desktopOnly: (what: string) => string }): CompBridge {
  const size = PREVIEW_COMP;
  let scene: GreenScreenScene | null = null;
  const sceneFor = (frames: number) => {
    if (!scene || scene.frames !== frames) scene = greenScreenScene({ ...size, frames, badFrame: -1 });
    return scene;
  };
  const space = workingSpace('acescg');
  const luma = lumaWeights('ap1');
  const frames = new Map<number, LinearImage>();
  const keyed = new Map<string, { fg: Float32Array; alpha: Float32Array }>();
  const keyers = new Map<string, Promise<ShotKeyer>>();
  let evaluator: { key: string; ev: CompEvaluator } | null = null;

  const context = (text: string, shotId: string) => {
    const parsed = parseProject(text);
    if (!parsed.ok) return { error: parsed.reason } as const;
    const project = parsed.project;
    const state = shotState(project, shotId);
    const timeline = viewerTimeline(project, shotId);
    if (!state) return { error: `No shot ${shotId}` } as const;
    if (project.handoffPath !== 'sample') return { error: options.desktopOnly('the comp reads the frames on the drive.') } as const;
    if (!timeline) return { error: 'The frame range is unknown.' } as const;
    const plate = project.handoff.shots.find((s) => s.shotId === shotId)?.resolution ?? { width: 4096, height: 2160 };
    return { project, state, timeline, plate, scene: sceneFor(timeline.last - timeline.first + 1) } as const;
  };
  type Ctx = Exclude<ReturnType<typeof context>, { error: string }>;

  const frameOf = (c: Ctx, f: number): LinearImage => {
    const index = Math.max(0, Math.min(c.scene.frames - 1, f - c.timeline.first));
    let img = frames.get(index);
    if (!img) {
      img = c.scene.render(index);
      frames.set(index, img);
      if (frames.size > 24) frames.delete(frames.keys().next().value!);
    }
    return img;
  };
  const keyIO = (c: Ctx): KeyIO => ({ frame: async (f) => frameOf(c, f), roto: async () => null, background: async () => c.scene.background });

  /** The Key tab's settings, or its Auto key (screen detected, defaults) when nothing has been keyed yet. */
  const keySettings = async (c: Ctx): Promise<KeySettings> => {
    const doc = c.state.key;
    if (doc?.screen) return { screen: doc.screen, params: doc.params, links: [], despill: doc.despill, lightWrap: { ...doc.lightWrap, output: false } };
    const d = await detectShotScreen(keyIO(c), analysisFrames(c.timeline.first, c.timeline.last, 3), null);
    const screen: KeyScreen = { kind: d.kind, source: 'auto', rgb: d.rgb, samples: [], coverage: d.coverage, frames: d.frames, track: true };
    return { screen, params: DEFAULT_KEY_PARAMS, links: [], despill: DespillSchema.parse({}), lightWrap: { ...LightWrapSchema.parse({}), output: false } };
  };
  const keyAt = async (c: Ctx, f: number) => {
    const settingsKey = JSON.stringify([c.state.key?.screen ?? null, c.state.key?.params ?? null, c.state.key?.despill ?? null]);
    const k = `${settingsKey}|${f}`;
    const hit = keyed.get(k);
    if (hit) return hit;
    let keyer = keyers.get(settingsKey);
    if (!keyer) {
      keyer = keySettings(c).then(async (s) => new ShotKeyer(s, await shotScreenModel(keyIO(c), s, c.timeline.first, c.timeline.last)));
      keyers.set(settingsKey, keyer);
    }
    const out = await (await keyer).keyAt(keyIO(c), f, frameOf(c, f), { pxScale: c.plate.width / size.width, luma, foreground: true });
    const v = { fg: out.fg!, alpha: out.alpha };
    keyed.set(k, v);
    if (keyed.size > 40) keyed.delete(keyed.keys().next().value!);
    return v;
  };

  const ioFor = (c: Ctx): CompIO => ({
    plate: c.plate,
    tracks: new Map((c.state.track2d?.tracks ?? []).map((t) => [t.id, t])),
    sourceVersion: (s) => (s.startsWith('key') ? JSON.stringify([c.state.key?.screen ?? null, c.state.key?.params ?? null, c.state.key?.despill ?? null]) : 'sample'),
    sourceStill: (s) => s === 'background',
    async source(source, _part, frame, width, height) {
      const fit = (img: RGBA) => (img.width === width && img.height === height ? img : resizeRGBA(img, width, height));
      const index = Math.max(0, Math.min(c.scene.frames - 1, frame - c.timeline.first));
      switch (source) {
        case 'plate':
          return fit(fromLinear(frameOf(c, frame)));
        case 'background':
          return fit(fromLinear(c.scene.background));
        case 'key_foreground': {
          const k = await keyAt(c, frame);
          return fit(fromPremult(k.fg, k.alpha, size.width, size.height));
        }
        case 'key_alpha':
          return fit(fromMatte((await keyAt(c, frame)).alpha, size.width, size.height));
        case 'roto':
          return fit(fromMatte(c.scene.alpha(index), size.width, size.height));
        default:
          throw new Error(`${COMP_SOURCE_LABELS[source]} is not part of the sample shot in the preview (on the desktop it is read from that module’s export).`);
      }
    },
  });

  const session = (input: CompShotInput): CompSessionInfo => {
    const c = context(input.text, input.shotId);
    const base: CompSessionInfo = { available: false, reason: null, frames: '', plate: null, first: 0, last: 0, fps: 24, previewWidth: size.width, encoding: { label: space.label, linear: true, note: null }, exportable: false, sources: [], sample: true };
    if ('error' in c) return { ...base, reason: c.error ?? null };
    if (!c.state.tasks.some((t) => t.kind === 'composite')) return { ...base, reason: 'This shot has no Prep composite task. Add it to work on it here.' };
    if (input.shotId !== '010_020') return { ...base, reason: 'In the browser preview the comp runs on the sample’s green-screen shot, 010_020. Pick it in the shot bar, or open your own handoff in the desktop app.' };
    const doc = compDoc(c.state);
    return {
      ...base,
      available: true,
      frames: LABEL,
      plate: c.plate,
      first: c.timeline.first,
      last: c.timeline.last,
      fps: c.project.handoff.shots.find((s) => s.shotId === input.shotId)?.frameRate ?? 24,
      sources: (doc?.nodes ?? [])
        .filter((n) => compSourceOf(n))
        .map((n) => {
          const s = compSourceOf(n)!;
          const okay = AVAILABLE.includes(s);
          const label = s === 'key_foreground' || s === 'key_alpha' ? `${COMP_SOURCE_LABELS[s]} (the key engine, here)` : s === 'roto' ? 'Roto: the sample’s matte' : s === 'background' ? 'Background: the sample’s night street' : s === 'plate' ? 'Plate: sample frames' : COMP_SOURCE_LABELS[s];
          return { node: n.id, source: s, ok: okay, label, reason: okay ? null : `${COMP_SOURCE_LABELS[s]} is not part of the sample shot in the preview.` };
        }),
    };
  };

  return {
    compSession: async (input) => ok(session(input)),
    compFrame: async (input): Promise<ApiResult<CompFrameView>> => {
      const started = performance.now();
      const c = context(input.text, input.shotId);
      if ('error' in c) return fail(c.error ?? 'Unavailable');
      const doc = compDoc(c.state);
      if (!doc) return fail('Start the comp first (step 1).');
      const key = `${input.shotId}|${c.scene.frames}`;
      if (!evaluator || evaluator.key !== key) evaluator = { key, ev: new CompEvaluator(ioFor(c), 384 * 1024 * 1024) };
      else evaluator.ev.setIOKeepCache(ioFor(c));
      const ev = evaluator.ev;
      const hits = ev.stats.hits;
      const misses = ev.stats.misses;
      const scale = Math.max(0.02, Math.min(1, input.scale));
      const frame = Math.max(c.timeline.first, Math.min(c.timeline.last, Math.round(input.frame)));
      const one = async (id: string | null) => {
        if (!id) return { pic: null, error: null };
        try {
          return { pic: compPicture(await ev.evaluate(doc, id, frame, { scale }), space), error: null };
        } catch (error) {
          return { pic: null, error: (error as Error).message };
        }
      };
      const a = await one(input.a);
      const b = await one(input.b);
      const s = ev.size(scale);
      return ok({ frame, width: s.width, height: s.height, a: a.pic, b: b.pic, errors: { a: a.error, b: b.error }, ms: Math.round(performance.now() - started), computed: ev.stats.misses - misses, cached: ev.stats.hits - hits, viewLabel: 'Sample frames: linear ACEScg → Rec.709 (approx.), for viewing' });
    },
    compRender: async () => fail(options.desktopOnly('the comp is rendered into the shot package on disk.')),
    compExport: async () => fail(options.desktopOnly('the graph, the Nuke script and the manifest are written into the shot package on disk.')),
  };
}
