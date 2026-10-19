'use client';

import { useState } from 'react';

/** Email the licence again, to the account's own address only. */
export function ResendLicense() {
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    setState('sending');
    setError(null);
    const response = await fetch('/api/account/resend-license', { method: 'POST' });
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) {
      setError(payload.error ?? 'The email could not be sent');
      setState('idle');
      return;
    }
    setState('sent');
  };

  if (state === 'sent') return <p className="notice">Sent. Check your inbox for your licence.</p>;

  return (
    <>
      <button type="button" className="button secondary small" onClick={() => void send()} disabled={state === 'sending'}>
        {state === 'sending' ? 'Sending…' : 'Email me my licence'}
      </button>
      {error ? (
        <p className="error small" role="alert" style={{ marginTop: 10 }}>
          {error}
        </p>
      ) : null}
    </>
  );
}
