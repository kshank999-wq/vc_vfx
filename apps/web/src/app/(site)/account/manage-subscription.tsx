'use client';

import { useState } from 'react';

/** Opens the Stripe customer portal: plan, card, invoices, cancellation. */
export function ManageSubscription() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/portal', { method: 'POST' });
      const payload = (await response.json()) as { url?: string; error?: string };
      if (!response.ok || !payload.url) throw new Error(payload.error ?? 'The billing portal could not be opened');
      window.location.assign(payload.url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The billing portal could not be opened');
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className="button secondary small" onClick={() => void open()} disabled={busy}>
        {busy ? 'Opening…' : 'Manage subscription'}
      </button>
      {error ? (
        <p className="error small" role="alert" style={{ marginTop: 10 }}>
          {error}
        </p>
      ) : null}
    </>
  );
}
