import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledPaths, parseFilterCaps, resolveTools, type ToolLocation } from '../ffmpeg-tools';

const loc = (over: Partial<ToolLocation> = {}): ToolLocation => ({ resourcesPath: '/Applications/VC VFX.app/Contents/Resources', appPath: '/repo/apps/desktop', packaged: true, platform: 'darwin', arch: 'arm64', ...over });

describe('bundledPaths', () => {
  it('looks in Resources/ffmpeg when packaged and resources/ffmpeg/<platform>-<arch> in development', () => {
    const resources = '/Applications/VC VFX.app/Contents/Resources';
    expect(bundledPaths(loc())).toEqual({ ffmpeg: join(resources, 'ffmpeg', 'ffmpeg'), ffprobe: join(resources, 'ffmpeg', 'ffprobe') });
    expect(bundledPaths(loc({ packaged: false, platform: 'win32', arch: 'x64' })).ffmpeg).toBe(join('/repo/apps/desktop', 'resources', 'ffmpeg', 'win32-x64', 'ffmpeg.exe'));
  });
});

describe('parseFilterCaps', () => {
  it('reads the filters the colour pipeline needs', () => {
    const listing = ' TSC colorchannelmixer V->V       Adjust colors by mixing color channels.\n TSC lut1d             V->V       Adjust colors using a 1D LUT.\n .SC zscale            V->V       Apply resizing.\n';
    expect(parseFilterCaps(listing)).toEqual({ zscale: true, lut1d: true, colorchannelmixer: true });
    expect(parseFilterCaps(' TSC lut3d  V->V  x\n')).toEqual({ zscale: false, lut1d: false, colorchannelmixer: false });
  });
});

describe('resolveTools', () => {
  it('reports a Settings path that does not run, instead of quietly using another', async () => {
    const r = await resolveTools('/definitely/not/ffmpeg', loc());
    expect(r.ffmpeg).toBeNull();
    expect(r.problem).toMatch(/Settings does not run/);
  });

  it.skipIf(spawnSync('ffmpeg', ['-version']).status !== 0)('falls back to PATH when nothing is bundled', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'vcvfx-nobundle-'));
    const r = await resolveTools('', loc({ packaged: false, appPath: empty, platform: process.platform, arch: process.arch }));
    expect(r).toMatchObject({ ffmpeg: 'ffmpeg', source: 'path', caps: { lut1d: true, colorchannelmixer: true } });
    expect(r.ffmpegVersion).toMatch(/^ffmpeg version/);
  });

  it('prefers the bundled copy over PATH', async () => {
    const r = await resolveTools('', loc({ packaged: false, appPath: join(__dirname, '../../..'), platform: process.platform, arch: process.arch }));
    if (r.source !== 'bundled') return; // not fetched on this machine
    expect(r.ffmpeg).toMatch(/resources[\\/]ffmpeg/);
    expect(r.ffprobe).toMatch(/ffprobe/);
    expect(r.caps).toEqual({ zscale: true, lut1d: true, colorchannelmixer: true });
  });
});
