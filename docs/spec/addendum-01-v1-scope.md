# Addendum 01 — V1 as built

The master spec lists eleven MVP priorities (§20). V1 ships the first two
in full and gives every later module a place in the queue, so a production
can track all of its prep in VC VFX from day one even where the work itself
is done in another application.

## Shipped

| Spec | What |
| --- | --- |
| §2, §18 | VCDIT handoff parser (`packages/domain/src/handoff.ts`). JSON, Zod-validated, every problem reported with its path. Unknown fields are kept, so a newer VCDIT never makes a drive unreadable. Duplicate shot IDs and inverted frame ranges are refused. |
| §3 | Interactive shot queue with status, scene, circle-take, task and text filters; printable shot list as HTML → PDF with the spec's columns plus a tick box. |
| §4 | Image-sequence plates via ffmpeg: DPX/TIFF/EXR/PNG, configurable start frame (default 1001), head/tail handles, versioned file names, no colour transform applied. Source checksum verification (streaming SHA-256). |
| §15, §16, §19 | Status model derived from task states; approval per task then per shot, always attributed; reopening approved work bumps the version and withdraws shot approval; every change logged. |
| §17 | Shot package folders `00_SOURCE_REFERENCE` … `10_DELIVERY`, versioned `manifest_vNNN.json` and `prep_report_vNNN.html`, `manifest.json` = latest. |

## Tracked, not yet automated

Roto, key, despill, clean plate, 2D track, camera track, sky, background
removal, texture extraction, lighting analysis, compositor. Each is a task
kind (`tasks.ts`, `available: false`) that moves through the same review and
approval states, so its results can be recorded and packaged.

## Decisions

- **Status is derived, never stored.** A shot's status is a function of its
  task states and the explicit approval/packaged/delivered acts. A handoff's
  own `status` field is informational and cannot import an approval.
- **Licence lapse is read-only, not locked.** A lapsed or never-activated copy
  opens projects, verifies sources and prints shot lists; it cannot run
  processing or write packages. A machine that cannot reach vc-vfx.com keeps
  full capability for 30 days from its last check (`OFFLINE_GRACE_DAYS`),
  because sets are often offline.
- **Prices live in Stripe.** The site reads them; nothing in the code names
  an amount.
