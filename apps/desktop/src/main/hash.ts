import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

/**
 * Stream a file through sha256. Camera originals run to hundreds of
 * gigabytes, so nothing here holds a file in memory. Opened read-only.
 */
export async function sha256File(
  path: string,
  options: { signal?: AbortSignal; onBytes?: (bytes: number) => void } = {},
): Promise<{ sha256: string; bytes: number }> {
  const { size } = await stat(path);
  const hash = createHash('sha256');
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path, { flags: 'r', highWaterMark: 4 * 1024 * 1024 });
    const abort = () => stream.destroy(new Error('Cancelled'));
    if (options.signal?.aborted) return abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    stream.on('data', (chunk) => {
      hash.update(chunk);
      options.onBytes?.(chunk.length);
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
  return { sha256: hash.digest('hex'), bytes: size };
}
