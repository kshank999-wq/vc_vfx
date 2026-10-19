'use client';

import { useState } from 'react';
import type { Platform } from '@vcvfx/domain';

export interface ReleaseBuildRow {
  id: string;
  platform: Platform;
  version: string;
  channel: 'stable' | 'beta' | 'internal';
  minimum_os_version: string | null;
  release_notes: string | null;
  artifact_key: string;
  artifact_size_bytes: number | null;
  sha256: string;
  active: boolean;
  published_at: string | null;
  created_at: string;
}

const PLATFORM_LABEL: Record<Platform, string> = { windows: 'Windows', macos: 'macOS' };

const formatBytes = (bytes: number | null): string => (bytes ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : '—');

/** SHA-256 of the chosen file, computed in the browser so it can be checked against the build's own. */
const sha256Of = async (file: File): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
};

export function ReleaseManager({ initialBuilds }: { initialBuilds: ReleaseBuildRow[] }) {
  const [builds, setBuilds] = useState(initialBuilds);
  const [platform, setPlatform] = useState<Platform>('windows');
  const [version, setVersion] = useState('');
  const [channel, setChannel] = useState<'stable' | 'beta' | 'internal'>('internal');
  const [minimumOsVersion, setMinimumOsVersion] = useState('');
  const [releaseNotes, setReleaseNotes] = useState('');
  const [sha256, setSha256] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = async () => {
    const response = await fetch('/api/admin/releases');
    const payload = (await response.json()) as { builds?: ReleaseBuildRow[] };
    if (payload.builds) setBuilds(payload.builds);
  };

  const publish = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!file || version.trim().length === 0) return;
    setError(null);
    setMessage(null);

    try {
      setBusy('hash');
      const computed = await sha256Of(file);
      const given = sha256.trim().toLowerCase();
      if (given && given !== computed) {
        throw new Error(`The file's SHA-256 (${computed}) does not match the one entered. Check you chose the right installer.`);
      }

      setBusy('upload');
      const urlResponse = await fetch('/api/admin/releases', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform, version: version.trim(), fileName: file.name }),
      });
      const urlPayload = (await urlResponse.json()) as { artifactKey?: string; signedUrl?: string; error?: string };
      if (!urlResponse.ok || !urlPayload.signedUrl || !urlPayload.artifactKey) {
        throw new Error(urlPayload.error ?? 'The upload could not be prepared');
      }
      const upload = await fetch(urlPayload.signedUrl, {
        method: 'PUT',
        headers: { 'content-type': file.type || 'application/octet-stream' },
        body: file,
      });
      if (!upload.ok) throw new Error(`The installer failed to upload (${upload.status})`);

      setBusy('record');
      const recordResponse = await fetch('/api/admin/releases', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          platform,
          version: version.trim(),
          channel,
          minimumOsVersion,
          releaseNotes,
          artifactKey: urlPayload.artifactKey,
          artifactSizeBytes: file.size,
          sha256: computed,
        }),
      });
      const recordPayload = (await recordResponse.json()) as { error?: string };
      if (!recordResponse.ok) throw new Error(recordPayload.error ?? 'The build could not be recorded');

      setMessage(`${PLATFORM_LABEL[platform]} ${version} uploaded. It is not live until you make it live.`);
      setFile(null);
      setVersion('');
      setSha256('');
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Publishing failed');
    } finally {
      setBusy(null);
    }
  };

  const setActive = async (build: ReleaseBuildRow, active: boolean, promote = false) => {
    setBusy(build.id);
    setError(null);
    const response = await fetch(`/api/admin/releases/${build.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(promote ? { active, channel: 'stable' } : { active }),
    });
    setBusy(null);
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      setError(payload.error ?? 'That build could not be changed');
      return;
    }
    setMessage(
      active
        ? `${PLATFORM_LABEL[build.platform]} ${build.version} is now the live ${promote ? 'stable' : build.channel} build.`
        : `${PLATFORM_LABEL[build.platform]} ${build.version} retired.`,
    );
    await refresh();
  };

  const live = (target: Platform) => builds.find((b) => b.platform === target && b.channel === 'stable' && b.active);

  return (
    <>
      <section>
        <h2>Serving now</h2>
        <div className="grid">
          {(['windows', 'macos'] as const).map((target) => {
            const current = live(target);
            return (
              <article key={target} className="card">
                <h3>{PLATFORM_LABEL[target]}</h3>
                <p>
                  {current
                    ? `Version ${current.version}${current.minimum_os_version ? ` · requires ${current.minimum_os_version}+` : ''}`
                    : 'No stable build live yet.'}
                </p>
              </article>
            );
          })}
        </div>
      </section>

      <section>
        <h2>Upload a build</h2>
        <form onSubmit={publish} className="release-form">
          <label className="field">
            <span>Platform</span>
            <select value={platform} onChange={(event) => setPlatform(event.target.value as Platform)}>
              <option value="windows">Windows</option>
              <option value="macos">macOS</option>
            </select>
          </label>
          <label className="field">
            <span>Version</span>
            <input value={version} onChange={(event) => setVersion(event.target.value)} placeholder="1.0.0" required />
          </label>
          <label className="field">
            <span>Channel</span>
            <select value={channel} onChange={(event) => setChannel(event.target.value as typeof channel)}>
              <option value="internal">Internal</option>
              <option value="beta">Beta</option>
              <option value="stable">Stable</option>
            </select>
          </label>
          <label className="field">
            <span>Minimum OS</span>
            <input
              value={minimumOsVersion}
              onChange={(event) => setMinimumOsVersion(event.target.value)}
              placeholder={platform === 'macos' ? '12.0' : '10.0.19041'}
            />
          </label>
          <label className="field wide">
            <span>Installer</span>
            <input type="file" accept=".exe,.msi,.dmg,.pkg,.zip" onChange={(event) => setFile(event.target.files?.[0] ?? null)} required />
          </label>
          <label className="field wide">
            <span>Expected SHA-256 (optional — it is computed from the file and checked against this)</span>
            <input value={sha256} onChange={(event) => setSha256(event.target.value)} placeholder="from the build workflow output" />
          </label>
          <label className="field wide">
            <span>Release notes</span>
            <textarea rows={4} value={releaseNotes} onChange={(event) => setReleaseNotes(event.target.value)} />
          </label>
          <div className="wide">
            <button type="submit" className="button" disabled={busy !== null || !file}>
              {busy === 'hash' ? 'Hashing…' : busy === 'upload' ? 'Uploading…' : busy === 'record' ? 'Recording…' : 'Upload build'}
            </button>
          </div>
        </form>
        {error ? (
          <p className="notice error" role="alert" style={{ marginTop: 16 }}>
            {error}
          </p>
        ) : null}
        {message ? (
          <p className="notice" role="status" style={{ marginTop: 16 }}>
            {message}
          </p>
        ) : null}
      </section>

      <section>
        <h2>All builds</h2>
        {builds.length === 0 ? (
          <p className="lede">Nothing uploaded yet.</p>
        ) : (
          <ul className="list">
            {builds.map((build) => (
              <li key={build.id} className="card row">
                <div style={{ minWidth: 0 }}>
                  <strong>
                    {PLATFORM_LABEL[build.platform]} {build.version}
                  </strong>{' '}
                  {build.active ? <span className="badge ok">live</span> : null}
                  <p className="lede small">
                    {build.channel}
                    {build.minimum_os_version ? ` · min ${build.minimum_os_version}` : ''} · {formatBytes(build.artifact_size_bytes)}
                  </p>
                  <p className="field-note" style={{ wordBreak: 'break-all' }}>
                    {build.sha256}
                  </p>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {!build.active && build.channel !== 'stable' ? (
                    <button type="button" className="button small" disabled={busy !== null} onClick={() => void setActive(build, true, true)}>
                      Promote to stable
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={build.active ? 'button secondary small' : 'button small'}
                    disabled={busy !== null}
                    onClick={() => void setActive(build, !build.active)}
                  >
                    {build.active ? 'Retire' : `Make live (${build.channel})`}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
