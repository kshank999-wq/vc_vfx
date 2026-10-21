// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useRef, useState } from 'react';
import { SAMPLE_HANDOFF, createProject, parseHandoff, shotState, type Project } from '@vcvfx/domain';
import { CleanPlateWorkspace, composeCleanPlate, type CleanPlateMutation } from '../components/cleanplate/CleanPlateWorkspace';
import { createCleanPlatePreview } from '../cleanplate-preview';
import type { CleanPlateFrameView } from '../../shared/cleanplate/bridge-types';
import { stubBridge } from './bridge-stub';

/**
 * The Clean Plate workspace (addendum 10) with the browser preview's own
 * engine: alignment and reconstruction really run, on the sample's synthetic
 * panning shot (small, for speed). jsdom has no canvas pixels, so drawing is
 * skipped; the numbers and the project are what is checked.
 */

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement['getContext'];
});
afterEach(cleanup);

const NOW = new Date('2026-10-21T12:00:00Z');
const SHOT = '020_010';
const sample = (): Project => {
  const r = parseHandoff(JSON.stringify(SAMPLE_HANDOFF));
  if (!r.ok) throw new Error('bad sample');
  return createProject(r.handoff, 'sample', 'dit', NOW);
};

function Harness({ onProject, exportable = false }: { onProject(p: Project): void; exportable?: boolean }) {
  const [project, setProject] = useState(sample);
  const [frame, setFrame] = useState(1120);
  const preview = createCleanPlatePreview({ desktopOnly: (w) => `Available in the desktop app: ${w}`, progress: () => undefined, size: { width: 160, height: 90 } });
  const [api] = useState(() => stubBridge({ ...preview, cancelJob: async (id) => void preview.cancel(id) }));
  void exportable;
  const latest = useRef(project);
  const onCleanPlate = (fn: CleanPlateMutation) => {
    const r = fn(latest.current, 'Ana', NOW);
    if (!r.ok) throw new Error(r.reason);
    latest.current = r.project;
    setProject(r.project);
    onProject(r.project);
    return true;
  };
  return (
    <CleanPlateWorkspace
      api={api}
      project={project}
      shotId={SHOT}
      projectKey="k"
      canEdit
      busy={false}
      actor="Ana"
      frame={frame}
      onFrame={setFrame}
      onCleanPlate={onCleanPlate}
      runJob={async (_label, fn) => fn(`job-${Math.random()}`)}
      notify={(kind, text) => kind === 'error' && console.log('NOTIFY', text)}
    />
  );
}

describe('the Clean Plate workspace', () => {
  it('removes the sample’s subjects, builds a plate per frame, shows what is unresolved, takes guidance, and never approves', async () => {
    let project = sample();
    render(<Harness onProject={(p) => (project = p)} />);
    const steps = screen.getByRole('list', { name: 'Clean plate steps' });
    const doc = () => shotState(project, SHOT)!.cleanPlate!;
    const task = () => shotState(project, SHOT)!.tasks.find((t) => t.kind === 'clean_plate')!;

    // 1. What to remove: the sample shot comes rotoscoped.
    const use = await waitFor(() => within(steps).getByRole('button', { name: /Remove the crew member and the light stand/ }));
    await waitFor(() => expect((use as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(use);
    expect(doc().remove.map((r) => [r.source.type, r.label])).toEqual([
      ['roto', 'Crew member'],
      ['roto', 'Light stand'],
    ]);
    expect(shotState(project, SHOT)!.roto!.parts.map((p) => p.id)).toEqual(expect.arrayContaining(['crew_member', 'light_stand']));
    expect(task().state).toBe('processing');
    // The viewer now shows what is removed on this frame.
    fireEvent.click(screen.getByRole('tab', { name: 'What is removed' }));

    // 3. Build: the camera pans, so a plate per frame.
    const build = within(steps).getByRole('button', { name: 'Build clean plate' });
    fireEvent.click(build);
    await waitFor(() => expect(doc().frames.length).toBeGreaterThan(200), { timeout: 110_000 });
    expect(doc().runs[0]).toMatchObject({ mode: 'sequence', alignment: 'homography', taskVersion: 1 });
    expect(doc().suggestion).toMatchObject({ mode: 'sequence', static: false });
    expect(task().state).toBe('needs_review');
    expect(task().approval).toBeNull();
    // The stand hides the same wall in every frame: unresolved, and said so.
    expect(doc().runs[0]!.low).toBeGreaterThan(0.05);
    expect(doc().runs[0]!.coverage).toBeGreaterThan(0.5);
    expect(screen.getByRole('tab', { name: 'Unresolved (red)', selected: true })).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Low confidence').previousSibling?.textContent).toMatch(/\d+(\.\d)?%/));
    expect(screen.getByText('Mode (auto)').previousSibling?.textContent).toBe('Per frame');

    // 4. Review: problem frames to step through; prefer or leave out a frame.
    fireEvent.click(screen.getAllByRole('button', { name: 'Next problem ▸' })[0]!);
    await waitFor(() => expect(Number(screen.getByRole('slider', { name: 'Frame' }).getAttribute('aria-valuenow'))).not.toBe(1120));
    fireEvent.click(within(steps).getByRole('button', { name: 'Leave it out' }));
    const left = Number(screen.getByRole('slider', { name: 'Frame' }).getAttribute('aria-valuenow'));
    expect(doc().guidance.exclude).toEqual([left]);
    // That changed the settings: the build is stale, the review reopened for correction.
    expect(task().state).toBe('needs_correction');
    expect(within(steps).getByRole('button', { name: 'Build again (settings changed)' })).toBeTruthy();
    // 5. Export is the desktop's.
    const exportButton = within(steps).queryByRole('button', { name: 'Export clean plate v001' });
    expect(exportButton).toBeNull(); // waiting for a build of the current settings
    expect(within(steps).getByText('Build with the current settings first (step 3).')).toBeTruthy();
  }, 120_000);

  it('composes every view, with an A/B wipe to the source and the unresolved area in red', () => {
    const w = 4;
    const h = 1;
    const rgb = (v: number) => new Uint8ClampedArray(w * h * 3).fill(v);
    const view: CleanPlateFrameView = {
      frame: 1,
      width: w,
      height: h,
      source: rgb(10),
      hole: Uint8Array.from([0, 255, 255, 0]),
      plate: rgb(100),
      confidence: Uint8Array.from([255, 255, 0, 255]),
      unresolved: Uint8Array.from([0, 0, 255, 0]),
      stillFrame: null,
      built: 'current',
      metrics: null,
      viewLabel: '',
    };
    expect(composeCleanPlate(view, 'source', { on: false, x: 0 })[4]).toBe(10);
    expect(composeCleanPlate(view, 'plate', { on: false, x: 0 })[4]).toBe(100);
    const red = composeCleanPlate(view, 'unresolved', { on: false, x: 0 });
    expect(red[8]!).toBeGreaterThan(150); // pixel 2: unresolved, red
    expect(red[9]!).toBeLessThan(red[8]! / 2);
    expect(red[4]).toBe(100); // pixel 1: resolved, the plate
    const removed = composeCleanPlate(view, 'removed', { on: false, x: 0 });
    expect(removed[4]).not.toBe(10);
    expect(removed[0]).toBe(10);
    const wiped = composeCleanPlate(view, 'plate', { on: true, x: 0.5 });
    expect([wiped[0], wiped[12]]).toEqual([10, 100]);
  });
});
