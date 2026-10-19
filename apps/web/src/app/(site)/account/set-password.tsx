'use client';

import { useState } from 'react';
import { browserClient } from '@/lib/supabase-browser';
import { SHORTEST, checkNewPassword, refusalFor } from '@/lib/password-words';

/**
 * Set or change a password. Only somebody already signed in can, so the
 * current password is asked for but not required — an account that has only
 * ever used email links has none to prove.
 */
export function SetPassword() {
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [status, setStatus] = useState<'idle' | 'working' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const said = checkNewPassword(password, again);
    if (said) {
      setError(said);
      return;
    }
    setError(null);
    setStatus('working');
    const { error: failure } = await browserClient().auth.updateUser(
      current.length > 0 ? { password, current_password: current } : { password },
    );
    if (failure) {
      setError(
        refusalFor(
          failure,
          'That is not your current password. If you have never set one, leave that box empty — if you have forgotten it, ask for a reset link on the sign-in page.',
        ),
      );
      setStatus('idle');
      return;
    }
    setCurrent('');
    setPassword('');
    setAgain('');
    setStatus('done');
  };

  return (
    <section>
      <h2>Password</h2>
      <p className="lede small" style={{ marginBottom: 16 }}>
        Optional. With a password you can sign in to the desktop app and the site without waiting for an email link.
      </p>
      {status === 'done' ? (
        <p className="notice" role="status" style={{ marginBottom: 16 }}>
          Saved. You can sign in with it anywhere now.
        </p>
      ) : null}
      <form onSubmit={save} className="form">
        <input
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
          placeholder="Current password (if you have one)"
          aria-label="Current password"
        />
        <input
          type="password"
          required
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder={`New password (${SHORTEST}+ characters)`}
          aria-label="New password"
        />
        <input
          type="password"
          required
          autoComplete="new-password"
          value={again}
          onChange={(event) => setAgain(event.target.value)}
          placeholder="New password again"
          aria-label="Repeat the new password"
        />
        <button type="submit" className="button" disabled={status === 'working'}>
          {status === 'working' ? 'Saving…' : 'Save password'}
        </button>
      </form>
      {error ? (
        <p className="error small" role="alert" style={{ marginTop: 12 }}>
          {error}
        </p>
      ) : null}
    </section>
  );
}
