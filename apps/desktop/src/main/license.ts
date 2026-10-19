import { app } from 'electron';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { capabilityFrom, explainRefusal, type ActivationOutcome, type Capability } from '@vcvfx/domain';
import type { LicenceStanding } from '../shared/bridge';
import { writeAtomic } from './atomic';
import { accessToken, CloudError, NOT_CONFIGURED } from './cloud';
import { SITE_URL, isCloudConfigured } from './config';
import { deviceFingerprint, deviceName, devicePlatform } from './device';

/**
 * What this machine last heard about its licence, and what that allows.
 *
 * The standing is cached in userData (`license-standing.json`) with the time
 * it was heard, so a machine offline on set keeps working inside the domain's
 * grace period. It is refreshed in the background every six hours. A failure
 * to reach the server changes nothing: it is not evidence of anything.
 * `capabilityFrom` (domain) decides `full` vs `read_only`.
 */

const standingPath = () => join(app.getPath('userData'), 'license-standing.json');
const ASK_EVERY_MS = 6 * 60 * 60 * 1000;

const StandingSchema = z.object({
  status: z.enum(['active', 'suspended', 'revoked', 'expired']),
  expiresAt: z.string().nullable(),
  checkedAt: z.string(),
});

const held = async (): Promise<LicenceStanding | null> => {
  try {
    const parsed = StandingSchema.safeParse(JSON.parse(await readFile(standingPath(), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const ask = async (): Promise<LicenceStanding | null | undefined> => {
  // undefined = "could not find out"; null = "the account has no licence".
  if (!isCloudConfigured()) return undefined;
  try {
    const token = await accessToken();
    const response = await fetch(`${SITE_URL}/api/licenses/standing`, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) return undefined;
    const payload = (await response.json().catch(() => null)) as { standing?: { status?: unknown; expiresAt?: unknown } | null } | null;
    if (!payload || !('standing' in payload)) return undefined;
    if (!payload.standing) {
      await rm(standingPath(), { force: true }).catch(() => undefined);
      return null;
    }
    const parsed = StandingSchema.safeParse({ ...payload.standing, expiresAt: payload.standing.expiresAt ?? null, checkedAt: new Date().toISOString() });
    if (!parsed.success) return undefined;
    await writeAtomic(standingPath(), JSON.stringify(parsed.data));
    return parsed.data;
  } catch {
    return undefined;
  }
};

/** The held standing; a due check runs behind the answer unless `recheck`. */
export const licenceStanding = async (recheck = false): Promise<LicenceStanding | null> => {
  const previous = await held();
  if (recheck) {
    const answer = await ask();
    return answer === undefined ? previous : answer;
  }
  const due = !previous || Date.now() - new Date(previous.checkedAt).getTime() > ASK_EVERY_MS;
  if (due) void ask();
  return previous;
};

export const capability = async (): Promise<Capability> => capabilityFrom(await held(), new Date());

export const READ_ONLY_REASON =
  'This copy is in read-only mode: it can open, browse, verify and print, but writing packages and running ffmpeg need an active VC VFX subscription. Subscribe at vc-vfx.com, then sign in and activate this computer under Account.';

/** Activate this installation. A refusal is an answer, returned as a message. */
export const activateLicence = async (): Promise<{ activated: boolean; message: string }> => {
  if (!isCloudConfigured()) throw new CloudError(NOT_CONFIGURED);
  const platform = devicePlatform();
  if (!platform) throw new CloudError('VC VFX licences cover Windows and macOS only.');
  const token = await accessToken();
  const response = await fetch(`${SITE_URL}/api/licenses/activate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ deviceFingerprint: await deviceFingerprint(), deviceName: deviceName(), platform, appVersion: app.getVersion() }),
  });
  const payload = (await response.json().catch(() => null)) as { outcome?: ActivationOutcome; error?: string } | null;
  if (response.status === 409 && payload?.outcome) {
    return { activated: false, message: explainRefusal(payload.outcome) ?? payload.error ?? 'Activation was refused.' };
  }
  if (!response.ok || !payload?.outcome) throw new CloudError(payload?.error ?? `Activation failed (${response.status}).`);
  if (payload.outcome.result !== 'activated') return { activated: false, message: explainRefusal(payload.outcome) ?? 'Activation was refused.' };
  await licenceStanding(true);
  const how = payload.outcome.reason === 'already_active' ? 'was already active' : 'is now activated';
  return { activated: true, message: `This computer ${how}.` };
};

/** Background refresh while the app is open. */
export const startStandingRefresh = (): void => {
  void licenceStanding(false);
  setInterval(() => void licenceStanding(false), ASK_EVERY_MS).unref?.();
};
