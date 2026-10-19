import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createProject, parseHandoff, type Project } from '@vcvfx/domain';

/** A handoff on a temporary "drive", with real files for its sources. */
export async function makeDrive(shots: { shotId: string; sourcePath: string; bytes?: Buffer; checksum?: 'right' | 'wrong' | 'md5' | 'none'; extra?: Record<string, unknown> }[]) {
  const root = await mkdtemp(join(tmpdir(), 'vcvfx-test-'));
  const drive = join(root, 'DRIVE');
  const handoffPath = join(drive, 'handoff.json');
  await mkdir(drive, { recursive: true });
  const handoffShots = [];
  for (const s of shots) {
    const checksums = [];
    if (s.bytes) {
      await mkdir(dirname(join(drive, s.sourcePath)), { recursive: true });
      await writeFile(join(drive, s.sourcePath), s.bytes);
    }
    const sha = createHash('sha256').update(s.bytes ?? Buffer.from('absent')).digest('hex');
    if (s.checksum === 'right') checksums.push({ path: s.sourcePath, algorithm: 'sha256', value: sha });
    if (s.checksum === 'wrong') checksums.push({ path: s.sourcePath, algorithm: 'sha256', value: '0'.repeat(64) });
    if (s.checksum === 'md5') checksums.push({ path: s.sourcePath, algorithm: 'md5', value: 'abc' });
    handoffShots.push({
      shotId: s.shotId,
      scene: '12A',
      sourcePath: s.sourcePath,
      frameIn: 10,
      frameOut: 19,
      handles: 2,
      frameRate: 24,
      tasks: [{ kind: 'sequence_conversion' }],
      checksums,
      ...s.extra,
    });
  }
  const text = JSON.stringify({ project: 'Night Shift', output: { format: 'png', bitDepth: 8, startFrame: 1001 }, shots: handoffShots });
  await writeFile(handoffPath, text);
  const parsed = parseHandoff(text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  const project: Project = createProject(parsed.handoff, handoffPath, 'Tester', new Date('2026-10-19T10:00:00Z'));
  return { root, drive, handoffPath, project };
}
