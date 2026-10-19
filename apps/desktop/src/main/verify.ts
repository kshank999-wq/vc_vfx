import { stat } from 'node:fs/promises';
import type { Project } from '@vcvfx/domain';
import type { VerifyResult } from '../shared/bridge';
import { sha256File } from './hash';
import { isSampleHandoff, resolveFromHandoff } from './paths';

/**
 * Source verification (master spec §15.1): every sha256 checksum the handoff
 * carries is recomputed from the file on the drive. Read only — files are
 * opened for reading and nothing beside them is written. No Electron here, so
 * it is tested against real files.
 *
 * Per shot: any file missing → `missing`; any mismatch → `mismatch`; every
 * sha256 matching → `verified`; no sha256 record to check → `unchecked`
 * (md5 / xxh64 records are reported, not computed).
 */

export interface VerifyProgress {
  shotId: string;
  file: string;
  bytesDone: number;
  bytesTotal: number;
  shotIndex: number;
  shotCount: number;
}

export async function verifyProject(
  project: Project,
  options: { signal?: AbortSignal; onProgress?: (p: VerifyProgress) => void } = {},
): Promise<VerifyResult[]> {
  const { handoffPath } = project;
  const results: VerifyResult[] = [];
  if (isSampleHandoff(handoffPath)) {
    return project.handoff.shots.map((s) => ({ shotId: s.shotId, result: 'missing', detail: 'The sample project has no media on disk' }));
  }

  // Work out the total up front so progress is honest across shots.
  const plans = await Promise.all(
    project.handoff.shots.map(async (shot) => {
      const records = shot.checksums.map((c) => ({ record: c, path: resolveFromHandoff(handoffPath, c.path)! }));
      const sizes = await Promise.all(records.map(async (r) => (await stat(r.path).catch(() => null))?.size ?? 0));
      return { shot, records, sizes };
    }),
  );
  const bytesTotal = plans.reduce((n, p) => n + p.records.reduce((m, r, i) => m + (r.record.algorithm === 'sha256' ? (p.sizes[i] ?? 0) : 0), 0), 0);
  let bytesDone = 0;

  for (const [shotIndex, { shot, records }] of plans.entries()) {
    if (options.signal?.aborted) throw new Error('Cancelled');
    const source = resolveFromHandoff(handoffPath, shot.sourcePath)!;
    const sourceExists = Boolean(await stat(source).catch(() => null));
    const missing: string[] = [];
    const mismatched: string[] = [];
    const matched: string[] = [];
    const skipped: string[] = [];

    if (!sourceExists) missing.push(shot.sourcePath);
    for (const { record, path } of records) {
      if (record.algorithm !== 'sha256') {
        skipped.push(`${record.path} (${record.algorithm})`);
        continue;
      }
      if (!(await stat(path).catch(() => null))) {
        if (!missing.includes(record.path)) missing.push(record.path);
        continue;
      }
      const { sha256 } = await sha256File(path, {
        ...(options.signal ? { signal: options.signal } : {}),
        onBytes: (n) => {
          bytesDone += n;
          options.onProgress?.({ shotId: shot.shotId, file: record.path, bytesDone, bytesTotal, shotIndex, shotCount: plans.length });
        },
      });
      (sha256.toLowerCase() === record.value.trim().toLowerCase() ? matched : mismatched).push(record.path);
    }
    options.onProgress?.({ shotId: shot.shotId, file: '', bytesDone, bytesTotal, shotIndex: shotIndex + 1, shotCount: plans.length });

    const skippedNote = skipped.length ? `; not computed: ${skipped.join(', ')}` : '';
    if (missing.length) results.push({ shotId: shot.shotId, result: 'missing', detail: `Missing: ${missing.join(', ')}${skippedNote}` });
    else if (mismatched.length) results.push({ shotId: shot.shotId, result: 'mismatch', detail: `Checksum mismatch: ${mismatched.join(', ')}${skippedNote}` });
    else if (matched.length) results.push({ shotId: shot.shotId, result: 'verified', detail: `sha256 matched: ${matched.join(', ')}${skippedNote}` });
    else results.push({ shotId: shot.shotId, result: 'unchecked', detail: `No sha256 checksum to verify against${skippedNote}` });
  }
  return results;
}
