import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The SAM 2 model files (addendum 04, addendum 18): downloaded on first use
 * into `userData/models/<id>/`, never shipped in the installer, never
 * committed.
 *
 * Every file is pinned by SHA-256 and size, and the source is pinned to a
 * repository *revision* (a commit), never a moving branch. The hashes were
 * taken from the hosting service's own metadata (Hugging Face's `lfs.sha256`
 * and `x-linked-etag`, and for the default model also the publisher's
 * CHECKSUMS.sha256) and match the files as downloaded (addendum 18 §1).
 *
 * Default: SAM 2.1 Hiera Tiny exported by samexporter's author
 * (Hugging Face nrl-ai/samexporter-onnx-models; its PROVENANCE.md names the
 * official checkpoint sam2.1_hiera_tiny.pt and facebookresearch/sam2 at
 * 2b90b9f5). Optional: SAM 2 (2.0) Hiera Base+ from the same author
 * (vietanhdev/segment-anything-2-onnx-models), better edges, about twice as
 * slow. Both are samexporter's layout (the tensors sam2.ts is written for).
 * The source can be overridden with VCVFX_SAM2_URL or `modelBaseUrl` in
 * Settings — the pins still apply.
 */

export interface ModelFile {
  name: string;
  /** Exact size in bytes as published (also the "Download model (N MB)" label). */
  approxBytes: number;
  /** Lowercase hex SHA-256, or null when not yet pinned. */
  sha256: string | null;
}

export interface ModelInfo {
  id: string;
  label: string;
  licence: string;
  defaultBaseUrl: string;
  /** Where the files and their hashes come from, for the record and the download page. */
  source?: { repository: string; revision: string; provenance: string };
  files: ModelFile[];
}

export const SAM2_MODEL: ModelInfo = {
  id: 'sam2.1_hiera_tiny',
  label: 'SAM 2.1 Hiera Tiny (ONNX, samexporter layout)',
  licence: 'SAM 2.1 weights: Apache-2.0 (Meta). ONNX export: samexporter (MIT); the export folder carries the Apache-2.0 licence.',
  defaultBaseUrl: 'https://huggingface.co/nrl-ai/samexporter-onnx-models/resolve/5050a79cd4b912dd745fff83047c4ef6fbd97be5/sam2_1_hiera_tiny/',
  source: {
    repository: 'https://huggingface.co/nrl-ai/samexporter-onnx-models',
    revision: '5050a79cd4b912dd745fff83047c4ef6fbd97be5',
    provenance: 'Exported with samexporter from the official checkpoint sam2.1_hiera_tiny.pt (facebookresearch/sam2 2b90b9f5ceec907a1c18123530e92e794ad901a4), ONNX opset 18 (the repository\'s PROVENANCE.md and CHECKSUMS.sha256).',
  },
  files: [
    { name: 'sam2.1_hiera_tiny.encoder.onnx', approxBytes: 109_471_931, sha256: '3d5ae796097a6afb1198ceea4187ecaa82736242d07f5658541829d6dfc3f871' },
    { name: 'sam2.1_hiera_tiny.decoder.onnx', approxBytes: 16_519_561, sha256: '197f1c7c8fd070aaf6f15ffc635f4c384422ba5eaa0f8c9e543e3d4b8e0e8e87' },
  ],
};

export const SAM2_BASE_PLUS_MODEL: ModelInfo = {
  id: 'sam2_hiera_base_plus',
  label: 'SAM 2 Hiera Base+ (ONNX, samexporter layout; higher quality, slower)',
  licence: 'SAM 2 weights: Apache-2.0 (Meta). ONNX export: samexporter (MIT), repository licensed Apache-2.0.',
  defaultBaseUrl: 'https://huggingface.co/vietanhdev/segment-anything-2-onnx-models/resolve/071f58077599431edd0e5d2ac52ecca4c78f1cab/',
  source: {
    repository: 'https://huggingface.co/vietanhdev/segment-anything-2-onnx-models',
    revision: '071f58077599431edd0e5d2ac52ecca4c78f1cab',
    provenance: 'samexporter export of Meta\'s SAM 2 (2.0) sam2_hiera_base_plus checkpoint by samexporter\'s author (the repository README).',
  },
  files: [
    { name: 'sam2_hiera_base_plus.encoder.onnx', approxBytes: 339_781_223, sha256: '53b79cec15f2078b3c7410f00f00950a09ef02007dccf238859fec156e42cc8d' },
    { name: 'sam2_hiera_base_plus.decoder.onnx', approxBytes: 20_640_886, sha256: '666f00ce2664de31211a71068b6b74c3fc5aeee089ebeb2fc9c37834b9ce03b4' },
  ],
};

export const SAM2_MODELS: readonly ModelInfo[] = [SAM2_MODEL, SAM2_BASE_PLUS_MODEL];
export type Sam2ModelId = 'sam2.1_hiera_tiny' | 'sam2_hiera_base_plus';
/** The model a setting names; the default for anything else. */
export const sam2Model = (id?: string | null): ModelInfo => SAM2_MODELS.find((m) => m.id === id) ?? SAM2_MODEL;

export const isPinned = (model: ModelInfo): boolean => model.files.every((f) => f.sha256 !== null && /^[0-9a-f]{64}$/.test(f.sha256));
export const modelBytes = (model: ModelInfo): number => model.files.reduce((n, f) => n + f.approxBytes, 0);
export const modelDir = (userData: string, model: ModelInfo): string => join(userData, 'models', model.id);

export const UNPINNED_REFUSAL =
  'This build of VC VFX has no pinned checksum for the SAM 2 model, so it will not download or run it. The Track engine works without it. (Release builds must pin the model files: see addendum 04.)';

export interface ModelStatus {
  id: string;
  label: string;
  approxBytes: number;
  present: boolean;
  pinned: boolean;
  /** Present and allowed to run in this build. */
  usable: boolean;
  reason: string | null;
  dir: string;
}

export async function modelStatus(userData: string, packaged: boolean, model: ModelInfo = SAM2_MODEL): Promise<ModelStatus> {
  const dir = modelDir(userData, model);
  const present = (await Promise.all(model.files.map((f) => stat(join(dir, f.name)).then((s) => s.isFile() && s.size > 0).catch(() => false)))).every(Boolean);
  const pinned = isPinned(model);
  const reason = packaged && !pinned ? UNPINNED_REFUSAL : present ? null : `The model is not downloaded yet (about ${Math.round(modelBytes(model) / 1e6)} MB).`;
  return { id: model.id, label: model.label, approxBytes: modelBytes(model), present, pinned, usable: present && (pinned || !packaged), reason, dir };
}

export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolvePromise, reject) => {
    createReadStream(path)
      .on('data', (d) => hash.update(d))
      .on('error', reject)
      .on('end', () => resolvePromise());
  });
  return hash.digest('hex');
}

/** Check the files on disk against their pins (a packaged build calls this before loading them). */
export async function verifyModel(userData: string, model: ModelInfo = SAM2_MODEL): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!isPinned(model)) return { ok: false, reason: UNPINNED_REFUSAL };
  for (const f of model.files) {
    const got = await sha256OfFile(join(modelDir(userData, model), f.name)).catch(() => null);
    if (got !== f.sha256) return { ok: false, reason: `${f.name} does not match its pinned SHA-256. Delete ${modelDir(userData, model)} and download it again.` };
  }
  return { ok: true };
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; body: ReadableStream<Uint8Array> | null }>;

export interface DownloadOptions {
  userData: string;
  packaged: boolean;
  baseUrl?: string;
  fetch: FetchLike;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, file: string) => void;
  model?: ModelInfo;
}

/**
 * Download the model files (resuming nothing: each file is fetched whole into
 * a .part file, hashed as it streams, checked, then moved into place).
 */
export async function downloadModel(o: DownloadOptions): Promise<{ dir: string; hashes: Record<string, string>; unpinned: boolean }> {
  const model = o.model ?? SAM2_MODEL;
  const pinned = isPinned(model);
  if (o.packaged && !pinned) throw new Error(UNPINNED_REFUSAL);
  const base = (o.baseUrl || model.defaultBaseUrl).replace(/\/?$/, '/');
  if (!/^https:\/\//.test(base)) throw new Error('The model source must be an https:// URL');
  const dir = modelDir(o.userData, model);
  await mkdir(dir, { recursive: true });
  const total = modelBytes(model);
  let done = 0;
  const hashes: Record<string, string> = {};
  for (const f of model.files) {
    const url = new URL(f.name, base).toString();
    const res = await o.fetch(url, o.signal ? { signal: o.signal } : {});
    if (!res.ok || !res.body) throw new Error(`Downloading ${f.name} failed: HTTP ${res.status} from ${url}`);
    const part = join(dir, `${f.name}.part`);
    const handle = await open(part, 'w');
    const hash = createHash('sha256');
    let fileBytes = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        if (o.signal?.aborted) throw new Error('Cancelled');
        const { done: end, value } = await reader.read();
        if (end) break;
        hash.update(value);
        fileBytes += value.length;
        await handle.write(value);
        done += value.length;
        o.onProgress?.(done, total, f.name);
      }
    } catch (error) {
      await handle.close();
      await rm(part, { force: true });
      throw error;
    }
    await handle.close();
    const got = hash.digest('hex');
    hashes[f.name] = got;
    if (f.sha256 && (got !== f.sha256 || fileBytes !== f.approxBytes)) {
      await rm(part, { force: true });
      throw new Error(`${f.name} downloaded from ${url} does not match its pinned SHA-256 and size (got ${got}, ${fileBytes} bytes). Nothing was installed.`);
    }
    await rename(part, join(dir, f.name));
  }
  if (!pinned) await writeFile(join(dir, 'PINS.json'), `${JSON.stringify({ note: 'Hashes of the files as downloaded; copy them into SAM2_MODEL in apps/desktop/src/main/roto/models.ts to pin them.', source: base, hashes }, null, 2)}\n`);
  return { dir, hashes, unpinned: !pinned };
}
