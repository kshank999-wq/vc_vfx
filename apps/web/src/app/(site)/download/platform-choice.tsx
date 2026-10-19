'use client';

import { useState } from 'react';
import type { Platform, SubscriptionPlan } from '@vcvfx/domain';

export interface PlanOffer {
  plan: SubscriptionPlan;
  label: string;
  per: string;
  formatted: string;
  savingPercent: number | null;
}

const OPTIONS: ReadonlyArray<{ platform: Platform; label: string; detail: string }> = [
  { platform: 'windows', label: 'Windows', detail: 'Windows 10 and 11, 64-bit' },
  { platform: 'macos', label: 'macOS', detail: 'Apple silicon and Intel' },
];

/** Plan and platform, then Stripe Checkout. The server picks the price. */
export function PlatformChoice({
  plans,
  initialPlan,
  checkoutOpen,
  signedIn,
}: {
  plans: PlanOffer[];
  initialPlan: SubscriptionPlan | null;
  checkoutOpen: boolean;
  signedIn: boolean;
}) {
  const [plan, setPlan] = useState<SubscriptionPlan>(
    initialPlan && plans.some((p) => p.plan === initialPlan) ? initialPlan : plans[0]?.plan ?? 'monthly',
  );
  const [platform, setPlatform] = useState<Platform>('windows');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startCheckout = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform, plan }),
      });
      const payload = (await response.json()) as { url?: string; error?: string };
      if (!response.ok || !payload.url) throw new Error(payload.error ?? 'Checkout could not be started');
      window.location.assign(payload.url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Checkout could not be started');
      setBusy(false);
    }
  };

  return (
    <section>
      <p className="step-label" style={{ marginTop: 0 }}>
        1 · Plan
      </p>
      {plans.length > 0 ? (
        <div className="choice-grid" role="radiogroup" aria-label="Plan">
          {plans.map((offer) => (
            <button
              key={offer.plan}
              type="button"
              className="choice"
              role="radio"
              aria-checked={plan === offer.plan}
              onClick={() => setPlan(offer.plan)}
            >
              <strong>
                {offer.label}
                {offer.savingPercent ? (
                  <span className="badge v1" style={{ marginLeft: 10, verticalAlign: 2 }}>
                    Save {offer.savingPercent}%
                  </span>
                ) : null}
              </strong>
              <span className="big" style={{ color: 'var(--text)' }}>
                {offer.formatted}
              </span>
              <span>{offer.per}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="pricing-soon">
          <span className="badge">Coming soon</span>
          <h3 style={{ marginTop: 14 }}>Pricing coming soon</h3>
          <p>Subscriptions are not open yet. Monthly and yearly plans will appear here when they are.</p>
        </div>
      )}

      <p className="step-label">2 · Platform</p>
      <div className="choice-grid">
        {OPTIONS.map((option) => (
          <button
            key={option.platform}
            type="button"
            className="choice"
            aria-pressed={platform === option.platform}
            onClick={() => setPlatform(option.platform)}
          >
            <strong>{option.label}</strong>
            <span>{option.detail}</span>
          </button>
        ))}
      </div>

      <div style={{ marginTop: 28 }}>
        <button type="button" className="button large" onClick={startCheckout} disabled={busy || !checkoutOpen}>
          {!checkoutOpen ? 'Checkout opens soon' : busy ? 'Opening checkout…' : 'Continue to checkout'}
        </button>
      </div>

      {error ? (
        <p className="notice error" role="alert" style={{ marginTop: 16 }}>
          {error}
        </p>
      ) : null}

      <p className="lede small" style={{ marginTop: 20, maxWidth: 640 }}>
        {signedIn
          ? 'The licence goes onto the account you are signed in with.'
          : 'No account needed first: one is created for the email you pay with, and your licence and a sign-in link arrive by email.'}{' '}
        Promotion codes can be entered at checkout. Cancel any time from your account.
      </p>
    </section>
  );
}
