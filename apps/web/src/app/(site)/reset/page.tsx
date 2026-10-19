'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { accountsOpen, browserClient } from '@/lib/supabase-browser';
import { SHORTEST, checkNewPassword, refusalFor } from '@/lib/password-words';

/**
 * Setting a new password after a reset link. The link is the proof, so the
 * old password is never asked for: `/auth/callback` has already turned the
 * code into the session by the time this renders.
 */
export default function ResetPage() {
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [status, setStatus] = useState<'idle' | 'working' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accountsOpen()) {
      setReady(true);
      return;
    }
    let alive = true;
    void browserClient()
      .auth.getSession()
      .then(({ data }) => {
        if (!alive) return;
        setSignedIn(Boolean(data.session));
        setEmail(data.session?.user.email ?? null);
        setReady(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const said = checkNewPassword(password, again);
    if (said) {
      setError(said);
      return;
    }
    setError(null);
    setStatus('working');
    const { error: failure } = await browserClient().auth.updateUser({ password });
    if (failure) {
      setError(refusalFor(failure, 'This link could not set a password. Ask for a new reset link and try again.'));
      setStatus('idle');
      return;
    }
    setStatus('done');
  };

  if (!ready) return null;

  return (
    <div className="shell">
      <div className="page-hero">
        <h1>{status === 'done' ? 'Password set' : signedIn ? 'Set a new password' : 'That link did not open'}</h1>
        {signedIn && status !== 'done' ? <p>{email ?? 'Your account'}</p> : null}
      </div>
      <div className="page-body">
        <div className="auth-card">
          {status === 'done' ? (
            <>
              <p className="notice" role="status">
                You are signed in, and the new password works everywhere now — including the desktop app.
              </p>
              <p style={{ marginTop: 18 }}>
                <Link href="/account" className="button">
                  My account
                </Link>
              </p>
            </>
          ) : !signedIn ? (
            <>
              <p className="notice">
                A reset link only works in the browser that asked for it, and only once. If your mail app opened it
                itself, copy the link into your own browser — or ask for a new one.
              </p>
              <p style={{ marginTop: 18 }}>
                <Link href="/signin" className="button">
                  Ask for a new link
                </Link>
              </p>
            </>
          ) : (
            <form onSubmit={save} className="form">
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
                placeholder="And again"
                aria-label="Repeat the new password"
              />
              <button type="submit" className="button" disabled={status === 'working'}>
                {status === 'working' ? 'Saving…' : 'Set password'}
              </button>
              {error ? (
                <p className="error small" role="alert">
                  {error}
                </p>
              ) : null}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
