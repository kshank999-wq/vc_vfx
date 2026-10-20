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

describe('plate colour', () => {
  it('shows the decision in one line and records a change, logged', async () => {
    await openSample();
    fireEvent.click(screen.getByText('020_010'));
    expect(screen.getByText('Writes ACEScg linear EXR half from Sony S-Log3 / S-Gamut3.Cine; no look applied.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Plate colour'), { target: { value: 'as_shot' } });
    expect(screen.getByText('Writes EXR half as shot (Sony S-Log3 / S-Gamut3.Cine kept); no look applied.')).toBeTruthy();
    expect(screen.getAllByText('plates.colour').length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('Source encoding'), { target: { value: 'red_log3g10_rwg' } });
    expect(document.querySelector('.pc-summary')?.textContent).toBe('Writes EXR half as shot (RED Log3G10 / REDWideGamutRGB kept); no look applied.');
  });

  it('keeps DPX plates in the camera encoding and says why a conversion is refused', async () => {
    await openSample();
    expect(screen.getByText('Writes DPX 10-bit as shot (ARRI LogC4 / AWG4 kept); no look applied.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Plate colour'), { target: { value: 'acescg' } });
    expect(screen.getByText(/needs a float format/)).toBeTruthy();
  });
});

describe('the frame viewer', () => {
  const frames = (over = {}) =>
    stubBridge({
      viewerSources: async () => ({ ok: true, data: { source: { available: true, reason: null, encoding: 'arri_logc4_awg4' }, plates: [{ version: 1, format: 'dpx', first: 1009, last: 1128, count: 120, encoding: 'arri_logc4_awg4' }] } }),
      viewerFrame: async (req) => ({ ok: true, data: { url: `vcvfx-frame://cache/${req.layer}-${req.view}-${req.frame}-${req.maxWidth}.jpg`, frame: req.frame, viewLabel: req.view === 'raw' ? 'Raw values (as encoded)' : 'ARRI LogC4 → Rec.709 (approx.)' } }),
      ...over,
    });

  it('opens on double-click at the editorial in-point, steps with the keyboard and closes with Esc', async () => {
    const table = await openSample(frames());
    fireEvent.doubleClick(shotRows(table)[0]!);
    await act(async () => undefined);
    const viewer = screen.getByRole('region', { name: 'Viewer — 010_020' });
    expect(within(viewer).getByLabelText('Frame').textContent).toBe('1009');
    expect((within(viewer).getByAltText('Source frame 1009') as HTMLImageElement).src).toBe('vcvfx-frame://cache/source-rec709-1009-1280.jpg');
    expect(within(viewer).getByText('TC 01:00:00:00')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: 'ArrowRight', shiftKey: true });
    expect(within(viewer).getByLabelText('Frame').textContent).toBe('1020');
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(within(viewer).getByLabelText('Frame').textContent).toBe('1019');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'Viewer — 010_020' })).toBeNull();
  });

  it('shows a contact sheet of first, last and twelve between; a tile jumps there', async () => {
    const table = await openSample(frames());
    fireEvent.doubleClick(shotRows(table)[0]!);
    await act(async () => undefined);
    const sheet = screen.getByRole('region', { name: 'Contact sheet' });
    const tiles = within(sheet).getAllByRole('button', { name: /^Frame / });
    expect(tiles).toHaveLength(14);
    expect(tiles[0]!.getAttribute('aria-label')).toBe('Frame 1009');
    expect(tiles[13]!.getAttribute('aria-label')).toBe('Frame 1128');
    fireEvent.click(tiles[5]!);
    expect(screen.getByLabelText('Frame').textContent).toBe(tiles[5]!.getAttribute('aria-label')!.slice(6));
  });

  it('wipes between source and plates, and marks a frame for correction in the shot, logged', async () => {
    const table = await openSample(frames());
    fireEvent.doubleClick(shotRows(table)[0]!);
    await act(async () => undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Wipe' }));
    await act(async () => undefined);
    expect(screen.getByAltText('Plates v001 frame 1009')).toBeTruthy();
    expect(screen.getByText('B · Plates v001')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Correction note'), { target: { value: 'Hair edge chatter' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mark for correction' }));
    expect(screen.getByRole('button', { name: '● Marked for correction' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByText('Marked for correction')).toBeTruthy();
    expect(document.querySelector('.review-marks')?.textContent).toBe('Marked for correction1009 source · Prep Artist — Hair edge chatter');
    expect(screen.getAllByText('review.marked').length).toBeGreaterThan(0);
  });

  it('switches the view for viewing only, and says when there is nothing to show', async () => {
    const table = await openSample(frames({ viewerSources: async () => ({ ok: true, data: { source: { available: false, reason: 'The sample project has no media on disk.', encoding: null }, plates: [] } }) }));
    fireEvent.doubleClick(shotRows(table)[0]!);
    await act(async () => undefined);
    expect(screen.getByText('The sample project has no media on disk.')).toBeTruthy();
    expect(screen.getByText('Nothing to show for this shot yet.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Wipe' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
