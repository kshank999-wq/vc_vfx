import Link from 'next/link';
import type { PlanPrice } from '@/lib/pricing';

const INCLUDED = ['Windows and macOS', 'Active on two computers', 'Every update while subscribed', 'Cancel any time'];

/** Prices as Stripe answers them, or an honest "coming soon" with buying disabled. */
export function PricingCards({ plans }: { plans: PlanPrice[] }) {
  if (plans.length === 0) {
    return (
      <div className="pricing-soon">
        <span className="badge">Coming soon</span>
        <h3 style={{ marginTop: 16 }}>Pricing coming soon</h3>
        <p>
          Monthly and yearly plans will be listed here when subscriptions open. Both cover Windows and macOS, two
          active computers and every update.
        </p>
        <p style={{ marginTop: 22 }}>
          <span className="button" aria-disabled="true">
            Buy — not yet available
          </span>
        </p>
      </div>
    );
  }

  return (
    <div className="pricing">
      {plans.map((plan) => (
        <article key={plan.plan} className={plan.plan === 'yearly' ? 'price-card featured' : 'price-card'}>
          <span className="plan">{plan.label}</span>
          {plan.savingPercent ? <span className="badge v1 save">Save {plan.savingPercent}%</span> : null}
          <div className="figure">{plan.formatted}</div>
          <div className="per">{plan.per}, plus any applicable tax</div>
          <ul className="ticks">
            {INCLUDED.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <Link href={`/download?plan=${plan.plan}`} className={plan.plan === 'yearly' ? 'button' : 'button secondary'}>
            Choose {plan.label.toLowerCase()}
          </Link>
        </article>
      ))}
    </div>
  );
}
