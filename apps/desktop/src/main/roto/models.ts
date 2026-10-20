import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The SAM 2 model files (addendum 04): downloaded on first use into
 * `userData/models/<id>/`, never shipped in the installer, never committed.
 *
 * Every file has a SHA-256 pin. **The pins below are placeholders (null) and
 * must be filled before a release**: download the files once from the
 * confirmed source, check them, and put their hashes here. A packaged build
 * refuses to download or load a file without a pin; a development build
 * downloads it, prints the hash it got (and writes it to PINS.json beside the
 * files) and uses it, so a developer can pin it.
 *
 * Default source — TO BE CONFIRMED before release: the Hugging Face
 * repository nrl-ai/samexporter-onnx-models, which publishes SAM 2.1 Tiny in
 * samexporter's layout (the input/output names sam2.ts is written against).
 * The exact folder and file names inside it have not been checked from this
 * environment (huggingface.co was unreachable). The source can be overridden
 * with the VCVFX_SAM2_URL environment variable or `modelBaseUrl` in Settings.
 */

export interface ModelFile {
  name: string;
  /** Approximate size, for the "Download model (N MB)" label. */
  approxBytes: number;
  /** Lowercase hex SHA-256, or null when not yet pinned. */
  sha256: string | null;
}

export interface ModelInfo {
  id: string;
  label: string;
  licence: string;
  defaultBaseUrl: string;
  files: ModelFile[];
}

export const SAM2_MODEL: ModelInfo = {
  id: 'sam2.1_hiera_tiny',
  label: 'SAM 2.1 Hiera Tiny (ONNX, samexporter layout)',
  licence: 'SAM 2: Apache-2.0 (Meta). ONNX export: samexporter (MIT).',
  defaultBaseUrl: 'https://huggingface.co/nrl-ai/samexporter-onnx-models/resolve/main/sam2.1_hiera_tiny/',
  files: [
    { name: 'sam2.1_hiera_tiny.encoder.onnx', approxBytes: 135_000_000, sha256: null },
    { name: 'sam2.1_hiera_tiny.decoder.onnx', approxBytes: 21_000_000, sha256: null },
  ],
};

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
    try {
      const reader = res.body.getReader();
      for (;;) {
        if (o.signal?.aborted) throw new Error('Cancelled');
        const { done: end, value } = await reader.read();
        if (end) break;
        hash.update(value);
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
    if (f.sha256 && got !== f.sha256) {
      await rm(part, { force: true });
      throw new Error(`${f.name} downloaded from ${url} does not match its pinned SHA-256 (got ${got}). Nothing was installed.`);
    }
    await rename(part, join(dir, f.name));
  }
  if (!pinned) await writeFile(join(dir, 'PINS.json'), `${JSON.stringify({ note: 'Hashes of the files as downloaded; copy them into SAM2_MODEL in apps/desktop/src/main/roto/models.ts to pin them.', source: base, hashes }, null, 2)}\n`);
  return { dir, hashes, unpinned: !pinned };
}
