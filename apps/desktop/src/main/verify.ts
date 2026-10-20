import { stat } from 'node:fs/promises';
import type { ChecksumRecord, Project } from '@vcvfx/domain';
import type { VerifyResult } from '../shared/bridge';
import { hashFile, isComputed, type ComputedAlgorithm } from './hash';
import { isSampleHandoff, resolveFromHandoff } from './paths';

/**
 * Source verification (master spec §15.1): every checksum the handoff
 * carries is recomputed from the file on the drive — sha256 (VC VFX's own),
 * and xxh64, MD5 and SHA-1 (what VCDIT ingests with). Read only: files are
 * opened for reading and nothing beside them is written. No Electron here, so
 * it is tested against real files.
 *
 * Per shot: any file missing → `missing`; any mismatch → `mismatch`; every
 * computable checksum matching → `verified`; nothing computable to check →
 * `unchecked` (xxh128 / xxh3 records are reported, not computed).
 */

export interface VerifyProgress {
  shotId: string;
  file: string;
  bytesDone: number;
  bytesTotal: number;
  shotIndex: number;
  shotCount: number;
}

interface FilePlan {
  path: string;
  absolute: string;
  size: number;
  /** Computable records for this file, grouped so it is read once. */
  records: (ChecksumRecord & { algorithm: ComputedAlgorithm })[];
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
      const skipped = shot.checksums.filter((c) => !isComputed(c.algorithm)).map((c) => `${c.path} (${c.algorithm})`);
      const byPath = new Map<string, FilePlan>();
      for (const record of shot.checksums) {
        if (!isComputed(record.algorithm)) continue;
        const plan = byPath.get(record.path) ?? { path: record.path, absolute: resolveFromHandoff(handoffPath, record.path)!, size: 0, records: [] };
        plan.records.push(record as FilePlan['records'][number]);
        byPath.set(record.path, plan);
      }
      const files = [...byPath.values()];
      await Promise.all(files.map(async (f) => (f.size = (await stat(f.absolute).catch(() => null))?.size ?? 0)));
      return { shot, files, skipped };
    }),
  );
  const bytesTotal = plans.reduce((n, p) => n + p.files.reduce((m, f) => m + f.size, 0), 0);
  let bytesDone = 0;

  for (const [shotIndex, { shot, files, skipped }] of plans.entries()) {
    if (options.signal?.aborted) throw new Error('Cancelled');
    const source = resolveFromHandoff(handoffPath, shot.sourcePath)!;
    const sourceExists = Boolean(await stat(source).catch(() => null));
    const missing: string[] = [];
    const mismatched: string[] = [];
    const matched: string[] = [];

    if (!sourceExists) missing.push(shot.sourcePath);
    for (const file of files) {
      if (!(await stat(file.absolute).catch(() => null))) {
        if (!missing.includes(file.path)) missing.push(file.path);
        continue;
      }
      const sizeWrong = file.records.some((r) => r.bytes !== undefined && r.bytes !== file.size);
      const { digests } = await hashFile(
        file.absolute,
        file.records.map((r) => r.algorithm),
        {
          ...(options.signal ? { signal: options.signal } : {}),
          onBytes: (n) => {
            bytesDone += n;
            options.onProgress?.({ shotId: shot.shotId, file: file.path, bytesDone, bytesTotal, shotIndex, shotCount: plans.length });
          },
        },
      );
      const allMatch = !sizeWrong && file.records.every((r) => digests[r.algorithm] === r.value.trim().toLowerCase());
      (allMatch ? matched : mismatched).push(`${file.path} (${[...new Set(file.records.map((r) => r.algorithm))].join(', ')})`);
    }
    options.onProgress?.({ shotId: shot.shotId, file: '', bytesDone, bytesTotal, shotIndex: shotIndex + 1, shotCount: plans.length });

    const skippedNote = skipped.length ? `; not computed: ${skipped.join(', ')}` : '';
    if (missing.length) results.push({ shotId: shot.shotId, result: 'missing', detail: `Missing: ${missing.join(', ')}${skippedNote}` });
    else if (mismatched.length) results.push({ shotId: shot.shotId, result: 'mismatch', detail: `Checksum mismatch: ${mismatched.join(', ')}${skippedNote}` });
    else if (matched.length) results.push({ shotId: shot.shotId, result: 'verified', detail: `Matched: ${matched.join(', ')}${skippedNote}` });
    else results.push({ shotId: shot.shotId, result: 'unchecked', detail: `No checksum to verify against${skippedNote}` });
  }
  return results;
}
