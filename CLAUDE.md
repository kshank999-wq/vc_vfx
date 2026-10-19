# Working on VC VFX

VC VFX is the VFX preparation and handoff companion to VCDIT. It is sold as a
downloadable desktop app (Windows, macOS) from <https://vc-vfx.com>.

## Reporting a revision

Finish every revision with a link: <https://vc-vfx.com> once it is on `main`
and the Vercel production deployment is READY, plus the commit link
`https://github.com/kshank999-wq/vc_vfx/commit/<sha>`. Branch preview URLs
are behind Vercel SSO and not worth handing over.

## Where things are

- `packages/domain` — the model: handoff schema (spec §18), shot queue and
  status model, approval rules, frame arithmetic, shot list, package
  manifest, licensing. Everything testable lives here.
- `apps/desktop` — Electron app. Main process does all file IO (checksums,
  ffmpeg, packages); the renderer is UI only.
- `apps/web` — vc-vfx.com: marketing, accounts, Stripe checkout and webhook,
  licence activation, signed installer downloads, admin release manager.
- `packages/supabase/migrations` — apply new ones to the live project as part
  of the change, then run the Supabase advisors and fix what they raise.
- `docs/spec/master-spec.md` — the product spec. `docs/spec/addendum-*.md`
  record what was built and why. Keep them current.
- `docs/deployment.md`, `docs/code-signing.md` — infrastructure.

## Rules from the spec that code must keep

- Never alter or delete source camera media. Read-only on anything under the
  handoff's source paths.
- Processing finishing never approves anything. Approval is a named human act,
  per task and then per shot.
- Reopening approved work bumps the version; outputs are versioned, never
  silently overwritten.
- No display look is baked into plates.
- Every change to a project is logged (who, when, what).

## Before pushing

    cd packages/domain && pnpm typecheck && pnpm test && pnpm build
    cd apps/desktop   && pnpm typecheck && pnpm test && pnpm build
    cd apps/web       && pnpm typecheck && pnpm test && pnpm build

Screenshot the real thing when the change is visual.

## Conventions

- Develop on a `claude/` branch; push to `main` only when Ken says so.
- No credential, key or certificate belongs in this repository.
- Keep this file short; history goes in commit messages and addenda.
