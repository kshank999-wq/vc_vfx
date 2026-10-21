// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { SAMPLE_HANDOFF, createProject, parseHandoff, serializeProject } from '@vcvfx/domain';
import { App } from '../App';
import { createRotoPreview } from '../roto-preview';
import { stubBridge } from './bridge-stub';

/**
 * Paint-to-roto in the renderer (addendum 04), with the browser preview's
 * own roto: the Track engine really runs, on the sample's synthetic shot.
 * jsdom has no canvas pixels or PointerEvent, so frames are stand-in URLs and
 * pointer events are MouseEvents with a pointer id.
 */

beforeAll(() => {
  // No canvas in jsdom: drawing is skipped (the workspace checks for a context).
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement['getContext'];
  if (!('PointerEvent' in window)) {
    class PointerEventShim extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    }
    Object.assign(window, { PointerEvent: PointerEventShim });
  }
});
afterEach(cleanup);

const desktopOnly = (what: string) => `Available in the desktop app: ${what}`;

function rotoBridge() {
  const roto = createRotoPreview({ desktopOnly, progress: () => undefined });
  return stubBridge({
    viewerSources: async () => ({ ok: true, data: { source: { available: false, reason: 'none', encoding: null }, plates: [] } }),
    rotoSession: (i) => roto.session(i),
    rotoFrame: async (i) => ({ ok: true, data: { url: `blob:frame-${i.frame}`, frame: i.frame, viewLabel: 'sample' } }),
    rotoRun: (i) => roto.run(i),
    rotoMask: (i) => roto.mask(i),
    rotoExport: async () => ({ ok: false, error: desktopOnly('mattes are written into the shot package on disk.') }),
  });
}

async function openRoto() {
  render(<App api={rotoBridge()} />);
  await act(async () => undefined);
  fireEvent.click(screen.getByRole('button', { name: 'Open sample project' }));
  const table = screen.getByRole('table', { name: 'Shot queue' });
  fireEvent.click(within(table).getAllByRole('row')[1]!);
  fireEvent.click(screen.getByRole('button', { name: 'Open Roto' }));
  await act(async () => undefined);
  await waitFor(() => expect(screen.getByLabelText('Paint on the frame')).toBeTruthy());
  const canvas = screen.getByLabelText('Paint on the frame') as HTMLCanvasElement;
  // The canvas covers the frame: 640 × 338 on screen for a 4096 × 2160 plate.
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 338, right: 640, bottom: 338, x: 0, y: 0, toJSON: () => ({}) });
  return canvas;
}

function paint(canvas: HTMLCanvasElement, points: [number, number][]) {
  fireEvent.pointerDown(canvas, { clientX: points[0]![0], clientY: points[0]![1], button: 0 });
  for (const [x, y] of points.slice(1)) fireEvent.pointerMove(canvas, { clientX: x, clientY: y });
  fireEvent.pointerUp(canvas);
}

describe('the roto workspace', () => {
  it('opens from the roto task in the Roto tab with both engines, SAM 2 the desktop app’s', async () => {
    await openRoto();
    expect(screen.getByRole('tab', { name: 'Roto' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('button', { name: /Paint the subject/ }).getAttribute('aria-expanded')).toBe('true');
    expect((screen.getByRole('radio', { name: /Track \(classical\)/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('radio', { name: /SAM 2\.1/ }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /Download model/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('640 px (sample)')).toBeTruthy();
    expect(screen.getByLabelText('Frame').textContent).toBe('1009');
  });

  it('paints a key frame in plate pixels, segments it, propagates both ways and records confidence per frame', async () => {
    const canvas = await openRoto();
    fireEvent.click(screen.getByRole('button', { name: 'Include' }));
    paint(canvas, [
      [160, 52],
      [160, 200],
      [160, 290],
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Exclude' }));
    paint(canvas, [
      [95, 40],
      [95, 300],
    ]);
    paint(canvas, [
      [235, 40],
      [235, 300],
    ]);
    expect(screen.getByText(/key frame · 3 strokes/)).toBeTruthy();
    // The log has the strokes, attributed, in plate pixels (×6.4).
    fireEvent.click(screen.getByRole('button', { name: '◀ Propagate ▶' }));
    await waitFor(() => expect(screen.getByText(/Subject: 120 of 120 frames/)).toBeTruthy(), { timeout: 60000 });
    const cells = screen.getAllByRole('button', { name: /^Frame \d+$/ });
    expect(cells).toHaveLength(120);
    expect(cells.every((c) => (c as HTMLElement).style.background !== '')).toBe(true);
    // The steps move on: painted and propagated are ticked.
    expect(document.querySelector('[data-step="paint"]')?.classList.contains('step-done')).toBe(true);
    expect(document.querySelector('[data-step="propagate"]')?.classList.contains('step-done')).toBe(true);
    // Processing finishing puts roto up for review; nothing approves it.
    fireEvent.click(screen.getByRole('tab', { name: 'Shots' }));
    const task = screen.getAllByText('Paint-to-roto').find((el) => el.classList.contains('task-name'))!.closest('li')!;
    expect(within(task).getByText('Needs Review')).toBeTruthy();
    // Approval needs the exported mattes (the desktop app writes them).
    expect((within(task).getByRole('button', { name: 'Approve…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText('roto.propagated').length).toBeGreaterThan(0);
    expect(document.body.textContent).toMatch(/Subject frame 1009: include stroke, \d+ points, radius \d+px/);
  }, 90000);

  it('adds component parts under the subject, sets how they combine; flagging waits for a matte', async () => {
    const canvas = await openRoto();
    fireEvent.change(screen.getByLabelText('New part name'), { target: { value: 'Right arm' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    const parts = screen.getByRole('list', { name: 'Roto parts' });
    expect(within(parts).getAllByRole('listitem').map((li) => li.querySelector('.part-name')?.textContent)).toEqual(['Subject', 'Right arm']);
    fireEvent.change(within(parts).getByLabelText('Right arm combines by'), { target: { value: 'subtract' } });
    expect((within(parts).getByLabelText('Right arm combines by') as HTMLSelectElement).value).toBe('subtract');
    // Paint the arm on its own part, then flag nothing yet: there is no matte to flag.
    fireEvent.click(within(parts).getByRole('button', { name: 'Right arm' }));
    paint(canvas, [
      [162, 120],
      [162, 180],
    ]);
    expect(document.querySelector('.info-line .part-chip')?.textContent).toBe('Right arm');
    // Reviewing waits for a propagated matte: there is nothing to flag yet.
    fireEvent.click(screen.getByRole('button', { name: /Review problem frames/ }));
    expect(screen.getByText('Propagate first (step 2).')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Flag' })).toBeNull();
    // [ and ] change the brush.
    const before = (screen.getByLabelText('Brush size') as HTMLInputElement).value;
    fireEvent.keyDown(window, { key: ']' });
    expect(Number((screen.getByLabelText('Brush size') as HTMLInputElement).value)).toBeGreaterThan(Number(before));
  });

  it('offers to add the roto task to a shot without one', async () => {
    const parsed = parseHandoff(JSON.stringify(SAMPLE_HANDOFF));
    if (!parsed.ok) throw new Error('sample');
    render(<App api={rotoBridge()} />);
    await act(async () => undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Open sample project' }));
    const table = screen.getByRole('table', { name: 'Shot queue' });
    fireEvent.doubleClick(within(table).getAllByRole('row')[2]!);
    await act(async () => undefined);
    fireEvent.click(screen.getByRole('tab', { name: 'Roto' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Roto to this shot' }));
    await act(async () => undefined);
    expect(screen.queryByRole('button', { name: 'Add Roto to this shot' })).toBeNull();
    expect(screen.getByLabelText('Paint on the frame')).toBeTruthy();
    expect(serializeProject(createProject(parsed.handoff, 'sample', 't', new Date()))).toBeTruthy();
  });
});
