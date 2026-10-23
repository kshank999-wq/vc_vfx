import { FILM_STUDIO_KEY_PREFIX, FILM_STUDIO_STATUS_PATH, type StatusSendOutcome } from '@vcvfx/domain';

/**
 * Sending the VFX status to VC Film Studio (addendum 19): one POST, and every
 * answer turned into something the person at the machine can act on. No
 * Electron here, so it is tested against a local server.
 *
 *   POST {site}/api/vfx/status
 *   Authorization: Bearer vcvfx_…
 *   Content-Type: application/json
 *
 * Film Studio's answers are sentences written for that person — `says` on
 * success, `error` on every refusal — and are passed on verbatim. When Film
 * Studio cannot be reached (a set is often offline) nothing is queued: the
 * answer says it was not sent, and the renderer offers the file instead.
 *
 * The key is never logged, never put in an answer, and never reaches the
 * renderer: every string that leaves here is scrubbed of it.
 */

export const SEND_TIMEOUT_MS = 30_000;

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal; redirect?: 'follow' | 'error' | 'manual' }) => Promise<{ status: number; text(): Promise<string> }>;

/** The site as typed, made an origin: `www.vcfilmstudio.com/` → `https://www.vcfilmstudio.com`. */
export function filmStudioOrigin(raw: string): { ok: true; origin: string } | { ok: false; reason: string } {
  const typed = raw.trim();
  if (!typed) return { ok: false, reason: 'Enter VC Film Studio’s address, e.g. https://www.vcfilmstudio.com' };
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(typed) ? typed : `https://${typed}`);
  } catch {
    return { ok: false, reason: `“${typed}” is not a web address. VC Film Studio’s is https://www.vcfilmstudio.com` };
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  // The key travels in a header: only over https, except to this computer (a Film Studio run locally).
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return { ok: false, reason: 'VC Film Studio’s address must start with https:// — the upload key is sent with every report.' };
  if (url.username || url.password) return { ok: false, reason: 'Leave the name and password out of the address; the upload key is what Film Studio checks.' };
  return { ok: true, origin: url.origin };
}

/** Why a pasted key cannot be a VC VFX upload key, or null when it can. */
export function uploadKeyProblem(raw: string): string | null {
  const key = raw.trim();
  if (!key) return 'Paste the upload key made on Film Studio’s data desk (From VC VFX → Send from VC VFX).';
  if (key.startsWith('vcdit_')) return 'That is a VC DIT upload key. VC VFX needs its own: make one on Film Studio’s data desk under From VC VFX → Send from VC VFX.';
  if (!key.startsWith(FILM_STUDIO_KEY_PREFIX)) return `A VC VFX upload key starts with “${FILM_STUDIO_KEY_PREFIX}”. Make one on Film Studio’s data desk under From VC VFX → Send from VC VFX.`;
  if (!/^vcvfx_[A-Za-z0-9_-]{32,200}$/.test(key)) return 'That upload key is not complete: copy it again from Film Studio, all of it.';
  return null;
}

/** "vcvfx_…7f3a": enough to tell keys apart, never enough to use one. */
export const keyHint = (key: string): string => `${FILM_STUDIO_KEY_PREFIX}…${key.slice(-4)}`;

/** Remove the key from a string, wherever it appears. */
export const redact = (s: string, key: string): string => (key ? s.split(key).join('[upload key]') : s);

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

const NOT_QUEUED = 'Nothing was queued and nothing was sent. Send again when there is a connection, or export the report (Export for VC Film Studio…) and import it on Film Studio’s data desk.';

export interface SendInput {
  origin: string;
  key: string;
  /** The `vc-film-studio.vfx-status/1` document as JSON text. */
  body: string;
  shots: number;
  readyToHandOff: number;
  fetch: FetchLike;
  timeoutMs?: number;
}

export async function sendFilmStudioStatus(input: SendInput): Promise<StatusSendOutcome> {
  const url = `${input.origin}${FILM_STUDIO_STATUS_PATH}`;
  const base = { url: input.origin, shots: input.shots };
  const scrub = (o: StatusSendOutcome): StatusSendOutcome => JSON.parse(redact(JSON.stringify(o), input.key)) as StatusSendOutcome;
  const controller = new AbortController();
  const timeoutMs = input.timeoutMs ?? SEND_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let status: number;
  let text: string;
  try {
    const response = await input.fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: input.body,
      signal: controller.signal,
      redirect: 'follow',
    });
    status = response.status;
    text = await response.text();
  } catch (error) {
    const timedOut = controller.signal.aborted;
    const why = timedOut ? `VC Film Studio did not answer within ${Math.round(timeoutMs / 1000)} seconds` : `VC Film Studio could not be reached at ${input.origin} (${(error as Error)?.message || 'no connection'}); this computer may be offline`;
    return scrub({ kind: 'not_sent', ...base, error: `Not sent: ${why}. ${NOT_QUEUED}` });
  } finally {
    clearTimeout(timer);
  }

  let answer: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) answer = parsed as Record<string, unknown>;
  } catch {
    answer = null;
  }
  if (!answer || typeof answer['ok'] !== 'boolean') {
    // Not Film Studio's answer at all: a wrong address, a proxy's page, a gateway timeout.
    return scrub({
      kind: 'refused',
      ...base,
      status,
      error: `${input.origin} answered HTTP ${status}, but not as VC Film Studio does. Check the address in Settings → VC Film Studio (it is normally https://www.vcfilmstudio.com). The report may not have arrived; sending again is safe.`,
      issues: [],
    });
  }
  if (answer['ok'] === true && status >= 200 && status < 300) {
    const summary = (answer['summary'] && typeof answer['summary'] === 'object' ? answer['summary'] : {}) as Record<string, unknown>;
    return scrub({
      kind: 'sent',
      ...base,
      shots: num(summary['shots'], input.shots),
      readyToHandOff: num(summary['readyToHandOff'], input.readyToHandOff),
      says: str(answer['says']) ?? 'Film Studio took the report.',
      warnings: strings(answer['warnings']),
      stale: answer['stale'] === true,
      report: str(answer['report']),
      production: str(answer['production']),
      summary: Object.fromEntries(Object.entries(summary).filter((e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1]))),
    });
  }
  return scrub({
    kind: 'refused',
    ...base,
    status,
    error: str(answer['error']) ?? `Film Studio refused the report (HTTP ${status}) without saying why.`,
    issues: strings(answer['issues']),
  });
}
