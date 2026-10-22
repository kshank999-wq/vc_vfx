# Addendum 10 — Clean plate generation / object removal prep

Master spec §8 asks for clean plates of shots where a moving subject must be
removed from the background: the artist identifies the subject with
paint-to-roto, VC VFX propagates the matte and rebuilds what it hides from
the unobstructed parts of other frames, aligned for the camera's motion,
with reference-frame and patch guidance where the automatic result needs it,
a still or a per-frame plate as the shot requires, and the unresolved or
low-confidence areas shown for paint. §15, §17 and §19 apply as everywhere:
review and human approval, versioned outputs in `04_CLEAN_PLATES`,
reproducibility from source + settings, a log of every change, never a
write near the camera media. This addendum records what was built, how,
what is measured and what is not.

## 1. What the artist does (the Clean Plate tab)

The Clean Plate tab sits between Key and Camera Track (⌘/Ctrl+5; the tabs
are now ⌘/Ctrl+1…8, addendum 08). Five numbered steps on the left, the
viewer in the centre, the numbers on the right.

1. **Choose what to remove** — a roto part with mattes (the subject painted
   and propagated in the Roto tab; *Paint the subject in Roto* opens it), or
   a box drawn on the picture round something that stays put; each can be
   switched off or removed; *Grow the matte by* (6 px by default) takes the
   subject's soft edge, motion blur and contact shadow too.
2. **Still or sequence, and alignment** — *Auto* / *Still* / *Per frame*
   (auto follows the build's suggestion, shown here with its reason);
   camera *Detect* / *Locked off* / *Moving*; the reference frame (the
   middle of the shot unless *Use frame N*); under *More*: frames either
   side to borrow from (12), anchor frames across the shot (16), agreement
   tolerance (6 %). The defaults are a good start, so the step counts as
   done once something is being removed.
3. **Build** — aligns every frame and rebuilds the background; reports
   still/per frame, the alignment used, how much of the removed area was
   seen in other frames and how much is unresolved.
4. **Review & fix** — *Next problem ▸*, *Looks right*, *Flag*; the current
   frame as a source: *Normal* / *Prefer it* / *Leave it out*; *Patch from
   frame F* + *Draw the region*: “take this region from that frame” (on the
   current frame of a sequence, for the still otherwise). Guidance changes
   the settings, so the build is marked stale until built again.
5. **Export clean plate vNNN** — the plate (still or sequence), confidence
   and unresolved masks, metadata and README into `04_CLEAN_PLATES`.
   Approval is the existing per-task approval in Details, which needs an
   export of that version.

Viewer: **Source**, **Clean plate**, **Unresolved (red)** (the plate with
what no frame saw, or what the frames disagree on, tinted red),
**Confidence** (confident pixels dimmed, doubtful amber, unseen red), **What
is removed** (the dilated matte tinted over the source); **A/B wipe**
against the source (drag to move); boxes and patch regions drawn over the
picture; a still is labelled as one plate in the reference frame's
coordinates; a stale build says so. The timeline is coloured by each
frame's confidence, problem frames underlined red, left-out frames faded,
preferred frames marked green, the reference frame marked. Right panel:
frames built, mode, seen in other frames %, low confidence %, alignment
residual, problem frames; the camera (motion, exposure, what it suggests);
this frame's measurements and problem; version, export, settings revision,
the frames and the encoding; supervisor notes; the task card (approve,
reopen) and the shot's history.

## 2. The model (`packages/domain/src/cleanplate.ts`, `cleanplate-schema.ts`)

A shot's `cleanPlate` document: what to remove (roto part or box in plate
pixels, label, frame range, enabled), mode (`auto` | `still` | `sequence`),
alignment (`auto` | `static` | `homography`), reference frame (null: the
middle), parameters (dilation, window, anchors, tolerance, feather), the
artist's guidance (preferred frames, left-out frames, patches: box, source
frame, frame range, enabled), the build's suggestion (still/sequence,
static, motion, residual, exposure change, reason, the revision it was made
at), one record per built frame (confidence; removed share, share seen in
other frames, unresolved share, mean confidence of the removed area,
residual, motion, exposure; status, problem reason, review, note), the last
200 builds, the exports, the working width (960) and a **settings revision**
bumped by every change that affects pixels. Plates, alignment and
confidence maps are never in the project.

Mutations — `addCleanPlateRemove`, `updateCleanPlateRemove`,
`removeCleanPlateRemove`, `setCleanPlateSettings`,
`setCleanPlateWorkingWidth`, `setCleanPlateFrameGuidance`,
`addCleanPlatePatch`, `updateCleanPlatePatch`, `removeCleanPlatePatch`,
`recordCleanPlateRun`, `flagCleanPlateFrame`,
`markCleanPlateFrameReviewed`, `recordCleanPlateExport` — are pure, logged
(`cleanplate.*`, who, when and what in words), and refused while the shot is
past prep or the clean plate is approved (“Clean plate v001 is approved.
Reopen it …”). A change moves `clean_plate` pending → processing or
needs_review → needs_correction; a build or an export moves it to
needs_review; nothing approves. `recordCleanPlateRun` refuses a build made
with an older settings revision; a new build replaces the previous build's
frame records (a still has one, the reference frame). A roto part can be
removed only once and only if it exists; a patch cannot come from a
left-out frame. `approveTask('clean_plate')` needs an export of the task's
version; reopening bumps the version, so the next export is v002 beside the
approved v001.

Queries: `cleanPlateConfidence(metrics)`, `cleanPlateProblemReasons`,
`cleanPlateReview`, `nextCleanPlateProblem`, `cleanPlateConfidenceSummary`,
`cleanPlateReference`, `cleanPlateModeFor`, `suggestCleanPlateMode`,
`cleanPlateNames`, `cleanPlateSettings`, `cleanPlateMetadata`,
`cleanPlateManifest` (the manifest's `cleanPlate` section).

**Project format 5.** A version 4 (or 3) project opens with every shot's
`cleanPlate` null and is saved as 5; an older VC VFX refuses a 5.
`clean_plate` is `available: true` in `tasks.ts`.

## 3. The engine (`apps/desktop/src/shared/cleanplate/`)

Pure TypeScript on typed arrays, in linear light (frames decoded exactly as
the key decodes them, addendum 09 §3.1); the same code runs in the
desktop's worker thread and in the browser preview.

**3.1 Alignment** (`align.ts`). Every frame is related to the reference
frame by a homography: exact for a camera that only pans, tilts, rolls and
zooms, and for a background that is far away or flat. It is built from the
camera tracker's parts (addendum 06): on a downscaled grey copy (≤ 640 px
wide, resampled with pixel centres aligned — binning at a non-integer factor
shifted the grid and measured as a 1.5 px residual on the preview — then
√luminance, blurred σ 0.8), Shi–Tomasi corners outside the subject's
matte (grown 2 px more) are carried frame to frame by pyramidal
Lucas–Kanade, forward–backward checked (0.5 px), points landing on the next
frame's matte dropped, and a homography fitted by RANSAC (1 px); these are
chained out from the reference in both directions. Each frame is then
refined **directly against the reference** — the reference's background
pixels (the matte left out) warped onto the frame, homography plus gain and
bias solved by Gauss–Newton with Huber weights, coarse to fine, the frame's
own matte occluding (the planar tracker's `alignTemplate`) — taken where at
least 20 % of the reference is still in view and the NCC is above 0.6, so
the chain's drift does not accumulate. The **residual** is measured, not
assumed: the frame warped into the reference's coordinates, corners tracked
between the two; the median leftover displacement (parallax, lens
distortion, rolling shutter) in plate pixels. **Exposure**: per-channel gain
of the frame against the reference, the median ratio over background both
see. A shot whose frames all move less than half a working pixel is a
**static camera**: every homography becomes the identity, so borrowed pixels
are copied, not resampled. Homographies are scaled exactly between pixel
grids (pixel centres at integers), so an alignment made at the working size
serves the export at plate resolution.

**3.2 Temporal fill** (`fill.ts`). For each pixel of the plate inside the
removal matte (and a feather ring round it), each candidate frame that sees
that spot clean — the bilinear footprint off its own matte — offers its
pixel, warped by target → frame (from the two frames' alignments) and
multiplied by the gain that brings it to the target's exposure. Candidates:
neighbours at offsets 1, 2, 3, 4, 6, 8, 12, … up to the window either side,
anchor frames spread over the shot (16; 32 for a still), the preferred
frames; left-out frames and the target itself never. Weight = (4 if
preferred) / (1 + |Δt| / window); at most 16 per pixel, the heaviest kept.
Vote: the weighted median luminance, the candidates within the tolerance of
it agree, the plate is their weighted mean. Pixel confidence =
min(1, agreeing / 3) · √(agreeing weight / total weight) · (mean alignment
quality of the agreeing frames, 1 − max(0, residual − 0.5 px) / 2, at least
0.25). So: seen clean in three or more agreeing, well-aligned frames → 1;
seen once → ⅓; frames that disagree (a second moving thing, a light the gain
did not follow) → lower. The ring blends the reconstruction into the frame's
own pixels; outside the matte the plate *is* the frame.

**3.3 Patches.** A patch region (soft-edged box) takes the source frame's
aligned, gain-matched pixels wherever that frame sees the spot clean,
overriding the vote (confidence 0.9) — inside the region whether or not it
was removed, so a missed shadow can be patched too. A patch from a frame
whose own matte covers the spot gives nothing there.

**3.4 What is never seen** is filled spatially by pull–push diffusion from
the plate around it (the key's clean-plate inpainting, on a crop round the
unknown area) and has confidence 0. Pixels below 0.5 are **unresolved**: red
in the viewer, full in the unresolved mask.

**3.5 Still and sequence** (`engine.ts`). A still is the reference frame
with its removed area rebuilt from every candidate, read one at a time (no
frame kept), in the reference frame's coordinates. A sequence builds every
frame in order with a sliding window of frames kept in memory (the window
either side, the anchors, preferred and patch-source frames); at plate
resolution the window and anchors are cut to a memory budget (1.5 GB by
default) and the metadata records what was used. *Auto* chooses a still
when the camera is static and the exposure changes by at most 0.15 stops
over the shot, a plate per frame otherwise.

## 4. Processing (`apps/desktop/src/main/cleanplate/`)

- *Frames* are read as the key reads them (`main/key/frames.ts`, `io.ts`):
  the newest plates when there are any, else the source, in linear light;
  the subject's mattes from the roto cache (a part with its children, scaled
  to the size asked for).
- *Builds* and *exports* run in `worker_threads`
  (`out/main/cleanplate-worker.js`, its own electron-vite entry) with
  progress and Cancel (between frames; the worker is terminated after 3 s).
  A build caches each frame's review picture, confidence and unresolved
  mask (display-encoded, deflated) in `userData/Clean Plate Cache/<project>/
  <shot>/v001/r<revision>/`; a new build clears the older revisions. The
  viewer reads the source frame and the removal matte live, and the plate
  from that cache when the last build of the task version exists (marked
  stale when the settings changed since).
- *Exports* are made again from source + settings: aligned at the working
  size (as the review build was), the alignment scaled to the plate, every
  plate rebuilt from full-resolution frames. The output root is checked
  against every source file first (never under a source path).
- Looking (session, review frame) is allowed read-only; building and
  exporting need a licence.

## 5. Confidence and problem frames

Per frame: removed share, share seen in other frames (or patched), share
unresolved, mean confidence of the removed area, residual, motion, exposure.
`cleanPlateConfidence` = the mean confidence of the removed area, lowered up
to half by a residual between 0.75 and 2.75 px; 1 for a frame with nothing
removed. Problems: confidence < 0.6, more than 2 % of the removed area
unresolved, residual > 1.5 px (parallax?), exposure more than ½ stop off the
reference.

## 6. What is written (§8, §17)

```
04_CLEAN_PLATES/<shot>_cleanplate_v001/
  <shot>_cleanplate_v001.1001.exr …          a plate per frame (sequence), RGB half float ZIP16,
                                              scene-linear in the plates' (working) encoding, no look; or
  <shot>_cleanplate_still_v001.<ref>.exr      one still in the reference frame's coordinates
  <shot>_cleanplate_conf_v001.1001.png …      16-bit greyscale confidence (full = seen in agreeing frames)
  <shot>_cleanplate_unresolved_v001.1001.png  16-bit greyscale, full where it wants paint or a patch
  <shot>_cleanplate_v001.json                 vcvfx.cleanplate/1: what was removed, every setting (revision),
                                              guidance, the alignment of every frame (homography reference →
                                              frame in plate pixels, residual, motion, gain), the suggestion,
                                              per-frame confidence and measurements, builds, approval
  README.txt                                  what each file is and how it was made
```

When the source encoding is unknown the plate is written as 16-bit RGB PNG
of its code values instead of EXR (and the session says so). Versioned,
never overwritten: an approved version on disk is refused; an unapproved one
has only its own files cleared and written again. The manifest's
`cleanPlate` section has the version, state and approval, the folder, the
mode and patterns, the format and encoding, the algorithm and revision,
what was removed, the dilation, the guidance, the suggestion and a
confidence summary.

## 7. Measured

Synthetic shot (`shared/cleanplate/synthetic.ts`): a textured brick wall
(band-limited value noise in four octaves, soft mortar lines 1.2 px wide at
320 × 180, warm and cool patches), tabulated at two samples per wall unit;
a camera that pans 30 % of the frame width, zooms ±3 %, rolls up to 1.1°
and keystones slightly (a true homography per frame, known exactly); a crew
member walking across; a light stand fixed in the world (what it hides is
never seen); noise σ ≈ 0.002 linear; optionally ±12 % exposure drift.
“Revealed” = pixels the crew member covers, ≥ 10 px from the stand;
“never revealed” = inside the stand. Error = mean |plate − truth| relative
to the truth's luminance.

| Shot | Revealed error | Never revealed flagged | Alignment |
| --- | --- | --- | --- |
| pan, 320 × 180, 32 frames, per frame | 1.7 % (1.68 % without noise) | 100 % | worst corner error 0.08 px over 24 frames; residual 0.015 px |
| pan, 960 × 540, 24 frames | 0.31 % | 100 % | residual 0.03 px |
| pan, 1920 × 1080, 12 frames | 0.25 % | 100 % | residual 0.06 px |
| locked off, 320 × 180, still | 0.000 % (pixel-exact: no resampling) | 100 % | static detected |
| pan with ±12 % exposure drift, 320 × 180 | 1.7 % | — | gains within 0.2 % of the truth |
| real pipeline: EXR ACEScg → worker → EXR export, 320 × 180, 14 frames | 1.7 % | > 95 % in the 16-bit unresolved mask | — |

The 1.7 % at 320 × 180 is bilinear resampling of texture near pixel size
(the mortar lines are 1.2 px wide): the same scene at three and six times
the size gives 0.3 % and 0.25 %. Confidence over the revealed area is
≥ 0.99. A frame where something bright crosses the wall is outvoted (error
< 0.5 %, tested); leaving it out removes it from the candidates altogether.

**Performance** (4-core Xeon @ 2.1 GHz, Node 22, one thread): alignment 252
ms/frame and fill 199 ms/frame at 960 × 540 (the review build, 24 frames:
≈ 2.2 fps over both); 224 and 539 ms/frame at 1920 × 1080. A plate-resolution
export of a 4K shot is therefore minutes, not seconds. The browser
preview's build of the sample shot (480 × 270, 264 frames) takes ≈ 51 s in
Node and ≈ 58 s in Chromium (progress reports are throttled to a few a
second: one per frame re-rendered the app and made it ten times slower).

## 8. Tested (`pnpm test`)

- Domain: every mutation and refusal (no task, missing roto part, a part
  removed twice, inverted ranges, out-of-range parameters, a patch from a
  left-out frame), logging with who/when/what, task moves, revision bumps
  only on real changes, stale-build refusal, problem reasons, the
  still/sequence suggestion, a still build replacing a sequence's records,
  approval needing an export, approved lock, reopening to v002 beside v001,
  names, metadata, manifest, v4 (and v3) → v5 migration and round trip, a
  newer project refused.
- Engine: alignment recovering the known homography (< 0.35 px; measured
  0.08) on a pan/zoom/roll with the subject excluded; static camera detected,
  still suggested; homography scaling between grids; the analysis surviving a
  worker message; sequence reconstruction (< 3 % revealed error, confidence
  > 0.7, never-revealed > 95 % flagged, the frame unchanged outside the
  matte); still on a static camera (< 0.2 %); exposure drift (gains within
  1 %, error < 3 %); excluded frames not candidates, preferred frames
  weighted 4×, a bright crossing outvoted; a patch filling its region from
  its frame, a patch from a frame that does not see the spot unused; the
  memory budget cutting window and anchors; frames read a bounded number of
  times.
- Main, real ffmpeg: a linear EXR source with the subject in the roto cache →
  session → review frame before and after → build in the worker → an output
  root among the camera media refused → export (EXR plates read back with
  ffmpeg and compared with the truth, 16-bit confidence and unresolved PNGs,
  metadata with per-frame alignment, README) → needs_review → approval →
  manifest → the approved version refused → reopened as a still v002 beside
  v001, v001 untouched → the source folder unchanged; worker cancel.
- Renderer (jsdom): the workspace with the preview engine: the sample's
  subjects removed, a full build (a plate per frame, needs review, never
  approved, unresolved shown), next problem, leaving a frame out reopening
  the review and staling the build, export waiting; every view composed with
  the A/B wipe and the red unresolved tint. Layout: the tab between Key and
  Camera Track, ⌘/Ctrl+1…8 and the View menu, its steps and task in
  Details, the missing-task card.

Checked by hand with screenshots of the built browser preview at 1440 × 900
and 1280 × 800: the start, what is removed, building, the unresolved
overlay, the A/B wipe, confidence and review (which led to the centre-aligned
downscale above, a timeline that shrinks rather than pushing its buttons into
the details panel, and the Build step opening as soon as something is
chosen).

## 9. Browser preview

The sample's clean-plate shot (020_010, “Remove crew member crossing at frame
1120”) is the synthetic panning shot rendered in the page (480 × 270, linear
ACEScg, the shot's 264 frames). Its two subjects come already rotoscoped:
*Remove the crew member and the light stand (sample roto)* adds them as roto
parts (the Roto task added if missing) and removes them. Alignment, the
build, review, guidance and patches run for real in the page; nothing is
written; exporting says it is the desktop app's.

## 10. Not verified, and limits

- Run end to end in the real app ([addendum 15](addendum-15-verification.md)):
  the roto subject removed from a locked-off shot, a still exported; OpenEXR
  3.5.2 reads it as RGB half, ZIP16, full window.
- **Not yet tried on production footage.** Only the synthetic shot (and an
  EXR encode of it) was built: real parallax, motion blur, rolling shutter,
  lens distortion, moving shadows and reflections, compression noise and
  flicker are untested.
- One homography per frame: a background with depth (a street, an interior)
  seen by a camera that translates has parallax the homography cannot
  follow. It is measured (the residual, a problem above 1.5 px, lowered
  confidence) but not corrected; such shots want the camera track and
  projection, which this does not do yet.
- The spatial fill is diffusion: it is smooth, carries no texture, and is
  only a placeholder for paint (always confidence 0). There is no
  PatchMatch-style texture synthesis.
- Exposure matching is a global per-channel gain per frame; a local light
  change (a passing shadow on the wall) shows as disagreement and lowered
  confidence, not compensated.
- The subject's shadow and reflections are removed only if the matte (grown
  by the dilation) or a patch covers them.
- Sequence exports at 4K are slow (≈ 0.55 s/frame at HD for the fill alone)
  and, under the memory budget, borrow from a smaller window than the review
  build; the metadata records the window used.
- A still is made in the reference frame's coordinates; a stabilised
  sequence is not written (the per-frame homographies in the metadata give
  it).
- On real footage ([addendum 16](addendum-16-real-footage.md)) a runner was removed from a panning ProRes shot
  (100 % of the removed area seen elsewhere, residual 0.62 px); what the roto
  missed (his shoes) stays. Frames whose alignment fails (residual over 8 px
  and 4 × the shot's median: a slate or flash frame in the handles) are never
  borrowed from (`ShotCleaner.unaligned`).
- Packaged Electron with the worker entry, Windows and macOS; a signed build.
