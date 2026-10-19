import { describe, expect, it } from 'vitest';
import { activateDevice, activationResponse, NO_LICENSE_MESSAGE, NOT_YOURS_MESSAGE, standingFor } from '../activation';
import { createFakeSupabase } from './fake-supabase';

const NOW = new Date('2026-10-19T12:00:00.000Z');
const FUTURE = '2026-11-19T00:00:00.000Z';
const PAST = '2026-09-19T00:00:00.000Z';

const license = (overrides: Record<string, unknown> = {}) => ({
  id: 'lic-1',
  user_id: 'u1',
  serial: 'VFX-AAAAA-BBBBB-CCCCC-DDDDD',
  status: 'active',
  max_activations: 2,
  expires_at: FUTURE,
  entitled_platforms: ['windows', 'macos'],
  ...overrides,
});

const device = (fingerprint: string, overrides: Record<string, unknown> = {}) => ({
  userId: 'u1',
  deviceFingerprint: fingerprint,
  deviceName: `Mac ${fingerprint}`,
  platform: 'macos' as const,
  appVersion: '1.0.0',
  ...overrides,
});

describe('activation response mapping', () => {
  it('activated → 200 {outcome, license}', () => {
    const response = activationResponse({ result: 'activated', reason: 'new_device' }, { serial: 'S', status: 'active', expiresAt: null, maxActivations: 2 });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ outcome: { result: 'activated', reason: 'new_device' }, license: { serial: 'S' } });
  });

  it('no slots → 409 {error, outcome} with the domain explanation', () => {
    const response = activationResponse({ result: 'refused', reason: 'no_slots', inUse: 2, limit: 2 }, null);
    expect(response.status).toBe(409);
    expect(response.body['outcome']).toEqual({ result: 'refused', reason: 'no_slots', inUse: 2, limit: 2 });
    expect(response.body['error']).toMatch(/2 of 2 computers/);
  });

  it('inactive → 409 with the domain explanation', () => {
    const response = activationResponse({ result: 'refused', reason: 'license_inactive' }, null);
    expect(response.status).toBe(409);
    expect(response.body['error']).toMatch(/not active/);
  });
});

describe('activateDevice', () => {
  it('without a serial, uses the account’s best live licence and records the device', async () => {
    const fake = createFakeSupabase({
      licenses: [license({ id: 'old', serial: 'VFX-OLDAA-AAAAA-AAAAA-AAAAA', expires_at: PAST }), license()],
    });
    const response = await activateDevice(device('fp-0001'), fake.client, NOW);
    expect(response.status).toBe(200);
    expect(response.body['outcome']).toEqual({ result: 'activated', reason: 'new_device' });
    expect(fake.state.device_activations).toHaveLength(1);
    expect(fake.state.device_activations[0]).toMatchObject({ license_id: 'lic-1', device_fingerprint: 'fp-0001', platform: 'macos' });
  });

  it('the same machine again is already_active and takes no new seat', async () => {
    const fake = createFakeSupabase({ licenses: [license()] });
    await activateDevice(device('fp-0001'), fake.client, NOW);
    const again = await activateDevice(device('fp-0001'), fake.client, NOW);
    expect(again.body['outcome']).toEqual({ result: 'activated', reason: 'already_active' });
    expect(fake.state.device_activations).toHaveLength(1);
  });

  it('a third machine is refused with 409 no_slots', async () => {
    const fake = createFakeSupabase({ licenses: [license()] });
    await activateDevice(device('fp-0001'), fake.client, NOW);
    await activateDevice(device('fp-0002'), fake.client, NOW);
    const third = await activateDevice(device('fp-0003'), fake.client, NOW);
    expect(third.status).toBe(409);
    expect(third.body['outcome']).toEqual({ result: 'refused', reason: 'no_slots', inUse: 2, limit: 2 });
  });

  it('a freed seat can be reclaimed (reactivated)', async () => {
    const fake = createFakeSupabase({
      licenses: [license()],
      device_activations: [
        { id: 'a1', license_id: 'lic-1', device_fingerprint: 'fp-0001', device_name: 'A', platform: 'macos', deactivated_at: PAST },
      ],
    });
    const response = await activateDevice(device('fp-0001'), fake.client, NOW);
    expect(response.body['outcome']).toEqual({ result: 'activated', reason: 'reactivated' });
    expect(fake.state.device_activations[0]?.['deactivated_at']).toBeNull();
  });

  it('a lapsed subscription is refused as license_inactive', async () => {
    const fake = createFakeSupabase({ licenses: [license({ expires_at: PAST })] });
    const response = await activateDevice(device('fp-0001'), fake.client, NOW);
    expect(response.status).toBe(409);
    expect(response.body['outcome']).toEqual({ result: 'refused', reason: 'license_inactive' });
  });

  it('an account with no licence is refused with a way to subscribe', async () => {
    const fake = createFakeSupabase();
    const response = await activateDevice(device('fp-0001'), fake.client, NOW);
    expect(response.status).toBe(409);
    expect(response.body['error']).toBe(NO_LICENSE_MESSAGE);
  });

  it('a serial from another account is refused, never activated', async () => {
    const fake = createFakeSupabase({ licenses: [license({ user_id: 'someone-else' })] });
    const response = await activateDevice(device('fp-0001', { serial: 'VFX-AAAAA-BBBBB-CCCCC-DDDDD' }), fake.client, NOW);
    expect(response.status).toBe(409);
    expect(response.body['error']).toBe(NOT_YOURS_MESSAGE);
    expect(fake.state.device_activations).toHaveLength(0);
  });

  it('a named serial on the account is used, case-insensitively', async () => {
    const fake = createFakeSupabase({ licenses: [license()] });
    const response = await activateDevice(device('fp-0001', { serial: 'vfx-aaaaa-bbbbb-ccccc-ddddd' }), fake.client, NOW);
    expect(response.status).toBe(200);
  });

  it('a malformed serial is a 400', async () => {
    const fake = createFakeSupabase({ licenses: [license()] });
    const response = await activateDevice(device('fp-0001', { serial: 'not-a-serial' }), fake.client, NOW);
    expect(response.status).toBe(400);
  });
});

describe('standing', () => {
  it('is the best licence’s status and expiry, or null', () => {
    expect(standingFor([], NOW)).toBeNull();
    expect(
      standingFor(
        [
          { status: 'expired', expires_at: PAST },
          { status: 'active', expires_at: FUTURE },
        ],
        NOW,
      ),
    ).toEqual({ status: 'active', expiresAt: FUTURE });
    expect(standingFor([{ status: 'mystery', expires_at: null }], NOW)).toBeNull();
  });
});
