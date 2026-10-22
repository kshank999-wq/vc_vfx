import { describe, expect, it } from 'vitest';
import {
  SAMPLE_HANDOFF,
  buildManifest,
  contactSheetFrames,
  createProject,
  parseHandoff,
  parseProject,
  plateColorFor,
  recordPlates,
  serializeProject,
  setPlateColorDefault,
  setShotPlateColor,
  setTaskState,
  approveTask,
  shotState,
  toggleReviewMark,
  type Project,
  type Result,
} from '../index.js';

const NOW = new Date('2026-10-20T12:00:00Z');
const ok = (r: Result): Project => {
  if (!r.ok) throw new Error(r.reason);
  return r.project;
};
const sample = (): Project => {
  const r = parseHandoff(JSON.stringify(SAMPLE_HANDOFF));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return createProject(r.handoff, '/Volumes/DRIVE/handoff.json', 'dit', NOW);
};

describe('plateColorFor', () => {
  it('keeps the DPX shot in LogC4 and converts the EXR shot from S-Log3 to ACEScg', () => {
    const p = sample();
    expect(plateColorFor(p, '010_020').summary).toBe('Writes DPX 10-bit as shot (ARRI LogC4 / AWG4 kept); no look applied.');
    expect(plateColorFor(p, '020_010').policy).toEqual({ mode: 'convert', from: 'sony_slog3_sgamut3cine', to: 'acescg' });
  });

  it('follows the project default, and logs its change', () => {
    const p = ok(setPlateColorDefault(sample(), 'aces2065_1', 'sup', NOW));
    expect(plateColorFor(p, '020_010').policy).toEqual({ mode: 'convert', from: 'sony_slog3_sgamut3cine', to: 'aces2065_1' });
    expect(p.log.at(-1)).toMatchObject({ action: 'project.plate_colour', detail: 'EXR plates: convert to ACEScg (linear AP1) → convert to ACES2065-1 (linear AP0)' });
  });
});

describe('setShotPlateColor', () => {
  it('records the operator’s encoding and choice, logged with the result', () => {
    const p = ok(setShotPlateColor(sample(), '020_010', { encoding: 'sony_slog3_sgamut3', choice: 'as_shot' }, 'ops', NOW));
    expect(shotState(p, '020_010')).toMatchObject({ sourceEncoding: 'sony_slog3_sgamut3', plateColor: 'as_shot' });
    expect(p.log.at(-1)?.action).toBe('plates.colour');
    expect(p.log.at(-1)?.detail).toMatch(/^plate colour Project default → As shot \(no conversion\); source encoding from handoff → Sony S-Log3 \/ S-Gamut3\. Writes EXR half as shot/);
  });

  it('is a no-op when nothing changes', () => {
    const p = sample();
    expect(ok(setShotPlateColor(p, '020_010', { choice: 'auto' }, 'ops', NOW))).toBe(p);
  });

  it('refuses once the plates are approved', () => {
    let p = sample();
    p = ok(setTaskState(p, '020_010', 'sequence_conversion', 'needs_review', 'ops', NOW));
    p = ok(approveTask(p, '020_010', 'sequence_conversion', 'Sup', NOW));
    const r = setShotPlateColor(p, '020_010', { choice: 'as_shot' }, 'ops', NOW);
    expect(r.ok).toBe(false);
  });
});

describe('recordPlates', () => {
  it('keeps one record per version and logs the exact transform', () => {
    let p = sample();
    const d = plateColorFor(p, '020_010');
    const record = {
      version: 1,
      pattern: '020_010_plate_v001.%04d.exr',
      format: 'exr',
      bitDepth: 16,
      frames: 264,
      firstFrame: 1001,
      lastFrame: 1264,
      color: { policy: d.policy, sourceEncoding: d.sourceEncoding, plateEncoding: d.plateEncoding, summary: d.summary, transform: 'Sony S-Log3 → linear; …', filter: 'zscale…', files: ['09_PROJECT_DATA/x.json'], lookApplied: false as const },
      notes: ['ffmpeg cannot write PIZ EXR compression; ZIP16 was used instead.'],
    };
    p = ok(recordPlates(p, '020_010', record, 'ops', NOW));
    p = ok(recordPlates(p, '020_010', { ...record, frames: 264 }, 'ops', NOW));
    expect(shotState(p, '020_010')?.plates).toHaveLength(1);
    expect(p.log.at(-1)).toMatchObject({ action: 'plates.written' });
    expect(p.log.at(-1)?.detail).toMatch(/ffmpeg -vf zscale/);
    const m = buildManifest(p, '020_010', { generatedAt: NOW, appVersion: '0.2.0', operator: 'ops', files: [] });
    expect(m.plates.color).toMatchObject({ written: true, sourceEncoding: 'sony_slog3_sgamut3cine', plateEncoding: 'acescg', lookApplied: false, files: ['09_PROJECT_DATA/x.json'] });
    // How the request was honoured reaches the vendor too.
    expect(m.plates.notes).toEqual(['ffmpeg cannot write PIZ EXR compression; ZIP16 was used instead.']);
  });

  it('puts the planned decision in the manifest before any plates exist', () => {
    const m = buildManifest(sample(), '010_020', { generatedAt: NOW, appVersion: '0.2.0', operator: 'ops', files: [] });
    expect(m.plates.color).toMatchObject({ written: false, policy: { mode: 'as_shot' }, sourceEncoding: 'arri_logc4_awg4', lookApplied: false });
  });
});

describe('review marks', () => {
  it('toggles a frame mark, logging both acts, and reaches the manifest', () => {
    let p = ok(toggleReviewMark(sample(), '010_020', { frame: 1040, viewing: 'source', note: 'Hair edge chatter' }, 'ops', NOW));
    expect(shotState(p, '010_020')?.reviewMarks).toEqual([{ frame: 1040, viewing: 'source', note: 'Hair edge chatter', by: 'ops', at: NOW.toISOString() }]);
    expect(p.log.at(-1)).toMatchObject({ action: 'review.marked', detail: 'frame 1040 (source): Hair edge chatter' });
    expect(buildManifest(p, '010_020', { generatedAt: NOW, appVersion: '0.2.0', operator: 'ops', files: [] }).review.marks).toHaveLength(1);
    p = ok(toggleReviewMark(p, '010_020', { frame: 1040, viewing: 'source' }, 'ops', NOW));
    expect(shotState(p, '010_020')?.reviewMarks).toEqual([]);
    expect(p.log.at(-1)?.action).toBe('review.unmarked');
  });
});

describe('contactSheetFrames', () => {
  it('spreads frames evenly with first and last', () => {
    expect(contactSheetFrames(1001, 1128)).toEqual([1001, 1011, 1021, 1030, 1040, 1050, 1060, 1069, 1079, 1089, 1099, 1108, 1118, 1128]);
    expect(contactSheetFrames(1001, 1004)).toEqual([1001, 1002, 1003, 1004]);
    expect(contactSheetFrames(5, 4)).toEqual([]);
  });
});

describe('older project files', () => {
  it('open with colour defaults filled in', () => {
    const p = sample();
    const raw = JSON.parse(serializeProject(p));
    delete raw.plateColorDefault;
    for (const s of raw.shots) {
      delete s.sourceEncoding;
      delete s.plateColor;
      delete s.plates;
      delete s.reviewMarks;
    }
    const r = parseProject(JSON.stringify(raw));
    if (!r.ok) throw new Error(r.reason);
    expect(r.project.plateColorDefault).toBe('acescg');
    expect(shotState(r.project, '010_020')).toMatchObject({ sourceEncoding: null, plateColor: 'auto', plates: [], reviewMarks: [] });
  });
});
