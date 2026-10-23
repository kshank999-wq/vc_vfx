import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FILM_STUDIO_DEFAULT_URL,
  PROJECT_VERSION,
  SAMPLE_HANDOFF,
  STATUS_BUCKETS,
  STATUS_BUCKET_TITLES,
  VFX_STATUS_FORMAT,
  addCompNode,
  approveShot,
  approveTask,
  buildFilmStudioStatus,
  createProject,
  handoffReadiness,
  lastStatusSend,
  markDelivered,
  markPackaged,
  parseHandoff,
  parseProject,
  readiness,
  recordStatusSend,
  reopenShot,
  serializeProject,
  setFilmStudioProduction,
  setSourceVerified,
  setTaskState,
  shotState,
  startComp,
  toggleReviewMark,
  vfxStatusCsv,
  vfxStatusReportHtml,
  type PrepTaskKind,
  type Project,
  type Result,
  type ShotState,
  type VfxStatusDocument,
} from '../index.js';
// Film Studio's own reader, vendored verbatim (see the file's header).
import * as filmStudio from './fixtures/film-studio-vfx-status.js';

const NOW = new Date('2026-10-19T12:00:00Z');
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const ok = (r: Result): Project => {
  if (!r.ok) throw new Error(r.reason);
  return r.project;
};
const INPUT = { generatedAt: at(500), appVersion: '0.1.0', operator: 'Ruth Okafor' };

const projectFrom = (handoff: unknown): Project => {
  const r = parseHandoff(JSON.stringify(handoff));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return createProject(r.handoff, '/Volumes/DRIVE/handoff.json', 'dit', NOW);
};
const sample = () => projectFrom(SAMPLE_HANDOFF);

/** Read a document exactly as Film Studio's route would: from its JSON text, through its reader. */
function readAsFilmStudio(doc: VfxStatusDocument) {
  const r = filmStudio.readVfxStatus(JSON.stringify(doc));
  if (!r.ok) throw new Error(`Film Studio refused the report: ${r.why}\n${r.issues.join('\n')}`);
  return r.doc;
}

const patch = (p: Project, shotId: string, fn: (s: ShotState) => ShotState): Project => ({ ...p, shots: p.shots.map((s) => (s.shotId === shotId ? fn(s) : s)) });

/** Put a task up for review, then approve it, as a person would. */
const approve = (p: Project, shotId: string, kind: PrepTaskKind, minute: number): Project => {
  const state = shotState(p, shotId)!.tasks.find((t) => t.kind === kind)!.state;
  const q = state === 'needs_review' ? p : ok(setTaskState(p, shotId, kind, 'needs_review', 'artist', at(minute)));
  return ok(approveTask(q, shotId, kind, 'Ada Renke', at(minute + 1)));
};
const approveAll = (p: Project, shotId: string, minute: number): Project =>
  shotState(p, shotId)!.tasks.reduce((q, t, i) => approve(q, shotId, t.kind, minute + i * 2), p);

const shot = (id: string, scene: string, tasks: PrepTaskKind[], extra: Record<string, unknown> = {}) => ({
  shotId: id,
  unit: 'Main',
  shootDay: 'Day 003 · 2026-09-16',
  scene,
  setup: 'B',
  take: '3',
  cameraRoll: 'A001',
  clip: `A001C0${id.slice(-2)}`,
  circled: true,
  sourcePath: `VFX/${id}.mxf`,
  frameIn: 100,
  frameOut: 147,
  handles: 8,
  timecodeIn: '11:01:12:00',
  frameRate: 24,
  resolution: { width: 4096, height: 2160 },
  camera: { body: 'ARRI ALEXA 35', lens: 'Signature Prime', focalLengthMm: 35 },
  color: { sourceColorSpace: 'ARRI LogC4 / AWG4' },
  tasks: tasks.map((kind) => ({ kind })),
  supervisorNotes: `Notes for ${id}`,
  checksums: [{ path: `VFX/${id}.mxf`, algorithm: 'sha256', value: 'a'.repeat(64) }],
  ...extra,
});

/**
 * A project with a shot in every state Film Studio has a section for, and
 * the awkward cases: a stale package, a reopened task, a delivery with a
 * vendor, a broken source, review marks, low-confidence roto, a key with
 * problem frames, a comp graph that does not validate, and fields longer
 * than the contract allows.
 */
function rich(): Project {
  const handoff = {
    project: 'Copper Line',
    productionCompany: 'Lantern Pictures',
    vfxSupervisor: 'M. Delgado',
    origin: { format: 'vcdit.vfx-handoff/1', tool: 'VC DIT 1.3.0', productionCode: 'CPL', day: { number: 3, date: '2026-09-16' } },
    output: { format: 'exr', bitDepth: 16, startFrame: 1001, compression: 'PIZ' },
    shots: [
      shot('S01', '1', []), // not started: no tasks
      shot('S02', '2', ['sequence_conversion', 'roto']), // ready for prep
      shot('S03', '3', ['sequence_conversion', 'key']), // processing
      shot('S04', '4', ['roto']), // needs review, low-confidence roto
      shot('S05', '5', ['key', 'despill']), // needs correction
      shot('S06', '6', ['track_2d']), // every task approved, shot not
      shot('S07', '7', ['clean_plate']), // prep approved, not packaged
      shot('S08', '8', ['sequence_conversion', 'camera_track']), // packaged: ready
      shot('S09', '9', ['sky_replacement']), // packaged, then reopened (stale package)
      shot('S10', '10', ['texture_extraction', 'lighting_analysis']), // packaged, reopened, a task reopened (version bump)
      shot('S11', '11', ['background_removal']), // delivered to a vendor
      shot('S12', '12', ['composite']), // a comp that does not validate
      shot('S13', 'A scene number far longer than Film Studio allows in its forty-character column', ['roto'], { setup: 'SETUP-WAY-TOO-LONG-FOR-FS', shootDay: 'Day 004 · 2026-09-17' }),
    ],
  };
  let p = projectFrom(handoff);
  p = ok(setTaskState(p, 'S03', 'sequence_conversion', 'processing', 'artist', at(1)));
  p = ok(setTaskState(p, 'S04', 'roto', 'needs_review', 'artist', at(2)));
  p = patch(p, 'S04', (s) => ({
    ...s,
    roto: {
      formatVersion: 1,
      parts: [
        {
          id: 'subject',
          name: 'Subject',
          parentId: null,
          combine: 'union',
          color: '#ff0000',
          visible: true,
          keyFrames: [{ frame: 1001, strokes: [] }],
          refine: { featherPx: 1, shrinkGrowPx: 0, temporalSmoothing: 0, edgeSnap: true },
          engine: { id: 'track', version: '1', settings: {} },
          frames: [
            { frame: 1001, status: 'key', confidence: 0.95, engine: 'track@1', from: 1001, reviewed: null, note: '' },
            { frame: 1002, status: 'propagated', confidence: 0.4, engine: 'track@1', from: 1001, reviewed: null, note: '' },
            { frame: 1003, status: 'propagated', confidence: 0.5, engine: 'track@1', from: 1001, reviewed: { by: 'artist', at: NOW.toISOString() }, note: '' },
            { frame: 1004, status: 'flagged', confidence: 0.8, engine: 'track@1', from: 1001, reviewed: null, note: 'hair edge' },
          ],
        },
      ],
      runs: [],
      exports: [],
      workingWidth: 1920,
      seq: 0,
    } as never,
  }));
  p = ok(setTaskState(p, 'S05', 'key', 'needs_correction', 'artist', at(3)));
  p = patch(p, 'S05', (s) => ({
    ...s,
    key: {
      frames: [
        { frame: 1001, confidence: 0.9, metrics: {}, status: 'processed', reason: '', reviewed: null, note: '' },
        { frame: 1002, confidence: 0.3, metrics: {}, status: 'processed', reason: 'spill on the arm', reviewed: null, note: '' },
        { frame: 1003, confidence: 0.7, metrics: {}, status: 'flagged', reason: '', reviewed: null, note: '' },
      ],
      exports: [],
    } as never,
  }));
  p = ok(toggleReviewMark(p, 'S05', { frame: 1010, viewing: 'source', note: 'matte chatter' }, 'sup', at(4)));
  p = approveAll(p, 'S06', 10);
  p = ok(approveShot(approveAll(p, 'S07', 20), 'S07', 'M. Delgado', at(29)));
  p = ok(markPackaged(ok(approveShot(approveAll(p, 'S08', 30), 'S08', 'M. Delgado', at(39))), 'S08', 'dit', at(40)));
  p = ok(markPackaged(ok(approveShot(approveAll(p, 'S09', 50), 'S09', 'M. Delgado', at(59))), 'S09', 'dit', at(60)));
  p = ok(reopenShot(p, 'S09', 'sup', at(61)));
  p = ok(markPackaged(ok(approveShot(approveAll(p, 'S10', 70), 'S10', 'M. Delgado', at(79))), 'S10', 'dit', at(80)));
  p = ok(reopenShot(p, 'S10', 'sup', at(81)));
  p = ok(setTaskState(p, 'S10', 'lighting_analysis', 'needs_review', 'artist', at(82)));
  p = ok(markPackaged(ok(approveShot(approveAll(p, 'S11', 90), 'S11', 'M. Delgado', at(99))), 'S11', 'dit', at(100)));
  p = ok(markDelivered(p, 'S11', 'dit', at(101), 'Northlight VFX'));
  p = ok(startComp(p, 'S12', 'empty', 'artist', at(110)));
  p = ok(addCompNode(p, 'S12', 'merge', {}, 'artist', at(111)));
  p = ok(setSourceVerified(p, 'S12', 'mismatch', 'sha256 differs', 'dit', at(112)));
  p = ok(setSourceVerified(p, 'S08', 'verified', 'sha256 matches', 'dit', at(113)));
  p = ok(setFilmStudioProduction(p, 'DEMO — THE COPPER LINE', 'sup', at(114)));
  return p;
}

const byId = (doc: VfxStatusDocument, id: string) => doc.shots.find((s) => s.handoffShotId === id)!;

describe('the VFX status document under Film Studio’s reader', () => {
  it('reads the sample project', () => {
    const doc = buildFilmStudioStatus(sample(), INPUT);
    expect(doc.format).toBe(VFX_STATUS_FORMAT);
    const read = readAsFilmStudio(doc);
    expect(read.shots).toHaveLength(5);
    expect(read.generator).toEqual({ app: 'VC VFX', version: '0.1.0' });
    expect(read.claimed?.readyToHandOff).toBe(0);
  });

  it('reads a project with a shot in every state, and the awkward cases', () => {
    const p = rich();
    const doc = buildFilmStudioStatus(p, INPUT);
    const read = readAsFilmStudio(doc);
    expect(read.shots).toHaveLength(13);
    expect(read.project.origin).toEqual({ format: 'vcdit.vfx-handoff/1', tool: 'VC DIT 1.3.0', productionCode: 'CPL', dayNumber: 3, dayDate: '2026-09-16' });
    expect(read.filmStudio?.production).toBe('DEMO — THE COPPER LINE');
    // Every status VC VFX derives appears, and Film Studio read it as sent.
    expect(new Set(read.shots.map((s) => s.status.key))).toEqual(new Set(['not_started', 'ready_for_prep', 'processing', 'needs_review', 'needs_correction', 'prep_approved', 'packaged', 'delivered']));
  });

  it('agrees with Film Studio on readiness, section and reasons for every shot', () => {
    const doc = buildFilmStudioStatus(rich(), INPUT);
    const read = readAsFilmStudio(doc);
    for (const s of doc.shots) {
      const theirs = filmStudio.readiness(read.shots.find((x) => x.handoffShotId === s.handoffShotId)!);
      expect(readiness(s), s.handoffShotId).toEqual(theirs);
    }
    // Every section of the printed log has a shot in it.
    expect(new Set(doc.shots.map((s) => readiness(s).bucket))).toEqual(new Set(STATUS_BUCKETS));
    // The summary is Film Studio's own count.
    expect(doc.summary.readyToHandOff).toBe(filmStudio.summarise(read.shots).ready);
    expect(doc.summary.readyToHandOff).toBe(1);
    expect(doc.summary.byStatus).toEqual(filmStudio.summarise(read.shots).byStatus);
    expect(doc.summary.byTaskState).toEqual(filmStudio.summarise(read.shots).byTaskState);
  });

  it('agrees with Film Studio on its own demo reports', () => {
    for (const file of ['film-studio-vc-vfx-status.json', 'film-studio-vc-vfx-status-earlier.json']) {
      const text = readFileSync(join(__dirname, 'fixtures', file), 'utf8');
      const r = filmStudio.readVfxStatus(text);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      const raw = JSON.parse(text) as VfxStatusDocument;
      for (const s of raw.shots) expect(readiness(s), s.handoffShotId).toEqual(filmStudio.readiness(r.doc.shots.find((x) => x.handoffShotId === s.handoffShotId)!));
    }
  });

  it('carries the same fields, in the same shape, as Film Studio’s demo report', () => {
    const demo = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'film-studio-vc-vfx-status.json'), 'utf8')) as { shots: Record<string, unknown>[] };
    const doc = buildFilmStudioStatus(rich(), INPUT);
    const packaged = byId(doc, 'S08') as unknown as Record<string, unknown>;
    const theirs = demo.shots.find((s) => (s['status'] as { key: string }).key === 'packaged' && s['packaged'])!;
    for (const k of ['handoffShotId', 'scene', 'setup', 'take', 'circled', 'cameraRoll', 'clip', 'unit', 'shootDay', 'shootDate', 'frames', 'frameRate', 'timecodeIn', 'camera', 'pixelAspect', 'status', 'source', 'tasks', 'approval', 'packaged', 'problems', 'supervisorNotes']) {
      expect(packaged[k], k).toBeDefined();
      if (theirs[k] !== null && theirs[k] !== undefined) expect(typeof packaged[k], k).toBe(typeof theirs[k]);
    }
    expect(Object.keys((packaged['packaged'] as object))).toEqual(expect.arrayContaining(Object.keys(theirs['packaged'] as object)));
  });
});

describe('what the document says about each shot', () => {
  const p = rich();
  const doc = buildFilmStudioStatus(p, INPUT);

  it('an approved task always carries its approval; others never do', () => {
    for (const s of doc.shots) for (const t of s.tasks) expect(t.approval !== null, `${s.handoffShotId} ${t.kind}`).toBe(t.state === 'approved');
  });

  it('a task reopened after packaging has a new version and no approval, and the shot is not ready', () => {
    const s = byId(doc, 'S10');
    const lighting = s.tasks.find((t) => t.kind === 'lighting_analysis')!;
    expect(lighting).toMatchObject({ state: 'needs_review', version: 2, approval: null });
    expect(s.packaged?.taskVersions).toEqual({ texture_extraction: 1, lighting_analysis: 1 });
    expect(s.status.key).not.toBe('packaged');
    expect(readiness(s).ready).toBe(false);
    expect(readiness(s).why).toContain('package v001 is out of date — the shot went back into prep');
  });

  it('a shot reopened after packaging reports its derived status, never packaged, and is held', () => {
    const s = byId(doc, 'S09');
    expect(s.status.key).toBe('prep_approved');
    expect(readiness(s)).toEqual({ ready: false, delivered: false, bucket: 'progress', why: ['package v001 is out of date — the shot went back into prep'] });
  });

  it('a packaged shot with every task approved at the packaged version is ready', () => {
    const s = byId(doc, 'S08');
    expect(s.packaged).toMatchObject({ version: 1, at: at(40).toISOString(), folder: 'COPPER_LINE_VFX/SCENE_8/SHOT_S08', taskVersions: { sequence_conversion: 1, camera_track: 1 } });
    expect(s.source).toEqual({ verified: 'verified', at: at(113).toISOString() });
    expect(handoffReadiness(p, 'S08')).toEqual({ ready: true, delivered: false, bucket: 'ready', why: [] });
  });

  it('a delivered shot says when and to whom', () => {
    expect(byId(doc, 'S11').delivered).toEqual({ at: at(101).toISOString(), to: 'Northlight VFX' });
    expect(readiness(byId(doc, 'S11')).bucket).toBe('delivered');
  });

  it('says what is not working, as sentences, with frames', () => {
    const s05 = byId(doc, 'S05').problems;
    expect(s05.find((x) => x.task === null && x.severity === 'warn')).toMatchObject({ frames: [1010] });
    expect(s05.find((x) => x.task === 'key' && x.text.includes('flagged'))).toMatchObject({ frames: [1003] });
    expect(s05.find((x) => x.task === 'key' && x.text.includes('not yet reviewed'))).toMatchObject({ frames: [1002] });
    const s04 = byId(doc, 'S04');
    // 1002 is low and unreviewed; 1003 was reviewed; 1001 is a key frame; 1004 is flagged.
    expect(s04.problems.find((x) => x.text.includes('low-confidence'))).toMatchObject({ task: 'roto', severity: 'warn', frames: [1002] });
    expect(s04.problems.find((x) => x.text.includes('flagged'))).toMatchObject({ frames: [1004] });
    expect(s04.tasks[0]).toMatchObject({ confidence: { frames: 4, low: 2, flagged: 1, reviewed: 1 }, problems: 2 });
    const s12 = byId(doc, 'S12').problems;
    expect(s12[0]).toMatchObject({ task: null, severity: 'error' });
    expect(s12.some((x) => x.task === 'composite' && x.severity === 'error' && /Merge/.test(x.text))).toBe(true);
    // Approved work is not second-guessed.
    expect(byId(doc, 'S08').problems).toEqual([]);
  });

  it('keeps text fields within the contract’s limits', () => {
    const s = byId(doc, 'S13');
    expect(s.scene.length).toBeLessThanOrEqual(40);
    expect(s.scene.endsWith('…')).toBe(true);
    expect(s.setup!.length).toBeLessThanOrEqual(20);
    expect(s.shootDate).toBe('2026-09-16'); // the handoff's day date wins over the label's
  });

  it('frames, timing, camera and plates come from the project', () => {
    const s = byId(doc, 'S08');
    expect(s.frames).toEqual({ in: 1001, out: 1064, handles: 8, count: 64, rangeFrom: 'handoff' });
    expect(s).toMatchObject({ frameRate: 24, timecodeIn: '11:01:12:00', pixelAspect: 1, camera: { body: 'ARRI ALEXA 35', lens: 'Signature Prime', focalLengthMm: 35 } });
  });
});

describe('the project format', () => {
  it('records the task versions a package was made from, and logs them', () => {
    const p = rich();
    expect(shotState(p, 'S08')!.packagedTaskVersions).toEqual({ sequence_conversion: 1, camera_track: 1 });
    expect(p.log.find((l) => l.shotId === 'S08' && l.action === 'shot.packaged')!.detail).toBe('package v001 from sequence_conversion v001, camera_track v001');
    expect(p.log.find((l) => l.shotId === 'S11' && l.action === 'shot.delivered')!.detail).toBe('to Northlight VFX');
  });

  it('opens a format 11 project: package task versions unknown, and omitted from the report', () => {
    let p = ok(markPackaged(ok(approveShot(approveAll(sample(), '010_030', 0), '010_030', 'Sup', at(9))), '010_030', 'dit', at(10)));
    const old = JSON.parse(serializeProject(p)) as Record<string, unknown> & { shots: Record<string, unknown>[] };
    old['version'] = 11;
    delete old['filmStudioProduction'];
    for (const s of old.shots) {
      delete s['packagedTaskVersions'];
      delete s['deliveredTo'];
    }
    const r = parseProject(JSON.stringify(old));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    p = r.project;
    expect(p.version).toBe(PROJECT_VERSION);
    expect(PROJECT_VERSION).toBe(12);
    expect(p.filmStudioProduction).toBe('');
    expect(shotState(p, '010_030')).toMatchObject({ packagedTaskVersions: null, deliveredTo: null, stage: 'packaged' });
    const doc = buildFilmStudioStatus(p, INPUT);
    const s = doc.shots.find((x) => x.handoffShotId === '010_030')!;
    expect(s.packaged).toBeDefined();
    expect(s.packaged!.taskVersions).toBeUndefined();
    // Film Studio then relies on status.key being packaged: still ready.
    expect(filmStudio.readiness(readAsFilmStudio(doc).shots.find((x) => x.handoffShotId === '010_030')!).ready).toBe(true);
    expect(doc.filmStudio).toBeUndefined();
  });

  it('a newer project is still refused', () => {
    const text = serializeProject({ ...sample(), version: PROJECT_VERSION + 1 });
    expect(parseProject(text).ok).toBe(false);
  });
});

describe('the printed log and the CSV', () => {
  const doc = buildFilmStudioStatus(rich(), INPUT);
  const html = vfxStatusReportHtml(doc, { supervisor: 'M. Delgado' });

  it('prints every section, in Film Studio’s order, landscape, with a signature block', () => {
    const positions = STATUS_BUCKETS.map((b) => html.indexOf(`<h2 class="b-${b}">${STATUS_BUCKET_TITLES[b]}`));
    expect(positions.every((x) => x > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(html).toContain('size: landscape');
    expect(html).toContain('VFX supervisor — M. Delgado');
    expect(html).toContain('1 shot is ready to hand off; 1 shot needs correction, 3 in review, 4 in progress, 3 not started. 1 shot has been delivered.');
    expect(html).not.toMatch(/<script/i);
  });

  it('lists each shot with its tasks, versions, approvers, package and what holds it', () => {
    expect(html).toContain('Northlight VFX');
    expect(html).toContain('Lighting</b> Needs Review v002');
    expect(html).toContain('Ada Renke');
    expect(html).toContain('package v001 is out of date');
    expect(html).toContain('matte chatter');
  });

  it('says a note shared by many shots once, above the sections, with the shots it is on', () => {
    const note = 'The source has not been verified against the DIT’s checksum yet. Run Verify sources on the Deliver tab.';
    expect(html.split(note).length - 1).toBe(1);
    expect(html).toMatch(/class="lifted".*\(10 shots: S01, S02/);
  });

  it('escapes what it prints', () => {
    const p = ok(setFilmStudioProduction(rich(), '<b>Prod</b> & "co"', 'sup', at(200)));
    const out = vfxStatusReportHtml(buildFilmStudioStatus(p, INPUT));
    expect(out).toContain('&lt;b&gt;Prod&lt;/b&gt; &amp; &quot;co&quot;');
    expect(out).not.toContain('<b>Prod</b>');
  });

  it('writes one CSV row per shot under Film Studio’s columns, safe for a spreadsheet', () => {
    const csv = vfxStatusCsv(doc);
    const lines = csv.replace(/^﻿/, '').trimEnd().split('\r\n');
    expect(lines[0]).toBe('VFX shot,Handoff shot,Scene,Setup,Take,Shoot day,Status,Section,Ready to hand off,Tasks,Shot approved,Package,Delivered,Problems,What is holding it');
    expect(lines).toHaveLength(14);
    expect(lines.find((l) => l.startsWith('S08,'))).toContain(',Ready to hand off,Yes,');
    const evil = vfxStatusCsv({ shots: [{ ...doc.shots[0]!, scene: '=HYPERLINK("x")' }] });
    expect(evil).toContain(`"'=HYPERLINK(""x"")"`);
  });
});

describe('sending, as the project log keeps it', () => {
  it('logs the counts and Film Studio’s answer, and the last send is found again', () => {
    let p = rich();
    p = recordStatusSend(p, { kind: 'sent', url: FILM_STUDIO_DEFAULT_URL, shots: 13, readyToHandOff: 1, says: '13 shots received: 1 ready to hand off.', warnings: ['Scene 13 is not in this production.'], stale: false, report: 'r1', production: 'DEMO' }, 'Ruth', at(300));
    expect(lastStatusSend(p)).toMatchObject({ action: 'filmstudio.sent', actor: 'Ruth' });
    expect(lastStatusSend(p)!.detail).toContain('13 shots, 1 ready to hand off. Film Studio: 13 shots received');
    p = recordStatusSend(p, { kind: 'refused', url: FILM_STUDIO_DEFAULT_URL, shots: 13, status: 409, error: 'This report is for “X”.', issues: [] }, 'Ruth', at(301));
    expect(lastStatusSend(p)!.detail).toContain('refused (409): This report is for “X”.');
    p = recordStatusSend(p, { kind: 'not_sent', url: FILM_STUDIO_DEFAULT_URL, shots: 13, error: 'offline' }, 'Ruth', at(302));
    expect(lastStatusSend(p)!.action).toBe('filmstudio.not_sent');
  });

  it('names the Film Studio production, logged', () => {
    const p = ok(setFilmStudioProduction(sample(), '  The Copper Line ', 'sup', NOW));
    expect(p.filmStudioProduction).toBe('The Copper Line');
    expect(p.log.at(-1)).toMatchObject({ action: 'filmstudio.production', detail: '(none) → The Copper Line' });
    expect(buildFilmStudioStatus(p, INPUT).filmStudio).toEqual({ production: 'The Copper Line' });
  });
});
