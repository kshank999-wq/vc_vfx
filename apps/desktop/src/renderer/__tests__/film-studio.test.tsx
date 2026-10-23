// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { parseProject, type StatusSendOutcome } from '@vcvfx/domain';
import { App } from '../App';
import type { FilmStudioInfo, VcvfxApi } from '../../shared/bridge';
import { stubBridge } from './bridge-stub';

afterEach(cleanup);

const INFO: FilmStudioInfo = { url: 'https://www.vcfilmstudio.com', defaultUrl: 'https://www.vcfilmstudio.com', hasKey: true, keyHint: 'vcvfx_…EFGH', encrypted: true, autoSend: false, available: true, reason: null };

const openDeliver = async (api: VcvfxApi) => {
  render(<App api={api} />);
  await act(async () => undefined);
  fireEvent.click(screen.getByRole('button', { name: 'Open sample project' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Deliver' }));
  fireEvent.click(screen.getByRole('button', { name: /VFX status & VC Film Studio/ }));
};

describe('the VFX status on the Deliver tab', () => {
  it('says where the project stands, in Film Studio’s words, and what holds this shot', async () => {
    await openDeliver(stubBridge({ filmStudioInfo: async () => INFO, sendVfxStatus: vi.fn() }));
    expect(screen.getByText('No shot is ready to hand off yet; 5 not started.')).toBeTruthy();
    expect(screen.getByText('Plates, Roto and Key not started')).toBeTruthy();
    expect(screen.getByText(/To www\.vcfilmstudio\.com/)).toBeTruthy();
  });

  it('prints and exports the report with the operator’s name', async () => {
    const printVfxStatus = vi.fn(async () => ({ ok: true as const, data: { path: '/tmp/Night Shift - VFX Status.pdf' } }));
    const exportVfxStatus = vi.fn(async () => ({ ok: true as const, data: { path: '/tmp/status.json' } }));
    await openDeliver(stubBridge({ filmStudioInfo: async () => INFO, printVfxStatus, exportVfxStatus }));
    fireEvent.click(screen.getByRole('button', { name: 'Save as PDF…' }));
    await act(async () => undefined);
    expect(printVfxStatus).toHaveBeenCalledWith(expect.objectContaining({ operator: 'Prep Artist', mode: 'pdf' }));
    expect(screen.getByText(/VFX status report saved to/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Export for VC Film Studio…' }));
    await act(async () => undefined);
    expect(exportVfxStatus).toHaveBeenCalledWith(expect.objectContaining({ format: 'json' }));
    expect(screen.getByText(/Import it on VC Film Studio’s data desk/)).toBeTruthy();
  });

  it('sends, shows Film Studio’s answer as it wrote it, and logs the send in the project', async () => {
    const outcome: StatusSendOutcome = {
      kind: 'sent', url: 'https://www.vcfilmstudio.com', shots: 5, readyToHandOff: 0, says: '5 shots received: 0 ready to hand off, 5 not started.',
      warnings: ['Scene 12A is not in this production.'], stale: false, report: 'r1', production: 'Night Shift',
      summary: { shots: 5, readyToHandOff: 0, notStarted: 5 },
    };
    const sendVfxStatus = vi.fn(async () => ({ ok: true as const, data: outcome }));
    const saveProject = vi.fn(async () => ({ ok: true as const, data: { path: '/p.vcvfx' } }));
    await openDeliver(stubBridge({ filmStudioInfo: async () => INFO, sendVfxStatus, saveProject }));
    fireEvent.click(screen.getByRole('button', { name: 'Send status to VC Film Studio' }));
    await act(async () => undefined);
    const dialog = screen.getByRole('dialog', { name: 'Sent to VC Film Studio' });
    expect(within(dialog).getByText('5 shots received: 0 ready to hand off, 5 not started.')).toBeTruthy();
    expect(within(dialog).getByText('Scene 12A is not in this production.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    expect(screen.getByText(/Last sent .* by Prep Artist: 5 shots, 0 ready to hand off/)).toBeTruthy();
  });

  it('shows every refusal verbatim, and offers the file instead', async () => {
    const error = 'This report is for “Night Shift”, but the key belongs to “DEMO — THE COPPER LINE”. In VC VFX set Project settings → VC Film Studio → Production to “DEMO — THE COPPER LINE”, or use the key made on the right production’s data desk.';
    const sendVfxStatus = vi.fn(async () => ({ ok: true as const, data: { kind: 'refused', url: 'https://www.vcfilmstudio.com', shots: 5, status: 409, error, issues: [] } as StatusSendOutcome }));
    const exportVfxStatus = vi.fn(async () => ({ ok: true as const, data: null }));
    await openDeliver(stubBridge({ filmStudioInfo: async () => INFO, sendVfxStatus, exportVfxStatus }));
    fireEvent.click(screen.getByRole('button', { name: 'Send status to VC Film Studio' }));
    await act(async () => undefined);
    const dialog = screen.getByRole('dialog', { name: 'VC Film Studio refused the report' });
    expect(within(dialog).getByText(error)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Settings…' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export for VC Film Studio…' }));
    await act(async () => undefined);
    expect(exportVfxStatus).toHaveBeenCalled();
  });

  it('with no key, says so and logs nothing', async () => {
    const sendVfxStatus = vi.fn(async () => ({ ok: false as const, error: 'No upload key yet. Make one on Film Studio’s data desk.' }));
    await openDeliver(stubBridge({ filmStudioInfo: async () => ({ ...INFO, hasKey: false, keyHint: null }), sendVfxStatus }));
    expect(screen.getByText(/No upload key yet\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send status to VC Film Studio' }));
    await act(async () => undefined);
    expect(within(screen.getByRole('dialog', { name: 'Not sent to VC Film Studio' })).getByText('No upload key yet. Make one on Film Studio’s data desk.')).toBeTruthy();
    expect(screen.queryByText(/Last sent|Last attempt/)).toBeNull();
  });

  it('where sending needs the desktop app, the button says so and export still works', async () => {
    await openDeliver(stubBridge({ filmStudioInfo: async () => ({ ...INFO, hasKey: false, available: false, reason: 'Available in the desktop app: sending uses a key kept in the keychain.' }) }));
    const button = screen.getByRole('button', { name: 'Send status to VC Film Studio' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toMatch(/desktop app/);
    expect((screen.getByRole('button', { name: 'Export for VC Film Studio…' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('Settings → VC Film Studio', () => {
  it('stores the key through main and only ever shows its hint', async () => {
    const configureFilmStudio = vi.fn(async (input: { key?: string }) => ({ ok: true as const, data: { ...INFO, hasKey: Boolean(input.key) || INFO.hasKey } }));
    render(<App api={stubBridge({ filmStudioInfo: async () => ({ ...INFO, hasKey: false, keyHint: null }), configureFilmStudio })} />);
    await act(async () => undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Open sample project' }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    const key = within(dialog).getByLabelText('Upload key') as HTMLInputElement;
    expect(key.type).toBe('password');
    fireEvent.change(key, { target: { value: 'vcvfx_0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH' } });
    fireEvent.change(within(dialog).getByLabelText('Film Studio production for this project'), { target: { value: 'DEMO — THE COPPER LINE' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await act(async () => undefined);
    expect(configureFilmStudio).toHaveBeenCalledWith({ url: '', autoSend: false, key: 'vcvfx_0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH' });
    expect(key.value).toBe('');
    expect(within(dialog).getByText(/kept in this computer’s keychain, encrypted/)).toBeTruthy();
  });

  it('the production name goes into the project, logged', async () => {
    let saved = '';
    let menu: ((c: 'save') => void) | null = null;
    const saveProject = vi.fn(async ({ text }: { text: string }) => {
      saved = text;
      return { ok: true as const, data: { path: '/p.vcvfx' } };
    });
    const onMenu = (listener: (c: never) => void) => {
      menu = listener as (c: 'save') => void;
      return () => undefined;
    };
    render(<App api={stubBridge({ filmStudioInfo: async () => INFO, configureFilmStudio: async () => ({ ok: true, data: INFO }), saveProject, onMenu: onMenu as VcvfxApi['onMenu'] })} />);
    await act(async () => undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Open sample project' }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    fireEvent.change(within(dialog).getByLabelText('Film Studio production for this project'), { target: { value: 'The Copper Line' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await act(async () => undefined);
    await act(async () => menu!('save'));
    const parsed = parseProject(saved);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.project.filmStudioProduction).toBe('The Copper Line');
    expect(parsed.project.log.at(-1)).toMatchObject({ action: 'filmstudio.production', detail: '(none) → The Copper Line' });
    expect(saved).not.toContain('vcvfx_');
  });
});
