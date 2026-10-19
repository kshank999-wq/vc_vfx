'use client';

import { useState } from 'react';
import type { Platform } from '@vcvfx/domain';

/** Asks for a fresh signed installer URL each click; the URL is never rendered. */
export function DownloadButton({ platform }: { platform: Platform }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sha, setSha] = useState<string | null>(null);

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/downloads/${platform}`);
      const payload = (await response.json()) as { url?: string; sha256?: string; error?: string };
      if (!response.ok || !payload.url) throw new Error(payload.error ?? 'Download could not be prepared');
      setSha(payload.sha256 ?? null);
      window.location.assign(payload.url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Download could not be prepared');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className="button" onClick={() => void download()} disabled={busy}>
        {busy ? 'Preparing…' : `Download for ${platform === 'windows' ? 'Windows' : 'macOS'}`}
      </button>
      {sha ? (
        <p className="field-note" style={{ marginTop: 8, wordBreak: 'break-all' }}>
          SHA-256 {sha}
        </p>
      ) : null}
      {error ? (
        <p className="error small" role="alert" style={{ marginTop: 8 }}>
          {error}
        </p>
      ) : null}
    </>
  );
}
