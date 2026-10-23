// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SAMPLE_HANDOFF, createProject, parseHandoff, setShotPixelAspect, type Project } from '@vcvfx/domain';
import { Viewer } from '../components/Viewer';
import { PixelAspectViewProvider } from '../components/FrameBox';
import { clientToImage, fitFrame, imageToStage, markerRadii, stageToImage } from '../frame-fit';
import { stubBridge } from './bridge-stub';

/**
 * Showing non-square plates (addendum 17). The picture is drawn de-squeezed
 * in the view only; overlays (corners, strokes, track points) are kept in
 * image pixels and drawn through the same box, so the mapping between the
 * screen and the image is exact both ways — checked here with numbers, and
 * on the real Viewer in jsdom with a measured stage.
 */

const STAGE = { width: 1000, height: 500 };
let observed: ResizeObserverCallback[] = [];

beforeAll(() => {
  // jsdom has no layout: every observed stage measures 1000 × 500.
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    constructor(private cb: ResizeObserverCallback) {
      observed.push(cb);
    }
    observe() {
      this.cb([{ contentRect: { ...STAGE, x: 0, y: 0, top: 0, left: 0, right: STAGE.width, bottom: STAGE.height } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    disconnect() {}
    unobserve() {}
  };
});
afterEach(() => {
  cleanup();
  observed = [];
});

describe('the frame box and its mapping', () => {
  it('is the de-squeezed shape, contained and centred', () => {
    // 1280 × 1080 at 1.5 is shown 1920 × 1080: in a 1000 × 500 stage, 888.9 × 500.
    const b = fitFrame(STAGE, { width: 1280, height: 1080 }, 1.5);
    expect(b.width / b.height).toBeCloseTo(1920 / 1080, 9);
    expect(b.height).toBeCloseTo(500, 9);
    expect(b.left).toBeCloseTo((1000 - b.width) / 2, 9);
    // Square pixels: the plain contain fit the workspaces always used.
    const sq = fitFrame(STAGE, { width: 1920, height: 1080 }, 1);
    expect(sq.scale).toBeCloseTo(Math.min(1000 / 1920, 500 / 1080), 12);
  });

  it('maps image pixels to the screen and back exactly, at 2, 1.5, 0.909 and 1', () => {
    for (const [a, size] of [[2, { width: 2048, height: 1716 }], [1.5, { width: 1280, height: 1080 }], [10 / 11, { width: 720, height: 480 }], [1, { width: 1920, height: 1080 }]] as const) {
      for (const [x, y] of [[0, 0], [size.width, size.height], [123.25, 456.5], [size.width / 2, 7]] as [number, number][]) {
        const s = imageToStage(STAGE, size, a, x, y);
        const back = stageToImage(STAGE, size, a, s.x, s.y)!;
        expect(back.x).toBeCloseTo(x, 9);
        expect(back.y).toBeCloseTo(y, 9);
      }
      // A horizontal step of one image pixel is `a` times a vertical one on screen.
      const p0 = imageToStage(STAGE, size, a, 100, 100);
      const px = imageToStage(STAGE, size, a, 101, 100);
      const py = imageToStage(STAGE, size, a, 100, 101);
      expect((px.x - p0.x) / (py.y - p0.y)).toBeCloseTo(a, 9);
      expect(stageToImage(STAGE, size, a, -5, 250)).toBeNull();
    }
  });

  it('a marker drawn with radii r / a, r reads as a circle on screen', () => {
    const [rx, ry] = markerRadii(10, 2);
    const size = { width: 2048, height: 1716 };
    const c = imageToStage(STAGE, size, 2, 500, 500);
    const right = imageToStage(STAGE, size, 2, 500 + rx, 500);
    const down = imageToStage(STAGE, size, 2, 500, 500 + ry);
    expect(right.x - c.x).toBeCloseTo(down.y - c.y, 9);
  });

  it('a pointer on an element maps through its bounding box', () => {
    const el = document.createElement('div');
    el.getBoundingClientRect = () => ({ left: 40, top: 30, width: STAGE.width, height: STAGE.height, right: 1040, bottom: 530, x: 40, y: 30, toJSON: () => ({}) });
    const size = { width: 1280, height: 1080 };
    const s = imageToStage(STAGE, size, 1.5, 640, 540);
    const p = clientToImage(el, size, 1.5, s.x + 40, s.y + 30)!;
    expect(p.x).toBeCloseTo(640, 9);
    expect(p.y).toBeCloseTo(540, 9);
  });
});

function project(par: number | null): Project {
  const raw = JSON.parse(JSON.stringify(SAMPLE_HANDOFF)) as { shots: Record<string, unknown>[] };
  raw.shots[0]!['resolution'] = { width: 1280, height: 1080 };
  const h = parseHandoff(JSON.stringify(raw));
  if (!h.ok) throw new Error('sample');
  let p = createProject(h.handoff, '/drive/handoff.json', 'Ana', new Date('2026-10-22T10:00:00Z'));
  if (par !== null) {
    const r = setShotPixelAspect(p, '010_020', { value: par }, 'Ana', new Date('2026-10-22T10:00:00Z'));
    if (!r.ok) throw new Error(r.reason);
    p = r.project;
  }
  return p;
}

function renderViewer(p: Project) {
  const api = stubBridge({
    viewerSources: async () => ({ ok: true, data: { source: { available: true, reason: null, encoding: null }, plates: [] } }),
    viewerFrame: async (req) => ({ ok: true, data: { url: `data:image/png;base64,AAAA#${req.frame}`, frame: req.frame, viewLabel: 'test view' } }),
  });
  return render(
    <PixelAspectViewProvider>
      <Viewer api={api} project={p} shotId="010_020" projectKey="k" canEdit frame={1001} onFrame={() => undefined} onToggleMark={() => undefined} />
    </PixelAspectViewProvider>,
  );
}

describe('the Viewer on a non-square shot', () => {
  it('draws the frame de-squeezed (1280 × 1080 at 1.5 shown 16:9), says so, and shows it squeezed on request', async () => {
    const { container } = renderViewer(project(1.5));
    await waitFor(() => expect(container.querySelector('.frame-box.fitted')).not.toBeNull());
    const box = container.querySelector('.frame-box.fitted') as HTMLElement;
    const ratio = () => parseFloat(box.style.width) / parseFloat(box.style.height);
    expect(ratio()).toBeCloseTo(1920 / 1080, 6);
    expect(box.dataset['pixelAspect']).toBe('1.5');
    expect(screen.getByText(/Pixel aspect 1\.5 · 1280×1080 shown 1920×1080/)).toBeTruthy();
    const tag = screen.getByRole('button', { name: /PAR 1\.5 · de-squeezed/ });
    fireEvent.click(tag);
    await waitFor(() => expect(screen.getByRole('button', { name: /PAR 1\.5 · squeezed/ })).toBeTruthy());
    expect(ratio()).toBeCloseTo(1280 / 1080, 6);
    expect(box.dataset['pixelAspect']).toBe('1');
  });

  it('a square shot shows no tag, and a known non-square raster left square is flagged', async () => {
    const { container } = renderViewer(project(null));
    await waitFor(() => expect(container.querySelector('.frame-box.fitted')).not.toBeNull());
    expect(screen.queryByRole('button', { name: /PAR / })).toBeNull();
    // 1280 × 1080 with nothing saying otherwise: square, but warned.
    const label = screen.getByText(/Pixel aspect 1 ⚠/);
    expect(label.getAttribute('title')).toMatch(/usually DVCPRO HD 1080/);
  });
});
