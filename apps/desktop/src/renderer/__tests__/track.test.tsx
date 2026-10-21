// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { SAMPLE_HANDOFF, createProject, focalPixels, parseHandoff, parseProject, shotState } from '@vcvfx/domain';
import { App } from '../App';
import { dispatch, type CameraCommand } from '../../shared/camera/commands';
import { MemoryStore, sessionBase, viewData } from '../../shared/camera/session';
import { TsCameraSolver } from '../../shared/camera/solver';
import { grayOf } from '../../shared/camera/klt';
import { renderScene, roomScene } from '../../shared/camera/render';
import { cameraPath } from '../../shared/camera/synthetic';
import { viewerTimeline } from '../../shared/viewer';
import { stubBridge } from './bridge-stub';

/**
 * The Track workspace in the renderer (addendum 06 §9): opened from the
 * sample's camera-track task, every button a command run by the shared
 * dispatcher on a small rendered shot, the outcome's ops applied to the
 * project (and its log). jsdom has no canvas pixels or WebGL, so the 3D view
 * reports that and frames are stand-in URLs.
 */

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement['getContext'];
});
afterEach(cleanup);

const W = 320;
const H = 180;
const N = 24;
// 25 mm on the VENICE 2 8.6K 3:2 film back the sample's 020_010 matches, at 320 px.
const intr = { f: focalPixels(25, 35.9, W), cx: (W - 1) / 2, cy: (H - 1) / 2, k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 };
const path = cameraPath('pan', N, 9);
const quads = roomScene(5);
const frames = path.map((p) => grayOf(renderScene(quads, { width: W, height: H, intr, R: p.R, t: p.t })));

function trackBridge(log: string[]) {
  const store = new MemoryStore();
  const ctx = (text: string, shotId: string) => {
    const parsed = parseProject(text);
    if (!parsed.ok) throw new Error(parsed.reason);
    const timeline = viewerTimeline(parsed.project, shotId)!;
    return { project: parsed.project, first: timeline.first, last: timeline.first + N - 1 };
  };
  return stubBridge({
    trackSession: async ({ text, shotId }) => {
      const c = ctx(text, shotId);
      return { ok: true, data: { available: true, reason: null, frames: 'test frames', plate: { width: W, height: H }, working: { width: W, height: H }, first: c.first, last: c.last, fps: 24, exportable: false, lidarFromDisk: false, sample: true } };
    },
    trackFrame: async (i) => ({ ok: true, data: { url: `blob:frame-${i.frame}`, frame: i.frame, viewLabel: 'test' } }),
    trackView: async ({ text, shotId }) => ({ ok: true, data: await viewData(shotState(ctx(text, shotId).project, shotId)?.camtrack, store, true) }),
    trackCommand: async (input) => {
      const c = ctx(input.text, input.shotId);
      const command = input.command as unknown as CameraCommand;
      log.push(command.verb);
      const out = await dispatch(
        {
          ...sessionBase(c.project, input.shotId, { first: c.first, last: c.last, fps: 24 }, { width: W, height: H }, { width: W, height: H }),
          io: { frame: async (f) => frames[Math.min(N - 1, Math.max(0, f - c.first))]! },
          store,
          solver: new TsCameraSolver(),
          actor: input.operator,
          now: () => new Date(),
          generator: 'test',
        },
        command,
      );
      return { ok: true, data: out.ok ? { ok: true, summary: out.summary, data: out.data, ops: out.ops } : { ok: false, error: out.error } };
    },
  });
}

describe('the Track workspace', () => {
  it('opens from the camera-track task, auto-tracks, solves and shows the error graph; exports are the desktop app’s', async () => {
    const log: string[] = [];
    render(<App api={trackBridge(log)} />);
    await act(async () => undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Open sample project' }));
    const table = screen.getByRole('table', { name: 'Shot queue' });
    const row = within(table).getAllByRole('row').find((r) => r.textContent?.includes('020_010'))!;
    fireEvent.click(row);
    fireEvent.click(screen.getByRole('button', { name: 'Open Camera Track' }));
    await act(async () => undefined);
    expect(screen.getByRole('tab', { name: 'Camera Track' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('region', { name: 'Current shot' }).textContent).toContain('020_010');
    // The viewer's frame is brought into the tracked range (the shot's first N frames here).
    const h = parseHandoff(JSON.stringify(SAMPLE_HANDOFF));
    if (!h.ok) throw new Error('sample');
    const first = viewerTimeline(createProject(h.handoff, 'sample', 'A', new Date()), '020_010')!.first;
    await waitFor(() => expect(Number(screen.getByLabelText('Frame').textContent)).toBeLessThanOrEqual(first + N - 1));

    fireEvent.click(await screen.findByRole('button', { name: 'Auto-track' }));
    // Tracking done: step 2 is ticked and folded, Solve is next.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Solve camera' })).toBeTruthy(), { timeout: 20_000 });
    expect(document.querySelector('[data-step="features"]')?.classList.contains('step-done')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Solve camera' }));
    // The numbers that matter are in Details, large.
    const rmsStat = () => [...document.querySelectorAll('.stat')].find((s) => s.textContent?.includes('RMS error'))!;
    await waitFor(() => expect(rmsStat().textContent).toMatch(/px/), { timeout: 20_000 });
    const rms = Number(rmsStat().querySelector('.stat-value')!.textContent!.replace(/[^\d.]/g, ''));
    expect(rms).toBeLessThan(0.5);
    expect(document.querySelector('[data-step="solve"]')?.classList.contains('step-done')).toBe(true);
    expect(document.querySelectorAll('.error-graph rect').length).toBeGreaterThanOrEqual(N);
    expect(log).toEqual(['auto_track', 'solve']);

    // The 3D view says plainly when there is no WebGL 2.
    fireEvent.click(screen.getByRole('button', { name: '3D view' }));
    expect(screen.getByText(/needs WebGL 2/)).toBeTruthy();

    // Exporting writes into a package on disk: in the preview it says so.
    const exportButton = screen.getByRole('button', { name: /^Export camera/ }) as HTMLButtonElement;
    expect(exportButton.disabled).toBe(true);
    expect(exportButton.title).toMatch(/desktop app/);
  }, 60_000);

  it('opens a 2D-only shot in the 2D Track tab', async () => {
    render(<App api={trackBridge([])} />);
    await act(async () => undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Open sample project' }));
    const table = screen.getByRole('table', { name: 'Shot queue' });
    fireEvent.click(within(table).getAllByRole('row').find((r) => r.textContent?.includes('010_030'))!);
    fireEvent.click(screen.getByRole('button', { name: 'Open 2D Track' }));
    await act(async () => undefined);
    expect(screen.getByRole('tab', { name: '2D Track' }).getAttribute('aria-selected')).toBe('true');
    // The shot has no camera track: that tab is greyed, with the reason, but still opens.
    expect(screen.getByRole('tab', { name: 'Camera Track' }).className).toContain('missing');
    expect(screen.getByRole('button', { name: 'New planar' })).toBeTruthy();
  });
});
