import { describe, expect, it } from 'vitest';
import { MAX_NOTICES, noticeKey, pushNotice, type Notice } from '../notices';

const n = (id: number, text: string, kind: Notice['kind'] = 'info'): Notice => ({ id, kind, text });

describe('toast notices', () => {
  it('collapses similar notices into one with a count', () => {
    expect(noticeKey(n(1, 'CP 3: 2.1 px'))).toBe(noticeKey(n(2, 'CP 14: 0.8 px')));
    expect(noticeKey(n(1, 'CP 3: 2.1 px'))).not.toBe(noticeKey(n(2, 'CP 3: 2.1 px', 'error')));
    let list: Notice[] = [];
    for (let i = 1; i <= 5; i += 1) list = pushNotice(list, n(i, `CP ${i}: residual ${i / 10} px`));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 5, count: 5, text: 'CP 5: residual 0.5 px' });
  });

  it('shows at most three, dropping the oldest chatter before an error', () => {
    let list: Notice[] = [n(1, 'Solve failed', 'error')];
    for (const [i, t] of ['Tracked', 'Aligned to the LiDAR', 'Exported camera v001', 'Saved'].entries()) list = pushNotice(list, n(i + 2, t, 'ok'));
    expect(list).toHaveLength(MAX_NOTICES);
    expect(list.map((x) => x.text)).toEqual(['Solve failed', 'Exported camera v001', 'Saved']);
  });
});
