// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useRef, useState } from 'react';
import { SAMPLE_HANDOFF, addTask, createProject, isolateDoc, parseHandoff, shotState, type PrepTaskKind, type Project } from '@vcvfx/domain';
import { IsolateWorkspace, composeIsolate, type IsolateMutation } from '../components/isolate/IsolateWorkspace';
import { createIsolatePreview } from '../isolate-preview';
import type { IsolateFrameView } from '../../shared/isolate/bridge-types';
import { stubBridge } from './bridge-stub';

/**
 * The Sky & BG workspace (addendum 11) with the browser preview's own
 * engine: the sky is found, the subject propagated and the plates rebuilt for
 * real, on the sample's synthetic rooftop shot (small, for speed). jsdom has
 * no canvas pixels, so drawing is skipped; the numbers and the project are
 * what is checked.
 */

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement['getContext'];
  // jsdom has no PointerEvent: a mouse event with a pointer id stands in, so painting carries its coordinates.
  if (!('PointerEvent' in window))
    (window as unknown as { PointerEvent: unknown }).PointerEvent = class extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    };
});
afterEach(cleanup);

const NOW = new Date('2026-10-21T12:00:00Z');
const SHOT = '030_010';
const sample = (): Project => {
  const r = parseHandoff(JSON.stringify(SAMPLE_HANDOFF));
  if (!r.ok) throw new Error('bad sample');
  return createProject(r.handoff, 'sample', 'dit', NOW);
};

function Harness({ onProject, initial = sample() }: { onProject(p: Project): void; initial?: Project }) {
  const [project, setProject] = useState(initial);
  const [frame, setFrame] = useState(1010);
  const [api] = useState(() => {
    const preview = createIsolatePreview({ desktopOnly: (w) => `Available in the desktop app: ${w}`, progress: () => undefined, size: { width: 192, height: 108 } });
    return stubBridge({ ...preview, cancelJob: async (id) => void preview.cancel(id) });
  });
  const latest = useRef(project);
  const onIsolate = (fn: IsolateMutation) => {
    const r = fn(latest.current, 'Ana', NOW);
    if (!r.ok) throw new Error(r.reason);
    latest.current = r.project;
    setProject(r.project);
    onProject(r.project);
    return true;
  };
  const onAddTask = (kind: PrepTaskKind) => onIsolate((p, a, t) => addTask(p, SHOT, kind, a, t));
  return (
    <IsolateWorkspace
      api={api}
      project={project}
      shotId={SHOT}
      projectKey="k"
      canEdit
      busy={false}
      actor="Ana"
      frame={frame}
      onFrame={setFrame}
      onIsolate={onIsolate}
      onAddTask={onAddTask}
      runJob={async (_label, fn) => fn(`job-${Math.random()}`)}
      notify={(kind, text) => kind === 'error' && console.log('NOTIFY', text)}
    />
  );
}

describe('the Sky & BG workspace', () => {
  it('isolates the sky with no seed, then the runner from his roto part; each a build for review, never an approval', async () => {
    let project = sample();
    render(<Harness onProject={(p) => (project = p)} />);
    const steps = screen.getByRole('list', { name: 'Isolation steps' });
    const task = (k: PrepTaskKind) => shotState(project, SHOT)!.tasks.find((t) => t.kind === k)!;
    for (const what of ['What to isolate: the sky', 'Find the sky', 'Build', 'Review & fix', 'Export sky v001']) expect(within(steps).getByText(what)).toBeTruthy();

    // The sky needs nothing: build it.
    const build = await waitFor(() => within(steps).getByRole('button', { name: 'Build sky matte' }));
    await waitFor(() => expect((build as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(build);
    await waitFor(() => expect(isolateDoc(shotState(project, SHOT), 'sky')?.frames.length).toBe(56), { timeout: 110_000 });
    const sky = isolateDoc(shotState(project, SHOT), 'sky')!;
    expect(sky.runs[0]).toMatchObject({ engine: 'sky-cues@1.1.0', alignment: 'homography', taskVersion: 1 });
    expect(task('sky_replacement').state).toBe('needs_review');
    expect(task('sky_replacement').approval).toBeNull();
    expect(task('background_removal').state).toBe('pending');
    expect(screen.getByRole('tab', { name: 'Overlay', selected: true })).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Confidence').previousSibling?.textContent).toMatch(/^0\.\d\d$/));
    for (const v of ['Matte', 'Foreground', 'Sky plate']) expect((screen.getByRole('tab', { name: v }) as HTMLButtonElement).disabled).toBe(false);

    // Export is the desktop's.
    expect(within(steps).getByText('Exporting writes into the shot package on disk: the desktop app does it.')).toBeTruthy();
    // Review: flag a frame; paint a correction.
    fireEvent.click(within(steps).getByRole('button', { name: 'Flag' }));
    expect(isolateDoc(shotState(project, SHOT), 'sky')!.frames.find((f) => f.frame === 1010)!.status).toBe('flagged');
    const keep = within(steps).getAllByRole('button', { name: /Keep in front/ })[0]!;
    fireEvent.click(keep);
    expect(keep.getAttribute('aria-pressed')).toBe('true');
    // Paint a correction on this frame (jsdom lays nothing out: the stage is 0 × 0, so the picture's centre is at 0, 0).
    const stage = document.querySelector('.key-stage')!;
    fireEvent.pointerDown(stage, { clientX: 20, clientY: -40, pointerId: 1, buttons: 1 });
    for (let i = 1; i <= 6; i += 1) fireEvent.pointerMove(stage, { clientX: 20 + 3 * i, clientY: -40 + i, pointerId: 1, buttons: 1 });
    fireEvent.pointerUp(stage, { clientX: 38, clientY: -34, pointerId: 1 });
    const painted = isolateDoc(shotState(project, SHOT), 'sky')!.keyFrames;
    expect(painted).toHaveLength(1);
    expect(painted[0]).toMatchObject({ frame: 1010, correction: true, strokes: [{ mode: 'include' }] });
    expect(painted[0]!.strokes[0]!.points.length).toBeGreaterThan(3);
    expect(task('sky_replacement').state).toBe('needs_correction');
    expect(within(steps).getAllByText('1 stroke on frame 1010').length).toBeGreaterThan(0);
    fireEvent.click(within(steps).getAllByRole('button', { name: 'Undo last' })[0]!);
    expect(isolateDoc(shotState(project, SHOT), 'sky')!.keyFrames).toHaveLength(0);
    fireEvent.click(keep);
    // Painting and taking it back changed the settings: the export waits for a build of them.
    expect(within(steps).getByText('Build with the current settings first (step 3).')).toBeTruthy();

    const skyRevision = isolateDoc(shotState(project, SHOT), 'sky')!.revision;
    // The subject: switch, take the sample's roto, build.
    fireEvent.click(within(steps).getByRole('button', { name: 'Subject from background' }));
    await waitFor(() => expect(within(steps).getByText('What to isolate: a subject')).toBeTruthy());
    const use = await waitFor(() => within(steps).getByRole('button', { name: /Use the runner \(sample roto\)/ }));
    await waitFor(() => expect((use as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(use);
    expect(isolateDoc(shotState(project, SHOT), 'background')!.seed).toMatchObject({ mode: 'roto', partId: 'runner' });
    expect(task('background_removal').state).toBe('processing');
    const buildSubject = within(steps).getByRole('button', { name: 'Build subject matte' });
    await waitFor(() => expect((buildSubject as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(buildSubject);
    await waitFor(() => expect(isolateDoc(shotState(project, SHOT), 'background')?.frames.length).toBe(56), { timeout: 110_000 });
    expect(task('background_removal').state).toBe('needs_review');
    expect(screen.getByRole('tab', { name: 'Background plate' })).toBeTruthy();
    // The sky's isolation is untouched by the subject's.
    expect(isolateDoc(shotState(project, SHOT), 'sky')!.revision).toBe(skyRevision);
    // A setting change makes the build stale and reopens the review for correction.
    fireEvent.click(within(steps).getByText('Edge and time'));
    fireEvent.click(within(steps).getByRole('button', { name: 'Leave it' }));
    expect(task('background_removal').state).toBe('needs_correction');
    expect(within(steps).getByRole('button', { name: 'Build again (changed)' })).toBeTruthy();
  }, 240_000);

  it('offers the task the shot is missing', async () => {
    const r = parseHandoff(JSON.stringify({ ...SAMPLE_HANDOFF, shots: SAMPLE_HANDOFF.shots.map((s) => (s.shotId === SHOT ? { ...s, tasks: [{ kind: 'sky_replacement' }] } : s)) }));
    if (!r.ok) throw new Error('bad');
    let project = createProject(r.handoff, 'sample', 'dit', NOW);
    render(<Harness initial={project} onProject={(p) => (project = p)} />);
    const steps = screen.getByRole('list', { name: 'Isolation steps' });
    expect((within(steps).getByRole('button', { name: 'Subject from background' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(steps).getByRole('button', { name: 'Add Background removal' }));
    expect(shotState(project, SHOT)!.tasks.map((t) => t.kind)).toContain('background_removal');
  });

  it('composes every view, with an A/B wipe to the source', () => {
    const w = 4;
    const h = 1;
    const rgb = (v: number) => new Uint8ClampedArray(w * h * 3).fill(v);
    const view: IsolateFrameView = {
      frame: 1,
      width: w,
      height: h,
      source: rgb(10),
      matte: Uint8Array.from([0, 255, 128, 255]),
      foreground: rgb(200),
      plate: rgb(100),
      confidence: Uint8Array.from([255, 255, 40, 255]),
      band: Uint8Array.from([0, 0, 255, 0]),
      unresolved: Uint8Array.from([0, 255, 0, 0]),
      built: 'current',
      metrics: null,
      viewLabel: '',
    };
    expect(composeIsolate(view, 'source', { on: false, x: 0 })[4]).toBe(10);
    const matte = composeIsolate(view, 'matte', { on: false, x: 0 });
    expect([matte[0], matte[4], matte[8]]).toEqual([0, 255, 128]);
    const fg = composeIsolate(view, 'foreground', { on: false, x: 0 });
    expect(fg[4]).toBe(200); // solid: the foreground
    expect(fg[0]).toBeLessThan(120); // clear: the checkerboard
    const plate = composeIsolate(view, 'plate', { on: false, x: 0 });
    expect(plate[0]).toBe(100);
    expect(plate[4]!).toBeGreaterThan(150); // unseen: red
    expect(plate[5]!).toBeLessThan(plate[4]! / 2);
    const overlay = composeIsolate(view, 'overlay', { on: false, x: 0 });
    expect(overlay[0]!).toBeGreaterThan(overlay[1]!); // the sky side tinted magenta
    expect(overlay[4]).toBe(10); // solid foreground untouched
    expect(overlay[8]!).toBeGreaterThan(150); // a doubtful edge: red
    const wiped = composeIsolate(view, 'plate', { on: true, x: 0.5 });
    expect([wiped[0], wiped[12]]).toEqual([10, 100]);
  });
});
