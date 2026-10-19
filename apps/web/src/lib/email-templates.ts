/**
 * Transactional email templates, versioned so the template that sent any
 * message is recorded in `email_events`. Email clients allow far less than a
 * browser: tables for layout, inline styles, solid colours, no web fonts.
 */

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  template: string;
  version: number;
}

const INK = '#0b0c10';
const PANEL = '#14161c';
const BORDER = '#2a2e38';
const AMBER = '#f2a33a';
const TEXT = '#eceef2';
const MUTED = '#9aa1ad';
const FONT = "system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const shell = (title: string, body: string, siteUrl: string): string => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:${INK}">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${INK}">
    <tr>
      <td align="center" style="padding:32px 16px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;width:100%">
          <tr>
            <td style="padding:0 0 18px;font-family:${FONT};font-size:15px;font-weight:700;letter-spacing:0.18em;color:${TEXT}">
              VC <span style="color:${AMBER}">VFX</span>
            </td>
          </tr>
          <tr>
            <td style="background:${PANEL};border:1px solid ${BORDER};border-top:3px solid ${AMBER};border-radius:6px;padding:32px">
              <h1 style="margin:0 0 18px;font-family:${FONT};font-size:22px;font-weight:700;line-height:1.3;color:${TEXT}">${escapeHtml(title)}</h1>
              <div style="font-family:${FONT};font-size:16px;line-height:1.6;color:${TEXT}">${body}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 4px;font-family:${FONT};font-size:12px;line-height:1.6;color:${MUTED}">
              VC VFX &middot; VFX preparation for independent productions &middot; Windows and macOS<br>
              <a href="${siteUrl}" style="color:${AMBER};text-decoration:none">${siteUrl.replace(/^https?:\/\//, '')}</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

const serialBlock = (serial: string): string => `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:22px 0">
    <tr>
      <td align="center" style="background:${INK};border:1px solid ${AMBER};border-radius:4px;padding:18px 12px">
        <span style="font-family:${FONT};font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:${MUTED}">Your licence</span><br>
        <span style="display:inline-block;margin-top:8px;font-family:${MONO};font-size:20px;font-weight:700;letter-spacing:0.08em;color:${TEXT}">${escapeHtml(serial)}</span>
      </td>
    </tr>
  </table>`;

const button = (url: string, label: string): string => `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 20px">
    <tr>
      <td style="background:${AMBER};border-radius:4px">
        <a href="${url}" style="display:inline-block;padding:12px 24px;font-family:${FONT};font-size:14px;font-weight:700;color:${INK};text-decoration:none">${escapeHtml(label)}</a>
      </td>
    </tr>
  </table>`;

const note = (text: string): string =>
  `<p style="margin:0 0 10px;font-family:${FONT};font-size:14px;line-height:1.6;color:${MUTED}">${text}</p>`;

export interface PurchaseEmailInput {
  serial: string;
  accountUrl: string;
  signInUrl: string;
  siteUrl: string;
}

export const purchaseConfirmation = (input: PurchaseEmailInput): RenderedEmail => ({
  template: 'purchase_confirmation',
  version: 1,
  subject: 'Your VC VFX licence',
  html: shell(
    'Thank you for subscribing to VC VFX',
    `<p style="margin:0 0 8px">Your subscription is active and your licence is ready. It covers both the Windows and macOS builds.</p>
     ${serialBlock(input.serial)}
     ${button(input.accountUrl, 'Download VC VFX')}
     ${note(`<strong style="color:${TEXT}">Signing in:</strong> an account has been set up for this email address. On the <a href="${input.signInUrl}" style="color:${AMBER}">sign-in page</a>, choose <em>Email me a link</em> and use this address &mdash; no password needed. Once you are in you can set one.`)}
     ${note('Sign in to the desktop app with the same account and it activates automatically. Manage or cancel your subscription from your account page at any time.')}`,
    input.siteUrl,
  ),
  text: [
    'VC VFX',
    '',
    'Thank you for subscribing to VC VFX. Your licence covers Windows and macOS.',
    '',
    `Your licence: ${input.serial}`,
    '',
    `Download: ${input.accountUrl}`,
    '',
    `Signing in: an account has been set up for this email address. At ${input.signInUrl} choose "Email me a link" and use this address. No password needed; you can set one afterwards.`,
    '',
    'Sign in to the desktop app with the same account and it activates automatically.',
  ].join('\n'),
});

export interface LicenseReminderInput {
  serial: string;
  accountUrl: string;
  siteUrl: string;
}

export const licenseReminder = (input: LicenseReminderInput): RenderedEmail => ({
  template: 'license_reminder',
  version: 1,
  subject: 'Your VC VFX licence',
  html: shell(
    'Here is your VC VFX licence',
    `${serialBlock(input.serial)}
     ${button(input.accountUrl, 'Go to your account')}
     ${note('You asked for this from your account page. If that was not you, nothing has changed &mdash; this email only repeats a licence you already own.')}`,
    input.siteUrl,
  ),
  text: [
    'VC VFX',
    '',
    `Your licence: ${input.serial}`,
    '',
    `Account: ${input.accountUrl}`,
    '',
    'You asked for this from your account page. If that was not you, nothing has changed.',
  ].join('\n'),
});
