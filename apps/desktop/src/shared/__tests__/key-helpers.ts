import { DEFAULT_KEY_PARAMS, DespillSchema, LightWrapSchema, type KeyLink, type ScreenKind } from '@vcvfx/domain';
import { signedDistance } from '../roto/image';
import type { KeyIO, KeySettings } from '../key/engine';
import type { LinearImage } from '../key/linear';
import type { GreenScreenScene } from '../key/synthetic';

/** Ground-truth regions of a synthetic frame: background (≥ 3 px from the subject), core (≥ 3 px inside, α = 1), edge (0 < α < 1). */
export function regions(alpha: Float32Array, w: number, h: number) {
  const on = new Uint8Array(alpha.length);
  const any = new Uint8Array(alpha.length);
  for (let i = 0; i < alpha.length; i += 1) {
    on[i] = alpha[i]! >= 0.999 ? 1 : 0;
    any[i] = alpha[i]! > 0 ? 1 : 0;
  }
  const sdSolid = signedDistance(on, w, h, 6);
  const sdAny = signedDistance(any, w, h, 6);
  const bg: number[] = [];
  const core: number[] = [];
  const edge: number[] = [];
  for (let i = 0; i < alpha.length; i += 1) {
    if (sdAny[i]! > 3) bg.push(i);
    else if (sdSolid[i]! < -3) core.push(i);
    else if (alpha[i]! > 0 && alpha[i]! < 1) edge.push(i);
  }
  return { bg, core, edge };
}

export function accuracy(est: Float32Array, truth: Float32Array, w: number, h: number) {
  const r = regions(truth, w, h);
  const mean = (idx: number[]) => idx.reduce((s, i) => s + est[i]!, 0) / Math.max(1, idx.length);
  const mae = (idx: number[]) => idx.reduce((s, i) => s + Math.abs(est[i]! - truth[i]!), 0) / Math.max(1, idx.length);
  return { bg: mean(r.bg), core: mean(r.core), edgeMae: mae(r.edge), allMae: mae([...truth.keys()]), counts: { bg: r.bg.length, core: r.core.length, edge: r.edge.length } };
}

export function sceneIO(scene: GreenScreenScene, roto: Record<string, (n: number) => Float32Array | null> = {}, withBackground = true): KeyIO {
  const cache = new Map<number, LinearImage>();
  return {
    frame: async (f) => {
      let img = cache.get(f);
      if (!img) {
        img = scene.render(f);
        cache.set(f, img);
        if (cache.size > 12) cache.delete(cache.keys().next().value!);
      }
      return img;
    },
    roto: async (partId, f) => roto[partId]?.(f) ?? null,
    background: async () => (withBackground ? scene.background : null),
  };
}

export function settingsFor(kind: ScreenKind, rgb: [number, number, number], over: Partial<KeySettings> = {}, links: KeyLink[] = []): KeySettings {
  return {
    screen: { kind, source: 'auto', rgb, samples: [], coverage: null, frames: [], track: true },
    params: { ...DEFAULT_KEY_PARAMS },
    links,
    despill: DespillSchema.parse({}),
    lightWrap: LightWrapSchema.parse({}),
    ...over,
  };
}

export const LUMA_AP1: [number, number, number] = [0.2722287, 0.6740818, 0.0536895];
