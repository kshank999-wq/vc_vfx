import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { defaultProjectPath, isInside, manifestPath, outputRootProblem, resolveFromHandoff, versionedName, withProjectExtension } from '../paths';

const drive = resolve('/Volumes/NIGHTSHIFT_A');
const handoff = join(drive, 'NightShift_handoff.json');

describe('resolveFromHandoff', () => {
  it('resolves media relative to the handoff’s folder, either slash', () => {
    expect(resolveFromHandoff(handoff, 'VFX/SCENE_12A/clip.mxf')).toBe(join(drive, 'VFX', 'SCENE_12A', 'clip.mxf'));
    expect(resolveFromHandoff(handoff, 'VFX\\SCENE_12A\\clip.mxf')).toBe(join(drive, 'VFX', 'SCENE_12A', 'clip.mxf'));
  });
  it('keeps absolute paths and has nothing for the sample', () => {
    const abs = resolve('/elsewhere/clip.mxf');
    expect(resolveFromHandoff(handoff, abs)).toBe(abs);
    expect(resolveFromHandoff('sample', 'VFX/clip.mxf')).toBeNull();
  });
});

describe('project paths', () => {
  it('defaults beside the handoff', () => {
    expect(defaultProjectPath(handoff, '/docs', 'Night Shift')).toBe(join(drive, 'NightShift_handoff.vcvfx'));
    expect(defaultProjectPath('sample', resolve('/docs'), 'Night: Shift')).toBe(join(resolve('/docs'), 'Night_ Shift.vcvfx'));
    expect(withProjectExtension('/a/b')).toBe('/a/b.vcvfx');
    expect(withProjectExtension('/a/b.VCVFX')).toBe('/a/b.VCVFX');
  });
});

describe('output root safety', () => {
  const source = join(drive, 'VFX', 'SCENE_12A', '010_020', 'clip.mxf');
  it('refuses a root inside a source media folder', () => {
    expect(outputRootProblem(join(drive, 'VFX', 'SCENE_12A', '010_020'), [source])).toMatch(/inside a source media folder/);
    expect(outputRootProblem(join(drive, 'VFX', 'SCENE_12A', '010_020', 'out'), [source])).toMatch(/inside/);
    expect(outputRootProblem(join(drive, 'VFX_PREP'), [source])).toBeNull();
    expect(outputRootProblem('relative/dir', [source])).toMatch(/full folder path/);
  });
  it('isInside is not fooled by shared prefixes', () => {
    expect(isInside('/a/bc', '/a/b')).toBe(false);
    expect(isInside('/a/b/c', '/a/b')).toBe(true);
    expect(isInside('/a/b', '/a/b')).toBe(true);
  });
});

describe('names', () => {
  it('versions manifest names and records forward slashes', () => {
    expect(versionedName('manifest', 2, 'json')).toBe('manifest_v002.json');
    expect(manifestPath(join('/x', 'SHOT'), join('/x', 'SHOT', '01_PLATES', 'a.exr'))).toBe('01_PLATES/a.exr');
  });
});
