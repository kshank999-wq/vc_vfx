import { describe, expect, it } from 'vitest';
import {
  CAMERA_DB,
  PROJECT_VERSION,
  SAMPLE_HANDOFF,
  SolveRecordSchema,
  createProject,
  effectiveFilmBack,
  handoffPixelAspect,
  modePixelAspect,
  parseHandoff,
  parsePixelAspect,
  parseProject,
  pixelAspectLabel,
  pixelAspectOf,
  resolvePixelAspect,
  serializeProject,
  setProbedMedia,
  setShotPixelAspect,
  shotPixelAspect,
  shotState,
  markPackaged,
  type Project,
} from '../index.js';

const now = new Date('2026-10-22T10:00:00Z');
const SHOT = '010_020';

function projectWith(edit: (shot: Record<string, unknown>) => void = () => {}): Project {
  const raw = JSON.parse(JSON.stringify(SAMPLE_HANDOFF)) as { shots: Record<string, unknown>[] };
  edit(raw.shots[0]!);
  const h = parseHandoff(JSON.stringify(raw));
  if (!h.ok) throw new Error(JSON.stringify(h.issues));
  return createProject(h.handoff, '/drive/handoff.json', 'Test', now);
}

const ok = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => {
  if (!r.ok) throw new Error((r as unknown as { reason: string }).reason);
  return r as Extract<T, { ok: true }>;
};

describe('pixel aspect values', () => {
  it('reads numbers and ratios, refuses nonsense and 0:1', () => {
    expect(parsePixelAspect('3:2')).toBe(1.5);
    expect(parsePixelAspect('4/3')).toBeCloseTo(1.3333, 4);
    expect(parsePixelAspect(' 2 ')).toBe(2);
    expect(parsePixelAspect('2×')).toBe(2);
    expect(parsePixelAspect(1.8)).toBe(1.8);
    expect(parsePixelAspect('0:1')).toBeNull();
    expect(parsePixelAspect('wide')).toBeNull();
    expect(parsePixelAspect(9)).toBeNull();
  });

  it('labels the common formats', () => {
    expect(pixelAspectLabel(1)).toBe('1 (square)');
    expect(pixelAspectLabel(1.5)).toMatch(/DVCPRO HD 1080/);
    expect(pixelAspectLabel(40 / 33)).toMatch(/NTSC DV 16:9/);
    expect(pixelAspectLabel(1.17)).toBe('1.17');
  });

  it('gives a camera mode its raster’s pixel aspect, not the lens squeeze', () => {
    const mini = CAMERA_DB.find((c) => c.modes.some((m) => m.id === '6x5-prores-4k-cine-anamorphic'))!;
    const desqueezed = mini.modes.find((m) => m.id === '6x5-prores-4k-cine-anamorphic')!;
    expect(desqueezed.anamorphicSqueeze).toBe(2);
    expect(modePixelAspect(desqueezed)).toBe(1); // recorded desqueezed to 4096 × 1716
    const raw = mini.modes.find((m) => m.id === '6x5-arriraw-2.6k')!;
    expect(modePixelAspect(raw)).toBe(2);
    expect(modePixelAspect(mini.modes.find((m) => m.anamorphicSqueeze === 1)!)).toBe(1);
  });

  it('reads the handoff: explicit pixel aspect, lens squeeze, or a squeeze already undone in camera', () => {
    expect(handoffPixelAspect({ camera: { pixelAspect: '3:2' } as never })).toMatchObject({ value: 1.5 });
    expect(handoffPixelAspect({ pixelAspect: 1.5 })).toMatchObject({ value: 1.5 });
    expect(handoffPixelAspect({ camera: { anamorphicSqueeze: 2 } as never })).toMatchObject({ value: 2 });
    // 2× lens on a 6:5 back, recorded at 4096 × 1716 (desqueezed): square pixels.
    expect(handoffPixelAspect({ camera: { anamorphicSqueeze: 2, filmBackMm: { width: 21.12, height: 17.7 } } as never, resolution: { width: 4096, height: 1716 } })).toMatchObject({ value: 1 });
    expect(handoffPixelAspect({ camera: { lensSqueeze: 1.8, filmBackMm: { width: 21.12, height: 17.7 } } as never, resolution: { width: 2560, height: 2146 } })).toMatchObject({ value: 1.8 });
    expect(handoffPixelAspect({ camera: {} as never })).toBeNull();
  });
});

describe('resolving a shot’s pixel aspect', () => {
  it('follows the priority: override > handoff > camera > clip > square', () => {
    const o = { value: 1.25, note: 'lens chart', by: 'Ana', at: now.toISOString() };
    const h = { value: 2, detail: 'handoff' };
    const c = { value: 1.8, detail: 'db' };
    const f = { value: 1.5, detail: 'pasp' };
    expect(resolvePixelAspect({ override: o, handoff: h, camera: c, clip: f })).toMatchObject({ value: 1.25, source: 'override' });
    expect(resolvePixelAspect({ handoff: h, camera: c, clip: f })).toMatchObject({ value: 2, source: 'handoff' });
    expect(resolvePixelAspect({ camera: c, clip: f })).toMatchObject({ value: 1.8, source: 'camera' });
    expect(resolvePixelAspect({ clip: f })).toMatchObject({ value: 1.5, source: 'clip' });
    const none = resolvePixelAspect({});
    expect(none).toMatchObject({ value: 1, source: 'default', anamorphic: false, warnings: [] });
  });

  it('warns when sources disagree instead of picking silently', () => {
    const d = resolvePixelAspect({ handoff: { value: 2, detail: '2× lens squeeze' }, clip: { value: 1, detail: 'plate.mov says 1' } });
    expect(d.value).toBe(2);
    expect(d.warnings).toHaveLength(1);
    expect(d.warnings[0]).toMatch(/clip says 1 \(square\).*handoff’s 2 is used/);
    // Agreement within tolerance is no warning.
    expect(resolvePixelAspect({ handoff: { value: 4 / 3, detail: '' }, clip: { value: 1.3333, detail: '' } }).warnings).toEqual([]);
  });

  it('hints at a raster that is almost never square, without applying it', () => {
    const d = resolvePixelAspect({ resolution: { width: 1280, height: 1080 } });
    expect(d.value).toBe(1);
    expect(d.hint).toMatchObject({ value: 1.5 });
    expect(d.warnings[0]).toMatch(/1280 × 1080 is usually DVCPRO HD 1080/);
    expect(resolvePixelAspect({ clip: { value: 1.5, detail: '' }, resolution: { width: 1280, height: 1080 } }).hint).toBeNull();
  });

  it('reads a project shot: handoff, then the probe, with the override on top and logged', () => {
    let p = projectWith((s) => {
      s['camera'] = { body: 'Panasonic AJ-HDX900', pixelAspect: 1.5 };
      s['resolution'] = { width: 1280, height: 1080 };
    });
    expect(shotPixelAspect(p, SHOT)).toMatchObject({ value: 1.5, source: 'handoff', warnings: [] });
    p = ok(setProbedMedia(p, SHOT, { file: 'a.mov', frameCount: 100, sampleAspect: 1 }, 'Test', now)).project;
    const d = shotPixelAspect(p, SHOT);
    expect(d).toMatchObject({ value: 1.5, source: 'handoff' });
    expect(d.warnings.join(' ')).toMatch(/clip says 1/);
    p = ok(setShotPixelAspect(p, SHOT, { value: 4 / 3, note: 'measured on the chart' }, 'Ana', now)).project;
    expect(pixelAspectOf(p, SHOT)).toBeCloseTo(4 / 3, 6);
    expect(shotPixelAspect(p, SHOT).source).toBe('override');
    expect(p.log.at(-1)).toMatchObject({ action: 'shot.pixel_aspect', actor: 'Ana', shotId: SHOT });
    expect(p.log.at(-1)!.detail).toMatch(/1\.5 .* → 1\.333/);
    // Unchanged: no new log entry.
    const again = ok(setShotPixelAspect(p, SHOT, { value: 4 / 3, note: 'measured on the chart' }, 'Ana', now)).project;
    expect(again).toBe(p);
    p = ok(setShotPixelAspect(p, SHOT, { value: null }, 'Ana', now)).project;
    expect(shotPixelAspect(p, SHOT).source).toBe('handoff');
    expect(setShotPixelAspect(p, SHOT, { value: 7 }, 'Ana', now).ok).toBe(false);
  });

  it('reads the clip’s sample aspect when the handoff says nothing', () => {
    let p = projectWith();
    expect(shotPixelAspect(p, SHOT)).toMatchObject({ value: 1, source: 'default' });
    p = ok(setProbedMedia(p, SHOT, { file: 'a.mov', frameCount: 100, sampleAspect: 2 }, 'Test', now)).project;
    expect(shotPixelAspect(p, SHOT)).toMatchObject({ value: 2, source: 'clip' });
    expect(p.log.at(-1)!.detail).toMatch(/pixel aspect 2/);
  });

  it('takes an anamorphic camera mode from the handoff camera text', () => {
    const p = projectWith((s) => {
      s['camera'] = { body: 'ARRI ALEXA Mini', sensorMode: '6:5 ARRIRAW 2.6K' };
      s['resolution'] = { width: 2578, height: 2160 };
    });
    expect(shotPixelAspect(p, SHOT)).toMatchObject({ value: 2, source: 'camera' });
  });

  it('refuses a change once the shot has left prep', () => {
    let p = projectWith();
    p = { ...p, shots: p.shots.map((s) => (s.shotId === SHOT ? { ...s, approval: { by: 'Ana', at: now.toISOString() } } : s)) };
    p = ok(markPackaged(p, SHOT, 'Ana', now)).project;
    expect(setShotPixelAspect(p, SHOT, { value: 2 }, 'Ana', now)).toMatchObject({ ok: false });
  });

  it('warns about an unreadable handoff value and ignores it', () => {
    const raw = JSON.parse(JSON.stringify(SAMPLE_HANDOFF)) as { shots: Record<string, unknown>[] };
    raw.shots[0]!['camera'] = { pixelAspect: 'wide' };
    const h = parseHandoff(JSON.stringify(raw));
    expect(h.ok).toBe(true);
    if (h.ok) expect(h.warnings.some((w) => /not a pixel aspect/.test(w.message))).toBe(true);
  });
});

describe('film back for a non-square plate', () => {
  it('multiplies an anamorphic sensor area by the squeeze', () => {
    // 2× on a 6:5 area recorded 2560 × 2146.
    expect(effectiveFilmBack({ width: 21.12, height: 17.7 }, { width: 2560, height: 2146 }, 2)).toMatchObject({ width: 42.24, height: 17.7, desqueezed: true });
  });
  it('keeps a back already the de-squeezed shape (DV 16:9 sensor sampled 1280 × 1080)', () => {
    expect(effectiveFilmBack({ width: 9.6, height: 5.4 }, { width: 1280, height: 1080 }, 1.5)).toMatchObject({ width: 9.6, height: 5.4, desqueezed: false });
  });
  it('is the back itself for square pixels', () => {
    expect(effectiveFilmBack({ width: 36, height: 24 }, { width: 1920, height: 1080 }, 1)).toMatchObject({ width: 36, desqueezed: false });
  });
});

describe('project format 10', () => {
  it('opens a format-9 project: no override, no sample aspect, solves at 1', () => {
    const p = projectWith();
    const v9 = JSON.parse(serializeProject(p));
    v9.version = 9;
    for (const s of v9.shots) delete s.pixelAspect;
    const opened = parseProject(JSON.stringify(v9));
    if (!opened.ok) throw new Error(opened.reason);
    expect(opened.project.version).toBe(PROJECT_VERSION);
    expect(PROJECT_VERSION).toBe(11);
    expect(shotState(opened.project, SHOT)!.pixelAspect).toBeNull();
    const rec = SolveRecordSchema.parse({
      number: 1, taskVersion: 1, file: 'solve-1', tracks: 't', engine: { id: 'vcvfx-ts', version: '1.0.0' },
      intrinsics: { focalPx: 1000, focalMm: null, cx: 0, cy: 0, k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 },
      stats: { rms: 0.5, medianError: 0.4, framesSolved: 1, framesTotal: 1, tracksUsed: 1, tracksTotal: 1, keyframes: 1, nodal: false, confidence: 1, minTracksPerFrame: 1 },
      at: now.toISOString(), by: 'Test',
    });
    expect(rec.intrinsics.pixelAspect).toBe(1);
  });

  it('round-trips an override', () => {
    const p = ok(setShotPixelAspect(projectWith(), SHOT, { value: 2 }, 'Ana', now)).project;
    const again = parseProject(serializeProject(p));
    if (!again.ok) throw new Error(again.reason);
    expect(shotState(again.project, SHOT)!.pixelAspect).toMatchObject({ value: 2, by: 'Ana' });
  });
});
