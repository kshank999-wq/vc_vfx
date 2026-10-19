import type Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import { fulfillCheckout, type FulfillmentInput } from '../fulfillment';
import { processStripeEvent, purchaseSettled, routeStripeEvent, type WebhookDeps } from '../webhook';
import { createFakeSupabase, type FakeSupabase } from './fake-supabase';

/**
 * The money path. Stripe delivers at least once, so: one purchase, one
 * licence, however many times the webhook arrives — and the licence follows
 * the subscription and the money afterwards.
 */

let serialCounter = 0;
const newSerial = () => {
  serialCounter += 1;
  return `VFX-TEST${String(serialCounter).padStart(1, 'A')}-AAAAA-BBBBB-CCCCC`;
};

const PERIOD_END = '2026-11-19T00:00:00.000Z';

const depsFor = (fake: FakeSupabase, overrides: Partial<WebhookDeps> = {}) => {
  const sendPurchaseEmail = vi.fn(async () => ({ sent: true, error: null }));
  const deps: WebhookDeps = {
    client: fake.client,
    newSerial,
    periodEnd: vi.fn(async () => PERIOD_END),
    subscriptionForCharge: vi.fn(async () => null),
    sendPurchaseEmail,
    ...overrides,
  };
  return { deps, sendPurchaseEmail: deps.sendPurchaseEmail as ReturnType<typeof vi.fn> };
};

const event = <T extends Stripe.Event['type']>(type: T, object: unknown, id = `evt_${type}_${Math.random()}`): Stripe.Event =>
  ({ id, type, data: { object } }) as unknown as Stripe.Event;

const checkout = (overrides: Record<string, unknown> = {}) =>
  event(
    'checkout.session.completed',
    {
      id: 'cs_test_1',
      mode: 'subscription',
      payment_status: 'paid',
      customer_details: { email: 'Colourist@Example.com' },
      customer_email: null,
      customer: 'cus_1',
      subscription: 'sub_1',
      payment_intent: null,
      amount_total: 2900,
      currency: 'usd',
      metadata: { platform: 'macos', supabase_user_id: '', plan: 'yearly' },
      ...overrides,
    },
    'evt_checkout_1',
  );

describe('checkout.session.completed', () => {
  it('creates an account, an order and a licence paid to the period end, and emails the serial', async () => {
    const fake = createFakeSupabase();
    const { deps, sendPurchaseEmail } = depsFor(fake);

    const result = await processStripeEvent(checkout(), deps);

    expect(result).toEqual({ status: 200, body: { received: true, action: 'fulfilled' } });
    expect(fake.state.authUsers).toHaveLength(1);
    expect(fake.state.authUsers[0]?.email).toBe('colourist@example.com');
    expect(fake.state.orders).toHaveLength(1);
    expect(fake.state.orders[0]).toMatchObject({
      status: 'paid',
      plan: 'yearly',
      selected_platform: 'macos',
      stripe_customer_id: 'cus_1',
      stripe_subscription_id: 'sub_1',
      amount_cents: 2900,
    });
    expect(fake.state.licenses).toHaveLength(1);
    expect(fake.state.licenses[0]).toMatchObject({
      status: 'active',
      expires_at: PERIOD_END,
      stripe_subscription_id: 'sub_1',
      entitled_platforms: ['windows', 'macos'],
    });
    expect(sendPurchaseEmail).toHaveBeenCalledTimes(1);
    expect(sendPurchaseEmail).toHaveBeenCalledWith({
      to: 'Colourist@Example.com',
      serial: fake.state.licenses[0]?.['serial'],
    });
    expect(fake.state.stripe_webhook_events[0]?.['processed_at']).toBeTruthy();
  });

  it('a redelivered event is a no-op', async () => {
    const fake = createFakeSupabase();
    const { deps, sendPurchaseEmail } = depsFor(fake);

    await processStripeEvent(checkout(), deps);
    const again = await processStripeEvent(checkout(), deps);

    expect(again.body).toMatchObject({ duplicate: true });
    expect(fake.state.licenses).toHaveLength(1);
    expect(sendPurchaseEmail).toHaveBeenCalledTimes(1);
  });

  it('a different event for the same session still makes exactly one licence and sends no second email', async () => {
    const fake = createFakeSupabase();
    const { deps, sendPurchaseEmail } = depsFor(fake);

    await processStripeEvent(checkout(), deps);
    const action = await routeStripeEvent(checkout(), deps);

    expect(action).toBe('fulfilment_replayed');
    expect(fake.state.orders).toHaveLength(1);
    expect(fake.state.licenses).toHaveLength(1);
    expect(sendPurchaseEmail).toHaveBeenCalledTimes(1);
  });

  it('uses the signed-in account named in metadata rather than creating one', async () => {
    const fake = createFakeSupabase();
    const { deps } = depsFor(fake);
    await processStripeEvent(checkout({ metadata: { platform: 'windows', supabase_user_id: 'user-42', plan: 'monthly' } }), deps);
    expect(fake.state.authUsers).toHaveLength(0);
    expect(fake.state.licenses[0]?.['user_id']).toBe('user-42');
    expect(fake.state.orders[0]?.['plan']).toBe('monthly');
  });

  it('finds a returning customer by email', async () => {
    const fake = createFakeSupabase({ profiles: [{ id: 'existing-user', email: 'colourist@example.com' }] });
    const { deps } = depsFor(fake);
    await processStripeEvent(checkout(), deps);
    expect(fake.state.authUsers).toHaveLength(0);
    expect(fake.state.licenses[0]?.['user_id']).toBe('existing-user');
  });

  it('fulfils a 100%-off checkout (no_payment_required) and ignores an unpaid one', async () => {
    expect(purchaseSettled('no_payment_required')).toBe(true);
    expect(purchaseSettled('unpaid')).toBe(false);

    const fake = createFakeSupabase();
    const { deps } = depsFor(fake);
    const action = await routeStripeEvent(checkout({ payment_status: 'unpaid' }), deps);
    expect(action).toBe('unsettled');
    expect(fake.state.licenses).toHaveLength(0);
  });

  it('a failure leaves the event unprocessed so Stripe retries, and the retry succeeds', async () => {
    const fake = createFakeSupabase();
    const { deps } = depsFor(fake);
    const failing = await processStripeEvent(checkout({ customer_details: null, customer_email: null }), deps);
    expect(failing.status).toBe(500);
    expect(fake.state.stripe_webhook_events[0]?.['processed_at']).toBeUndefined();
    expect(fake.state.stripe_webhook_events[0]?.['error']).toMatch(/no customer email/);

    const retried = await processStripeEvent(checkout(), deps);
    expect(retried.status).toBe(200);
    expect(fake.state.licenses).toHaveLength(1);
  });

  it('an email failure never fails the webhook', async () => {
    const fake = createFakeSupabase();
    const { deps } = depsFor(fake, { sendPurchaseEmail: vi.fn(async () => Promise.reject(new Error('resend down'))) });
    const result = await processStripeEvent(checkout(), deps);
    expect(result.status).toBe(200);
    expect(fake.state.licenses).toHaveLength(1);
  });
});

describe('fulfilCheckout under concurrency', () => {
  it('two deliveries racing on the same session make one licence', async () => {
    const fake = createFakeSupabase();
    const input: FulfillmentInput = {
      checkoutSessionId: 'cs_race',
      paymentIntentId: null,
      stripeCustomerId: 'cus_r',
      customerEmail: 'race@example.com',
      amountCents: 2900,
      currency: 'usd',
      plan: 'monthly',
      selectedPlatform: 'windows',
      userId: null,
      subscriptionId: 'sub_r',
      expiresAt: PERIOD_END,
    };
    const [a, b] = await Promise.all([
      fulfillCheckout(input, { client: fake.client, newSerial }),
      fulfillCheckout(input, { client: fake.client, newSerial }),
    ]);
    expect(fake.state.licenses).toHaveLength(1);
    expect(a.licenseId).toBe(b.licenseId);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
  });
});

describe('subscription events', () => {
  const seeded = () =>
    createFakeSupabase({
      licenses: [
        { id: 'lic-1', user_id: 'u1', order_id: 'o1', serial: 'VFX-A', status: 'active', stripe_subscription_id: 'sub_1', expires_at: '2026-10-01T00:00:00.000Z' },
        { id: 'lic-2', user_id: 'u2', order_id: 'o2', serial: 'VFX-B', status: 'active', stripe_subscription_id: 'sub_2', expires_at: '2026-10-01T00:00:00.000Z' },
      ],
    });
  const subscription = (status: string, end = 1_800_000_000) => ({ id: 'sub_1', status, current_period_end: end, metadata: { kind: 'desktop' } });

  it('a renewal moves the paid-up date', async () => {
    const fake = seeded();
    const { deps } = depsFor(fake);
    await routeStripeEvent(event('customer.subscription.updated', subscription('active')), deps);
    expect(fake.state.licenses[0]).toMatchObject({ status: 'active', expires_at: new Date(1_800_000_000 * 1000).toISOString() });
    expect(fake.state.licenses[1]?.['expires_at']).toBe('2026-10-01T00:00:00.000Z');
  });

  it('past_due still entitles; canceled and unpaid expire', async () => {
    for (const [status, expected] of [
      ['past_due', 'active'],
      ['trialing', 'active'],
      ['canceled', 'expired'],
      ['unpaid', 'expired'],
      ['incomplete_expired', 'expired'],
    ] as const) {
      const fake = seeded();
      const { deps } = depsFor(fake);
      await routeStripeEvent(event('customer.subscription.updated', subscription(status)), deps);
      expect(fake.state.licenses[0]?.['status']).toBe(expected);
    }
  });

  it('deleted expires the licence', async () => {
    const fake = seeded();
    const { deps } = depsFor(fake);
    const action = await routeStripeEvent(event('customer.subscription.deleted', subscription('canceled')), deps);
    expect(action).toBe('subscription_synced');
    expect(fake.state.licenses[0]?.['status']).toBe('expired');
  });

  it('an event that beats the checkout is harmless', async () => {
    const fake = createFakeSupabase();
    const { deps } = depsFor(fake);
    await expect(routeStripeEvent(event('customer.subscription.created', subscription('active')), deps)).resolves.toBe(
      'subscription_synced',
    );
    expect(fake.state.licenses).toHaveLength(0);
  });
});

describe('refunds and disputes', () => {
  const seeded = () =>
    createFakeSupabase({
      orders: [{ id: 'o1', user_id: 'u1', status: 'paid', stripe_subscription_id: 'sub_1', stripe_payment_intent_id: null }],
      licenses: [{ id: 'lic-1', user_id: 'u1', order_id: 'o1', serial: 'VFX-A', status: 'active', stripe_subscription_id: 'sub_1' }],
    });

  it('a refunded subscription charge revokes the licence and marks the order', async () => {
    const fake = seeded();
    const { deps } = depsFor(fake, { subscriptionForCharge: vi.fn(async () => 'sub_1') });
    const action = await routeStripeEvent(event('charge.refunded', { id: 'ch_1', payment_intent: 'pi_1' }), deps);
    expect(action).toBe('refunded');
    expect(fake.state.orders[0]?.['status']).toBe('refunded');
    expect(fake.state.licenses[0]?.['status']).toBe('revoked');
  });

  it('a dispute is read off the dispute object, not a charge', async () => {
    const fake = seeded();
    const lookup = vi.fn(async () => 'sub_1');
    const { deps } = depsFor(fake, { subscriptionForCharge: lookup });
    const action = await routeStripeEvent(event('charge.dispute.created', { id: 'dp_1', charge: 'ch_9', payment_intent: 'pi_9' }), deps);
    expect(action).toBe('disputed');
    expect(lookup).toHaveBeenCalledWith('ch_9');
    expect(fake.state.orders[0]?.['status']).toBe('disputed');
    expect(fake.state.licenses[0]?.['status']).toBe('revoked');
  });

  it('falls back to the payment intent on the order', async () => {
    const fake = createFakeSupabase({
      orders: [{ id: 'o7', user_id: 'u1', status: 'paid', stripe_payment_intent_id: 'pi_7' }],
      licenses: [{ id: 'lic-7', user_id: 'u1', order_id: 'o7', serial: 'VFX-Z', status: 'active' }],
    });
    const { deps } = depsFor(fake);
    await routeStripeEvent(event('charge.refunded', { id: 'ch_7', payment_intent: 'pi_7' }), deps);
    expect(fake.state.licenses[0]?.['status']).toBe('revoked');
  });
});

it('ignores events it does not handle, and marks them processed', async () => {
  const fake = createFakeSupabase();
  const { deps } = depsFor(fake);
  const result = await processStripeEvent(event('invoice.paid', {}, 'evt_other'), deps);
  expect(result.body).toMatchObject({ action: 'ignored' });
  expect(fake.state.stripe_webhook_events[0]?.['processed_at']).toBeTruthy();
});
