// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useRef, useState } from 'react';
import { SAMPLE_HANDOFF, addTask, createProject, lightingDoc, lightingRig, parseHandoff, shotState, type Project } from '@vcvfx/domain';
import { LightingWorkspace, composeLighting, type LightingMutation } from '../components/lighting/LightingWorkspace';
import { createLightingPreview } from '../lighting-preview';
import type { LightingFrameView } from '../../shared/lighting/bridge-types';
import { stubBridge } from './bridge-stub';

/**
 * The Lighting workspace (addendum 14) with the browser preview's own engine:
 * the sample storeroom shot is rendered in the page (small, for speed) and
 * analysed for real. jsdom has no canvas pixels, so drawing is skipped; the
 * steps, the numbers, the edits and the project are what is checked.
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
  const p = createProject(r.handoff, 'sample', 'dit', NOW);
  const t = addTask(p, SHOT, 'lighting_analysis', 'dit', NOW);
  if (!t.ok) throw new Error(t.reason);
  return t.project;
};

const errors: string[] = [];
function Harness({ onProject }: { onProject(p: Project): void }) {
  const [project, setProject] = useState(sample);
  const preview = createLightingPreview({ desktopOnly: (w) => `Available in the desktop app: ${w}`, progress: () => undefined, scene: { width: 240, height: 136, samples: 8, supersample: 1 } });
  const [api] = useState(() => stubBridge({ ...preview, cancelJob: async (id) => void preview.cancel(id) }));
  const latest = useRef(project);
  const onLighting = (fn: LightingMutation) => {
    const r = fn(latest.current, 'Ana', NOW);
    if (!r.ok) {
      errors.push(r.reason);
      return false;
    }
    latest.current = r.project;
    setProject(r.project);
    onProject(r.project);
    return true;
  };
  return <LightingWorkspace api={api} project={project} shotId={SHOT} projectKey="k" canEdit busy={false} actor="Ana" onLighting={onLighting} runJob={async (_label, fn) => fn(`job-${Math.random()}`)} notify={(kind, text) => kind === 'error' && errors.push(text)} />;
}

describe('the Lighting workspace', () => {
  it('adds the sample references, analyses, edits and locks a light, adds one, and never approves', { timeout: 120_000 }, async () => {
    let project = sample();
    render(<Harness onProject={(p) => (project = p)} />);
    const steps = screen.getByRole('list', { name: 'Lighting steps' });
    const doc = () => lightingDoc(shotState(project, SHOT))!;
    const task = () => shotState(project, SHOT)!.tasks.find((t) => t.kind === 'lighting_analysis')!;
    expect([...steps.querySelectorAll('.step-title > span:first-child')].map((x) => x.textContent)).toEqual(['Frames and references', 'Analyse', 'Review the lights', 'Lens and camera', 'Export to Unreal / USD v001']);
    expect(within(screen.getByRole('tablist', { name: 'View' })).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Plate', 'Relit', 'A/B wipe', 'Reference']);

    // 1. The references: the sample's chrome ball, grey ball and HDRI, read only, the balls' circles known.
    const use = await waitFor(() => within(steps).getByRole('button', { name: /Use the sample references/ }));
    await waitFor(() => expect((use as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.click(use);
    });
    await waitFor(() => expect(doc().references.map((r) => r.kind)).toEqual(['chrome_ball', 'grey_ball', 'hdri']));
    expect(doc().references[0]).toMatchObject({ from: 'sample', circle: { r: 84 } });
    expect(task().state).toBe('processing');
    // The HDRI's heading, typed (logged, a new settings revision).
    const rev = doc().revision;
    fireEvent.click(within(steps).getByRole('button', { name: /HDRI \(equirect\)/ }));
    const heading = screen.getByLabelText('HDRI heading') as HTMLInputElement;
    fireEvent.change(heading, { target: { value: '30' } });
    fireEvent.blur(heading);
    expect(doc().references[2]!.headingDeg).toBe(30);
    expect(doc().revision).toBe(rev + 1);

    // 2. Analyse.
    const analyse = within(steps).getByRole('button', { name: 'Analyse' });
    await act(async () => {
      fireEvent.click(analyse);
    });
    await waitFor(() => expect(doc().analysis).not.toBeNull(), { timeout: 90_000 });
    expect(errors).toEqual([]);
    expect(task()).toMatchObject({ state: 'needs_review', approval: null });
    const a = doc().analysis!;
    const key = a.lights.find((l) => l.id === 'key')!;
    expect(key.evidence).toContain('hdri');
    expect(Math.abs(key.azimuth.value - 48)).toBeLessThan(8);
    expect(a.lights.map((l) => l.id)).toEqual(expect.arrayContaining(['key', 'fill', 'rim']));
    await waitFor(() => expect(screen.getByText('Lights found').closest('.stat')!.textContent).toMatch(/\d/));

    // 3. Select the key; change its intensity (logged, locked); unlock it back to the estimate.
    fireEvent.click(within(screen.getByRole('list', { name: 'Lights' })).getByRole('button', { name: /^Key/ }));
    const slider = screen.getByRole('slider', { name: 'Intensity' }) as HTMLInputElement;
    fireEvent.change(slider, { target: { value: '0.5' } });
    fireEvent.pointerUp(slider);
    expect(lightingRig(doc()).find((l) => l.id === 'key')!).toMatchObject({ locked: ['intensityStops'], spec: { intensityStops: 0.5 } });
    expect(project.log.some((e) => e.action === 'lighting.light' && e.detail.includes('intensity 0 stops → +0.5 stops'))).toBe(true);
    expect(task().state).toBe('needs_correction');
    fireEvent.click(screen.getByRole('button', { name: 'Unlock intensity' }));
    expect(lightingRig(doc()).find((l) => l.id === 'key')!.spec.intensityStops).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Lock elevation' }));
    expect(lightingRig(doc()).find((l) => l.id === 'key')!.locked).toEqual(['elevationDeg']);

    // Add a practical by hand; it is selected; turn off the rim.
    fireEvent.click(within(steps).getByRole('button', { name: 'Add a practical' }));
    expect(lightingRig(doc()).at(-1)).toMatchObject({ origin: 'artist', spec: { role: 'practical', temperatureK: 2700 } });
    const lights = screen.getByRole('list', { name: 'Lights' });
    const rimRow = within(lights).getByRole('button', { name: /^Rim/ }).closest('li')!;
    fireEvent.click(within(rimRow).getByRole('checkbox'));
    expect(lightingRig(doc()).find((l) => l.id === 'rim')!.spec.enabled).toBe(false);

    // 4. The lens: the metadata's 25 mm; an override is logged.
    const focal = screen.getByLabelText('Focal length override') as HTMLInputElement;
    fireEvent.change(focal, { target: { value: '27' } });
    fireEvent.blur(focal);
    expect(doc().lens.focalMm).toBe(27);
    expect(a.lens.focalSource).toBe('metadata');

    // 5. Export is the desktop app's; approval is never reached from here.
    const exportButton = within(steps).getByRole('button', { name: 'Export light rig v001' }) as HTMLButtonElement;
    expect(exportButton.disabled).toBe(true);
    expect(within(steps).getByText(/the desktop app does it/)).toBeTruthy();
    expect(task().approval).toBeNull();
    // The AI review is the desktop app's too.
    expect((screen.getByRole('button', { name: 'Ask AI' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('composes the plate, the relit subject and the wipe between them', () => {
    const view: LightingFrameView = { frame: 1, width: 4, height: 1, rgb: new Uint8ClampedArray([10, 10, 10, 20, 20, 20, 30, 30, 30, 40, 40, 40]), relit: new Uint8ClampedArray([1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4]), mask: null, ball: null, match: null, built: 'current', label: '', ms: 0 };
    expect(Array.from(composeLighting(view, 'plate', 0.5).data.filter((_, i) => i % 4 === 0))).toEqual([10, 20, 30, 40]);
    expect(Array.from(composeLighting(view, 'relit', 0.5).data.filter((_, i) => i % 4 === 0))).toEqual([1, 2, 3, 4]);
    expect(Array.from(composeLighting(view, 'wipe', 0.5).data.filter((_, i) => i % 4 === 0))).toEqual([10, 20, 3, 4]);
  });
});
