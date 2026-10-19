import { Resend } from 'resend';
import { env } from './env';
import { adminClient } from './supabase';
import { licenseReminder, purchaseConfirmation, type RenderedEmail } from './email-templates';

/**
 * Transactional email. Every outcome is logged to `email_events` (template and
 * version, never the body). A send failure never fails a purchase: the licence
 * already exists and is always on the account page.
 */

export interface SendResult {
  sent: boolean;
  error: string | null;
}

const deliver = async (to: string, email: RenderedEmail): Promise<SendResult> => {
  const log = {
    to_address: to,
    template: `${email.template}@${email.version}`,
    status: 'queued',
    provider_message_id: null as string | null,
    error: null as string | null,
  };
  try {
    const resend = new Resend(env.resendApiKey);
    const { data, error } = await resend.emails.send({
      from: env.resendFrom,
      to,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });
    if (error) throw new Error(error.message);
    log.status = 'sent';
    log.provider_message_id = data?.id ?? null;
  } catch (cause) {
    log.status = 'failed';
    log.error = cause instanceof Error ? cause.message : String(cause);
  }
  try {
    await adminClient().from('email_events').insert(log);
  } catch {
    // Logging is for support; it must not turn a sent email into an error.
  }
  return { sent: log.status === 'sent', error: log.error };
};

export const sendPurchaseEmail = (input: { to: string; serial: string }): Promise<SendResult> =>
  deliver(
    input.to,
    purchaseConfirmation({
      serial: input.serial,
      accountUrl: `${env.siteUrl}/account`,
      signInUrl: `${env.siteUrl}/signin`,
      siteUrl: env.siteUrl,
    }),
  );

export const sendLicenseReminder = (input: { to: string; serial: string }): Promise<SendResult> =>
  deliver(input.to, licenseReminder({ serial: input.serial, accountUrl: `${env.siteUrl}/account`, siteUrl: env.siteUrl }));
