// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAMPLE_HANDOFF, createProject, parseHandoff, serializeProject } from '@vcvfx/domain';
import { BROWSER_PREFIX, DESKTOP_ONLY, createBrowserBridge } from '../browser-bridge';

const sampleText = () => {
  const parsed = parseHandoff(JSON.stringify(SAMPLE_HANDOFF));
  if (!parsed.ok) throw new Error('sample did not parse');
  return serializeProject(createProject(parsed.handoff, 'NightShift_handoff.json', 'Tester', new Date('2026-01-01T00:00:00Z')));
};

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.useRealTimers());

describe('the browser preview bridge', () => {
  it('is licensed, so the approval flow can be tried', async () => {
    const api = createBrowserBridge();
    expect((await api.licenceStanding(false))?.status).toBe('active');
  });

  it('opens the sample at start when nothing is kept in this browser', async () => {
    vi.useFakeTimers();
    const api = createBrowserBridge();
    const seen: string[] = [];
    api.onMenu((c) => seen.push(c));
    vi.runAllTimers();
    expect(seen).toEqual(['open-sample']);
  });

  it('keeps a saved project in this browser and reopens it next time', async () => {
    const text = sampleText();
    const first = createBrowserBridge();
    const saved = await first.saveProject({ path: null, text });
    expect(saved).toEqual({ ok: true, data: { path: `${BROWSER_PREFIX}NightShift_handoff.vcvfx` } });

    vi.useFakeTimers();
    const second = createBrowserBridge();
    expect((await second.getSettings()).recent).toEqual([`${BROWSER_PREFIX}NightShift_handoff.vcvfx`]);
    const seen: string[] = [];
    second.onMenu((c) => seen.push(c));
    vi.runAllTimers();
    expect(seen).toEqual([`open-recent:${BROWSER_PREFIX}NightShift_handoff.vcvfx`]);
    const reopened = await second.openProjectPath(`${BROWSER_PREFIX}NightShift_handoff.vcvfx`);
    expect(reopened.ok && reopened.data.text).toBe(text);
  });

  it('downloads on Save As', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const api = createBrowserBridge();
    const r = await api.saveProject({ path: `${BROWSER_PREFIX}A.vcvfx`, text: sampleText(), saveAs: true });
    expect(r.ok).toBe(true);
    expect(click).toHaveBeenCalledOnce();
    click.mockRestore();
  });

  it('says plainly what needs the desktop app', async () => {
    const api = createBrowserBridge();
    for (const r of [
      await api.verifySources({ jobId: 'j', text: '' }),
      await api.packageShot({ jobId: 'j', text: '', shotId: 's', projectKey: 'k', operator: 'o' }),
      await api.generateSequence({ jobId: 'j', text: '', shotId: 's', projectKey: 'k' }),
      await api.chooseOutputRoot({ projectKey: 'k', text: '' }),
    ]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain(DESKTOP_ONLY);
    }
  });

  it('works when localStorage throws', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const api = createBrowserBridge();
    const r = await api.saveProject({ path: null, text: sampleText() });
    expect(r.ok).toBe(true);
    get.mockRestore();
    set.mockRestore();
  });
});

describe('the viewer in the browser preview', () => {
  const sample = () => {
    const parsed = parseHandoff(JSON.stringify(SAMPLE_HANDOFF));
    if (!parsed.ok) throw new Error('sample did not parse');
    return serializeProject(createProject(parsed.handoff, 'sample', 'Tester', new Date('2026-01-01T00:00:00Z')));
  };

  it('offers the sample project’s stand-in source and plates, labelled as samples', async () => {
    const api = createBrowserBridge();
    const r = await api.viewerSources({ text: sample(), shotId: '010_020', projectKey: 'k' });
    if (!r.ok) throw new Error(r.error);
    expect(r.data).toMatchObject({ sample: true, source: { available: true, encoding: 'arri_logc4_awg4' }, plates: [{ version: 1, first: 1009, last: 1128, encoding: 'acescg' }] });
  });

  it('returns a bundled frame for any frame of the shot, with the view’s label', async () => {
    const api = createBrowserBridge();
    const base = { text: sample(), shotId: '010_020', projectKey: 'k', layer: 'source' as const, maxWidth: 960 };
    const first = await api.viewerFrame({ ...base, frame: 900, view: 'rec709' });
    const last = await api.viewerFrame({ ...base, frame: 1128, view: 'raw' });
    if (!first.ok || !last.ok) throw new Error('no frame');
    expect(first.data).toMatchObject({ frame: 1009, viewLabel: 'ARRI LogC4 → Rec.709 (approx.)' });
    expect(first.data.url).toMatch(/source-rec709-1/);
    expect(last.data.url).toMatch(/source-raw-5/);
    const plate = await api.viewerFrame({ ...base, layer: 'plates', version: 1, frame: 1060, view: 'rec709' });
    expect(plate.ok && plate.data.viewLabel).toBe('ACEScg → Rec.709 (approx.)');
  });

  it('says frames of a real project need the desktop app', async () => {
    const api = createBrowserBridge();
    const r = await api.viewerSources({ text: sampleText(), shotId: '010_020', projectKey: 'k' });
    expect(r.ok && r.data.source.reason).toMatch(new RegExp(`^${DESKTOP_ONLY}`));
    expect((await api.viewerFrame({ text: sampleText(), shotId: '010_020', projectKey: 'k', layer: 'source', frame: 1010, view: 'raw', maxWidth: 480 })).ok).toBe(false);
  });

  it('runs paint-to-roto in the page for the sample, and says export and SAM 2 are the desktop app’s', async () => {
    const api = createBrowserBridge();
    const text = sampleText().replace('"handoffPath": "NightShift_handoff.json"', '"handoffPath": "sample"');
    const session = await api.rotoSession({ text, shotId: '010_020', projectKey: 'k' });
    expect(session).toMatchObject({ ok: true, data: { available: true, sample: true, exportable: false, working: { width: 640, height: 338 }, first: 1009, last: 1128 } });
    if (!session.ok) return;
    expect(session.data.engines.map((e) => [e.id, e.available])).toEqual([
      ['track', true],
      ['sam2', false],
    ]);
    const exported = await api.rotoExport({ jobId: 'j', text, shotId: '010_020', projectKey: 'k', operator: 'T', exr: false });
    expect(exported.ok ? '' : exported.error).toMatch(new RegExp(`^${DESKTOP_ONLY}`));
    const model = await api.rotoModel({ jobId: 'j', action: 'download' });
    expect(model.ok ? '' : model.error).toMatch(new RegExp(`^${DESKTOP_ONLY}`));
    // A real project's roto needs its media.
    const real = await api.rotoSession({ text: sampleText(), shotId: '010_020', projectKey: 'k' });
    expect(real.ok && real.data.available).toBe(false);
  });
});

