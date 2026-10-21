/**
 * Toast notices: at most a few on screen, repeated ones collapsed into one
 * with a count, information gone after a few seconds. Errors stay until
 * dismissed (or pushed out by newer ones) so they are not missed.
 */

export interface Notice {
  id: number;
  kind: 'info' | 'error' | 'ok';
  text: string;
  action?: { label: string; run: () => void };
  /** How many similar notices this one stands for (1 = itself). */
  count?: number;
}

export const MAX_NOTICES = 3;
/** Milliseconds an info or ok notice stays up. */
export const NOTICE_MS = 5000;

/**
 * Two notices are "similar" when they are the same kind and say the same
 * thing up to the numbers in it: "CP 3: 2.1 px" and "CP 4: 0.8 px" collapse.
 */
export function noticeKey(n: Pick<Notice, 'kind' | 'text'>): string {
  const head = n.text.split(/[:—–]/)[0] ?? n.text;
  return `${n.kind}|${head.replace(/\d+(?:[.,]\d+)?/g, '#').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 80)}`;
}

/** The list after a new notice: a similar one is replaced (count + 1, moved to the end); the oldest go past `max`. */
export function pushNotice(list: readonly Notice[], n: Notice, max = MAX_NOTICES): Notice[] {
  const key = noticeKey(n);
  const prev = list.find((x) => noticeKey(x) === key);
  const rest = prev ? list.filter((x) => x !== prev) : [...list];
  const next = [...rest, { ...n, count: (prev?.count ?? 1) + (prev ? 1 : 0) }];
  if (next.length <= max) return next;
  // Drop the oldest non-errors first, so an error is not pushed out by chatter.
  const out = [...next];
  while (out.length > max) {
    const i = out.findIndex((x, j) => x.kind !== 'error' && j < out.length - 1);
    out.splice(i >= 0 ? i : 0, 1);
  }
  return out;
}
