import { describe, expect, it } from 'vitest';
import { localDay, localStamp } from '../local-time.js';

describe('local time on printed forms', () => {
  const at = '2026-11-10T22:47:00.000Z';

  it('prints the clock the crew reads, month first, with the zone named', () => {
    expect(localStamp(at, { timeZone: 'America/Los_Angeles' })).toBe('11/10/2026, 14:47 PST');
    expect(localStamp(new Date(at), { seconds: true, timeZone: 'America/New_York' })).toBe('11/10/2026, 17:47:00 EST');
  });

  it('just after midnight is 00, not 24', () => {
    expect(localStamp('2026-11-10T08:05:00Z', { timeZone: 'America/Los_Angeles' })).toBe('11/10/2026, 00:05 PST');
  });

  it('a shot packaged late in the evening belongs to that day, not the UTC tomorrow', () => {
    expect(localDay('2026-11-11T06:30:00Z', { timeZone: 'America/Los_Angeles' })).toBe('11/10/2026');
  });

  it('says what it was given when it is not a time', () => {
    expect(localStamp('not a time')).toBe('not a time');
    expect(localDay(undefined)).toBe('');
  });
});
