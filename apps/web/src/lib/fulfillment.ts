import type { SupabaseClient } from '@supabase/supabase-js';
import { isPlatform, type Platform, type SubscriptionPlan } from '@vcvfx/domain';

/**
 * Turning a paid Stripe checkout into an entitlement.
 *
 * Stripe delivers webhooks at least once, so this is idempotent: a retry of
 * the same event ends with exactly one order and exactly one licence. Two
 * unique constraints do the real work — `orders.stripe_checkout_session_id`
 * and `licenses.order_id` — so concurrent retries collide in Postgres rather
 * than racing here. The client is an argument so the money path is tested
 * against a fake.
 */

export interface FulfillmentInput {
  checkoutSessionId: string;
  paymentIntentId: string | null;
  stripeCustomerId: string | null;
  customerEmail: string;
  amountCents: number;
  currency: string;
  plan: SubscriptionPlan;
  selectedPlatform: Platform | null;
  /** Present when the buyer was signed in when they started checkout. */
  userId: string | null;
  subscriptionId: string | null;
  /** The paid-up-to date (`current_period_end`), or null if not yet known. */
  expiresAt: string | null;
}

export interface FulfillmentResult {
  userId: string;
  orderId: string;
  licenseId: string;
  serial: string;
  /** False when a retry found the licence already present. */
  created: boolean;
}

export interface FulfillmentDeps {
  client: SupabaseClient;
  newSerial: () => string;
}

export const parsePlatform = (value: unknown): Platform | null =>
  typeof value === 'string' && isPlatform(value) ? value : null;

const findByEmail = async (client: SupabaseClient, email: string): Promise<string | null> => {
  const { data } = await client.from('profiles').select('id').ilike('email', email).maybeSingle();
  return (data?.id as string | undefined) ?? null;
};

/**
 * Resolve the buyer to an account: the signed-in id if checkout carried one,
 * else an existing profile with that email, else a new confirmed account (the
 * purchase email tells them how to sign in with a magic link).
 */
export const resolveUserId = async (client: SupabaseClient, input: FulfillmentInput): Promise<string> => {
  if (input.userId) return input.userId;
  const email = input.customerEmail.trim().toLowerCase();

  const existing = await findByEmail(client, email);
  if (existing) return existing;

  const { data: created, error } = await client.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { source: 'stripe_checkout' },
  });
  if (created?.user) return created.user.id;

  // Lost a race with a concurrent delivery that created the same account.
  const raced = await findByEmail(client, email);
  if (raced) return raced;
  throw new Error(`Could not create or find an account for ${email}: ${error?.message ?? 'unknown error'}`);
};

export const fulfillCheckout = async (input: FulfillmentInput, deps: FulfillmentDeps): Promise<FulfillmentResult> => {
  const { client, newSerial } = deps;
  const userId = await resolveUserId(client, input);

  const { data: order, error: orderError } = await client
    .from('orders')
    .upsert(
      {
        user_id: userId,
        status: 'paid',
        plan: input.plan,
        selected_platform: input.selectedPlatform,
        amount_cents: input.amountCents,
        currency: input.currency,
        stripe_checkout_session_id: input.checkoutSessionId,
        stripe_payment_intent_id: input.paymentIntentId,
        stripe_customer_id: input.stripeCustomerId,
        stripe_subscription_id: input.subscriptionId,
        paid_at: new Date().toISOString(),
      },
      { onConflict: 'stripe_checkout_session_id' },
    )
    .select('id')
    .single();
  if (orderError || !order) {
    throw new Error(`Could not record order for session ${input.checkoutSessionId}: ${orderError?.message}`);
  }
  const orderId = order.id as string;

  const existing = await client.from('licenses').select('id, serial').eq('order_id', orderId).maybeSingle();
  if (existing.data) {
    // A replay. If the first delivery landed before the period end was known,
    // catch it up; writing it again is harmless.
    if (input.subscriptionId) {
      await client
        .from('licenses')
        .update({ stripe_subscription_id: input.subscriptionId, expires_at: input.expiresAt })
        .eq('id', existing.data.id);
    }
    return { userId, orderId, licenseId: existing.data.id, serial: existing.data.serial, created: false };
  }

  const { data: license, error: licenseError } = await client
    .from('licenses')
    .insert({
      user_id: userId,
      order_id: orderId,
      serial: newSerial(),
      status: 'active',
      entitled_platforms: ['windows', 'macos'],
      stripe_subscription_id: input.subscriptionId,
      expires_at: input.expiresAt,
    })
    .select('id, serial')
    .single();

  if (licenseError || !license) {
    // A concurrent retry won the unique(order_id) race — read its licence.
    const { data: raced } = await client.from('licenses').select('id, serial').eq('order_id', orderId).maybeSingle();
    if (raced) return { userId, orderId, licenseId: raced.id, serial: raced.serial, created: false };
    throw new Error(`Could not issue licence for order ${orderId}: ${licenseError?.message}`);
  }

  return { userId, orderId, licenseId: license.id, serial: license.serial, created: true };
};
