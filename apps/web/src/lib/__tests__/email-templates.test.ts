import { describe, expect, it } from 'vitest';
import { licenseReminder, purchaseConfirmation } from '../email-templates';

describe('email templates', () => {
  it('purchase email carries the serial, the account link and the magic sign-in note', () => {
    const email = purchaseConfirmation({
      serial: 'VFX-AAAAA-BBBBB-CCCCC-DDDDD',
      accountUrl: 'https://vc-vfx.com/account',
      signInUrl: 'https://vc-vfx.com/signin',
      siteUrl: 'https://vc-vfx.com',
    });
    for (const body of [email.html, email.text]) {
      expect(body).toContain('VFX-AAAAA-BBBBB-CCCCC-DDDDD');
      expect(body).toContain('https://vc-vfx.com/account');
      expect(body).toContain('https://vc-vfx.com/signin');
      expect(body).toContain('Email me a link');
    }
    expect(email.template).toBe('purchase_confirmation');
    expect(email.version).toBeGreaterThan(0);
  });

  it('reminder repeats the serial', () => {
    const email = licenseReminder({ serial: 'VFX-AAAAA-BBBBB-CCCCC-DDDDD', accountUrl: 'https://vc-vfx.com/account', siteUrl: 'https://vc-vfx.com' });
    expect(email.text).toContain('VFX-AAAAA-BBBBB-CCCCC-DDDDD');
  });
});
