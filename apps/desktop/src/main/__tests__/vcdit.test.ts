import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { link, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import xxhash from 'xxhash-wasm';
import { addTask, createProject, parseHandoff, setProbedMedia, shotTiming, type Project } from '@vcvfx/domain';
import { outputRootProblem, resolveFromHandoff } from '../paths';
import { sourceFiles } from '../package-shot';
import { probeProject } from '../probe';
import { generateSequence } from '../sequence';
import { verifyProject } from '../verify';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

/**
 * A destination drive laid out exactly as VCDIT leaves it (vc-dit
 * src/main/vfx/mirror.ts, vfx-service.ts): the card in CAMERA_ORIGINALS, the
 * VFX take folders beside it (hard links, or a reference file), and the
 * handoff JSON in the VFX folder, every path relative to that folder.
 */
async function makeVcditDrive(clip: (path: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'vcvfx-vcdit-'));
  const day = join(root, 'RAID', 'HALCYON', 'SHOOT_DAY_001_2026-10-07');
  const card = join(day, 'CAMERA_ORIGINALS', 'A015');
  const vfx = join(day, 'VFX');
  const files = ['A015R1AB/A015C002_261007_R1AB.mov', 'A015R1AB/A015C002_261007_R1AB.xml', 'A015R1AB/A015C001_261007_R1AB.mov'];
  for (const f of files) {
    await mkdir(dirname(join(card, f)), { recursive: true });
    if (f.endsWith('.mov')) await clip(join(card, f));
    else await writeFile(join(card, f), '<clip/>');
  }
  // 14B take 3: hard-linked into its take folder, sidecar and all.
  const linked = join(vfx, 'SCENE_014', 'SETUP_B', 'T03_A015C002');
  for (const f of files.slice(0, 2)) {
    await mkdir(dirname(join(linked, f)), { recursive: true });
    await link(join(card, f), join(linked, f));
  }
  // 14 take 1, DIT tag: referenced (a drive without hard links).
  const referenced = join(vfx, 'SCENE_014', 'SETUP_NONE', 'T01_A015C001');
  await mkdir(referenced, { recursive: true });
  await writeFile(join(referenced, 'VFX_REFERENCE.json'), JSON.stringify({ schema: 'vcdit.vfx-reference/1', clip: 'A015C001' }));

  const xx = await xxhash();
  const entry = async (f: string) => {
    const bytes = await readFile(join(card, f));
    const state = xx.create64();
    state.update(bytes);
    return { path: f, size: bytes.length, checksum: state.digest().toString(16).padStart(16, '0') };
  };
  const body = {
    schema: 'vcdit.vfx-handoff/1',
    createdAt: '2026-10-07T20:15:00.000Z',
    tool: { name: 'VC DIT', version: 'test' },
    production: { name: 'HALCYON', code: 'HLC', frameRate: '24' },
    day: { number: 1, date: '2026-10-07' },
    shots: [
      {
        scene: '14',
        setup: 'B',
        take: '03',
        clip: 'A015C002',
        note: 'Sky replacement',
        flaggedBy: 'Script sup.',
        mirror: { method: 'Hard link', folder: 'SCENE_014/SETUP_B/T03_A015C002' },
        editorialFolder: '../CAMERA_ORIGINALS/A015',
        checksumMethod: 'xxHash64',
        files: [await entry(files[0]!), await entry(files[1]!)],
      },
      {
        scene: '14',
        setup: '—',
        take: '01',
        clip: 'A015C001',
        note: 'Monitor comp',
        flaggedBy: 'DIT tag',
        mirror: { method: 'Reference', folder: 'SCENE_014/SETUP_NONE/T01_A015C001' },
        editorialFolder: '../CAMERA_ORIGINALS/A015',
        checksumMethod: 'xxHash64',
        files: [await entry(files[2]!)],
      },
    ],
  };
  const handoffPath = join(vfx, 'VC_VFX_PREP_HLC_D001_20261007_201500Z.json');
  await writeFile(handoffPath, `${JSON.stringify(body, null, 2)}\n`);
  const parsed = parseHandoff(await readFile(handoffPath, 'utf8'));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  const project: Project = createProject(parsed.handoff, handoffPath, 'Tester', new Date('2026-10-20T10:00:00Z'));
  return { root, day, card, vfx, linked, handoffPath, project };
}

const bytesClip = (n: number) => async (path: string) => writeFile(path, Buffer.alloc(n, path.length % 251));

describe('a VCDIT drive', () => {
  it('resolves each source relative to the handoff: the hard link, or the editorial copy when referenced', async () => {
    const { project, handoffPath, linked, card } = await makeVcditDrive(bytesClip(4096));
    const [a, b] = project.handoff.shots;
    expect(a!.shotId).toBe('14_B_03');
    expect(resolveFromHandoff(handoffPath, a!.sourcePath)).toBe(join(linked, 'A015R1AB', 'A015C002_261007_R1AB.mov'));
    expect(resolveFromHandoff(handoffPath, a!.sourceFiles![0]!)).toBe(join(linked, 'A015R1AB', 'A015C002_261007_R1AB.xml'));
    expect(resolveFromHandoff(handoffPath, b!.sourcePath)).toBe(join(card, 'A015R1AB', 'A015C001_261007_R1AB.mov'));
    for (const path of sourceFiles(project)) expect((await stat(path)).isFile()).toBe(true);
    // Nothing may be written in the take folders, sidecars included.
    expect(outputRootProblem(join(linked, 'A015R1AB', 'OUT'), sourceFiles(project))).toMatch(/inside a source media folder/);
  });

  it('verifies VCDIT’s xxHash64 checksums, read only, and catches a changed file', async () => {
    const { project, linked, card } = await makeVcditDrive(bytesClip(3 * 1024 * 1024));
    const before = await readdir(join(linked, 'A015R1AB'));
    let results = await verifyProject(project);
    expect(Object.fromEntries(results.map((r) => [r.shotId, r.result]))).toEqual({ '14_B_03': 'verified', '14_01': 'verified' });
    expect(results.find((r) => r.shotId === '14_B_03')!.detail).toMatch(/xxh64/);
    expect(await readdir(join(linked, 'A015R1AB'))).toEqual(before);

    await writeFile(join(card, 'A015R1AB', 'A015C001_261007_R1AB.mov'), Buffer.alloc(3 * 1024 * 1024, 1));
    results = await verifyProject(project);
    expect(results.find((r) => r.shotId === '14_01')!.result).toBe('mismatch');
  });
});

describe.skipIf(!hasFfmpeg)('a VCDIT drive with real clips (ffmpeg, ffprobe)', () => {
  const movie = async (path: string) => {
    const made = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x36:rate=24', '-t', '2', '-pix_fmt', 'yuv420p', '-timecode', '01:00:00:00', path]);
    if (made.status !== 0) throw new Error(made.stderr.toString());
  };

  it('reads each clip’s length, timecode and size with ffprobe', async () => {
    const { project } = await makeVcditDrive(movie);
    const results = await probeProject(project, 'ffprobe');
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.error).toBeUndefined();
      expect(r.media).toMatchObject({ frameCount: 48, timecodeIn: '01:00:00:00', frameRate: 24, resolution: { width: 64, height: 36 } });
    }
    let p = project;
    for (const r of results) {
      const applied = setProbedMedia(p, r.shotId, r.media!, 'Tester', new Date());
      if (!applied.ok) throw new Error(applied.reason);
      p = applied.project;
    }
    expect(shotTiming(p, p.handoff.shots[0]!)).toMatchObject({ frameIn: 0, frameOut: 47, handles: 0, from: 'probe' });
    // Once read, nothing is left to probe.
    expect(await probeProject(p, 'ffprobe')).toEqual([]);
  });

  it('writes plates for the whole take, probing first when the range is unknown, never beside the source', async () => {
    const { project, root, linked } = await makeVcditDrive(movie);
    const withTask = addTask(project, '14_B_03', 'sequence_conversion', 'Tester', new Date());
    if (!withTask.ok) throw new Error(withTask.reason);

    const noProbe = await generateSequence({ project: withTask.project, shotId: '14_B_03', outputRoot: join(root, 'OUT'), ffmpeg: 'ffmpeg', ffprobe: null });
    expect(noProbe).toMatchObject({ ok: false, reason: expect.stringMatching(/no frame range yet.*ffprobe/s) });

    const r = await generateSequence({ project: withTask.project, shotId: '14_B_03', outputRoot: join(root, 'OUT'), ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' });
    if (!r.ok) throw new Error(r.reason);
    expect(r.frames).toBe(48);
    expect(r.probed).toMatchObject({ frameCount: 48 });
    const files = (await readdir(r.folder)).sort();
    expect(files[0]).toBe('14_B_03_plate_v001.1001.exr');
    expect(files.at(-1)).toBe('14_B_03_plate_v001.1048.exr');
    expect(r.folder).toBe(join(root, 'OUT', 'HALCYON_VFX', 'SCENE_14', 'SHOT_14_B_03', '01_PLATES'));
    expect((await readdir(join(linked, 'A015R1AB'))).sort()).toEqual(['A015C002_261007_R1AB.mov', 'A015C002_261007_R1AB.xml']);
  }, 30_000);
});
