import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isPlan, licenseStatusForSubscription } from '@vcvfx/domain';
import { fulfillCheckout, parsePlatform } from './fulfillment';

/**
 * What the Stripe webhook does with a verified event. Kept out of the route so
 * the whole money path — idempotency, fulfilment, renewals, refunds — runs in
 * tests against a fake database with every Stripe call injected.
 */

export interface WebhookDeps {
  client: SupabaseClient;
  newSerial: () => string;
  /** `current_period_end` of a subscription as ISO, or null if Stripe cannot say. */
  periodEnd: (subscriptionId: string) => Promise<string | null>;
  /** The subscription a charge paid for (via its invoice), or null. */
  subscriptionForCharge: (chargeId: string) => Promise<string | null>;
  sendPurchaseEmail: (input: { to: string; serial: string }) => Promise<unknown>;
}

export type EventAction =
  | 'fulfilled'
  | 'fulfilment_replayed'
  | 'unsettled'
  | 'subscription_synced'
  | 'refunded'
  | 'disputed'
  | 'ignored';

/** Stripe's `payment_status` words that mean the buyer owes nothing further. */
export const purchaseSettled = (paymentStatus: string | null | undefined): boolean =>
  paymentStatus === 'paid' || paymentStatus === 'no_payment_required';

const idOf = (value: string | { id: string } | null | undefined): string | null =>
  typeof value === 'string' ? value : value?.id ?? null;

const handleCheckout = async (session: Stripe.Checkout.Session, deps: WebhookDeps): Promise<EventAction> => {
  if (!purchaseSettled(session.payment_status)) return 'unsettled';
  const email = session.customer_details?.email ?? session.customer_email;
  if (!email) throw new Error(`Checkout session ${session.id} has no customer email`);

  const subscriptionId = idOf(session.subscription);
  const expiresAt = subscriptionId ? await deps.periodEnd(subscriptionId) : null;
  const plan = session.metadata?.['plan'];

  const result = await fulfillCheckout(
    {
      checkoutSessionId: session.id,
      paymentIntentId: idOf(session.payment_intent),
      stripeCustomerId: idOf(session.customer),
      customerEmail: email,
      amountCents: session.amount_total ?? 0,
      currency: session.currency ?? 'usd',
      plan: plan && isPlan(plan) ? plan : 'monthly',
      selectedPlatform: parsePlatform(session.metadata?.['platform']),
      userId: session.metadata?.['supabase_user_id'] || null,
      subscriptionId,
      expiresAt,
    },
    { client: deps.client, newSerial: deps.newSerial },
  );

  // Only the first successful fulfilment sends mail; a failure to send is the
  // email module's to log, never a reason to fail the webhook.
  if (result.created) {
    try {
      await deps.sendPurchaseEmail({ to: email, serial: result.serial });
    } catch {
      // Logged by the sender; the licence is on the account page regardless.
    }
    return 'fulfilled';
  }
  return 'fulfilment_replayed';
};

/**
 * A renewal, lapse, plan change or cancellation: move the licence's status and
 * paid-up date to what Stripe says. No licence yet is not a failure — the
 * subscription event can beat the checkout, which then writes both itself.
 */
const handleSubscription = async (subscription: Stripe.Subscription, deps: WebhookDeps): Promise<EventAction> => {
  await deps.client
    .from('licenses')
    .update({
      status: licenseStatusForSubscription(subscription.status),
      expires_at: new Date(subscription.current_period_end * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('stripe_subscription_id', subscription.id);
  return 'subscription_synced';
};

/** Entitlement follows the money: a refund or dispute revokes the licence. */
const handleReversal = async (
  status: 'refunded' | 'disputed',
  paymentIntentId: string | null,
  chargeId: string | null,
  deps: WebhookDeps,
): Promise<EventAction> => {
  const { client } = deps;
  const subscriptionId = chargeId ? await deps.subscriptionForCharge(chargeId) : null;

  if (subscriptionId) {
    await client.from('orders').update({ status }).eq('stripe_subscription_id', subscriptionId);
    await client
      .from('licenses')
      .update({ status: 'revoked', updated_at: new Date().toISOString() })
      .eq('stripe_subscription_id', subscriptionId);
  }
  if (paymentIntentId) {
    const { data: order } = await client
      .from('orders')
      .update({ status })
      .eq('stripe_payment_intent_id', paymentIntentId)
      .select('id')
      .maybeSingle();
    if (order) {
      await client
        .from('licenses')
        .update({ status: 'revoked', updated_at: new Date().toISOString() })
        .eq('order_id', order.id);
    }
  }
  return status;
};

export const routeStripeEvent = async (event: Stripe.Event, deps: WebhookDeps): Promise<EventAction> => {
  switch (event.type) {
    case 'checkout.session.completed':
      return handleCheckout(event.data.object, deps);
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return handleSubscription(event.data.object, deps);
    case 'charge.refunded': {
      const charge = event.data.object;
      return handleReversal('refunded', idOf(charge.payment_intent), charge.id, deps);
    }
    case 'charge.dispute.created': {
      const dispute = event.data.object;
      return handleReversal('disputed', idOf(dispute.payment_intent), idOf(dispute.charge), deps);
    }
    default:
      return 'ignored';
  }
};

export interface WebhookResult {
  status: 200 | 500;
  body: Record<string, unknown>;
}

/**
 * Claim the event id, route it, and mark it processed. A redelivery of an
 * event already processed exits at once; one whose earlier attempt failed is
 * let through, which is exactly what Stripe's retry is for.
 */
export const processStripeEvent = async (event: Stripe.Event, deps: WebhookDeps): Promise<WebhookResult> => {
  const { client } = deps;
  const { error: claimError } = await client.from('stripe_webhook_events').insert({ id: event.id, type: event.type });
  if (claimError) {
    const { data: seen } = await client
      .from('stripe_webhook_events')
      .select('processed_at')
      .eq('id', event.id)
      .maybeSingle();
    if (seen?.processed_at) return { status: 200, body: { received: true, duplicate: true } };
  }

  try {
    const action = await routeStripeEvent(event, deps);
    await client
      .from('stripe_webhook_events')
      .update({ processed_at: new Date().toISOString(), error: null })
      .eq('id', event.id);
    return { status: 200, body: { received: true, action } };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Fulfilment failed';
    // processed_at stays null so Stripe's retry re-runs the idempotent path.
    await client.from('stripe_webhook_events').update({ error: message }).eq('id', event.id);
    return { status: 500, body: { error: message } };
  }
};
