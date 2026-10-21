// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { MenuCommand } from '../../shared/bridge';
import { App } from '../App';
import { moduleForDigit, moduleStatus, moduleToOpen } from '../modules';
import { SAMPLE_HANDOFF, createProject, parseHandoff } from '@vcvfx/domain';
import { stubBridge } from './bridge-stub';

/**
 * The tab layout (addendum 08): module tabs in the top toolbar, the shot bar
 * under them, a task-missing tab that offers to add the task, the Key tab's
 * keying steps, and the first-run tour.
 */

afterEach(cleanup);

async function openSample(api = stubBridge()) {
  const view = render(<App api={api} />);
  await act(async () => undefined);
  fireEvent.click(screen.getByRole('button', { name: 'Open sample project' }));
  await act(async () => undefined);
  return view;
}
const tab = (name: string) => screen.getByRole('tab', { name });
const selected = (name: string) => tab(name).getAttribute('aria-selected') === 'true';
const shotBarName = () => within(screen.getByRole('region', { name: 'Current shot' })).getByRole('heading', { level: 2 }).textContent;

function sample() {
  const h = parseHandoff(JSON.stringify(SAMPLE_HANDOFF));
  if (!h.ok) throw new Error('sample');
  return createProject(h.handoff, 'sample', 'A', new Date());
}

describe('module tabs', () => {
  it('lists every module in the top toolbar and switches between them', async () => {
    await openSample();
    const tabs = within(screen.getByRole('tablist', { name: 'Modules' })).getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('aria-label'))).toEqual(['Shots', 'Plates', 'Roto', 'Key', 'Camera Track', '2D Track', 'Deliver']);
    expect(selected('Shots')).toBe(true);
    expect(screen.getByRole('table', { name: 'Shot queue' })).toBeTruthy();

    fireEvent.click(tab('Plates'));
    expect(selected('Plates')).toBe(true);
    expect(screen.queryByRole('table', { name: 'Shot queue' })).toBeNull();
    expect(screen.getByRole('main', { name: 'Plates' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Viewer — 010_020' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Check source & colour/ })).toBeTruthy();

    fireEvent.click(tab('Deliver'));
    expect(screen.getByRole('main', { name: 'Deliver' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Package contents' }).textContent).toContain('02_MATTES_ROTO');
  });

  it('switches with ⌘/Ctrl+1…7 and the View menu', async () => {
    let send: (c: MenuCommand) => void = () => undefined;
    await openSample(stubBridge({ onMenu: (l) => ((send = l), () => undefined) }));
    fireEvent.keyDown(window, { key: '3', ctrlKey: true });
    expect(selected('Roto')).toBe(true);
    fireEvent.keyDown(window, { key: '7', metaKey: true });
    expect(selected('Deliver')).toBe(true);
    fireEvent.keyDown(window, { key: '1', ctrlKey: true });
    expect(selected('Shots')).toBe(true);
    act(() => send('show-camera'));
    expect(selected('Camera Track')).toBe(true);
    act(() => send('show-shots'));
    expect(selected('Shots')).toBe(true);
  });

  it('opens the selected shot’s module on double-click and remembers the last module', async () => {
    await openSample();
    const table = screen.getByRole('table', { name: 'Shot queue' });
    const row = (id: string) => within(table).getAllByRole('row').find((r) => r.getAttribute('data-shot') === id)!;
    fireEvent.doubleClick(row('010_030'));
    expect(selected('2D Track')).toBe(true);
    expect(shotBarName()).toBe('010_030');
    fireEvent.click(tab('Shots'));
    fireEvent.doubleClick(within(screen.getByRole('table', { name: 'Shot queue' })).getAllByRole('row').find((r) => r.getAttribute('data-shot') === '020_010')!);
    expect(selected('Plates')).toBe(true);
    expect(shotBarName()).toBe('020_010');
  });

  it('maps digits and picks the module to open from the shot’s tasks', () => {
    expect(moduleForDigit('1')).toBe('shots');
    expect(moduleForDigit('7')).toBe('deliver');
    expect(moduleForDigit('8')).toBeNull();
    const p = sample();
    expect(moduleToOpen(p, '010_030', null)).toBe('track2d');
    expect(moduleToOpen(p, '010_030', 'roto')).toBe('track2d');
    expect(moduleToOpen(p, '010_020', 'roto')).toBe('roto');
    expect(moduleStatus(p, '010_030', 'roto')).toMatchObject({ kind: 'missing' });
    expect(moduleStatus(p, '010_020', 'roto')).toEqual({ kind: 'task', state: 'pending' });
    expect(moduleStatus(p, '010_020', 'deliver')).toEqual({ kind: 'shot', status: 'ready_for_prep' });
  });
});

describe('the shot bar', () => {
  it('shows the current shot big, and moves with prev/next, ⌘/Ctrl+↑/↓ and the dropdown', async () => {
    await openSample();
    fireEvent.click(tab('Plates'));
    const bar = screen.getByRole('region', { name: 'Current shot' });
    expect(shotBarName()).toBe('010_020');
    expect(bar.textContent).toContain('Scene 12A');
    expect(bar.textContent).toContain('Take 4');
    expect(bar.textContent).toContain('Ready for Prep');
    expect(bar.textContent).toContain('1 of 3');
    expect((within(bar).getByRole('button', { name: 'Previous shot' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(within(bar).getByRole('button', { name: 'Next shot' }));
    expect(shotBarName()).toBe('010_030');
    expect(selected('Plates')).toBe(true);
    fireEvent.keyDown(window, { key: 'ArrowDown', ctrlKey: true });
    expect(shotBarName()).toBe('020_010');
    expect((within(screen.getByRole('region', { name: 'Current shot' })).getByRole('button', { name: 'Next shot' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(window, { key: 'ArrowUp', metaKey: true });
    expect(shotBarName()).toBe('010_030');
    fireEvent.change(screen.getByLabelText('Go to shot'), { target: { value: '010_020' } });
    expect(shotBarName()).toBe('010_020');
    // The Shots tab follows: the same shot is selected there.
    fireEvent.click(tab('Shots'));
    expect(screen.getByRole('heading', { level: 2, name: '010_020' })).toBeTruthy();
  });
});

describe('a module whose task the shot does not have', () => {
  it('greys the tab with the reason, and adds the task from inside it', async () => {
    await openSample();
    fireEvent.click(within(screen.getByRole('table', { name: 'Shot queue' })).getAllByRole('row')[2]!); // 010_030: 2D only
    expect(tab('Roto').className).toContain('missing');
    expect(tab('Roto').title).toMatch(/010_030 has no Roto task/);
    expect(tab('2D Track').className).not.toContain('missing');

    fireEvent.click(tab('Roto'));
    expect(selected('Roto')).toBe(true);
    expect(screen.getByRole('heading', { name: '010_030 has no Roto task' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add Roto to this shot' }));
    await act(async () => undefined);
    expect(screen.queryByRole('button', { name: 'Add Roto to this shot' })).toBeNull();
    expect(tab('Roto').className).not.toContain('missing');
    expect(screen.getByRole('button', { name: /Paint the subject/ })).toBeTruthy();
  });

  it('offers it read-only with the reason', async () => {
    await openSample(stubBridge({}, null));
    fireEvent.click(within(screen.getByRole('table', { name: 'Shot queue' })).getAllByRole('row')[2]!);
    fireEvent.click(tab('Camera Track'));
    const add = screen.getByRole('button', { name: 'Add Camera Track to this shot' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(add.title).toMatch(/Read-only/);
  });
});

describe('the Key tab', () => {
  it('walks the keying steps beside the viewer, with the key and despill tasks in Details', async () => {
    await openSample();
    fireEvent.click(tab('Key'));
    expect(screen.getByRole('main', { name: 'Key' })).toBeTruthy();
    const steps = screen.getByRole('complementary', { name: 'Steps' });
    for (const what of ['Pick the screen', 'Key', 'Garbage & holdout', 'Repair with roto', 'Despill', 'Light wrap & match', 'Process shot & review', 'Export key v001']) expect(within(steps).getByText(what)).toBeTruthy();
    expect(within(steps).getByRole('button', { name: 'Auto key' })).toBeTruthy();
    expect(screen.queryByRole('note', { name: 'Keying is coming next' })).toBeNull();
    // The shot's Key task is tracked and approved here.
    expect(screen.getByText('Green/blue-screen key')).toBeTruthy();
  });
});

describe('the first-run tour', () => {
  it('shows once, walks the four steps, and stays dismissed', async () => {
    localStorage.removeItem('vcvfx.tour.done');
    const first = await openSample();
    const dialog = screen.getByRole('dialog', { name: 'Quick tour' });
    expect(within(dialog).getByText('Shots is home')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    expect(within(dialog).getByText('Pick a shot')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    expect(within(dialog).getByText('One tab per job')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    expect(within(dialog).getByText('Follow the steps')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog', { name: 'Quick tour' })).toBeNull();
    expect(localStorage.getItem('vcvfx.tour.done')).toBe('1');
    first.unmount();

    await openSample();
    expect(screen.queryByRole('dialog', { name: 'Quick tour' })).toBeNull();
    // Help brings it back.
    fireEvent.click(screen.getByRole('button', { name: 'Help' }));
    expect(screen.getByRole('dialog', { name: 'Quick tour' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Skip the tour' }));
    expect(screen.queryByRole('dialog', { name: 'Quick tour' })).toBeNull();
  });

  it('keeps the “What’s here” strip hidden once dismissed', async () => {
    localStorage.removeItem('vcvfx.whatshere.hidden');
    const first = await openSample();
    const strip = screen.getByRole('region', { name: 'What’s here' });
    fireEvent.click(within(strip).getByRole('button', { name: /Roto/ }));
    expect(selected('Roto')).toBe(true);
    fireEvent.click(tab('Shots'));
    fireEvent.click(screen.getByRole('button', { name: 'Got it — hide this' }));
    expect(screen.queryByRole('region', { name: 'What’s here' })).toBeNull();
    first.unmount();
    await openSample();
    expect(screen.queryByRole('region', { name: 'What’s here' })).toBeNull();
    localStorage.removeItem('vcvfx.whatshere.hidden');
  });
});
