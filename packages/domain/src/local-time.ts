/**
 * Times and dates on printed forms, in the reader's local time (Ken, 10
 * November 2026): the crew reads 14:47 PST, not 22:47 UTC, and a shot packaged
 * at 11pm belongs to that day, not tomorrow. Month first, as VC DIT and VC Film
 * Studio print them, 24-hour, with the zone named so the page says which clock.
 *
 * `timeZone` is for tests; left out, it is this computer's own zone.
 */

const parse = (at: string | Date): Date | null => {
  const d = typeof at === 'string' ? new Date(at) : at;
  return Number.isNaN(d.getTime()) ? null : d;
};

/** "11/10/2026, 14:47 PST" (with `seconds`, "11/10/2026, 14:47:00 PST"). */
export function localStamp(at: string | Date, opts: { seconds?: boolean; timeZone?: string } = {}): string {
  const d = parse(at);
  if (!d) return String(at);
  return d.toLocaleString('en-US', {
    month: '2-digit', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    ...(opts.seconds ? { second: '2-digit' as const } : {}),
    hourCycle: 'h23', timeZoneName: 'short', timeZone: opts.timeZone,
  });
}

/** "11/10/2026": the local calendar day, not the UTC one. */
export function localDay(at: string | Date | undefined, opts: { timeZone?: string } = {}): string {
  if (!at) return '';
  const d = parse(at);
  if (!d) return String(at);
  return d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', timeZone: opts.timeZone });
}
