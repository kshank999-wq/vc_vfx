import { createHash, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import xxhash from 'xxhash-wasm';

/**
 * Stream a file through one or more checksums in a single read. Camera
 * originals run to hundreds of gigabytes, so nothing here holds a file in
 * memory. Opened read-only.
 *
 * Digests are lowercase hex. xxh64 is seed 0, written as VCDIT and ASC MHL
 * write it: the 64-bit value as 16 hex digits, most significant first.
 */

export const COMPUTED_ALGORITHMS = ['sha256', 'md5', 'sha1', 'xxh64'] as const;
export type ComputedAlgorithm = (typeof COMPUTED_ALGORITHMS)[number];

export function isComputed(algorithm: string): algorithm is ComputedAlgorithm {
  return (COMPUTED_ALGORITHMS as readonly string[]).includes(algorithm);
}

interface Hasher {
  update(chunk: Uint8Array): void;
  digest(): string;
}

let xx: Awaited<ReturnType<typeof xxhash>> | null = null;

async function hasherFor(algorithm: ComputedAlgorithm): Promise<Hasher> {
  if (algorithm === 'xxh64') {
    xx ??= await xxhash();
    const state = xx.create64();
    return { update: (chunk) => void state.update(chunk), digest: () => state.digest().toString(16).padStart(16, '0') };
  }
  const hash: Hash = createHash(algorithm);
  return { update: (chunk) => void hash.update(chunk), digest: () => hash.digest('hex') };
}

export async function hashFile<A extends ComputedAlgorithm>(
  path: string,
  algorithms: readonly A[],
  options: { signal?: AbortSignal; onBytes?: (bytes: number) => void } = {},
): Promise<{ digests: Record<A, string>; bytes: number }> {
  const { size } = await stat(path);
  const unique = [...new Set(algorithms)];
  const hashers = await Promise.all(unique.map((a) => hasherFor(a)));
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path, { flags: 'r', highWaterMark: 4 * 1024 * 1024 });
    const abort = () => stream.destroy(new Error('Cancelled'));
    if (options.signal?.aborted) return abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    stream.on('data', (chunk) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      for (const h of hashers) h.update(bytes);
      options.onBytes?.(bytes.length);
    });
    stream.on('error', (error) => {
      options.signal?.removeEventListener('abort', abort);
      reject(error);
    });
    stream.on('end', () => {
      options.signal?.removeEventListener('abort', abort);
      resolvePromise();
    });
  });
  const digests = Object.fromEntries(unique.map((a, i) => [a, hashers[i]!.digest()])) as Record<A, string>;
  return { digests, bytes: size };
}

export async function sha256File(
  path: string,
  options: { signal?: AbortSignal; onBytes?: (bytes: number) => void } = {},
): Promise<{ sha256: string; bytes: number }> {
  const { digests, bytes } = await hashFile(path, ['sha256'], options);
  return { sha256: digests.sha256, bytes };
}
