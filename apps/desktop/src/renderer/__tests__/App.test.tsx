// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { App } from '../App';
import { stubBridge } from './bridge-stub';

afterEach(cleanup);

const openSample = async (api = stubBridge()) => {
  render(<App api={api} />);
  // Let the start-up calls (licence, settings) settle.
  await act(async () => undefined);
  fireEvent.click(screen.getByRole('button', { name: 'Open sample project' }));
  return screen.getByRole('table', { name: 'Shot queue' });
};

const shotRows = (table: HTMLElement) => within(table).getAllByRole('row').slice(1);

describe('shot queue', () => {
  it('renders the sample’s rows with frames, prep and status', async () => {
    const table = await openSample();
    const rows = shotRows(table);
    expect(rows.map((r) => r.getAttribute('data-shot'))).toEqual(['010_020', '010_030', '020_010']);
    expect(within(rows[0]!).getByText('1001–1128')).toBeTruthy();
    expect(within(rows[0]!).getByText('DPX + Roto + Key')).toBeTruthy();
    expect(within(rows[0]!).getByText('Ready for Prep')).toBeTruthy();
  });

  it('filters to circle takes', async () => {
    const table = await openSample();
    fireEvent.click(screen.getByLabelText(/Circle takes only/));
    expect(shotRows(table).map((r) => r.getAttribute('data-shot'))).toEqual(['010_020', '010_030']);
  });

  it('filters by status chip, scene and search', async () => {
    const table = await openSample();
    fireEvent.change(screen.getByLabelText('Scene'), { target: { value: '18' } });
    expect(shotRows(table).map((r) => r.getAttribute('data-shot'))).toEqual(['020_010']);
    fireEvent.change(screen.getByLabelText('Scene'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'monitor' } });
    expect(shotRows(table).map((r) => r.getAttribute('data-shot'))).toEqual(['010_030']);
  });

  it('moves the selection with the arrow keys', async () => {
    const table = await openSample();
    expect(shotRows(table)[0]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(shotRows(table)[1]!.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('heading', { level: 2, name: '010_030' })).toBeTruthy();
  });
});

describe('approval', () => {
  it('disables Approve shot and shows the domain’s reason', async () => {
    await openSample();
    const approve = screen.getByRole('button', { name: 'Approve shot…' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    const reason = 'Approve every task first: Image-sequence conversion, Paint-to-roto, Green/blue-screen key';
    expect(approve.title).toBe(reason);
    expect(screen.getByRole('note').textContent).toBe(reason);
  });

  it('records a task approval with the approver’s name, then allows the shot approval', async () => {
    const table = await openSample();
    fireEvent.click(within(table).getByText('010_030'));
    fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve…' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve task' });
    const input = within(dialog).getByLabelText('Approved by') as HTMLInputElement;
    expect(input.value).toBe('Prep Artist');
    fireEvent.change(input, { target: { value: 'M. Delgado' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(screen.getByText(/Approved by/).textContent).toContain('M. Delgado');
    const approve = screen.getByRole('button', { name: 'Approve shot…' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
    fireEvent.click(approve);
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Approve shot' })).getByRole('button', { name: 'Approve' }));
    expect(screen.queryByRole('button', { name: 'Approve shot…' })).toBeNull();
    expect(screen.getByText(/Shot approved by/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Package' }) as HTMLButtonElement).disabled).toBe(false);
    expect(within(table).getByText('Prep Approved')).toBeTruthy();
  });

  it('is read-only without a licence: browsing works, changing work does not', async () => {
    const openExternal = vi.fn(async () => undefined);
    const table = await openSample(stubBridge({ openExternal }, null));
    expect(shotRows(table)).toHaveLength(3);
    expect(screen.getByText(/Read-only\./)).toBeTruthy();
    const approve = screen.getByRole('button', { name: 'Approve shot…' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(approve.title).toMatch(/Read-only mode/);
    expect((screen.getByRole('button', { name: 'Print' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Subscribe at vc-vfx.com' }));
    expect(openExternal).toHaveBeenCalledWith('subscribe');
  });

  it('explains a missing ffmpeg and leaves the task unchanged', async () => {
    await openSample();
    fireEvent.click(screen.getByRole('button', { name: 'Generate plates' }));
    await act(async () => undefined);
    expect(screen.getByText(/ffmpeg was not found/)).toBeTruthy();
    const task = screen.getByText('Image-sequence conversion', { selector: '.task-name' }).closest('li')!;
    expect(within(task).getByText('Pending')).toBeTruthy();
  });
});

describe('handoff errors', () => {
  it('lists every issue when a handoff fails to parse', async () => {
    const api = stubBridge({
      openHandoffDialog: async () => ({ ok: true, data: { path: '/drive/bad.json', text: JSON.stringify({ project: '', shots: [{ shotId: 'A' }] }) } }),
    });
    render(<App api={api} />);
    await act(async () => undefined);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open VCDIT Handoff…' }));
    });
    const dialog = screen.getByRole('dialog', { name: 'This handoff cannot be read' });
    expect(within(dialog).getByText('shots[0].scene')).toBeTruthy();
    expect(within(dialog).getByText('shots[0].frameRate')).toBeTruthy();
    expect(within(dialog).getAllByRole('row').length).toBeGreaterThan(4);
  });
});
