import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
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

/**
 * onnxruntime-node in a process of its own (addendum 18). Inside Electron,
 * running the SAM 2 encoder in a worker thread crashes the app (SIGTRAP) as
 * soon as the first output tensor is collected: onnxruntime-node hands back
 * tensors over memory V8's sandbox does not allow in a worker isolate. The
 * same code runs in a plain Node, in Electron's main thread, and in a process
 * started with ELECTRON_RUN_AS_NODE — so the workers start one such process
 * (the app's own binary, as Node) and talk to it over IPC. It keeps the image
 * embedding and sends back only the decoder's masks.
 */
const HOST_SOURCE = String.raw`'use strict';
const ort = require(process.argv[2]);
let enc = null;
let dec = null;
const embeds = new Map();
let next = 1;
const send = (m) => process.send(m);
process.on('message', async (m) => {
  try {
    if (m.op === 'init') {
      const o = { executionProviders: ['cpu'], graphOptimizationLevel: 'all', ...(m.threads ? { intraOpNumThreads: m.threads } : {}) };
      enc = await ort.InferenceSession.create(m.encoder, o);
      dec = await ort.InferenceSession.create(m.decoder, o);
      send({ id: m.id, ok: true, names: { encoderIn: enc.inputNames, encoderOut: enc.outputNames, decoderIn: dec.inputNames, decoderOut: dec.outputNames } });
    } else if (m.op === 'encode') {
      const out = await enc.run({ image: new ort.Tensor('float32', m.pixels, [1, 3, 1024, 1024]) });
      const h = next++;
      embeds.set(h, { e: out.image_embed, h0: out.high_res_feats_0, h1: out.high_res_feats_1 });
      while (embeds.size > 3) embeds.delete(embeds.keys().next().value);
      send({ id: m.id, ok: true, handle: h, dims: { imageEmbed: [...out.image_embed.dims], highRes0: [...out.high_res_feats_0.dims], highRes1: [...out.high_res_feats_1.dims] } });
    } else if (m.op === 'decode') {
      const x = embeds.get(m.handle);
      if (!x) throw new Error('The image embedding is gone');
      const T = (d, dims) => new ort.Tensor('float32', d, dims);
      const n = m.labels.length;
      const out = await dec.run({ image_embed: x.e, high_res_feats_0: x.h0, high_res_feats_1: x.h1, point_coords: T(m.coords, [1, n, 2]), point_labels: T(m.labels, [1, n]), mask_input: T(m.maskInput || new Float32Array(256 * 256), [1, 1, 256, 256]), has_mask_input: T(Float32Array.from([m.maskInput ? 1 : 0]), [1]) });
      send({ id: m.id, ok: true, masks: Float32Array.from(out.masks.data), ious: Float32Array.from(out.iou_predictions.data), dims: [...out.masks.dims] });
    } else if (m.op === 'quit') process.exit(0);
  } catch (e) {
    send({ id: m.id, ok: false, error: String((e && e.message) || e) });
  }
});
`;

function hostFile(): string {
  const dir = join(tmpdir(), 'vcvfx-ort-host');
  const file = join(dir, `host-${createHash('sha256').update(HOST_SOURCE).digest('hex').slice(0, 12)}.cjs`);
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, HOST_SOURCE);
  }
  return file;
}

/** Whether inference should run in a process of its own: always inside Electron, or when asked (tests). */
export const ortNeedsHost = (): boolean => Boolean(process.versions['electron']) || process.env['VCVFX_ORT_HOST'] === '1';

type HostReply = { id: number; ok: boolean; error?: string; [k: string]: unknown };

export class HostedSam2Runtime implements Sam2Runtime {
  private seq = 0;
  private waiting = new Map<number, { resolve(v: HostReply): void; reject(e: Error): void }>();
  private err = '';

  private constructor(private readonly child: ChildProcess) {
    child.on('message', (m: HostReply) => {
      const w = this.waiting.get(m.id);
      if (!w) return;
      this.waiting.delete(m.id);
      if (m.ok) w.resolve(m);
      else w.reject(new Error(m.error ?? 'SAM 2 inference failed'));
    });
    child.stderr?.on('data', (d: Buffer) => (this.err = (this.err + d.toString()).slice(-2000)));
    child.on('exit', (code) => {
      for (const w of this.waiting.values()) w.reject(new Error(`The SAM 2 process stopped (exit ${code}): ${this.err.split('\n').filter((l) => !/W:onnxruntime/.test(l)).pop() ?? ''}`));
      this.waiting.clear();
    });
  }

  private call(msg: Record<string, unknown>): Promise<HostReply> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.child.send({ ...msg, id });
    });
  }

  /** `ortPath` is an absolute path to onnxruntime-node's folder (loadOrt's `from`, resolved). */
  static async create(ortPath: string, encoderPath: string, decoderPath: string, threads?: number): Promise<HostedSam2Runtime> {
    const child = fork(hostFile(), [ortPath], { execPath: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const rt = new HostedSam2Runtime(child);
    try {
      const r = await rt.call({ op: 'init', encoder: encoderPath, decoder: decoderPath, threads });
      const names = r['names'] as { encoderIn: string[]; encoderOut: string[]; decoderIn: string[]; decoderOut: string[] };
      const problem = checkSessions({ inputNames: names.encoderIn, outputNames: names.encoderOut }, { inputNames: names.decoderIn, outputNames: names.decoderOut });
      if (problem) throw new Error(problem);
    } catch (error) {
      rt.dispose();
      throw error;
    }
    return rt;
  }

  async encode(pixels: Float32Array): Promise<Sam2Embedding> {
    if (pixels.length !== 3 * SAM2_INPUT * SAM2_INPUT) throw new Error('SAM 2 input must be 3 × 1024 × 1024');
    const r = await this.call({ op: 'encode', pixels });
    const empty = new Float32Array(0);
    return { imageEmbed: empty, highRes0: empty, highRes1: empty, dims: r['dims'] as Sam2Embedding['dims'], handle: r['handle'] as number };
  }

  async decode(e: Sam2Embedding, prompt: Sam2Prompt): Promise<Sam2Decoded> {
    if (e.handle === undefined) throw new Error('That embedding was not made by this SAM 2 process');
    const r = await this.call({ op: 'decode', handle: e.handle, coords: prompt.coords, labels: prompt.labels, maskInput: prompt.maskInput });
    const dims = r['dims'] as number[];
    if (dims[2] !== SAM2_LOWRES || dims[3] !== SAM2_LOWRES) throw new Error(`The decoder's masks are ${dims.join('×')}, not 256 × 256`);
    return { masks: r['masks'] as Float32Array, ious: r['ious'] as Float32Array, count: dims[1] ?? 1 };
  }

  dispose(): void {
    try {
      this.child.send({ op: 'quit', id: 0 });
    } catch {
      // already gone
    }
    setTimeout(() => this.child.kill(), 2000).unref();
  }
}

