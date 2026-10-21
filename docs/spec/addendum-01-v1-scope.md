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
| §10.1–10.3 | Camera tracking ([addendum 06](addendum-06-camera-tracking.md)): corner detection and pyramidal KLT tracking (forward–backward checked, roto parts and drawn rectangles excluded), an in-house incremental structure-from-motion solver with bundle adjustment (focal and distortion optional, nodal detected), error graph and worst tracks, a camera database with sources and verification flags, project lens profiles and checkerboard calibration, LiDAR / survey import (PLY, E57, LAS, OBJ, XYZ, CSV) with correspondences, similarity alignment, LiDAR-constrained solve and ICP, a coordinate system (units, up axis, origin, ground, scale), and versioned exports into `06_CAMERA_TRACK` for Nuke, Maya, Blender, After Effects, 3ds Max, FBX, Unreal 5, Unity, USD, Houdini, Fusion / Resolve and .chan, with lens STMaps (EXR), JSON, report and README. Project format 3. |
| §9 | 2D tracking (addendum 06 §7): planar surface tracking from four corners (homography, RANSAC, direct refinement, roto occluders) and point tracking, drop-in preview, per-frame confidence, corrections as keys with local re-tracking; Nuke CornerPin2D, After Effects corner pin script, Mocha-style keyframe text and JSON into `05_TRACKS_2D`. |
| §6, §7 | Green/blue-screen keying ([addendum 09](addendum-09-keying.md)): one-click auto key in linear light (screen detection robust to uneven lighting, eyedropper, green/blue), colour difference against a clean-plate model of the screen, core and edge mattes with unmixing edge refinement for hair and motion blur, garbage/holdout/repair mattes from roto parts or boxes, Repair with roto seeded from the key, despill replacing the spill with the background reference's light (skin and listed colours protected), light wrap and a suggested colour match as previews and metadata, per-frame confidence and problem frames, versioned exports into `03_KEYS` (16-bit alpha, premultiplied despilled EXR foreground, optional core/edge mattes and light-wrap layer, JSON, README). Project format 4. |
| §8 | Clean plates / object removal ([addendum 10](addendum-10-clean-plate.md)): the subject from roto parts or drawn boxes (dilated), every frame aligned to a reference by homography (KLT + RANSAC chained, refined directly against the reference, residual measured, static camera detected), exposure matched per frame, the removed area rebuilt by a robust weighted vote of aligned neighbouring and anchor frames, preferred / left-out frames and “take this region from that frame” patches, what no frame sees filled spatially and flagged; a still in the reference frame or a plate per frame (auto from the camera's motion); per-pixel confidence and an unresolved overlay, problem frames; versioned exports into `04_CLEAN_PLATES` (half-float EXR plate or still, 16-bit confidence and unresolved masks, JSON with per-frame alignment, README). Project format 5. |
| §11 | Sky isolation / replacement prep and background removal ([addendum 11](addendum-11-sky-background.md)), one Sky & BG tab for both tasks: the sky found automatically per frame (brightness, colour, smoothness, position, colour models), a temporal prior from the neighbouring frames aligned by homography (not where something moves in front of the sky), a graph cut; a subject from a box, paint or a roto part, segmented and propagated by the roto engines (Track, or SAM 2.1 when installed); paint corrections on any frame carried to the frames around it; the edge unmixed in linear light (fractional alpha for branches, wires, hair), smoothed in time where the picture agrees; the premultiplied foreground with the sky/background unmixed out of its edge; the sky or background plate rebuilt behind the foreground from the frames that saw it (the clean plate's reconstruction), what none saw filled and flagged; per-frame confidence and problem frames (flicker, uncertain edge, low contrast, unseen plate, nothing found); versioned exports into `02_MATTES_ROTO` (`<shot>_sky_vNNN` / `<shot>_bg_vNNN`: 16-bit matte PNG and EXR, RGBA EXR foreground, RGB EXR plate, 16-bit confidence maps, the sequence manifest, README). Project format 6. |

## Tracked, not yet automated

Texture extraction, lighting analysis, compositor. Each is a task kind
(`tasks.ts`, `available: false`) that moves through the same review and
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
