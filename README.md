# VC VFX

VFX preparation, automation and handoff for independent productions — the
companion to [VCDIT](https://vc-dit.com). Sold at <https://vc-vfx.com>.

- `packages/domain` — handoff schema, shot queue, approvals, packaging, licensing
- `apps/desktop` — the Electron app for Windows and macOS
- `apps/web` — vc-vfx.com (Next.js on Vercel, Supabase, Stripe)
- `packages/supabase/migrations` — database schema
- `docs/` — product spec, deployment, code signing

```
pnpm install
pnpm -r typecheck && pnpm -r test && pnpm -r build
pnpm dev:desktop   # or: pnpm dev:web
```
