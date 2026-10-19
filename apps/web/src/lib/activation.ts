import type { SupabaseClient } from '@supabase/supabase-js';
import {
  bestLicense,
  decideActivation,
  explainRefusal,
  isWellFormedSerial,
  type ActivationOutcome,
  type DeviceActivation,
  type License,
  type LicenseStatus,
  type Platform,
} from '@vcvfx/domain';

/**
 * Activating and freeing device seats. The decision is the domain's
 * (`decideActivation`); this module reads and writes rows and maps the answer
 * to the HTTP contract the desktop app relies on:
 *
 *   200 { outcome, license }   activated
 *   409 { error, outcome }     refused (inactive licence, no free seat, not on this account)
 */

export interface ActivateInput {
  userId: string;
  serial?: string | undefined;
  deviceFingerprint: string;
  deviceName: string;
  platform: Platform;
  appVersion: string;
}

export interface ActivationResponse {
  status: 200 | 400 | 409 | 500;
  body: Record<string, unknown>;
}

interface LicenseRow {
  id: string;
  serial: string;
  status: LicenseStatus;
  max_activations: number;
  expires_at: string | null;
  entitled_platforms: Platform[];
}

interface ActivationRow {
  id: string;
  license_id: string;
  device_fingerprint: string;
  device_name: string;
  platform: Platform;
  deactivated_at: string | null;
}

export const NO_LICENSE_MESSAGE = 'There is no VC VFX licence on this account. Subscribe at vc-vfx.com/download.';
export const NOT_YOURS_MESSAGE = 'That licence is not on this account.';

const toLicense = (row: LicenseRow): License & { serial: string } => ({
  id: row.id,
  serial: row.serial,
  status: row.status,
  maxActivations: row.max_activations,
  expiresAt: row.expires_at,
  entitledPlatforms: row.entitled_platforms ?? [],
});

const toActivation = (row: ActivationRow): DeviceActivation => ({
  id: row.id,
  licenseId: row.license_id,
  deviceFingerprint: row.device_fingerprint,
  deviceName: row.device_name,
  platform: row.platform,
  deactivatedAt: row.deactivated_at,
});

/** Pure: how an outcome is answered over HTTP. */
export const activationResponse = (
  outcome: ActivationOutcome,
  license: { serial: string; status: LicenseStatus; expiresAt: string | null; maxActivations: number } | null,
  message?: string,
): ActivationResponse => {
  if (outcome.result === 'refused') {
    return { status: 409, body: { error: message ?? explainRefusal(outcome), outcome } };
  }
  return { status: 200, body: { outcome, license } };
};

const refusedInactive: ActivationOutcome = { result: 'refused', reason: 'license_inactive' };

export const activateDevice = async (
  input: ActivateInput,
  client: SupabaseClient,
  now: Date = new Date(),
): Promise<ActivationResponse> => {
  if (input.serial !== undefined && input.serial.trim() !== '' && !isWellFormedSerial(input.serial)) {
    return { status: 400, body: { error: 'That does not look like a VC VFX serial (VFX-XXXXX-XXXXX-XXXXX-XXXXX).' } };
  }

  const { data: licenseRows, error: licenseError } = await client
    .from('licenses')
    .select('id, serial, status, max_activations, expires_at, entitled_platforms')
    .eq('user_id', input.userId);
  if (licenseError) return { status: 500, body: { error: 'Your licences could not be read.' } };
  const licenses = ((licenseRows ?? []) as LicenseRow[]).map(toLicense);

  // A serial is scoped to the caller's own account: knowing one is not enough
  // to spend somebody else's seats. Without one, the account's best licence.
  const wanted = input.serial?.trim().toUpperCase();
  const license = wanted ? licenses.find((l) => l.serial === wanted) ?? null : bestLicense(licenses, now);
  if (!license) {
    return activationResponse(refusedInactive, null, wanted ? NOT_YOURS_MESSAGE : NO_LICENSE_MESSAGE);
  }

  const { data: activationRows, error: activationError } = await client
    .from('device_activations')
    .select('id, license_id, device_fingerprint, device_name, platform, deactivated_at')
    .eq('license_id', license.id);
  if (activationError) return { status: 500, body: { error: 'Your devices could not be read.' } };

  const outcome = decideActivation({
    license,
    activations: ((activationRows ?? []) as ActivationRow[]).map(toActivation),
    deviceFingerprint: input.deviceFingerprint,
    now,
  });
  const summary = {
    serial: license.serial,
    status: license.status,
    expiresAt: license.expiresAt,
    maxActivations: license.maxActivations,
  };
  if (outcome.result === 'refused') return activationResponse(outcome, summary);

  const nowIso = now.toISOString();
  const row: Record<string, unknown> = {
    license_id: license.id,
    device_fingerprint: input.deviceFingerprint,
    device_name: input.deviceName,
    platform: input.platform,
    app_version: input.appVersion,
    last_seen_at: nowIso,
    deactivated_at: null,
  };
  if (outcome.reason !== 'already_active') row['activated_at'] = nowIso;

  const { error } = await client
    .from('device_activations')
    .upsert(row, { onConflict: 'license_id,device_fingerprint' });
  if (error) return { status: 500, body: { error: 'The activation could not be recorded. Try again in a moment.' } };

  return activationResponse(outcome, summary);
};

/** Free a seat. The row is kept (marked deactivated) so support can see history. */
export const deactivateDevice = async (
  input: { userId: string; activationId: string },
  client: SupabaseClient,
): Promise<{ ok: boolean; error: string | null }> => {
  const { data: row } = await client
    .from('device_activations')
    .select('id, license_id')
    .eq('id', input.activationId)
    .maybeSingle();
  if (!row) return { ok: false, error: 'No such device.' };

  const { data: owned } = await client
    .from('licenses')
    .select('id')
    .eq('id', row.license_id)
    .eq('user_id', input.userId)
    .maybeSingle();
  if (!owned) return { ok: false, error: 'That device is not on a licence you own.' };

  const { error } = await client
    .from('device_activations')
    .update({ deactivated_at: new Date().toISOString() })
    .eq('id', input.activationId);
  return error ? { ok: false, error: error.message } : { ok: true, error: null };
};

export interface DeviceListing {
  id: string;
  deviceName: string;
  platform: Platform;
  appVersion: string | null;
  activatedAt: string;
  lastSeenAt: string | null;
  deactivatedAt: string | null;
  serial: string;
  maxActivations: number;
}

export const listDevices = async (userId: string, client: SupabaseClient): Promise<DeviceListing[]> => {
  const { data: licenseRows } = await client.from('licenses').select('id, serial, max_activations').eq('user_id', userId);
  const licenses = (licenseRows ?? []) as Array<{ id: string; serial: string; max_activations: number }>;
  if (licenses.length === 0) return [];

  const { data: rows } = await client
    .from('device_activations')
    .select('id, license_id, device_name, platform, app_version, activated_at, last_seen_at, deactivated_at')
    .in('license_id', licenses.map((l) => l.id))
    .order('activated_at', { ascending: false });

  return ((rows ?? []) as Array<Record<string, unknown>>).flatMap((row) => {
    const license = licenses.find((l) => l.id === row['license_id']);
    if (!license) return [];
    return [
      {
        id: row['id'] as string,
        deviceName: (row['device_name'] as string) || 'Unnamed computer',
        platform: row['platform'] as Platform,
        appVersion: (row['app_version'] as string | null) ?? null,
        activatedAt: row['activated_at'] as string,
        lastSeenAt: (row['last_seen_at'] as string | null) ?? null,
        deactivatedAt: (row['deactivated_at'] as string | null) ?? null,
        serial: license.serial,
        maxActivations: license.max_activations,
      },
    ];
  });
};

/** The account's standing for the desktop to cache: its best licence's status and expiry. */
export const standingFor = (
  rows: ReadonlyArray<{ status: string; expires_at: string | null }>,
  now: Date,
): { status: LicenseStatus; expiresAt: string | null } | null => {
  const known = rows.flatMap((row) =>
    ['active', 'suspended', 'revoked', 'expired'].includes(row.status)
      ? [{ status: row.status as LicenseStatus, expiresAt: row.expires_at }]
      : [],
  );
  const best = bestLicense(known, now);
  return best ? { status: best.status, expiresAt: best.expiresAt } : null;
};
