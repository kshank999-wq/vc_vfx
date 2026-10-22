import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, stat, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import {
  FORMAT_EXTENSIONS,
  TRANSFERS,
  VIEW_LINEAR_MAX,
  cube1D,
  handoffShot,
  plateColorFor,
  shotState,
  shotTiming,
  versionTag,
  viewDisplayCurve,
  viewTransform,
  type ColorEncodingId,
  type Project,
  type SequenceFormat,
  type TransferId,
  type ViewPipeline,
} from '@vcvfx/domain';
import { buildFrameArgs, FULL_CAPS, type FfmpegCaps, type SourceInput } from '../shared/ffmpeg-args';
import type { ViewerFrame, ViewerFrameRequest, ViewerSources } from '../shared/bridge';
import { viewerTimeline } from '../shared/viewer';
import { FrameCache, frameKey, frameUrl } from './frame-cache';
import { cameraRawProblem } from './image-sequence';
import { shotFolder } from './package-shot';
import { isSampleHandoff, resolveFromHandoff } from './paths';
import { hintsFrom, sourceInputFor } from './sequence';

/**
 * The frame viewer's main-process half (master spec §5.2, §15.4; addendum 03).
 *
 * Frames are extracted by ffmpeg, through a view transform that exists only
 * for looking (decode → Rec.709 primaries → filmic tone curve → display
 * gamma; or raw), scaled for the screen, written as JPEG into the frame
 * cache and handed to the renderer as a `vcvfx-frame://` URL. Nothing here
 * writes beside the media or touches a plate. No Electron here.
 */

const VIEW_LUT_VERSION = 1;

export interface ViewerContext {
  cache: FrameCache;
  ffmpeg: string;
  caps: FfmpegCaps;
}

const PLATE_EXTENSIONS = Object.entries(FORMAT_EXTENSIONS) as [SequenceFormat, string][];

/** Plate versions in a 01_PLATES folder for a shot name: `<name>_plate_v001.1001.exr`. */
export function platesInFolder(names: readonly string[], shotName: string): { version: number; format: SequenceFormat; first: number; last: number; count: number }[] {
  const found = new Map<number, { format: SequenceFormat; frames: number[] }>();
  const head = `${shotName}_plate_v`;
  for (const n of names) {
    if (!n.startsWith(head)) continue;
    const m = /^(\d{3,})\.(\d+)\.([A-Za-z]+)$/.exec(n.slice(head.length));
    if (!m) continue;
    const format = PLATE_EXTENSIONS.find(([, ext]) => ext === m[3]!.toLowerCase())?.[0];
    if (!format) continue;
    const version = Number(m[1]);
    const entry = found.get(version) ?? { format, frames: [] };
    entry.frames.push(Number(m[2]));
    found.set(version, entry);
  }
  return [...found.entries()]
    .map(([version, e]) => ({ version, format: e.format, first: Math.min(...e.frames), last: Math.max(...e.frames), count: e.frames.length }))
    .sort((a, b) => a.version - b.version);
}

export async function viewerSources(project: Project, shotId: string, outputRoot: string | null): Promise<ViewerSources> {
  const shot = handoffShot(project, shotId);
  const state = shotState(project, shotId);
  if (!shot || !state) throw new Error(`No shot ${shotId}`);
  const decision = plateColorFor(project, shotId);
  let reason: string | null = null;
  if (isSampleHandoff(project.handoffPath)) reason = 'The sample project has no media on disk.';
  else {
    const abs = resolveFromHandoff(project.handoffPath, shot.sourcePath)!;
    reason = cameraRawProblem(abs) ?? (existsSync(abs) ? null : `The source is not on the drive: ${shot.sourcePath}`);
    if (!reason && !viewerTimeline(project, shotId)) reason = 'The frame range is unknown. Read it from the clip first (Sequence plan › Read from clip).';
  }
  const plates: ViewerSources['plates'] = [];
  if (outputRoot && !isSampleHandoff(project.handoffPath)) {
    const dir = join(shotFolder(project, shotId, outputRoot), '01_PLATES');
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const p of platesInFolder(names, state.vfxShotId ?? shot.shotId)) {
      const record = state.plates.find((r) => r.version === p.version);
      plates.push({ ...p, encoding: record ? record.color.plateEncoding : decision.plateEncoding });
    }
  }
  return { source: { available: reason === null, reason, encoding: decision.sourceEncoding }, plates };
}

/** The view's LUT files, written once into the cache's own `luts` folder. */
export async function viewLuts(cacheDir: string, view: ViewPipeline): Promise<{ dir: string; decode?: string; tone?: string }> {
  const dir = join(cacheDir, 'luts');
  await mkdir(dir, { recursive: true });
  const ensure = async (name: string, make: () => string) => {
    const path = join(dir, name);
    if (!existsSync(path)) {
      const tmp = `${path}.${process.pid}.part`;
      await writeFile(tmp, make());
      await rename(tmp, path);
    }
    return name;
  };
  const out: { dir: string; decode?: string; tone?: string } = { dir };
  if (view.decode) {
    const t: TransferId = view.decode;
    out.decode = await ensure(`v${VIEW_LUT_VERSION}_decode_${t}.cube`, () => cube1D(TRANSFERS[t].toLinear, { size: 4096, title: `${TRANSFERS[t].label} to linear (viewing)` }));
  }
  if (view.tone) {
    out.tone = await ensure(`v${VIEW_LUT_VERSION}_tone_rec709.cube`, () => cube1D(viewDisplayCurve, { size: 65536, domainMin: 0, domainMax: VIEW_LINEAR_MAX, title: 'Filmic tone + 2.4 display (viewing only)' }));
  }
  return out;
}

function runFfmpeg(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error(`ffmpeg could not read that frame: ${err.trim().split('\n').pop() ?? `exit ${code}`}`));
    });
  });
}

/** One viewer frame: from the cache, or extracted now. */
export async function viewerFrame(project: Project, req: ViewerFrameRequest, outputRoot: string | null, ctx: ViewerContext): Promise<ViewerFrame> {
  const shot = handoffShot(project, req.shotId);
  const state = shotState(project, req.shotId);
  if (!shot || !state) throw new Error(`No shot ${req.shotId}`);
  if (isSampleHandoff(project.handoffPath)) throw new Error('The sample project has no media on disk.');
  const timeline = viewerTimeline(project, req.shotId);
  if (!timeline) throw new Error('The frame range is unknown. Read it from the clip first.');
  const frame = Math.min(timeline.last, Math.max(timeline.first, Math.round(req.frame)));
  const decision = plateColorFor(project, req.shotId);

  let source: SourceInput;
  let frameArg: number;
  let file: string;
  let encoding: ColorEncodingId | null;
  let hints = hintsFrom(state.probe);
  if (req.layer === 'source') {
    const abs = resolveFromHandoff(project.handoffPath, shot.sourcePath)!;
    const resolved = await sourceInputFor(abs, timeline.frameRate, shotTiming(project, shot));
    if (!resolved.ok) throw new Error(resolved.reason);
    source = resolved.source;
    const index = (viewerTimeline(project, req.shotId, resolved.clipStart) ?? timeline).clipIndex(frame);
    frameArg = source.kind === 'sequence' ? source.startNumber + index : index;
    file = source.kind === 'sequence' ? source.pattern.replace(/%0(\d+)d/, (_m, n: string) => String(frameArg).padStart(Number(n), '0')) : abs;
    encoding = decision.sourceEncoding;
  } else {
    if (!outputRoot) throw new Error('No output root is chosen for this project, so there are no plates to show.');
    const version = req.version ?? state.tasks.find((t) => t.kind === 'sequence_conversion')?.version ?? 1;
    const dir = join(shotFolder(project, req.shotId, outputRoot), '01_PLATES');
    const name = state.vfxShotId ?? shot.shotId;
    const found = platesInFolder(await readdir(dir).catch(() => [] as string[]), name).find((p) => p.version === version);
    if (!found) throw new Error(`No ${versionTag(version)} plates in ${dir}`);
    const pattern = join(dir, `${name}_plate_${versionTag(version)}.%04d.${FORMAT_EXTENSIONS[found.format]}`);
    source = { kind: 'sequence', pattern, startNumber: found.first, frameRate: timeline.frameRate };
    frameArg = Math.min(found.last, Math.max(found.first, frame));
    file = pattern.replace('%04d', String(frameArg).padStart(4, '0'));
    const record = state.plates.find((r) => r.version === version);
    encoding = record ? record.color.plateEncoding : decision.plateEncoding;
    hints = { yuv: false };
  }

  const view = viewTransform(encoding, req.view);
  const info = await stat(file).catch(() => null);
  if (!info) throw new Error(`Not on disk: ${file}`);
  const maxWidth = Math.max(64, Math.min(4096, Math.round(req.maxWidth)));
  const hash = frameKey({ v: VIEW_LUT_VERSION, file, size: info.size, mtime: info.mtimeMs, frame: frameArg, view: [view.label, view.decode, view.matrix, view.tone], maxWidth, hints });
  await ctx.cache.get(
    hash,
    async (tmp) => {
      const luts = await viewLuts(ctx.cache.dir, view);
      const args = buildFrameArgs({
        source,
        frame: frameArg,
        frameRate: timeline.frameRate,
        view,
        luts: { ...(luts.decode ? { decode: luts.decode } : {}), ...(luts.tone ? { tone: luts.tone } : {}) },
        hints,
        caps: ctx.caps ?? FULL_CAPS,
        maxWidth,
        output: tmp,
      });
      await runFfmpeg(ctx.ffmpeg, args, luts.dir);
    },
    { prefetch: Boolean(req.prefetch) },
  );
  return { url: frameUrl(hash), frame, viewLabel: view.label };
}
