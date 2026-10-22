// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useRef, useState } from 'react';
import { SAMPLE_HANDOFF, createProject, parseHandoff, shotState, textureDoc, type Project } from '@vcvfx/domain';
import { TextureWorkspace, composeTexture, type TextureMutation } from '../components/texture/TextureWorkspace';
import { createTexturePreview } from '../texture-preview';
import type { TextureImageView } from '../../shared/texture/bridge-types';
import { stubBridge } from './bridge-stub';

/**
 * The Textures workspace (addendum 12) with the browser preview's own engine:
 * the sample storeroom set is made in the page (small, for speed) and the
 * textures, the scan's planes and the placements are really built. jsdom has
 * no canvas pixels, so drawing is skipped; the steps, the numbers and the
 * project are what is checked.
 */

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement['getContext'];
});
afterEach(cleanup);

const NOW = new Date('2026-10-22T12:00:00Z');
const SHOT = '040_010';
const sample = (): Project => {
  const r = parseHandoff(JSON.stringify(SAMPLE_HANDOFF));
  if (!r.ok) throw new Error('bad sample');
  return createProject(r.handoff, 'sample', 'dit', NOW);
};

function Harness({ onProject }: { onProject(p: Project): void }) {
  const [project, setProject] = useState(sample);
  const preview = createTexturePreview({
    desktopOnly: (w) => `Available in the desktop app: ${w}`,
    progress: () => undefined,
    set: { photo: { width: 320, height: 240, supersample: 1 }, panorama: { width: 1024, supersample: 1, heading: 25 }, scan: { spacing: 0.1, up: 'z' } },
    maxTexture: 96,
  });
  const [api] = useState(() => stubBridge({ ...preview, cancelJob: async (id) => void preview.cancel(id) }));
  const latest = useRef(project);
  const onTexture = (fn: TextureMutation) => {
    const r = fn(latest.current, 'Ana', NOW);
    if (!r.ok) throw new Error(r.reason);
    latest.current = r.project;
    setProject(r.project);
    onProject(r.project);
    return true;
  };
  return <TextureWorkspace api={api} project={project} shotId={SHOT} projectKey="k" canEdit busy={false} actor="Ana" onTexture={onTexture} runJob={async (_label, fn) => fn(`job-${Math.random()}`)} notify={(kind, text) => kind === 'error' && console.log('NOTIFY', text)} />;
}

describe('the Textures workspace', () => {
  it('adds the sample set, marks its regions, builds, reviews the placement, and never approves', async () => {
    let project = sample();
    render(<Harness onProject={(p) => (project = p)} />);
    const steps = screen.getByRole('list', { name: 'Texture steps' });
    const doc = () => textureDoc(shotState(project, SHOT))!;
    const task = () => shotState(project, SHOT)!.tasks.find((t) => t.kind === 'texture_extraction')!;
    expect([...steps.querySelectorAll('.step-title > span:first-child')].map((x) => x.textContent)).toEqual(['Add references', 'Mark a region', 'Correct and build', 'Make seamless', 'Placement on the scan', 'Export textures v001']);
    expect(within(screen.getByRole('tablist', { name: 'View' })).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Photo', 'Rectified', 'Delit', 'Tiled 3×3', 'Panorama', 'Scan']);

    // 1. The references: the sample set (photos, the panorama, the scan), read only.
    const use = await waitFor(() => within(steps).getByRole('button', { name: /Use the sample set/ }));
    await waitFor(() => expect((use as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.click(use);
    });
    await waitFor(() => expect(doc().references.map((r) => r.kind)).toEqual(['photo', 'photo', 'photo', 'panorama', 'scan']));
    expect(doc().references[0]).toMatchObject({ from: 'sample', width: 320, height: 240, encoding: 'srgb', camera: { filmBackWidthMm: 36 } });
    expect(doc().references[4]!.points).toBeGreaterThan(1000);
    expect(task().state).toBe('processing');
    expect(within(steps).getAllByText(/storeroom_wall_A.jpg/).length).toBeGreaterThan(0);

    // 2. The regions, with their measured sizes.
    const mark = await waitFor(() => within(steps).getByRole('button', { name: /Mark the sample’s three regions/ }));
    fireEvent.click(mark);
    expect(doc().regions.map((r) => [r.name, r.size?.width])).toEqual([
      ['Brick wall', 1.6],
      ['Plaster wall', 1.6],
      ['Floor tiles', 2],
    ]);
    // The region's size can be changed by hand (logged, a new settings revision).
    const rev = doc().revision;
    const width = screen.getByLabelText('Real width') as HTMLInputElement;
    fireEvent.change(width, { target: { value: '1.7' } });
    fireEvent.blur(width);
    expect(doc().regions[0]!.size).toEqual({ width: 1.7, height: 1.2, units: 'm' });
    expect(doc().revision).toBe(rev + 1);
    fireEvent.change(width, { target: { value: '1.6' } });
    fireEvent.blur(width);

    // 4. Make the brick wall tile (before the build, so one build shows it).
    fireEvent.click(within(steps).getByRole('button', { name: 'Across and down' }));
    expect(doc().regions[0]!.settings.tile).toBe('xy');

    // 3. Build.
    const build = within(steps).getByRole('button', { name: 'Build textures' });
    await act(async () => {
      fireEvent.click(build);
    });
    await waitFor(() => expect(doc().records).toHaveLength(3), { timeout: 60_000 });
    expect(task().state).toBe('needs_review');
    expect(task().approval).toBeNull();
    expect(doc().planes).toHaveLength(6);
    expect(doc().records[0]!.metrics.seamScore).not.toBeNull();
    expect(doc().placements.length).toBeGreaterThan(0);
    expect(doc().placements.every((x) => x.decision === 'pending')).toBe(true);
    const info = screen.getByText('Regions built').closest('.stat')!;
    expect(info.textContent).toContain('3');

    // 6. Export is the desktop app's; approval is never reached from here.
    const exportButton = within(steps).getByRole('button', { name: 'Export textures v001' }) as HTMLButtonElement;
    expect(exportButton.disabled).toBe(true);
    expect(within(steps).getByText(/the desktop app does it/)).toBeTruthy();

    // 5. Placement: accept the suggestion for the first photo, then reject and undo.
    const accept = within(steps).getByRole('button', { name: 'Accept' });
    fireEvent.click(accept);
    expect(doc().placements.find((x) => x.photoId === doc().references[0]!.id)!.decision).toBe('accepted');
    expect(project.log.at(-1)!.action === 'texture.placement' || project.log.at(-2)!.action === 'texture.placement').toBe(true);
    fireEvent.click(within(steps).getByRole('button', { name: 'Reject' }));
    expect(doc().placements.find((x) => x.photoId === doc().references[0]!.id)!.decision).toBe('rejected');
    fireEvent.click(within(steps).getByRole('button', { name: 'Undo' }));
    expect(doc().placements.find((x) => x.photoId === doc().references[0]!.id)!.decision).toBe('pending');
    // The region onto a plane by hand.
    const plane = within(steps).getByLabelText('Region plane') as HTMLSelectElement;
    const floor = doc().planes.find((p) => p.label === 'floor')!;
    fireEvent.change(plane, { target: { value: floor.id } });
    expect(doc().regions[0]!.target.planeId).toBe(floor.id);
    fireEvent.change(plane, { target: { value: '' } });

    // The views: the delit texture of the region comes from the build.
    fireEvent.click(screen.getByRole('tab', { name: 'Delit' }));
    await waitFor(() => expect(screen.getByLabelText('Delit of Brick wall')).toBeTruthy());

    // Placement decisions are settings: the build is stale and export waits for a new one.
    expect(within(steps).getByText('Build with the current settings first (step 3).')).toBeTruthy();
    expect(task().state).not.toBe('approved');
  }, 120_000);
});

describe('composing the viewer', () => {
  const view = (w: number, h: number, v: number): TextureImageView => ({ width: w, height: h, rgb: new Uint8ClampedArray(w * h * 3).fill(v), mask: null, built: 'current', label: '' });
  it('repeats a tile three by three and wipes the original in on the left', () => {
    const t = composeTexture(view(4, 2, 100), { tile: 3 });
    expect([t.width, t.height]).toEqual([12, 6]);
    expect(t.data[4 * (5 * 12 + 11)]).toBe(100);
    const w = composeTexture(view(10, 2, 200), { wipe: { x: 0.5, other: view(10, 2, 50) } });
    expect(w.data[0]).toBe(50);
    expect(w.data[4 * 9]).toBe(200);
    const masked = composeTexture({ ...view(2, 1, 200), mask: Uint8Array.from([255, 0]) }, { dimOutside: true });
    expect(masked.data[0]).toBe(200);
    expect(masked.data[4]).toBe(70);
  });
});
