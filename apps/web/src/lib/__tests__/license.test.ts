import { describe, expect, it } from 'vitest';
import { isWellFormedSerial } from '@vcvfx/domain';
import { generateSerial } from '../license';

describe('serials', () => {
  it('are VFX-XXXXX-XXXXX-XXXXX-XXXXX and well formed', () => {
    for (let i = 0; i < 50; i += 1) {
      const serial = generateSerial();
      expect(serial).toMatch(/^VFX(-[A-Z2-9]{5}){4}$/);
      expect(isWellFormedSerial(serial)).toBe(true);
    }
  });

  it('do not repeat', () => {
    const seen = new Set(Array.from({ length: 200 }, generateSerial));
    expect(seen.size).toBe(200);
  });
});
