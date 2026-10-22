import { describe, expect, it } from 'vitest';
import { approveShot, approveTask, createProject, parseHandoff, setTaskState, SAMPLE_HANDOFF, type Project } from '@vcvfx/domain';
import { compareVersions, isNewer } from '../version';
import { prepReportHtml } from '../report';
import { deliveredRange, projectKey, requiredPrep } from '../queue';

const sample = (): Project => {
  const parsed = parseHandoff(JSON.stringify(SAMPLE_HANDOFF));
  if (!parsed.ok) throw new Error('sample');
  return createProject(parsed.handoff, 'sample', 'Tester', new Date('2026-10-19T10:00:00Z'));
};

describe('compareVersions', () => {
  it('compares numerically', () => {
    expect(isNewer('0.10.0', '0.9.3')).toBe(true);
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1);
    expect(compareVersions('v2.0', '1.9.9')).toBe(1);
  });
});

describe('queue display helpers', () => {
  it('shows delivered frames and prep in the spec’s shot-list form', () => {
    const p = sample();
    const shot = p.handoff.shots[0]!;
    expect(deliveredRange(p, shot)).toBe('1001–1128');
    expect(requiredPrep(p, shot, p.shots[0]!)).toBe('DPX + Roto + Key');
    expect(projectKey(null, 'sample')).toBe('handoff:sample');
    expect(projectKey('/a/b.vcvfx', 'sample')).toBe('/a/b.vcvfx');
  });
});

describe('prepReportHtml', () => {
  it('carries metadata, approvals and the log, escaped', () => {
    let p = sample();
    const at = new Date('2026-10-19T11:00:00Z');
    const r1 = setTaskState(p, '010_030', 'track_2d', 'needs_review', 'Tester', at);
    if (!r1.ok) throw new Error(r1.reason);
    const r2 = approveTask(r1.project, '010_030', 'track_2d', '<script>M. Delgado</script>', at);
    if (!r2.ok) throw new Error(r2.reason);
    const r3 = approveShot(r2.project, '010_030', 'M. Delgado', at);
    if (!r3.ok) throw new Error(r3.reason);
    p = r3.project;
    const html = prepReportHtml(p, '010_030', { generatedAt: at, appVersion: '0.1.0', operator: 'Tester' });
    expect(html).toContain('Monitor replacement');
    expect(html).toContain('ARRI ALEXA 35');
    expect(html).toContain('shot.approved');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});

describe('prepReportHtml plates', () => {
  it('names the EXR compression in the files, not one ffmpeg cannot write', () => {
    // The sample asks for PIZ; the plates are ZIP16.
    const html = prepReportHtml(sample(), '010_030', { generatedAt: new Date('2026-10-19T11:00:00Z'), appVersion: '0.1.0', operator: 'Tester' });
    expect(html).toContain('EXR 16-bit (ZIP16; PIZ was asked, which ffmpeg cannot write)');
    expect(html).not.toContain('16-bit (PIZ)');
  });
});
