import { app, dialog, shell, type BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isNewer } from '../shared/version';
import { accessToken } from './cloud';
import { SITE_URL, isCloudConfigured } from './config';
import { devicePlatform } from './device';

/**
 * Help › Check for Updates.
 *
 * Deliberate rather than silent: check the public catalogue, ask, download
 * through the entitlement-checked endpoint (signed, short-lived URL), verify
 * the sha256, then hand the installer to the OS. A checksum mismatch discards
 * the download — what arrived is not what was published.
 */

interface PublishedBuild {
  platform: string;
  version: string;
}

const show = (parent: BrowserWindow | null, options: Electron.MessageBoxOptions) =>
  parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);

export async function checkForUpdatesInteractive(parent: BrowserWindow | null): Promise<void> {
  const current = app.getVersion();
  const platform = devicePlatform();
  try {
    if (!platform) {
      await show(parent, { type: 'info', message: 'Updates', detail: 'VC VFX publishes builds for Windows and macOS only.' });
      return;
    }
    const response = await fetch(`${SITE_URL}/api/releases`);
    if (!response.ok) throw new Error(`The release catalogue could not be read (${response.status}).`);
    const payload = (await response.json()) as { builds?: PublishedBuild[] };
    const latest = (payload.builds ?? [])
      .filter((b) => b.platform === platform && typeof b.version === 'string')
      .sort((a, b) => (isNewer(a.version, b.version) ? -1 : 1))[0];
    if (!latest || !isNewer(latest.version, current)) {
      await show(parent, { type: 'info', message: 'VC VFX is up to date', detail: `You have version ${current}.` });
      return;
    }
    const { response: choice } = await show(parent, {
      type: 'question',
      message: `VC VFX ${latest.version} is available`,
      detail: `You have ${current}. Download and install it now? Save your work first; the installer will ask VC VFX to quit.`,
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice !== 0) return;
    if (!isCloudConfigured()) throw new Error('This build cannot sign in, so it cannot download updates. Download the latest version from your account at vc-vfx.com.');

    const authorised = await fetch(`${SITE_URL}/api/downloads/${platform}`, { headers: { authorization: `Bearer ${await accessToken()}` } });
    const grant = (await authorised.json().catch(() => null)) as { url?: string; version?: string; sha256?: string; error?: string } | null;
    if (!authorised.ok || !grant?.url || !grant.sha256) throw new Error(grant?.error ?? `The download could not be authorised (${authorised.status}).`);

    const installer = await fetch(grant.url);
    if (!installer.ok) throw new Error(`The installer could not be downloaded (${installer.status}).`);
    const bytes = Buffer.from(await installer.arrayBuffer());
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual.toLowerCase() !== grant.sha256.trim().toLowerCase()) {
      throw new Error('The downloaded installer did not match its published checksum, so it was discarded. Try again, or download from your account page.');
    }
    const directory = join(tmpdir(), 'vcvfx-updates');
    await mkdir(directory, { recursive: true });
    const path = join(directory, `VCVFX-${grant.version ?? latest.version}.${platform === 'windows' ? 'exe' : 'dmg'}`);
    await writeFile(path, bytes);
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
    if (platform === 'windows') setTimeout(() => app.quit(), 1000);
  } catch (error) {
    await show(parent, { type: 'error', message: 'Update check failed', detail: (error as Error).message });
  }
}
