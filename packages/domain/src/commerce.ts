/**
 * Commerce: plans, licences, serials and device activation.
 *
 * Same model as VC Writer: a Stripe subscription (monthly or yearly) issues a
 * licence with a serial; each licence may be active on a fixed number of
 * machines; a lapse is written to the licence's own status and expiry. Prices
 * are never stored here — Stripe is the source of truth for what a plan costs.
 */

export const PLATFORMS = ['windows', 'macos'] as const;
export type Platform = (typeof PLATFORMS)[number];
export const isPlatform = (s: string): s is Platform => (PLATFORMS as readonly string[]).includes(s);

export const PLANS = ['monthly', 'yearly'] as const;
export type SubscriptionPlan = (typeof PLANS)[number];
export const isPlan = (s: string): s is SubscriptionPlan => (PLANS as readonly string[]).includes(s);

export type LicenseStatus = 'active' | 'suspended' | 'revoked' | 'expired';

export interface License {
  id: string;
  status: LicenseStatus;
  maxActivations: number;
  expiresAt: string | null;
  entitledPlatforms: readonly Platform[];
}

export interface DeviceActivation {
  id: string;
  licenseId: string;
  deviceFingerprint: string;
  deviceName: string;
  platform: Platform;
  deactivatedAt: string | null;
}

export const SERIAL_PREFIX = 'VFX';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** `VFX-XXXXX-XXXXX-XXXXX-XXXXX` from 20 random bytes supplied by the host. */
export function serialFromBytes(bytes: Uint8Array): string {
  if (bytes.length < 20) throw new Error('Need 20 random bytes');
  const chars = Array.from(bytes.slice(0, 20), (b) => ALPHABET[b % ALPHABET.length]!);
  const groups = [0, 5, 10, 15].map((i) => chars.slice(i, i + 5).join(''));
  return [SERIAL_PREFIX, ...groups].join('-');
}

export function isWellFormedSerial(s: string): boolean {
  return new RegExp(`^${SERIAL_PREFIX}(-[${ALPHABET}]{5}){4}$`).test(s.trim().toUpperCase());
}

/** Active status and, for a subscription, inside the paid period. */
export function licenseLive(license: Pick<License, 'status' | 'expiresAt'>, now: Date): boolean {
  if (license.status !== 'active') return false;
  return license.expiresAt === null || new Date(license.expiresAt).getTime() > now.getTime();
}

export function canDownloadPlatform(license: Pick<License, 'status' | 'expiresAt' | 'entitledPlatforms'>, platform: Platform, now: Date): boolean {
  return licenseLive(license, now) && license.entitledPlatforms.includes(platform);
}

const ENTITLING = new Set(['active', 'trialing', 'past_due']);
/** Stripe subscription status → licence status. Unknown words do not entitle. */
export function licenseStatusForSubscription(stripeStatus: string): LicenseStatus {
  return ENTITLING.has(stripeStatus) ? 'active' : 'expired';
}

export type ActivationOutcome =
  | { result: 'activated'; reason: 'new_device' | 'already_active' | 'reactivated' }
  | { result: 'refused'; reason: 'license_inactive' }
  | { result: 'refused'; reason: 'no_slots'; inUse: number; limit: number };

export function decideActivation(req: {
  license: License;
  activations: readonly DeviceActivation[];
  deviceFingerprint: string;
  now: Date;
}): ActivationOutcome {
  if (!licenseLive(req.license, req.now)) return { result: 'refused', reason: 'license_inactive' };
  const own = req.activations.filter((a) => a.licenseId === req.license.id);
  const existing = own.find((a) => a.deviceFingerprint === req.deviceFingerprint);
  if (existing && existing.deactivatedAt === null) return { result: 'activated', reason: 'already_active' };
  const inUse = own.filter((a) => a.deactivatedAt === null).length;
  if (inUse >= req.license.maxActivations) return { result: 'refused', reason: 'no_slots', inUse, limit: req.license.maxActivations };
  return { result: 'activated', reason: existing ? 'reactivated' : 'new_device' };
}

export function explainRefusal(o: ActivationOutcome): string | null {
  if (o.result !== 'refused') return null;
  if (o.reason === 'license_inactive') return 'This licence is not active. Check your subscription at vc-vfx.com/account.';
  return `This licence is on ${o.inUse} of ${o.limit} computers. Free one from your account at vc-vfx.com/account and try again.`;
}

/** The account's liveliest licence, or null if it has none. */
export function bestLicense<T extends Pick<License, 'status' | 'expiresAt'>>(licenses: readonly T[], now: Date): T | null {
  if (licenses.length === 0) return null;
  const live = licenses.find((l) => licenseLive(l, now));
  if (live) return live;
  const t = (l: T) => (l.expiresAt ? new Date(l.expiresAt).getTime() : Number.NEGATIVE_INFINITY);
  return [...licenses].sort((a, b) => t(b) - t(a))[0]!;
}

/**
 * What the desktop may do, from the last standing it heard (cached so a
 * machine offline on set keeps working). A lapsed or never-activated copy can
 * still open projects and print shot lists; it cannot write packages or run
 * processing. Work already on disk is never held hostage.
 */
export const OFFLINE_GRACE_DAYS = 30;
export type Capability = 'full' | 'read_only';

export function capabilityFrom(standing: { status: LicenseStatus; expiresAt: string | null; checkedAt: string } | null, now: Date): Capability {
  if (!standing) return 'read_only';
  if (!licenseLive(standing, now)) return 'read_only';
  const ageDays = (now.getTime() - new Date(standing.checkedAt).getTime()) / 86_400_000;
  return ageDays <= OFFLINE_GRACE_DAYS ? 'full' : 'read_only';
}
