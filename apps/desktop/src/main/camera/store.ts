import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CameraStore } from '../../shared/camera/commands';
import { writeAtomic } from '../atomic';

/**
 * The track cache (addendum 06 §2): the large data of camera tracking —
 * feature tracks, solves, downsampled point clouds — one file per id, in
 * `userData/Track Cache/<project>/<shot>/<id>.vcvx`. Ids are never reused
 * (each change writes a new file), so the project's references always point
 * at exactly the data they were made with. Never beside the media, never in
 * the package: exports are written separately.
 */

const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80) || '_';
const ID = /^[a-z]+-\d{4,}$/;

export class FileStore implements CameraStore {
  readonly root: string;

  constructor(cacheRoot: string, projectKey: string, shotId: string) {
    this.root = join(cacheRoot, createHash('sha256').update(projectKey).digest('hex').slice(0, 16), safe(shotId));
  }

  /** The same store, by its folder (how a worker thread is handed it). */
  static at(root: string): FileStore {
    const store = Object.create(FileStore.prototype) as FileStore;
    (store as { root: string }).root = root;
    return store;
  }

  file(id: string): string {
    if (!ID.test(id)) throw new Error(`Not a track cache id: ${id}`);
    return join(this.root, `${id}.vcvx`);
  }

  async get(id: string): Promise<Uint8Array | null> {
    const buf = await readFile(this.file(id)).catch(() => null);
    return buf ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : null;
  }

  async put(id: string, bytes: Uint8Array): Promise<void> {
    await writeAtomic(this.file(id), bytes);
  }
}
