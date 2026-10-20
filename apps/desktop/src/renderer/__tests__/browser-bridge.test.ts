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
