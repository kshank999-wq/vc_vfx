'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { safeNextPath } from '@/lib/auth-redirect';
import { accountsOpen, browserClient } from '@/lib/supabase-browser';

/**
 * Sign in with a password, or with an emailed link. Buyers who checked out
 * without an account have no password yet, so the link is how they first get
 * in; a password then works in any browser, where a link only works in the
 * browser that asked for it.
 */
export default function SignInPage() {
  return (
    <Suspense fallback={null}>
      <SignInForm />
    </Suspense>
  );
}

type Way = 'password' | 'link' | 'forgot';

function SignInForm() {
  const params = useSearchParams();
  const next = safeNextPath(params.get('next'));
  const failed = params.get('error') === 'link_expired';

  const [way, setWay] = useState<Way>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<'idle' | 'working' | 'sent' | 'reset-sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  if (!accountsOpen()) {
    return (
      <div className="shell">
        <div className="page-hero">
          <h1>Sign in</h1>
          <p>Accounts are not open yet. They open with the first release of VC VFX — check back soon.</p>
          <p style={{ marginTop: 24 }}>
            <Link href="/" className="button secondary">
              Back to the home page
            </Link>
          </p>
        </div>
      </div>
    );
  }

  const choose = (target: Way) => {
    setWay(target);
    setError(null);
  };

  const signIn = async (event: React.FormEvent) => {
    event.preventDefault();
    setStatus('working');
    setError(null);
    const { error: failure } = await browserClient().auth.signInWithPassword({ email, password });
    if (failure) {
      setError(
        failure.message === 'Invalid login credentials'
          ? 'That email and password do not match. If you have never set a password, use “Email me a link” instead.'
          : failure.message,
      );
      setStatus('idle');
      return;
    }
    // A full navigation so the server components read the new session cookie.
    window.location.assign(next);
  };

  const sendLink = async (event: React.FormEvent) => {
    event.preventDefault();
    setStatus('working');
    setError(null);
    const { error: failure } = await browserClient().auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
        // Accounts are made by checkout, never by asking for a link.
        shouldCreateUser: false,
      },
    });
    if (failure) {
      setError(
        /signups? not allowed|not found/i.test(failure.message)
          ? 'There is no VC VFX account for that address. Accounts are created when you subscribe.'
          : failure.message,
      );
      setStatus('idle');
      return;
    }
    setStatus('sent');
  };

  const sendReset = async (event: React.FormEvent) => {
    event.preventDefault();
    setStatus('working');
    setError(null);
    const { error: failure } = await browserClient().auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent('/reset')}`,
    });
    if (failure) {
      setError(failure.message);
      setStatus('idle');
      return;
    }
    setStatus('reset-sent');
  };

  if (status === 'sent' || status === 'reset-sent') {
    return (
      <div className="shell">
        <div className="page-hero">
          <h1>Check your email</h1>
        </div>
        <div className="page-body">
          <div className="auth-card">
            <p className="notice">
              {status === 'sent'
                ? `A sign-in link is on its way to ${email}.`
                : `If ${email} has an account, a link to set a new password is on its way.`}{' '}
              <strong>Open it in this browser</strong> — the link only works where it was asked for, and only once.
            </p>
            <p style={{ marginTop: 18 }}>
              <button type="button" className="button secondary" onClick={() => setStatus('idle')}>
                Back
              </button>
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <div className="page-hero">
        <h1>Sign in</h1>
        <p>Use the email address you subscribed with.</p>
      </div>
      <div className="page-body">
        <div className="auth-card">
          <div className="tabs" role="tablist" aria-label="How to sign in">
            <button type="button" role="tab" aria-selected={way !== 'link'} onClick={() => choose('password')}>
              Password
            </button>
            <button type="button" role="tab" aria-selected={way === 'link'} onClick={() => choose('link')}>
              Email me a link
            </button>
          </div>

          {way === 'password' ? (
            <form onSubmit={signIn} className="form">
              <input
                type="email"
                required
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@studio.com"
                aria-label="Email address"
              />
              <input
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Password"
                aria-label="Password"
              />
              <button type="submit" className="button" disabled={status === 'working'}>
                {status === 'working' ? 'Signing in…' : 'Sign in'}
              </button>
              <button type="button" className="text-button small" style={{ justifySelf: 'start' }} onClick={() => choose('forgot')}>
                Forgotten your password?
              </button>
            </form>
          ) : way === 'forgot' ? (
            <form onSubmit={sendReset} className="form">
              <input
                type="email"
                required
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@studio.com"
                aria-label="Email address"
              />
              <button type="submit" className="button" disabled={status === 'working'}>
                {status === 'working' ? 'Sending…' : 'Email me a reset link'}
              </button>
              <button type="button" className="text-button small" style={{ justifySelf: 'start' }} onClick={() => choose('password')}>
                Back to signing in
              </button>
            </form>
          ) : (
            <form onSubmit={sendLink} className="form">
              <input
                type="email"
                required
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@studio.com"
                aria-label="Email address"
              />
              <button type="submit" className="button" disabled={status === 'working'}>
                {status === 'working' ? 'Sending…' : 'Email me a link'}
              </button>
              <p className="field-note">New subscribers start here: no password needed.</p>
            </form>
          )}

          {error ? (
            <p className="error small" role="alert" style={{ marginTop: 16 }}>
              {error}
            </p>
          ) : null}

          {failed ? (
            <p className="notice" role="status" style={{ marginTop: 18 }}>
              That link could not sign you in: it had already been used, or it was opened in a different browser from
              the one that asked for it. Ask for a new one — or set a password once you are in.
            </p>
          ) : null}
        </div>
        <p className="lede small" style={{ marginTop: 20 }}>
          No account yet? One is created when you <Link href="/download">subscribe</Link>.
        </p>
      </div>
    </div>
  );
}
