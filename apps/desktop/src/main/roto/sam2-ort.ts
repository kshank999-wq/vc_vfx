import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { SAM2_INPUT, SAM2_LOWRES, type Sam2Decoded, type Sam2Embedding, type Sam2Prompt, type Sam2Runtime } from '../../shared/roto/sam2';

/**
 * SAM 2 inference with onnxruntime-node (addendum 04), on the CPU.
 *
 * onnxruntime-node is not a workspace dependency: its package carries native
 * binaries for every platform (~190 MB), which every install — the website's
 * on Vercel included — would otherwise download. `scripts/fetch-onnxruntime.mjs`
 * installs a pinned version into `resources/onnxruntime/`, electron-builder
 * copies it beside app.asar (a native module cannot load from inside the
 * archive), and this file loads it from there, or from wherever Node can
 * resolve it in development.
 *
 * Tensor names and shapes are samexporter's (see shared/roto/sam2.ts).
 */

/** The subset of onnxruntime-node's API used here. */
export interface OrtTensor {
  data: unknown;
  dims: readonly number[];
}
export interface OrtSession {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
  release?(): Promise<void>;
}
export interface OrtModule {
  Tensor: new (type: 'float32', data: Float32Array, dims: readonly number[]) => OrtTensor;
  InferenceSession: { create(path: string, options?: Record<string, unknown>): Promise<OrtSession> };
}

/** Where onnxruntime-node may be. */
export function ortCandidates(loc: { resourcesPath: string; appPath: string; packaged: boolean }): string[] {
  const rel = join('onnxruntime', 'node_modules', 'onnxruntime-node');
  return [loc.packaged ? join(loc.resourcesPath, rel) : join(loc.appPath, 'resources', rel), 'onnxruntime-node'];
}

/** Load onnxruntime-node from the first candidate that has it. `detail` says where it looked (development: run scripts/fetch-onnxruntime.mjs). */
export function loadOrt(candidates: readonly string[]): { ok: true; ort: OrtModule; from: string } | { ok: false; reason: string; detail: string } {
  const req = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);
  const problems: string[] = [];
  for (const c of candidates) {
    if (c.includes('/') || c.includes('\\')) {
      if (!existsSync(c)) {
        problems.push(`${c}: not there`);
        continue;
      }
    }
    try {
      return { ok: true, ort: req(c) as OrtModule, from: c };
    } catch (error) {
      problems.push(`${c}: ${(error as Error).message.split('\n')[0]}`);
    }
  }
  return { ok: false, reason: 'The SAM 2 runtime (onnxruntime-node) is not installed with this copy of VC VFX.', detail: problems.join('; ') };
}

const ENCODER_OUT = ['high_res_feats_0', 'high_res_feats_1', 'image_embed'] as const;
const DECODER_IN = ['image_embed', 'high_res_feats_0', 'high_res_feats_1', 'point_coords', 'point_labels', 'mask_input', 'has_mask_input'] as const;
const DECODER_OUT = ['masks', 'iou_predictions'] as const;

/** Refuse a model whose tensors are not named as samexporter names them. */
export function checkSessions(encoder: Pick<OrtSession, 'inputNames' | 'outputNames'>, decoder: Pick<OrtSession, 'inputNames' | 'outputNames'>): string | null {
  const missing = [
    ...(encoder.inputNames.includes('image') ? [] : ['encoder input image']),
    ...ENCODER_OUT.filter((n) => !encoder.outputNames.includes(n)).map((n) => `encoder output ${n}`),
    ...DECODER_IN.filter((n) => !decoder.inputNames.includes(n)).map((n) => `decoder input ${n}`),
    ...DECODER_OUT.filter((n) => !decoder.outputNames.includes(n)).map((n) => `decoder output ${n}`),
  ];
  return missing.length ? `These model files are not a samexporter SAM 2 export: missing ${missing.join(', ')}` : null;
}

export class OrtSam2Runtime implements Sam2Runtime {
  private constructor(
    private readonly ort: OrtModule,
    private readonly encoder: OrtSession,
    private readonly decoder: OrtSession,
  ) {}

  static async create(ort: OrtModule, encoderPath: string, decoderPath: string, threads?: number): Promise<OrtSam2Runtime> {
    const options = { executionProviders: ['cpu'], graphOptimizationLevel: 'all', ...(threads ? { intraOpNumThreads: threads } : {}) };
    const encoder = await ort.InferenceSession.create(encoderPath, options);
    const decoder = await ort.InferenceSession.create(decoderPath, options);
    const problem = checkSessions(encoder, decoder);
    if (problem) throw new Error(problem);
    return new OrtSam2Runtime(ort, encoder, decoder);
  }

  async encode(pixels: Float32Array): Promise<Sam2Embedding> {
    if (pixels.length !== 3 * SAM2_INPUT * SAM2_INPUT) throw new Error('SAM 2 input must be 3 × 1024 × 1024');
    const out = await this.encoder.run({ image: new this.ort.Tensor('float32', pixels, [1, 3, SAM2_INPUT, SAM2_INPUT]) });
    const get = (name: (typeof ENCODER_OUT)[number]) => {
      const t = out[name];
      if (!t || !(t.data instanceof Float32Array)) throw new Error(`The encoder gave no ${name}`);
      return t;
    };
    const e = get('image_embed');
    const h0 = get('high_res_feats_0');
    const h1 = get('high_res_feats_1');
    return {
      imageEmbed: e.data as Float32Array,
      highRes0: h0.data as Float32Array,
      highRes1: h1.data as Float32Array,
      dims: { imageEmbed: [...e.dims], highRes0: [...h0.dims], highRes1: [...h1.dims] },
    };
  }

  async decode(e: Sam2Embedding, prompt: Sam2Prompt): Promise<Sam2Decoded> {
    const n = prompt.labels.length;
    const T = (data: Float32Array, dims: readonly number[]) => new this.ort.Tensor('float32', data, dims);
    const dims = e.dims ?? { imageEmbed: [1, 256, 64, 64], highRes0: [1, 32, 256, 256], highRes1: [1, 64, 128, 128] };
    const out = await this.decoder.run({
      image_embed: T(e.imageEmbed, dims.imageEmbed),
      high_res_feats_0: T(e.highRes0, dims.highRes0),
      high_res_feats_1: T(e.highRes1, dims.highRes1),
      point_coords: T(prompt.coords, [1, n, 2]),
      point_labels: T(prompt.labels, [1, n]),
      mask_input: T(prompt.maskInput ?? new Float32Array(SAM2_LOWRES * SAM2_LOWRES), [1, 1, SAM2_LOWRES, SAM2_LOWRES]),
      has_mask_input: T(Float32Array.from([prompt.maskInput ? 1 : 0]), [1]),
    });
    const masks = out['masks'];
    const ious = out['iou_predictions'];
    if (!masks || !ious || !(masks.data instanceof Float32Array) || !(ious.data instanceof Float32Array)) throw new Error('The decoder gave no masks');
    const count = masks.dims[1] ?? 1;
    if (masks.dims[2] !== SAM2_LOWRES || masks.dims[3] !== SAM2_LOWRES) throw new Error(`The decoder's masks are ${masks.dims.join('×')}, not 256 × 256`);
    return { masks: masks.data, ious: ious.data, count };
  }

  dispose(): void {
    void this.encoder.release?.();
    void this.decoder.release?.();
  }
}
