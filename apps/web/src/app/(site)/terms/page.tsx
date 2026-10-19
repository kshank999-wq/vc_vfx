import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Terms', description: 'Terms for VC VFX subscriptions and the desktop app.' };

export default function TermsPage() {
  return (
    <div className="shell">
      <div className="page-hero">
        <h1>Terms</h1>
        <p>The terms for subscribing to and using VC VFX.</p>
      </div>
      <div className="page-body prose">
        <h2>The subscription</h2>
        <p>
          VC VFX is sold as a monthly or yearly subscription, billed in advance through Stripe and renewed
          automatically until you cancel. Prices are shown before checkout and may include tax where it applies. You
          can change plan, update your card or cancel from your account page; a cancelled subscription runs to the end
          of the period already paid for.
        </p>

        <h2>Your licence</h2>
        <p>
          A subscription gives you a licence to install and use VC VFX on Windows and macOS on up to two computers at a
          time. You can free a computer from your account page and activate another. The licence is personal to your
          account and may not be shared, resold or used to circumvent the computer limit.
        </p>

        <h2>If the subscription ends</h2>
        <p>
          When a subscription lapses the app can still open your projects and print shot lists, but processing and
          package writing stop until it is renewed. Your files on disk are always yours. A refunded or disputed payment
          revokes the licence it paid for.
        </p>

        <h2>What V1 does</h2>
        <p>
          V1 reads the VCDIT handoff, builds the shot queue and printable prep list, verifies source checksums,
          generates image-sequence plates and writes shot packages with manifests. Features described as on the
          roadmap are not part of the current product and may change.
        </p>

        <h2>Your media and your responsibility</h2>
        <p>
          VC VFX never alters or deletes original camera media and verifies what it writes, but production data is
          irreplaceable: keep independent backups, and review and approve every output before it is delivered.
          Approval in VC VFX is always a human decision.
        </p>

        <h2>Warranty and liability</h2>
        <p>
          VC VFX is provided as is. To the extent the law allows, we are not liable for indirect or consequential loss,
          and our total liability is limited to the subscription fees you paid in the twelve months before the claim.
          Nothing here limits rights you have under consumer law that cannot be excluded.
        </p>

        <h2>Changes and contact</h2>
        <p>
          We may update these terms; material changes are announced by email before they take effect. Questions:{' '}
          <a href="mailto:support@vc-vfx.com">support@vc-vfx.com</a>.
        </p>
      </div>
    </div>
  );
}
