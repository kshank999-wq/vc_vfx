# Addendum 01 — V1 as built

The master spec lists eleven MVP priorities (§20). V1 ships the first two
in full, then the third — paint-to-roto ([addendum 04](addendum-04-paint-to-roto.md)) —
and gives every later module a place in the queue, so a production
can track all of its prep in VC VFX from day one even where the work itself
is done in another application.

## Shipped

| Spec | What |
| --- | --- |
| §2, §18 | VCDIT handoff parser (`packages/domain/src/handoff.ts`). JSON, Zod-validated, every problem reported with its path. Unknown fields are kept, so a newer VCDIT never makes a drive unreadable. Duplicate shot IDs and inverted frame ranges are refused. |
| §3 | Interactive shot queue with status, scene, circle-take, task and text filters; printable shot list as HTML → PDF with the spec's columns plus a tick box. |
| §4 | Image-sequence plates via ffmpeg: DPX/TIFF/EXR/PNG, configurable start frame (default 1001), head/tail handles, versioned file names. Source checksum verification (streaming SHA-256). |
| §4 | ffmpeg and ffprobe bundled with the installer (Settings override → bundled → PATH), pinned by SHA-256 ([addendum 03](addendum-03-plates-colour-viewer.md) §1). |
| §4, §19 | Explicit, recorded plate colour: source encoding read from the handoff (or set per shot), EXR converted to ACEScg / ACES2065-1 / linear Rec.709 with the vendors' published curves and matrices, DPX/TIFF kept as shot; the transform and its LUT written to `09_PROJECT_DATA`, logged and in the manifest; never a display look (addendum 03 §2). |
| §4 | Image-sequence sources (DPX/EXR/TIFF from VCDIT) read as sequences; camera raw (R3D, BRAW, ARRIRAW, Canon RAW, DNG) refused with the transcode instruction (addendum 03 §3). |
| §5.2, §15.4 | Frame viewer: source or plate versions in delivered numbering with timecode, A/B wipe and toggle, playback, view-only Rec.709 (approx.) / raw transforms, cached frames over a locked-down `vcvfx-frame://` protocol; contact sheet of first/last and twelve between; per-frame "Mark for correction" notes, logged (addendum 03 §4). |
| §15, §16, §19 | Status model derived from task states; approval per task then per shot, always attributed; reopening approved work bumps the version and withdraws shot approval; every change logged. |
| §17 | Shot package folders `00_SOURCE_REFERENCE` … `10_DELIVERY`, versioned `manifest_vNNN.json` and `prep_report_vNNN.html`, `manifest.json` = latest. |
| §5, §5.1, §5.2 | Paint-to-roto ([addendum 04](addendum-04-paint-to-roto.md)): include/exclude paint on key frames, a classical Track engine (graph-cut segmentation, object-motion propagation, per-frame confidence) and an optional SAM 2.1 engine (ONNX, model downloaded on first use, pinned); parts combined into the subject matte; confidence timeline, next problem frame, contact sheet of mattes; corrections re-propagate locally; versioned 16-bit PNG (+ EXR) matte sequences and metadata in `02_MATTES_ROTO`; approval through the roto task. Project format 2. |

## Tracked, not yet automated

Key, despill, clean plate, 2D track, camera track, sky, background
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
