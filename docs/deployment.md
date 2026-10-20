# Deploying vc-vfx.com

The site is `apps/web` (Next.js 14, App Router), package `@vcvfx/web`. It builds
and serves the marketing pages with **no environment variables at all**: pricing
shows "Pricing coming soon" and Buy is disabled until Stripe is configured, and
sign-in says accounts are not open until Supabase is configured. Every key is
read lazily at the point of use.

## 1. Vercel

1. New project from the `VC VFX` GitHub repository.
2. **Root Directory:** `apps/web`. Leave **"Include source files outside of the
   Root Directory in the Build Step"** on (the default) — the build needs
   `packages/domain`.
3. Framework preset: Next.js (also pinned by `apps/web/vercel.json`). Install
   command: pinned by `apps/web/vercel.json` to
   `ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install` — pnpm finds the workspace
   from the root `pnpm-lock.yaml` and installs every package, the desktop's
   devDependencies included (the preview build needs its Vite), but the site
   never needs Electron's ~100 MB binary. Build command: default (`pnpm build`,
   which runs `pnpm --filter @vcvfx/domain build`, then the browser preview
   build, then `next build`). Node 20.11+.
4. **Domains:** add `vc-vfx.com` as the production domain and `www.vc-vfx.com`
   as a 308 redirect to `vc-vfx.com`. At the registrar: `A @ 76.76.21.21` and
   `CNAME www cname.vercel-dns.com` (or whatever Vercel's domain panel shows).
5. **Environment variables** (Production, and Preview if wanted) — see
   `apps/web/.env.example` for the full list:

   | Variable | Value |
   | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon / publishable key |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key (server only) |
   | `NEXT_PUBLIC_SITE_URL` | `https://vc-vfx.com` (the default) |
   | `STRIPE_SECRET_KEY` | `sk_live_…` |
   | `STRIPE_WEBHOOK_SECRET` | `whsec_…` from the webhook endpoint below |
   | `STRIPE_PRICE_ID_MONTHLY` | `price_…` (monthly recurring) |
   | `STRIPE_PRICE_ID_YEARLY` | `price_…` (yearly recurring) |
   | `RESEND_API_KEY` | `re_…` |
   | `RESEND_FROM_ADDRESS` | `VC VFX <noreply@vc-vfx.com>` (the default) |
   | `RELEASE_BUCKET` | `releases` (the default) |
   | `RELEASE_DOWNLOAD_TTL_SECONDS` | `900` (the default) |

   `NEXT_PUBLIC_*` values are inlined at build time: **redeploy** after changing
   them.

## 2. Supabase

1. Create the project and apply the migrations in
   `packages/supabase/migrations` in order (`0001_accounts_commerce_releases.sql`
   creates profiles, orders, licences, device activations, release builds, the
   webhook/email logs, RLS, and the private `releases` storage bucket). Then run
   the security and performance advisors and fix what they raise.
2. **Authentication → URL Configuration**
   - Site URL: `https://vc-vfx.com`
   - Redirect URLs: `https://vc-vfx.com/auth/callback` (add
     `http://localhost:3000/auth/callback` for local development).
3. **Authentication → Providers → Email:** enabled. Sign-ups through the site
   are never opened — accounts are created by the Stripe webhook (the sign-in
   page asks for links with `shouldCreateUser: false`). You may disable public
   sign-ups in the dashboard.
4. **Authentication → SMTP:** point Supabase's own auth email (magic links,
   password resets) at Resend's SMTP (`smtp.resend.com`, user `resend`, password
   = a Resend API key) with sender `VC VFX <noreply@vc-vfx.com>`; the built-in
   sender is heavily rate-limited.

## 3. Stripe

1. **Product:** create a product named **VC VFX** with two **recurring** prices:
   monthly and yearly. Copy their ids into `STRIPE_PRICE_ID_MONTHLY` and
   `STRIPE_PRICE_ID_YEARLY`. The site reads the displayed price from Stripe;
   nothing is hard-coded.
2. **Stripe Tax:** turn on Stripe Tax and set the product's tax code
   (e.g. *Software as a service — business use*) and your origin address.
   Checkout uses `automatic_tax` and requires a billing address.
3. **Webhook:** Developers → Webhooks → Add endpoint
   `https://vc-vfx.com/api/stripe/webhook` with these events:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `charge.refunded`
   - `charge.dispute.created`

   Copy its signing secret into `STRIPE_WEBHOOK_SECRET`. The handler is
   idempotent (each event id is claimed in `stripe_webhook_events`).
4. **Customer portal:** Settings → Billing → Customer portal: enable, allow
   cancelling (at period end), updating payment methods, viewing invoices and
   switching between the monthly and yearly prices. The account page's
   "Manage subscription" opens it via `POST /api/portal`.
5. **Promotion codes:** checkout allows them; create coupons and codes in the
   dashboard as needed.
6. Test end to end in test mode first (test keys and test prices in a Preview
   deployment), e.g. `stripe trigger checkout.session.completed` or a real test
   checkout with card `4242 4242 4242 4242`.

## 4. Resend

Add and verify the domain `vc-vfx.com` in Resend (SPF, DKIM and the return-path
records it lists), create an API key with sending access, and set
`RESEND_API_KEY`. Every send is logged (template and version, never the body)
in `email_events`.

## 5. Making an administrator

Create the account first (buy, or **Authentication → Users → Add user** in the
Supabase dashboard), then in the SQL editor:

```sql
update public.profiles set is_admin = true
where lower(email) = lower('you@example.com');
```

The Admin link appears in the site header for that account; `/admin` shows
counts of orders, licences and activations, and `/admin/releases` manages builds.

### Browser preview

The desktop application's interface is also served at
**https://vc-vfx.com/preview**, for administrators only — before launch and
after `SITE_LAUNCHED=true` alike — so a change pushed to `main` can be tried at
the next refresh instead of after a download and an install. It is linked from
`/admin` ("Preview the app").

It is the same renderer the desktop runs, built by plain Vite
(`apps/desktop/vite.preview.config.ts`, `pnpm --filter @vcvfx/desktop
build:preview`) with `src/renderer/preview.tsx` installing a browser bridge
(`src/renderer/browser-bridge.ts`) where the preload would put `window.vcvfx`.
The site's build runs `apps/web/scripts/build-preview.mjs`, which builds it and
copies it under `apps/web/public/preview/` (git-ignored). A failed preview build
fails the deployment rather than leaving a stale preview.

What it does: opens the sample project at start (or the last project kept in
this browser), opens a handoff or `.vcvfx` through a file picker, keeps
projects in memory and `localStorage`, downloads a `.vcvfx` on **Download
project** (Save As), and prints the shot list through the browser's print
dialog (Export PDF is the same dialog). The licence standing is `active`, so the
approval flow can be tried. Verifying sources, writing plates, packaging,
choosing an output root and signing in answer "Available in the desktop app".
The frame viewer works on the sample project with bundled stand-in frames
(`src/renderer/assets/sample-frames`, labelled "sample frames"); on any other
project it says frames are read from the drive by the desktop app.

Access is decided in `src/middleware.ts` (`src/lib/preview-gate.ts`) from the
signed-in user's `profiles.is_admin`; anyone else is redirected to
`/signin?next=%2Fpreview`. The gate covers `/preview` and
`/preview/index.html` (Next serves `public/` *after* middleware, and the matcher
includes these paths). The page carries its own content security policy —
`script-src 'self'`, since a Vite bundle has no nonce to carry — and
`Cache-Control: no-store`. The bundle's hashed files under `/preview/assets/`
are deliberately not gated, as in VC Writer: they are build artifacts of code
that ships in the installer, their names are only knowable from the gated page,
and gating them costs a Supabase round trip per file and turns a file fetched
after the session expires into HTML. They are cached `immutable`.

## 6. Publishing a release

The installers include ffmpeg and ffprobe. `package:mac` / `package:win` run
`apps/desktop/scripts/fetch-ffmpeg.mjs` first, which downloads the pinned
static builds and refuses any whose SHA-256 differs (docs/spec/addendum-03).
To update ffmpeg, change the release tag and pins there, and run the
colour-pipeline tests against the new binary.

1. Sign in as an administrator and open `https://vc-vfx.com/admin/releases`.
2. Choose the platform, version, channel (start with *internal* or *beta*),
   minimum OS and release notes, pick the installer, and optionally paste the
   SHA-256 from the build workflow. The page hashes the file in the browser
   (refusing a mismatch), uploads it straight to the private `releases` bucket
   with a signed upload URL, and records the build **inactive**.
3. Click **Make live** (or **Promote to stable**). That retires the previous
   live build for the same platform and channel only — Windows and macOS are
   independent.
4. The desktop updater sees it at `GET /api/releases` (active stable builds),
   and entitled customers download through `GET /api/downloads/{windows|macos}`,
   which re-checks the licence and returns a signed URL valid for
   `RELEASE_DOWNLOAD_TTL_SECONDS`.

## API used by the desktop app

| Route | Auth | Response |
| --- | --- | --- |
| `POST /api/licenses/activate` body `{deviceFingerprint, deviceName, platform, appVersion, serial?}` | Bearer access token or cookie | 200 `{outcome, license}` · 409 `{error, outcome}` · 401 |
| `GET /api/licenses/standing` | Bearer | `{standing: {status, expiresAt} \| null}` |
| `GET /api/releases` | public | `{builds: [{platform, version, minimumOsVersion, releaseNotes, publishedAt, sha256, sizeBytes}]}` |
| `GET /api/downloads/{windows\|macos}` | Bearer or cookie | `{url, version, sha256, minimumOsVersion, expiresInSeconds}` |

Without a `serial`, activation uses the account's best live licence. Serials
look like `VFX-XXXXX-XXXXX-XXXXX-XXXXX`.

## Launching

Until launch, every page except sign-in, the auth callback and the APIs shows
`/coming-soon` to anyone who is not an admin (`profiles.is_admin`). Sign in at
`/signin` as an admin to see the real site. To open it to the public, set
`SITE_LAUNCHED=true` in Vercel (Production) and redeploy.
