// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useRef, useState } from 'react';
import { SAMPLE_HANDOFF, createProject, parseHandoff, shotState, type Project } from '@vcvfx/domain';
import { KeyWorkspace, composeMode, type KeyMutation } from '../components/key/KeyWorkspace';
import { createKeyPreview } from '../key-preview';
import { stubBridge } from './bridge-stub';

/**
 * The Key workspace (addendum 09) with the browser preview's own keyer: the
 * engine really runs, on the sample's synthetic green-screen shot. jsdom has
 * no canvas pixels, so drawing is skipped; the numbers and the project are
 * what is checked.
 */

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement['getContext'];
});
afterEach(cleanup);

const NOW = new Date('2026-10-21T12:00:00Z');
const sample = (): Project => {
  const r = parseHandoff(JSON.stringify(SAMPLE_HANDOFF));
  if (!r.ok) throw new Error('bad sample');
  return createProject(r.handoff, 'sample', 'dit', NOW);
};

function Harness({ onProject }: { onProject(p: Project): void }) {
  const [project, setProject] = useState(sample);
  const [frame, setFrame] = useState(1010);
  const keying = createKeyPreview({ desktopOnly: (w) => `Available in the desktop app: ${w}`, progress: () => undefined });
  const [api] = useState(() => stubBridge({ ...keying, cancelJob: async (id) => void keying.cancel(id) }));
  // The app applies each mutation to the latest project (its own ref), so two in a row compose.
  const latest = useRef(project);
  const onKey = (fn: KeyMutation) => {
    const r = fn(latest.current, 'Ana', NOW);
    if (!r.ok) throw new Error(r.reason);
    latest.current = r.project;
    setProject(r.project);
    onProject(r.project);
    return true;
  };
  return (
    <KeyWorkspace
      api={api}
      project={project}
      shotId="010_020"
      projectKey="k"
      canEdit
      busy={false}
      actor="Ana"
      frame={frame}
      onFrame={setFrame}
      onKey={onKey}
      runJob={async (_label, fn) => fn(`job-${Math.random()}`)}
      notify={(kind, text) => kind === 'error' && console.log('NOTIFY', text)}
      onAddKeyTask={() => undefined}
    />
  );
}

describe('the Key workspace', () => {
  it('auto keys in one click, processes the shot, finds the bad frame, and repairs with roto', async () => {
    let project = sample();
    render(<Harness onProject={(p) => (project = p)} />);
    const steps = screen.getByRole('list', { name: 'Key steps' });
    await waitFor(() => expect((within(steps).getByRole('button', { name: 'Auto key' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(steps).getByRole('button', { name: 'Auto key' }));
    await waitFor(() => expect(shotState(project, '010_020')!.key?.screen?.kind).toBe('green'), { timeout: 20_000 });
    // The handoff's background plate became the despill reference.
    expect(shotState(project, '010_020')!.key!.despill.background).toMatchObject({ kind: 'reference', path: 'VFX/SCENE_12A/BG/city_night_plate.exr' });
    expect(shotState(project, '010_020')!.tasks.find((t) => t.kind === 'key')!.state).toBe('processing');
    // The review key of the frame arrives: its numbers in Details.
    await waitFor(() => expect(screen.getByText('Matte quality, frame 1010').previousSibling?.textContent).toMatch(/\d+%/), { timeout: 20_000 });
    expect(screen.getByRole('tab', { name: 'Over background', selected: true })).toBeTruthy();

    // Process the whole shot: the frame the preview's screen light half fails on is found.
    const openStep = (title: RegExp, button: string | RegExp) => {
      if (!within(steps).queryByRole('button', { name: button })) fireEvent.click(within(steps).getByRole('button', { name: title }));
      return within(steps).getByRole('button', { name: button });
    };
    const processButton = openStep(/Process shot & review/, /Process \d+ frames/);
    const count = Number(/Process (\d+) frames/.exec(processButton.textContent ?? '')![1]);
    expect(count).toBeGreaterThan(100);
    fireEvent.click(processButton);
    await waitFor(() => expect(shotState(project, '010_020')!.key!.frames).toHaveLength(count), { timeout: 60_000 });
    const key = shotState(project, '010_020')!.key!;
    const bad = key.frames[0]!.frame + Math.round(count * 0.62);
    expect(key.frames.filter((f) => f.reason).map((f) => f.frame)).toContain(bad);
    expect(shotState(project, '010_020')!.tasks.find((t) => t.kind === 'key')!.state).toBe('needs_review');
    fireEvent.click(screen.getAllByRole('button', { name: 'Next problem ▸' })[0]!);
    await waitFor(() => expect(screen.getByRole('slider', { name: 'Frame' }).getAttribute('aria-valuenow')).toBe(String(bad)));

    // Repair with roto: a roto part seeded from this frame's key, linked as a repair.
    fireEvent.click(openStep(/Repair with roto/, `Repair frame ${bad} with roto`));
    await waitFor(() => expect(shotState(project, '010_020')!.key!.links.map((l) => l.kind)).toEqual(['repair']), { timeout: 20_000 });
    expect(shotState(project, '010_020')!.roto!.parts.map((p) => p.id)).toContain('key_repair_1');
    // Adding the repair changed the settings: the shot asks to be processed again before export.
    expect(within(steps).getByText(/settings changed since: process again/)).toBeTruthy();
  }, 120_000);

  it('composes every review mode, with an A/B wipe to the source', () => {
    const w = 4;
    const h = 2;
    const n = w * h;
    const rgb = (v: number) => new Uint8ClampedArray(n * 3).fill(v);
    const view = {
      frame: 1,
      width: w,
      height: h,
      source: rgb(10),
      premult: rgb(20),
      comp: rgb(30),
      alpha: Uint8Array.from([0, 128, 255, 255, 0, 128, 255, 255]),
      core: Uint8Array.from([0, 0, 1, 1, 0, 0, 1, 1]),
      garbage: null,
      holdout: null,
      repair: null,
      spill: null,
      subject: Uint8Array.from([0, 0, 255, 255, 0, 0, 255, 255]),
      subjectConfidence: 0.9,
      shadow: Uint8Array.from([200, 0, 0, 0, 0, 0, 0, 0]),
      confidence: 1,
      metrics: { screenCoverage: 0.5, coreNoise: 0, edgeActivity: 0.25, holes: 0, residual: 0 },
      screen: [0.1, 0.4, 0.1] as [number, number, number],
      viewLabel: '',
    };
    expect(composeMode(view, 'premult', { on: false, x: 0 })[0]).toBe(20);
    expect(composeMode(view, 'over', { on: false, x: 0 })[0]).toBe(30);
    expect(composeMode(view, 'alpha', { on: false, x: 0 })[4]).toBe(128);
    const edge = composeMode(view, 'edge', { on: false, x: 0 });
    expect(edge[4]).toBeGreaterThan(edge[8]! * 0.9); // the soft pixel is highlighted
    // Subject: the segmentation tinted cyan; Shadow: the density white on black.
    const subj = composeMode(view, 'subject', { on: false, x: 0 });
    expect(subj[4 * 2 + 2]).toBeGreaterThan(subj[4 * 2]!);
    expect(composeMode(view, 'shadow', { on: false, x: 0 })[0]).toBe(200);
    expect(composeMode(view, 'shadow', { on: false, x: 0 })[4]).toBeLessThan(30);
    const wiped = composeMode(view, 'over', { on: true, x: 0.5 });
    expect([wiped[0], wiped[8]]).toEqual([10, 30]);
  });
});
