import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PACKAGE_FOLDERS, approveShot, approveTask, setTaskState, type Project } from '@vcvfx/domain';
import { packageShot } from '../package-shot';
import { makeDrive } from './fixtures';

const approved = (p: Project, shotId: string): Project => {
  const now = new Date('2026-10-19T11:00:00Z');
  let r = setTaskState(p, shotId, 'sequence_conversion', 'needs_review', 'Tester', now);
  if (r.ok) r = approveTask(r.project, shotId, 'sequence_conversion', 'Sup', now);
  if (r.ok) r = approveShot(r.project, shotId, 'Sup', now);
  if (!r.ok) throw new Error(r.reason);
  return r.project;
};

describe('packageShot', () => {
  it('refuses an unapproved shot and writes nothing', async () => {
    const { project, root } = await makeDrive([{ shotId: 'A', sourcePath: 'VFX/A/a.mov', bytes: Buffer.from('a') }]);
    const r = await packageShot({ project, shotId: 'A', outputRoot: join(root, 'OUT'), operator: 'T', appVersion: '0.1.0', now: new Date() });
    expect(r).toEqual({ ok: false, reason: 'A must be prep approved before it is packaged' });
    await expect(readdir(join(root, 'OUT'))).rejects.toThrow();
  });

  it('refuses an output root inside source media', async () => {
    const { project, drive } = await makeDrive([{ shotId: 'A', sourcePath: 'VFX/A/a.mov', bytes: Buffer.from('a') }]);
    const r = await packageShot({ project: approved(project, 'A'), shotId: 'A', outputRoot: join(drive, 'VFX', 'A'), operator: 'T', appVersion: '0.1.0', now: new Date() });
    expect(r.ok).toBe(false);
  });

  it('writes the §17 folders, a versioned manifest and report, and keeps every version', async () => {
    const { project, root } = await makeDrive([{ shotId: 'A', sourcePath: 'VFX/A/a.mov', bytes: Buffer.from('a') }]);
    const out = join(root, 'OUT');
    const first = await packageShot({ project: approved(project, 'A'), shotId: 'A', outputRoot: out, operator: 'T', appVersion: '0.1.0', now: new Date('2026-10-19T12:00:00Z') });
    if (!first.ok) throw new Error(first.reason);
    expect(first.version).toBe(1);
    expect(first.folder).toBe(join(out, 'NIGHT_SHIFT_VFX', 'SCENE_12A', 'SHOT_A'));
    const names = await readdir(first.folder);
    for (const f of PACKAGE_FOLDERS) expect(names).toContain(f);
    expect(names).toEqual(expect.arrayContaining(['manifest.json', 'manifest_v001.json', 'prep_report.html', 'prep_report_v001.html']));
    const manifest = JSON.parse(await readFile(join(first.folder, 'manifest.json'), 'utf8'));
    expect(manifest.packageVersion).toBe('v001');
    expect(manifest.status).toBe('packaged');
    expect(manifest.checksums.delivered.map((d: { path: string }) => d.path)).toEqual(['prep_report_v001.html']);
    expect(manifest.checksums.delivered[0].value).toMatch(/^[0-9a-f]{64}$/);

    // Reopen → package again: v002 alongside v001; manifest.json is the latest.
    const { reopenShot } = await import('@vcvfx/domain');
    const reopened = reopenShot(first.project, 'A', 'T', new Date());
    if (!reopened.ok) throw new Error(reopened.reason);
    const second = await packageShot({ project: reopened.project, shotId: 'A', outputRoot: out, operator: 'T', appVersion: '0.1.0', now: new Date('2026-10-19T13:00:00Z') });
    if (!second.ok) throw new Error(second.reason);
    expect(second.version).toBe(2);
    const v1 = JSON.parse(await readFile(join(first.folder, 'manifest_v001.json'), 'utf8'));
    const latest = JSON.parse(await readFile(join(first.folder, 'manifest.json'), 'utf8'));
    expect(v1.packageVersion).toBe('v001');
    expect(latest.packageVersion).toBe('v002');
    expect(latest.checksums.delivered.map((d: { path: string }) => d.path)).toEqual(['prep_report_v001.html', 'prep_report_v002.html']);

    // Writing v002 again (an old project file) is refused, never overwritten.
    const again = await packageShot({ project: reopened.project, shotId: 'A', outputRoot: out, operator: 'T', appVersion: '0.1.0', now: new Date() });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toMatch(/never replaced/);
  });
});
