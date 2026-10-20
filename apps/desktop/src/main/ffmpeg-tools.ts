import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FfmpegCaps } from '../shared/ffmpeg-args';

/**
 * Which ffmpeg and ffprobe VC VFX runs (addendum 03), in this order:
 *
 *  1. the path set in Settings — an explicit choice, so if it does not run
 *     VC VFX says so rather than quietly using another;
 *  2. the copy bundled in the installer (Resources/ffmpeg), or in
 *     development the one scripts/fetch-ffmpeg.mjs put in resources/ffmpeg;
 *  3. ffmpeg on PATH.
 *
 * ffprobe comes from the same place: beside a Settings ffmpeg, the bundled
 * one, or PATH. No Electron here: the caller passes where the app lives.
 */

export interface ToolLocation {
  /** process.resourcesPath, packaged. */
  resourcesPath: string;
  /** app.getAppPath(): apps/desktop in development. */
  appPath: string;
  packaged: boolean;
  platform: NodeJS.Platform;
  arch: string;
}

export type ToolSource = 'settings' | 'bundled' | 'path';

export interface ResolvedTools {
  ffmpeg: string | null;
  ffmpegVersion: string | null;
  ffprobe: string | null;
  source: ToolSource | null;
  caps: FfmpegCaps;
  /** Why ffmpeg was not found, in words for the operator. */
  problem: string | null;
}

const exe = (platform: NodeJS.Platform, name: string) => (platform === 'win32' ? `${name}.exe` : name);

/** Where the bundled binaries are, whether or not they exist. */
export function bundledPaths(loc: ToolLocation): { ffmpeg: string; ffprobe: string } {
  const dir = loc.packaged ? join(loc.resourcesPath, 'ffmpeg') : join(loc.appPath, 'resources', 'ffmpeg', `${loc.platform}-${loc.arch}`);
  return { ffmpeg: join(dir, exe(loc.platform, 'ffmpeg')), ffprobe: join(dir, exe(loc.platform, 'ffprobe')) };
}

/** ffprobe beside a configured ffmpeg: "/opt/ff/ffmpeg" → "/opt/ff/ffprobe", "C:\\ff\\ffmpeg.exe" → "C:\\ff\\ffprobe.exe". */
export function ffprobePathFor(ffmpeg: string): string {
  const configured = ffmpeg.trim();
  if (!configured) return 'ffprobe';
  const cut = Math.max(configured.lastIndexOf('/'), configured.lastIndexOf('\\'));
  const dir = configured.slice(0, cut + 1);
  const name = configured.slice(cut + 1);
  const ext = /\.exe$/i.test(name) ? name.slice(name.length - 4) : '';
  return `${dir}ffprobe${ext}`;
}

/** Run a command and collect stdout; null when it could not start or failed. */
export function runForOutput(command: string, args: string[], timeoutMs = 15000): Promise<string | null> {
  return new Promise((resolvePromise) => {
    try {
      const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.stdout.on('data', (d: Buffer) => {
        if (out.length < 4 * 1024 * 1024) out += d.toString();
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolvePromise(null);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolvePromise(code === 0 ? out : null);
      });
    } catch {
      resolvePromise(null);
    }
  });
}

/** The filters VC VFX's colour pipeline uses, from `ffmpeg -filters`. */
export function parseFilterCaps(listing: string): FfmpegCaps {
  const has = (name: string) => new RegExp(`^\\s*[A-Z.|]{2,4}\\s+${name}\\s`, 'm').test(listing);
  return { zscale: has('zscale'), lut1d: has('lut1d'), colorchannelmixer: has('colorchannelmixer') };
}

const NONE: FfmpegCaps = { zscale: false, lut1d: false, colorchannelmixer: false };

async function probeFfmpeg(command: string): Promise<{ version: string; caps: FfmpegCaps } | null> {
  const version = await runForOutput(command, ['-hide_banner', '-version']);
  if (version === null) return null;
  const filters = await runForOutput(command, ['-hide_banner', '-filters']);
  return { version: (version.split('\n')[0] ?? '').trim(), caps: filters ? parseFilterCaps(filters) : NONE };
}

async function runs(command: string): Promise<boolean> {
  return (await runForOutput(command, ['-hide_banner', '-version'])) !== null;
}

export async function resolveTools(configured: string, loc: ToolLocation): Promise<ResolvedTools> {
  const setting = configured.trim();
  if (setting) {
    const found = await probeFfmpeg(setting);
    if (!found) return { ffmpeg: null, ffmpegVersion: null, ffprobe: null, source: null, caps: NONE, problem: `The ffmpeg set in Settings does not run: ${setting}. Clear it to use the ffmpeg bundled with VC VFX.` };
    const probe = ffprobePathFor(setting);
    return { ffmpeg: setting, ffmpegVersion: found.version, ffprobe: (await runs(probe)) ? probe : null, source: 'settings', caps: found.caps, problem: null };
  }
  const bundled = bundledPaths(loc);
  if (existsSync(bundled.ffmpeg)) {
    const found = await probeFfmpeg(bundled.ffmpeg);
    if (found) {
      return { ffmpeg: bundled.ffmpeg, ffmpegVersion: found.version, ffprobe: existsSync(bundled.ffprobe) && (await runs(bundled.ffprobe)) ? bundled.ffprobe : null, source: 'bundled', caps: found.caps, problem: null };
    }
  }
  const onPath = await probeFfmpeg('ffmpeg');
  if (onPath) return { ffmpeg: 'ffmpeg', ffmpegVersion: onPath.version, ffprobe: (await runs('ffprobe')) ? 'ffprobe' : null, source: 'path', caps: onPath.caps, problem: null };
  return {
    ffmpeg: null,
    ffmpegVersion: null,
    ffprobe: null,
    source: null,
    caps: NONE,
    problem: loc.packaged
      ? 'The ffmpeg bundled with VC VFX did not run, and none was found on PATH. Reinstall VC VFX, or set an ffmpeg in Settings.'
      : 'No ffmpeg: run `pnpm --filter @vcvfx/desktop fetch:ffmpeg` (or install one on PATH), or set its path in Settings.',
  };
}

/** Resolution is a handful of process spawns; it is cached per Settings value until Settings change. */
export function cachedResolver(loc: () => ToolLocation) {
  let cache: { key: string; value: Promise<ResolvedTools> } | null = null;
  return {
    get(configured: string): Promise<ResolvedTools> {
      if (!cache || cache.key !== configured) cache = { key: configured, value: resolveTools(configured, loc()) };
      return cache.value;
    },
    reset(): void {
      cache = null;
    },
  };
}
