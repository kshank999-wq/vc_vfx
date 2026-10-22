// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useRef, useState } from 'react';
import { COMP_NODE_H, COMP_NODE_W, SAMPLE_HANDOFF, addTask, compDoc, compNodeParams, createProject, parseHandoff, shotState, type Project } from '@vcvfx/domain';
import { CompInfo, CompViewer, compStepDefs, composeComp, useCompController, type CompMutation } from '../components/comp/CompWorkspace';
import { StepList } from '../components/Layout';
import { createCompPreview } from '../comp-preview';
import { inputX } from '../components/comp/GraphEditor';
import type { CompFrameView } from '../../shared/comp/bridge-types';
import { stubBridge } from './bridge-stub';

/**
 * The Comp workspace (addendum 13) with the browser preview's own evaluator
 * and key engine on the sample's green-screen shot: start from the suggested
 * graph, select a node and change its parameters, add a node with the Tab
 * menu, connect by dragging, bypass with D, delete, undo, view 1 and 2 —
 * every change a logged mutation. jsdom has no canvas pixels, so drawing is
 * skipped; the project and the preview's numbers are what is checked.
 */

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement['getContext'];
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

const NOW = new Date('2026-10-22T12:00:00Z');
const SHOT = '010_020';
const sample = (): Project => {
  const r = parseHandoff(JSON.stringify(SAMPLE_HANDOFF));
  if (!r.ok) throw new Error('bad sample');
  const p = createProject(r.handoff, 'sample', 'dit', NOW);
  const added = addTask(p, SHOT, 'composite', 'dit', NOW);
  if (!added.ok) throw new Error(added.reason);
  return added.project;
};

function Workspace({ ctl }: { ctl: ReturnType<typeof useCompController> }) {
  return (
    <div>
      <StepList steps={compStepDefs(ctl)} resetKey={SHOT} />
      <section className="module-center">
        <CompViewer ctl={ctl} />
      </section>
      <aside>
        <CompInfo ctl={ctl} />
      </aside>
    </div>
  );
}

function Harness({ onProject }: { onProject(p: Project): void }) {
  const [project, setProject] = useState(sample);
  const [frame, setFrame] = useState(1010);
  const [api] = useState(() => stubBridge({ ...createCompPreview({ desktopOnly: (w) => `Available in the desktop app: ${w}` }) }));
  const latest = useRef(project);
  const onComp = (fn: CompMutation) => {
    const r = fn(latest.current, 'Ana', NOW);
    if (!r.ok) {
      console.log('REFUSED', r.reason);
      return false;
    }
    latest.current = r.project;
    setProject(r.project);
    onProject(r.project);
    return true;
  };
  const ctl = useCompController({ api, project, shotId: SHOT, projectKey: 'k', canEdit: true, busy: false, actor: 'Ana', frame, onFrame: setFrame, onComp, runJob: async (_l, fn) => fn('job'), notify: (k, t) => k === 'error' && console.log('NOTIFY', t) });
  return <Workspace ctl={ctl} />;
}

const doc = (p: Project) => compDoc(shotState(p, SHOT))!;
const byName = (p: Project, name: string) => doc(p).nodes.find((n) => n.name === name)!;

/** Client coordinates of a graph point (the editor's view is on its svg; jsdom puts the svg at 0,0). */
function client(svg: Element, x: number, y: number) {
  const [vx, vy, k] = svg.getAttribute('data-view')!.split(',').map(Number) as [number, number, number];
  return { clientX: (x - vx) * k, clientY: (y - vy) * k };
}

describe('the Comp workspace', () => {
  it('starts from the suggested graph, previews 1 and 2, and edits the graph by hand — every change logged and undoable', async () => {
    let project = sample();
    render(<Harness onProject={(p) => (project = p)} />);
    // Step 1: the suggestion names what it will build.
    expect(await screen.findByText(/Read_plate · Keyer1 · Read_background · LightWrap1 · Merge1 · Write1/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start from the suggested graph' }));
    await waitFor(() => expect(doc(project).nodes).toHaveLength(6));
    expect(project.log.at(-2)!.action).toBe('comp.graph');

    // The preview evaluates the comp (1: Merge1) and the plate (2) here, with the key engine.
    await waitFor(() => expect(document.querySelector('.stat[title*="computed"]')).toBeTruthy(), { timeout: 15_000 });
    expect(document.querySelector('.stat[title*="computed"]')!.getAttribute('title')).toBe("5 computed, 1 from the cache") // the background feeds the wrap and the merge: once;
    expect(screen.getByRole('tab', { name: /^1: Merge1/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /^2: Read_plate/ })).toBeTruthy();

    // Select the light wrap: its parameters show; change one (a logged, compact line).
    const svg = document.querySelector('.comp-graph-svg')!;
    const wrapNode = document.querySelector('[data-name="LightWrap1"]')!;
    fireEvent.pointerDown(wrapNode, { button: 0, ...client(svg, byName(project, 'LightWrap1').x + 10, byName(project, 'LightWrap1').y + 10) });
    fireEvent.pointerUp(svg, { button: 0 });
    const params = await screen.findByRole('region', { name: 'Parameters of LightWrap1' }).catch(() => screen.getByLabelText('Parameters of LightWrap1'));
    const intensity = within(params).getByRole('slider', { name: 'Intensity' });
    fireEvent.change(intensity, { target: { value: '1.2' } });
    fireEvent.pointerUp(intensity);
    await waitFor(() => expect(compNodeParams(byName(project, 'LightWrap1'))['intensity']).toBe(1.2));
    expect(project.log.at(-1)).toMatchObject({ action: 'comp.params', detail: 'LightWrap1.intensity 0.6 → 1.2' });
    // Reset that one parameter.
    fireEvent.click(within(params).getByRole('button', { name: 'Reset Intensity' }));
    await waitFor(() => expect(byName(project, 'LightWrap1').params).toEqual({}));

    // Tab opens the add-node menu; searching and Enter inserts a Grade after the selected node (Nuke's insert).
    const graph = document.querySelector('.comp-graph') as HTMLElement;
    fireEvent.keyDown(graph, { key: 'Tab' });
    const search = await screen.findByRole('searchbox', { name: 'Search nodes' });
    fireEvent.change(search, { target: { value: 'gra' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() => expect(byName(project, 'Grade1')).toBeTruthy());
    const grade = byName(project, 'Grade1');
    expect(doc(project).edges).toContainEqual({ from: byName(project, 'LightWrap1').id, to: grade.id, input: 'src' });
    expect(doc(project).edges).toContainEqual({ from: grade.id, to: byName(project, 'Merge1').id, input: 'A' });

    // Connect by dragging: the plate's output onto the Grade's mask is refused (a plate has no matte) — and the Keyer's alpha? Drag Read_plate onto the Merge's B instead.
    const plate = byName(project, 'Read_plate');
    const merge = byName(project, 'Merge1');
    const outPort = document.querySelector(`[data-port="out"][data-node="${plate.id}"]`)!;
    fireEvent.pointerDown(outPort, { button: 0, ...client(svg, plate.x + COMP_NODE_W / 2, plate.y + COMP_NODE_H) });
    fireEvent.pointerMove(svg, { buttons: 1, ...client(svg, merge.x + inputX(0, 3), merge.y) });
    fireEvent.pointerUp(svg, { button: 0, ...client(svg, merge.x + inputX(0, 3), merge.y) });
    await waitFor(() => expect(doc(project).edges).toContainEqual({ from: plate.id, to: merge.id, input: 'B' }));
    expect(project.log.at(-1)!.detail).toBe('Read_plate → Merge1.B (was Read_background)');

    // D bypasses the selected node (the Grade, still selected after adding? select it first).
    const gradeEl = document.querySelector('[data-name="Grade1"]')!;
    fireEvent.pointerDown(gradeEl, { button: 0, ...client(svg, grade.x + 5, grade.y + 5) });
    fireEvent.pointerUp(svg, { button: 0 });
    fireEvent.keyDown(graph, { key: 'd' });
    await waitFor(() => expect(byName(project, 'Grade1').disabled).toBe(true));
    // 2 puts it in the viewer's B.
    fireEvent.keyDown(graph, { key: '2' });
    await waitFor(() => expect(doc(project).viewer.b).toBe(grade.id));
    // Delete removes it, joining the light wrap to the merge again.
    fireEvent.keyDown(graph, { key: 'Delete' });
    await waitFor(() => expect(doc(project).nodes.some((n) => n.name === 'Grade1')).toBe(false));
    expect(doc(project).edges).toContainEqual({ from: byName(project, 'LightWrap1').id, to: merge.id, input: 'A' });
    // ⌘Z undoes the delete (logged).
    fireEvent.keyDown(graph, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(doc(project).nodes.some((n) => n.name === 'Grade1')).toBe(true));
    expect(project.log.at(-1)).toMatchObject({ action: 'comp.undo', detail: 'undid: deleted Grade1' });
    // Dragging a node moves it (layout only), logged once.
    const g2 = byName(project, 'Grade1');
    const gEl = document.querySelector('[data-name="Grade1"]')!;
    fireEvent.pointerDown(gEl, { button: 0, ...client(svg, g2.x + 5, g2.y + 5) });
    fireEvent.pointerMove(svg, { buttons: 1, ...client(svg, g2.x + 85, g2.y + 45) });
    fireEvent.pointerUp(svg, { button: 0, ...client(svg, g2.x + 85, g2.y + 45) });
    await waitFor(() => expect(byName(project, 'Grade1')).toMatchObject({ x: g2.x + 80, y: g2.y + 40 }));
    expect(project.log.at(-1)).toMatchObject({ action: 'comp.layout', detail: '1 node moved' });

    // Render and export are the desktop's here; nothing is approved by any of this.
    expect(shotState(project, SHOT)!.tasks.find((t) => t.kind === 'composite')!.state).toBe('processing');
    expect(screen.getByRole('button', { name: /Render \d+ frames/ }).hasAttribute('disabled')).toBe(true);
  }, 60_000);

  it('composes A, B, the wipe and the alpha channel', () => {
    const pic = (v: number, a: number) => ({ rgb: new Uint8ClampedArray(12).fill(v), alpha: new Uint8Array(4).fill(a) });
    const view: CompFrameView = { frame: 1, width: 4, height: 1, a: pic(200, 255), b: pic(50, 100), errors: { a: null, b: null }, ms: 1, computed: 0, cached: 0, viewLabel: '' };
    expect([...composeComp(view, 'a', 0.5, 'rgb').slice(0, 4)]).toEqual([200, 200, 200, 255]);
    expect([...composeComp(view, 'b', 0.5, 'rgb').slice(0, 4)]).toEqual([50, 50, 50, 255]);
    const w = composeComp(view, 'wipe', 0.5, 'rgb');
    expect([w[0], w[4], w[8], w[12]]).toEqual([200, 200, 50, 50]);
    expect(composeComp(view, 'b', 0.5, 'alpha')[0]).toBe(100);
  });
});

void act;
