import { describe, expect, it } from 'vitest';
import { CAMERA_DB, CAMERA_CATEGORIES, SAMPLE_HANDOFF, createProject, defaultMode, matchCamera, modeLabel, newCamTrackDocument, parseHandoff, sourceUrl } from '../index.js';
import { CAMERA_DATA } from '../camera-db-data.js';

/** Aliases compare without case, spaces, dashes or underscores ("ALEXA_MINI_LF" = "Alexa Mini LF"). */
const key = (s: string) => s.toLowerCase().replace(/[\s_-]/g, '');

describe('camera database (merged table)', () => {
  it('has the merged coverage: every researched model, the earlier ids kept', () => {
    expect(CAMERA_DB.length).toBe(189);
    expect(CAMERA_DB.reduce((n, c) => n + c.modes.length, 0)).toBeGreaterThanOrEqual(597);
    // Projects store cameraId / modeId: the earlier table's ids still resolve.
    for (const [id, mode] of [
      ['arri-alexa-35', '4.6k-3x2-og'],
      ['arri-alexa-mini-lf', 'lf-og'],
      ['sony-venice-2-8k', '8.6k-3x2'],
      ['sony-venice-6k', '6k-3x2'],
      ['red-komodo-6k', '6k-17x9'],
      ['bmd-ursa-mini-pro-12k', '12k-dci'],
      ['apple-iphone-15-pro-main', 'uhd'],
    ] as const)
      expect(CAMERA_DB.find((c) => c.id === id)?.modes.some((m) => m.id === mode)).toBe(true);
    const ids = CAMERA_DB.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of CAMERA_DB) expect(CAMERA_CATEGORIES).toContain(c.category);
  });

  it('has no alias that names two cameras', () => {
    const owner = new Map<string, string>();
    for (const c of CAMERA_DB)
      for (const name of new Set([c.model, `${c.make} ${c.model}`, ...c.aliases].map(key))) {
        const prev = owner.get(name);
        expect(prev === undefined || prev === c.id, `"${name}" names ${prev} and ${c.id}`).toBe(true);
        owner.set(name, c.id);
      }
  });

  it('gives every model a default mode and unique mode ids', () => {
    for (const c of CAMERA_DATA) {
      expect(c.modes.some((m) => m.id === c.defaultModeId), `${c.id} default ${c.defaultModeId}`).toBe(true);
      expect(new Set(c.modes.map((m) => m.id)).size).toBe(c.modes.length);
    }
    for (const c of CAMERA_DB) expect(defaultMode(c).id).toBe(c.defaultModeId);
  });

  it('keeps millimetre aspect ≈ pixel aspect, except the documented cases', () => {
    // Sony F65: rotated (Q67) photosite grid, 8192 × 2160 photosites do not map 1:1 onto the area.
    // GoPro HERO10 stills: a nominal 1/2.3" size against the 5568 × 4192 raster.
    const exceptions = new Set(['sony-f65/8k-photosites-full', 'gopro-hero10-black/full-sensor-stills']);
    const outliers: string[] = [];
    for (const c of CAMERA_DB)
      for (const m of c.modes) {
        expect(m.filmBackMm.width).toBeGreaterThan(0);
        expect(m.px.width).toBeGreaterThan(0);
        const r = m.filmBackMm.width / m.filmBackMm.height / (m.px.width / m.px.height);
        // An anamorphic raster is either recorded squeezed (r ≈ 1) or desqueezed (r ≈ 1 / squeeze).
        const ok = Math.abs(r - 1) <= 0.02 || (m.anamorphicSqueeze !== 1 && Math.abs(r * m.anamorphicSqueeze - 1) <= 0.02);
        if (!ok) outliers.push(`${c.id}/${m.id}`);
      }
    expect(outliers.sort()).toEqual([...exceptions].sort());
  });

  it('keeps the verification honest: notes and sources on unverified entries, the earlier verified figures intact', () => {
    for (const c of CAMERA_DB) {
      expect(c.sources.length + (c.source ? 1 : 0)).toBeGreaterThan(0);
      if (!c.verified) expect(c.verifiedNotes.length).toBeGreaterThan(0);
      // A body that is not verified has no verified mode.
      if (!c.verified) expect(c.modes.every((m) => !m.verified)).toBe(true);
    }
    const a35 = CAMERA_DB.find((c) => c.id === 'arri-alexa-35')!;
    expect(a35.modes.find((m) => m.id === '4k-2x1')).toMatchObject({ filmBackMm: { width: 24.88, height: 12.44 }, verified: true });
    expect(sourceUrl(a35)).toMatch(/^https:\/\/www\.arri\.com\//);
    expect(modeLabel(a35.modes[0]!)).toBe('4.6K 3:2 Open Gate — 27.99 × 19.22 mm · 4608×3164');
    // Desqueezed anamorphic output is labelled so.
    const sxt = CAMERA_DB.find((c) => c.id === 'arri-alexa-sxt-plus')!;
    expect(sxt.modes.some((m) => m.anamorphicSqueeze === 2)).toBe(true);
  });

  it('carries fixed focal lengths for fixed-lens drones and phones, as separate entries per camera', () => {
    const mavic = CAMERA_DB.filter((c) => c.make === 'DJI' && c.model.startsWith('Mavic 3 Pro'));
    expect(mavic.length).toBe(3);
    for (const c of mavic) expect(c.fixedFocalMm).toBeGreaterThan(5);
    expect(CAMERA_DB.find((c) => c.id === 'apple-iphone-16-pro-main')!.fixedFocalMm).toBeCloseTo(6.77, 2);
    // Interchangeable-lens cameras have none.
    expect(CAMERA_DB.find((c) => c.id === 'arri-alexa-35')!.fixedFocalMm).toBeNull();
  });

  it('matches handoff camera text across makers', () => {
    const cases: [string, string][] = [
      ['ALEXA35', 'arri-alexa-35'],
      ['ARRI ALEXA Mini LF', 'arri-alexa-mini-lf'],
      ['ALEXA_MINI_LF', 'arri-alexa-mini-lf'],
      ['ILME-FX3', 'sony-fx3'],
      ['Sony VENICE 2', 'sony-venice-2-8k'],
      ['RED V-RAPTOR [X] 8K VV', 'red-v-raptor-x-8k-vv'],
      ['RED Komodo', 'red-komodo-6k'],
      ['Canon C300 Mk III', 'canon-c300-iii'],
      ['Blackmagic URSA Mini Pro 12K', 'bmd-ursa-mini-pro-12k'],
      ['BMPCC 6K Pro', 'bmd-pocket-cinema-camera-6k-pro'],
      ['Panasonic VariCam LT', 'panasonic-varicam-lt'],
      ['Nikon Z9', 'nikon-z9'],
      ['Fujifilm X-H2S', 'fujifilm-x-h2s'],
      ['Phantom Flex 4K', 'phantom-flex4k'],
      ['Mavic 3 Pro Hasselblad', 'dji-mavic-3-pro-hasselblad-wide'],
      ['DJI Mavic 3 Pro 70mm', 'dji-mavic-3-pro-medium-tele-70-mm'],
      ['DJI Mini 4 Pro', 'dji-mini-4-pro'],
      ['Zenmuse X9-8K Air', 'dji-inspire-3-zenmuse-x9-8k-air'],
      ['iPhone 15 Pro', 'apple-iphone-15-pro-main'],
      ['GoPro HERO12', 'gopro-hero12-black'],
    ];
    for (const [text, id] of cases) {
      const m = matchCamera({ body: text });
      expect(m?.camera.id, text).toBe(id);
      expect(m?.confident, text).toBe(true);
    }
    expect(matchCamera({ body: 'Bolex H16' })).toBeNull();
    // With no mode text the body's default mode is chosen; mode text and resolution still win.
    expect(matchCamera({ body: 'Mavic 3 Pro Hasselblad' })!.mode.id).toBe(CAMERA_DB.find((c) => c.id === 'dji-mavic-3-pro-hasselblad-wide')!.defaultModeId);
    expect(matchCamera({ body: 'ARRI ALEXA 35', sensorMode: '3.3K 6:5' })!.mode.id).toBe('3.3k-6x5');
  });
});

describe('a new camera-track document from the handoff', () => {
  it('fills the focal of a fixed-lens camera and records the handoff text', () => {
    const raw = structuredClone(SAMPLE_HANDOFF) as { shots: { shotId: string; camera?: Record<string, unknown> }[] };
    raw.shots.find((s) => s.shotId === '020_010')!.camera = { body: 'DJI Mavic 3 Pro 70mm' };
    const h = parseHandoff(JSON.stringify(raw));
    if (!h.ok) throw new Error('handoff');
    const doc = newCamTrackDocument(createProject(h.handoff, '/drive/handoff.json', 'Test', new Date('2026-10-21T10:00:00Z')), '020_010');
    expect(doc.camera?.cameraId).toBe('dji-mavic-3-pro-medium-tele-70-mm');
    expect(doc.camera?.handoffText).toBe('DJI Mavic 3 Pro 70mm');
    expect(doc.lens.focalMm).toBeCloseTo(19.6, 1);
    expect(doc.lens.focalMode).toBe('approx');
  });
});
