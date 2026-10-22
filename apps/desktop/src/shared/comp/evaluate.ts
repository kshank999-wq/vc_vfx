import { COMP_NODES, compInput, compNode, compNodeParams, compSourceOf, type CompDocument, type CompNode, type CompSource, type MergeOperation, type Track2d } from '@vcvfx/domain';
import { lumaWeights } from '../key/linear';
import { blank, blurRGBA, erodeRGBA, resizeRGBA, type Filter, type RGBA } from './image';
import {
  colorCorrect,
  constant,
  copyChannel,
  cornerPinMatrix,
  crop,
  despill,
  grade,
  lightWrap,
  masked,
  merge,
  premult,
  saturation,
  shuffle,
  trackCornerPin,
  trackOffset,
  transformMatrix,
  unpremult,
  warpMatrix,
} from './ops';

/**
 * The compositor's evaluator (addendum 13 §3): pull-based — asking for a
 * node's picture on a frame asks its inputs, and so on up to the sources —
 * over premultiplied linear RGBA at a chosen scale (1 for the render, a
 * fraction for the interactive proxy).
 *
 * Every result is cached under a key made of the node's type, its
 * parameters, whether it is bypassed, its inputs' keys and — only where time
 * matters (a moving source, a track) — the frame. Changing a parameter
 * changes that node's key and the keys downstream of it, so only those are
 * computed again; everything upstream is a cache hit ("non-destructive
 * parameter changes and cached previews", §14). A Constant's key has no
 * frame: it is made once for the whole shot. A bypassed node's key is its
 * main input's.
 */

export interface CompIO {
  /** A source's picture on a frame at w × h, premultiplied linear RGBA (a plate: alpha 1; a matte: rgb = a). Throws why it cannot be read. */
  source(source: CompSource, part: string, frame: number, width: number, height: number, signal?: AbortSignal): Promise<RGBA>;
  /** Changes when a source's files change (e.g. the export's version and time), so cached pictures of an older one are not used. */
  sourceVersion?(source: CompSource, part: string): string;
  /** Whether a source is one picture for every frame (a still clean plate, a texture, a reference image). */
  sourceStill?(source: CompSource, part: string): boolean;
  /** The shot's 2D tracks by id (plate pixels). */
  tracks: ReadonlyMap<string, Track2d>;
  /** Plate resolution: what scale 1 is. */
  plate: { width: number; height: number };
}

export class CompEvalError extends Error {
  constructor(
    readonly nodeId: string,
    readonly nodeName: string,
    message: string,
  ) {
    super(`${nodeName}: ${message}`);
  }
}

export interface CompStats {
  /** Times each node was computed (cache misses), by node id. */
  evaluations: Map<string, number>;
  hits: number;
  misses: number;
}

/** FNV-1a over a string, 52 bits, as base 36: short cache keys. */
function hash(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return ((h1 >>> 0) * 0x100000 + ((h2 >>> 0) & 0xfffff)).toString(36);
}

const AP1_LUMA = lumaWeights('ap1');

export interface EvalOptions {
  /** 1: plate resolution; 0.25: a quarter-size proxy. */
  scale: number;
  signal?: AbortSignal;
}

export class CompEvaluator {
  private cache = new Map<string, RGBA>();
  private bytes = 0;
  readonly stats: CompStats = { evaluations: new Map(), hits: 0, misses: 0 };

  constructor(
    private io: CompIO,
    /** Bytes of pictures kept (least recently used dropped first). */
    private budget = 768 * 1024 * 1024,
  ) {}

  /** The IO changed (another shot, a source written again): keep nothing. */
  setIO(io: CompIO): void {
    this.io = io;
    this.clear();
  }

  clear(): void {
    this.cache.clear();
    this.bytes = 0;
  }

  resetStats(): void {
    this.stats.evaluations.clear();
    this.stats.hits = 0;
    this.stats.misses = 0;
  }

  size(scale: number): { width: number; height: number } {
    return { width: Math.max(1, Math.round(this.io.plate.width * scale)), height: Math.max(1, Math.round(this.io.plate.height * scale)) };
  }

  /**
   * A node's cache key on a frame: what decides its pixels. Memoised per
   * call (`memo`), so a graph is keyed in one pass.
   */
  key(doc: Pick<CompDocument, 'nodes' | 'edges'>, id: string, frame: number, scale: number, memo = new Map<string, string>(), guard = new Set<string>()): string {
    const hit = memo.get(id);
    if (hit) return hit;
    const node = compNode(doc, id);
    if (!node) return 'none';
    if (guard.has(id)) throw new CompEvalError(id, node.name, 'the graph loops back on itself here');
    guard.add(id);
    const info = COMP_NODES[node.type];
    const inputKey = (name: string) => {
      const src = compInput(doc, id, name);
      return src ? this.key(doc, src.id, frame, scale, memo, guard) : '-';
    };
    let k: string;
    if (node.disabled) {
      k = info.pass ? inputKey(info.pass) : 'none';
    } else {
      const params = compNodeParams(node);
      const parts: unknown[] = [node.type, params, scale, info.inputs.map((i) => inputKey(i.name))];
      const source = compSourceOf(node);
      if (source) {
        const part = String(params['part'] ?? '');
        parts.push(this.io.sourceVersion?.(source, part) ?? '', this.io.sourceStill?.(source, part) ? 'still' : frame);
      }
      if (node.type === 'cornerpin' || node.type === 'track') {
        const t = this.io.tracks.get(String(params['track'] ?? ''));
        if (node.type === 'track' || params['source'] === 'track') parts.push(frame, t ? t.frames.length + ':' + JSON.stringify(t.frames.at(-1) ?? null) + JSON.stringify(t.keys.map((x) => x.frame)) : 'no-track');
      }
      k = hash(JSON.stringify(parts));
    }
    guard.delete(id);
    memo.set(id, k);
    return k;
  }

  private remember(key: string, img: RGBA): void {
    const prev = this.cache.get(key);
    if (prev) this.bytes -= prev.data.byteLength;
    this.cache.delete(key);
    this.cache.set(key, img);
    this.bytes += img.data.byteLength;
    while (this.bytes > this.budget && this.cache.size > 1) {
      const oldest = this.cache.keys().next().value!;
      this.bytes -= this.cache.get(oldest)!.data.byteLength;
      this.cache.delete(oldest);
    }
  }

  /** Whether a node's picture on this frame is already cached. */
  cached(doc: Pick<CompDocument, 'nodes' | 'edges'>, id: string, frame: number, scale: number): boolean {
    return this.cache.has(this.key(doc, id, frame, scale));
  }

  async evaluate(doc: Pick<CompDocument, 'nodes' | 'edges'>, id: string, frame: number, o: EvalOptions): Promise<RGBA> {
    const memo = new Map<string, string>();
    return this.pull(doc, id, frame, o, memo);
  }

  private async pull(doc: Pick<CompDocument, 'nodes' | 'edges'>, id: string, frame: number, o: EvalOptions, memo: Map<string, string>): Promise<RGBA> {
    if (o.signal?.aborted) throw new Error('Cancelled');
    const node = compNode(doc, id);
    const { width, height } = this.size(o.scale);
    if (!node) return blank(width, height);
    const key = this.key(doc, id, frame, o.scale, memo);
    const hit = this.cache.get(key);
    if (hit) {
      this.stats.hits += 1;
      // Most recently used last.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const info = COMP_NODES[node.type];
    if (node.disabled) {
      const src = info.pass ? compInput(doc, id, info.pass) : undefined;
      return src ? this.pull(doc, src.id, frame, o, memo) : blank(width, height);
    }
    const input = async (name: string): Promise<RGBA | null> => {
      const src = compInput(doc, id, name);
      return src ? this.pull(doc, src.id, frame, o, memo) : null;
    };
    const need = async (name: string): Promise<RGBA> => {
      const img = await input(name);
      if (!img) throw new CompEvalError(node.id, node.name, `needs its ${name} input connected`);
      return img;
    };
    this.stats.misses += 1;
    this.stats.evaluations.set(id, (this.stats.evaluations.get(id) ?? 0) + 1);
    const out = await this.compute(node, frame, o.scale, width, height, input, need, o.signal);
    this.remember(key, out);
    return out;
  }

  private async compute(
    node: CompNode,
    frame: number,
    scale: number,
    width: number,
    height: number,
    input: (name: string) => Promise<RGBA | null>,
    need: (name: string) => Promise<RGBA>,
    signal?: AbortSignal,
  ): Promise<RGBA> {
    const p = compNodeParams(node);
    const num = (k: string) => Number(p[k]);
    const vec = (k: string) => p[k] as number[];
    const fail = (message: string) => new CompEvalError(node.id, node.name, message);
    const source = compSourceOf(node);
    if (source) {
      try {
        const img = await this.io.source(source, String(p['part'] ?? ''), frame, width, height, signal);
        return img.width === width && img.height === height ? img : resizeRGBA(img, width, height);
      } catch (error) {
        throw fail((error as Error).message);
      }
    }
    switch (node.type) {
      case 'write':
      case 'dot':
        return need('src');
      case 'constant':
        return constant(width, height, vec('color'));
      case 'switch': {
        const which = Math.max(0, Math.min(3, Math.round(num('which'))));
        return (await input(`in${which}`)) ?? blank(width, height);
      }
      case 'merge': {
        const B = await input('B');
        const A = await input('A');
        return merge(p['operation'] as MergeOperation, A, B, await input('mask'), num('mix'), width, height);
      }
      case 'grade': {
        const src = await need('src');
        const out = grade(src, { blackpoint: num('blackpoint'), whitepoint: num('whitepoint'), lift: num('lift'), gain: num('gain'), multiply: num('multiply'), offset: num('offset'), gamma: num('gamma'), exposure: num('exposure'), blackClamp: Boolean(p['blackClamp']), whiteClamp: Boolean(p['whiteClamp']), unpremult: Boolean(p['unpremult']) });
        return masked(out, src, await input('mask'));
      }
      case 'colorcorrect': {
        const src = await need('src');
        return masked(colorCorrect(src, { saturation: num('saturation'), contrast: num('contrast'), gamma: num('gamma'), gain: num('gain'), offset: num('offset'), unpremult: Boolean(p['unpremult']) }), src, await input('mask'));
      }
      case 'saturation': {
        const src = await need('src');
        return masked(saturation(src, num('saturation')), src, await input('mask'));
      }
      case 'blur': {
        const src = await need('src');
        // Nuke's size is the filter's width; σ ≈ size / (2·√(2 ln 2)) treats it as the full width at half maximum.
        return masked(blurRGBA(src, (num('size') * scale) / 2.3548, p['channels'] === 'alpha'), src, await input('mask'));
      }
      case 'erode': {
        const src = await need('src');
        return masked(erodeRGBA(src, num('size') * scale, p['channels'] !== 'rgba'), src, await input('mask'));
      }
      case 'shuffle':
        return shuffle(await need('src'), { r: String(p['r']), g: String(p['g']), b: String(p['b']), a: String(p['a']) });
      case 'copy':
        return copyChannel(await need('B'), await input('A'), String(p['from']), String(p['to']));
      case 'premult':
        return premult(await need('src'));
      case 'unpremult':
        return unpremult(await need('src'));
      case 'crop': {
        const [x0, y0] = vec('min');
        const [x1, y1] = vec('max');
        return crop(await need('src'), { x0: x0! * width, y0: y0! * height, x1: x1! * width, y1: y1! * height }, num('softness') * scale);
      }
      case 'transform': {
        const src = await need('src');
        const t = vec('translate');
        const c = vec('center');
        const m = transformMatrix({ translate: [t[0]! * scale, t[1]! * scale], rotate: num('rotate'), scale: vec('scale') as [number, number], center: [c[0]! * width, c[1]! * height], invert: Boolean(p['invert']) });
        const forward = p['invert'] ? inverseOr(m) : m;
        return masked(warpMatrix(src, forward, p['filter'] as Filter), src, await input('mask'));
      }
      case 'cornerpin': {
        const src = await need('src');
        let m;
        if (p['source'] === 'track') {
          const t = this.io.tracks.get(String(p['track'] ?? ''));
          if (!t) throw fail(p['track'] ? `there is no 2D track “${String(p['track'])}”` : 'choose a planar track');
          m = trackCornerPin(t, frame, Math.round(num('reference')), p['mode'] === 'stabilise' ? 'stabilise' : 'matchmove', scale);
          if (!m) throw fail(`the track “${t.name}” has no four corners to pin with`);
        } else {
          const from: [number, number][] = [
            [0, 0],
            [width, 0],
            [width, height],
            [0, height],
          ];
          const to = (['to1', 'to2', 'to3', 'to4'] as const).map((k) => [vec(k)[0]! * width, vec(k)[1]! * height] as [number, number]);
          m = cornerPinMatrix(from, to);
          if (!m) throw fail('those corners do not make a usable pin');
        }
        return masked(warpMatrix(src, m, p['filter'] as Filter), src, await input('mask'));
      }
      case 'track': {
        const src = await need('src');
        const t = this.io.tracks.get(String(p['track'] ?? ''));
        if (!t) throw fail(p['track'] ? `there is no 2D track “${String(p['track'])}”` : 'choose a 2D track');
        const d = trackOffset(t, frame, Math.round(num('reference')), p['mode'] === 'stabilise' ? 'stabilise' : 'matchmove', scale);
        if (!d) throw fail(`the track “${t.name}” has no tracked frames`);
        return masked(warpMatrix(src, [1, 0, d[0], 0, 1, d[1], 0, 0, 1], p['filter'] as Filter), src, await input('mask'));
      }
      case 'despill': {
        const src = await need('src');
        return despill(src, { kind: p['screen'] === 'blue' ? 'blue' : 'green', limit: p['limit'] as 'average', weight: num('weight'), strength: num('strength'), restore: p['restore'] as 'neutral', restoreAmount: num('restoreAmount'), protectSkin: Boolean(p['protectSkin']), luma: AP1_LUMA }, await input('bg'), num('backgroundBlur') * scale);
      }
      case 'lightwrap': {
        const fg = await need('fg');
        const bg = await need('bg');
        return lightWrap(fg, bg, { width: num('width') * scale, intensity: num('intensity'), lumaWeight: num('lumaWeight'), luma: AP1_LUMA });
      }
      default:
        throw fail(`${COMP_NODES[node.type].label} is not evaluated here`);
    }
  }
}

function inverseOr(m: number[]): number[] {
  const [a, b, c, d, e, f] = m as [number, number, number, number, number, number];
  const det = a * e - b * d;
  if (Math.abs(det) < 1e-12) return m;
  return [e / det, -b / det, (b * f - c * e) / det, -d / det, a / det, (c * d - a * f) / det, 0, 0, 1];
}

/** The nodes a picture of `id` depends on, the node first (for the UI's "computed" count). */
export function compDependencies(doc: Pick<CompDocument, 'nodes' | 'edges'>, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (cur: string) => {
    if (seen.has(cur)) return;
    seen.add(cur);
    out.push(cur);
    for (const e of doc.edges) if (e.to === cur) walk(e.from);
  };
  walk(id);
  return out;
}
