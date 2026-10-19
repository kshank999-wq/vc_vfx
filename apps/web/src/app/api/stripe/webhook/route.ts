import type Stripe from 'stripe';
import { env, hasSupabase } from '@/lib/env';
import { json } from '@/lib/http';
import { generateSerial } from '@/lib/license';
import { sendPurchaseEmail } from '@/lib/email';
import { stripe } from '@/lib/stripe';
import { adminClient } from '@/lib/supabase';
import { processStripeEvent } from '@/lib/webhook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const periodEnd = async (subscriptionId: string): Promise<string | null> => {
  try {
    const subscription = await stripe().subscriptions.retrieve(subscriptionId);
    return new Date(subscription.current_period_end * 1000).toISOString();
  } catch {
    // A licence with no expiry never lapses — the safe way to be wrong for
    // somebody who has just paid; the next subscription event writes the date.
    return null;
  }
};

const subscriptionForCharge = async (chargeId: string): Promise<string | null> => {
  try {
    const charge = await stripe().charges.retrieve(chargeId, { expand: ['invoice'] });
    const invoice = charge.invoice as Stripe.Invoice | string | null;
    if (!invoice || typeof invoice === 'string') return null;
    const subscription = invoice.subscription;
    return typeof subscription === 'string' ? subscription : subscription?.id ?? null;
  } catch {
    return null;
  }
};

/**
 * Stripe webhook — the only place a paid entitlement is created. Verify the
 * signature, then hand the event to `processStripeEvent`, which claims it for
 * idempotency, routes it and records the outcome.
 */
export async function POST(request: Request): Promise<Response> {
  const signature = request.headers.get('stripe-signature');
  if (!signature) return json({ error: 'Missing stripe-signature header' }, 400);

  let event: Stripe.Event;
  try {
    const payload = await request.text();
    event = stripe().webhooks.constructEvent(payload, signature, env.stripeWebhookSecret);
  } catch (cause) {
    return json({ error: cause instanceof Error ? cause.message : 'Signature verification failed' }, 400);
  }

  // Without a database there is nowhere to write the entitlement: answer 500
  // so Stripe keeps retrying until Supabase is configured.
  if (!hasSupabase()) return json({ error: 'Accounts are not configured' }, 500);

  const result = await processStripeEvent(event, {
    client: adminClient(),
    newSerial: generateSerial,
    periodEnd,
    subscriptionForCharge,
    sendPurchaseEmail,
  });
  return json(result.body, result.status);
}
