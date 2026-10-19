'use client';

import { useCallback, useEffect, useState } from 'react';

interface DeviceRow {
  id: string;
  deviceName: string;
  platform: 'windows' | 'macos';
  appVersion: string | null;
  activatedAt: string;
  lastSeenAt: string | null;
  deactivatedAt: string | null;
  serial: string;
  maxActivations: number;
}

const formatDate = (value: string | null): string =>
  value ? new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';

/** Free a seat here when a computer is lost or replaced — no support email needed. */
export function Devices() {
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/licenses/devices');
      if (response.ok) {
        const payload = (await response.json()) as { devices?: DeviceRow[] };
        setDevices(payload.devices ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const free = async (device: DeviceRow) => {
    setBusy(device.id);
    setError(null);
    const response = await fetch('/api/licenses/devices', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ activationId: device.id }),
    });
    setBusy(null);
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      setError(payload.error ?? 'That device could not be freed');
      return;
    }
    await load();
  };

  if (loading) return <p className="lede">Loading your computers…</p>;

  const active = devices.filter((d) => d.deactivatedAt === null);
  const past = devices.length - active.length;
  const limit = devices[0]?.maxActivations ?? 2;

  if (devices.length === 0) {
    return <p className="lede">No computers yet. VC VFX activates the first time you sign in to the app.</p>;
  }

  return (
    <>
      <p className="lede">
        {active.length} of {limit} seats in use.
      </p>
      <ul className="list" style={{ marginTop: 14 }}>
        {active.map((device) => (
          <li key={device.id} className="card row">
            <div>
              <strong>{device.deviceName}</strong>
              <p className="lede small">
                {device.platform === 'windows' ? 'Windows' : 'macOS'} · activated {formatDate(device.activatedAt)}
                {device.appVersion ? ` · v${device.appVersion}` : ''}
                {device.lastSeenAt ? ` · last seen ${formatDate(device.lastSeenAt)}` : ''}
              </p>
            </div>
            <button type="button" className="button secondary small" disabled={busy !== null} onClick={() => void free(device)}>
              {busy === device.id ? 'Freeing…' : 'Free this seat'}
            </button>
          </li>
        ))}
      </ul>
      {past > 0 ? (
        <p className="lede small" style={{ marginTop: 12 }}>
          {past} earlier {past === 1 ? 'computer' : 'computers'} on record. Signing in on one again reclaims a seat if one is free.
        </p>
      ) : null}
      {error ? (
        <p className="error" role="alert" style={{ marginTop: 12 }}>
          {error}
        </p>
      ) : null}
    </>
  );
}
