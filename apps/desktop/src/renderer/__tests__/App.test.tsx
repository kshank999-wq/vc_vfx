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

describe('a VCDIT handoff', () => {
  const shot = (scene: string, setup: string, take: string, clip: string, note: string) => ({
    scene,
    setup,
    take,
    clip,
    note,
    flaggedBy: 'Script sup.',
    mirror: { method: 'Hard link', folder: `SCENE_${scene}/SETUP_${setup}/T${take}_${clip}` },
    editorialFolder: `../CAMERA_ORIGINALS/${clip.slice(0, 4)}`,
    checksumMethod: 'xxHash64',
    files: [{ path: `${clip}R1AB/${clip}_261007_R1AB.mxf`, size: 200000, checksum: '8d1c3a7e5b2f0c94' }],
  });
  const VCDIT = JSON.stringify({
    schema: 'vcdit.vfx-handoff/1',
    createdAt: '2026-10-07T20:15:00.000Z',
    tool: { name: 'VC DIT', version: '1.4.0' },
    production: { name: 'HALCYON', code: 'HLC', frameRate: '23.976 fps' },
    day: { number: 1, date: '2026-10-07' },
    shots: [shot('14', 'B', '03', 'A015C002', 'Sky replacement'), shot('14', 'C', '01', 'A015C004', 'Monitor comp'), shot('15', 'A', '02', 'A016C001', '')],
  });
  const path = '/RAID/HALCYON/SHOOT_DAY_001_2026-10-07/VFX/VC_VFX_PREP_HLC_D001_20261007_201500Z.json';

  const openVcdit = async (overrides: Parameters<typeof stubBridge>[0] = {}) => {
    const api = stubBridge({ openHandoffDialog: async () => ({ ok: true, data: { path, text: VCDIT } }), ...overrides });
    render(<App api={api} />);
    await act(async () => undefined);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open VCDIT Handoff…' }));
    });
    return screen.getByRole('table', { name: 'Shot queue' });
  };

  it('opens, shows the day, and leaves frames unknown when ffprobe is missing', async () => {
    const probeSources = vi.fn(async () => ({ ok: true as const, data: { ffprobe: null, results: [] } }));
    const table = await openVcdit({ probeSources });
    expect(shotRows(table).map((r) => r.getAttribute('data-shot'))).toEqual(['14_B_03', '14_C_01', '15_A_02']);
    expect(screen.getByText(/Day 1 · 2026-10-07/)).toBeTruthy();
    expect(within(shotRows(table)[0]!).getByText('—', { selector: 'td.num' })).toBeTruthy();
    expect(probeSources).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/ffprobe \(part of ffmpeg\) was not found/)).toBeTruthy();
    expect(screen.getByText(/Frame range unknown/)).toBeTruthy();
    expect(screen.getByText(/Handoff loaded with \d+ warnings/)).toBeTruthy();
  });

  it('fills frame ranges from ffprobe', async () => {
    const probeSources = vi.fn(async () => ({
      ok: true as const,
      data: {
        ffprobe: 'ffprobe',
        results: [
          { shotId: '14_B_03', media: { file: 'a.mxf', frameCount: 240, timecodeIn: '14:22:10:05', frameRate: 23.976, resolution: { width: 4608, height: 3164 }, codec: 'arriraw' } },
          { shotId: '14_C_01', error: 'The source clip is not on the drive' },
        ],
      },
    }));
    const table = await openVcdit({ probeSources });
    expect(within(shotRows(table)[0]!).getByText('1001–1240')).toBeTruthy();
    expect(within(shotRows(table)[1]!).getByText('—', { selector: 'td.num' })).toBeTruthy();
    expect(screen.getByText(/Read 1 of 2 clips/)).toBeTruthy();
    expect(screen.getByText('4608 × 3164')).toBeTruthy();
  });

  it('adds a task to several shots picked with Ctrl- and Shift-click', async () => {
    const table = await openVcdit();
    const rows = shotRows(table);
    fireEvent.click(rows[0]!);
    fireEvent.click(rows[2]!, { shiftKey: true });
    expect(screen.getByText('3 shots selected')).toBeTruthy();
    fireEvent.click(shotRows(table)[1]!, { ctrlKey: true });
    expect(screen.getByText('2 shots selected')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Task for selected shots'), { target: { value: 'sequence_conversion' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to 2 shots' }));
    expect(screen.getByText(/Image-sequence conversion added to 2 shots/)).toBeTruthy();
    const prep = shotRows(table).map((r) => within(r).queryByText('EXR') !== null);
    expect(prep).toEqual([true, false, true]);
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByText(/shots selected/)).toBeNull();
  });

  it('takes the VFX editor’s shot number', async () => {
    const table = await openVcdit();
    const input = screen.getByLabelText('VFX shot number') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'HLC_014_010' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set' }));
    expect(within(table).getByText('HLC_014_010')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'HLC_014_010' })).toBeTruthy();
    expect(screen.getByText(/handoff ID 14_B_03/)).toBeTruthy();
  });
});
