# Addendum 11 — Sky isolation / replacement prep and background removal

Master spec §11 asks for AI-assisted foreground/background isolation of
stills and footage, consistent across the sequence rather than frame by
frame, correctable by prompt, paint or reference when the automatic matte is
wrong; sky isolation for replacement with edge and foreground-occlusion
handling; and the matte, the isolated foreground, the background or sky plate
and the sequence manifests exported separately so downstream artists keep
control. §15, §17 and §19 apply as everywhere: review and human approval,
versioned outputs (here in `02_MATTES_ROTO`), reproducibility from source +
settings, a log of every change, local processing, never a write near the
camera media. This addendum records what was built, how, what is measured and
what is not.

Both prep tasks — `sky_replacement` (*Sky isolation / replacement prep*) and
`background_removal` (*Background removal*) — are now `available: true`. They
share one engine and one tab, and stay two tasks: each has its own document,
version, review and approval.

## 1. What the artist does (the Sky & BG tab)

The Sky & BG tab sits between Clean Plate and Camera Track (⌘/Ctrl+6; the tabs
are now ⌘/Ctrl+1…9, addendum 08). It works on whichever of the two tasks the
shot has; it greys out only when the shot has neither, and offers to add
either. Five numbered steps on the left, the viewer in the centre, the numbers
on the right.

1. **What to isolate: the sky / a subject** — *Sky* or *Subject from
   background*; the task's version and state; *Add …* for the one the shot
   does not have. Switching keeps each target's own work. The step's title
   says which is shown and, when the shot has both, that the other is here.
2. **Find the sky** — nothing to do: the sky is found automatically. *Less /
   more sky* (where the cues are unsure), *Keep what moves in front of the
   sky* (on by default), optional paint. **Show the subject** — *Box* (drag a
   box round it), *Paint* (keep / make background), or *Roto part* (a part
   painted and propagated in the Roto tab; *Paint the subject in Roto*); the
   seed frame (the middle unless *Use frame N*); the engine, *Track
   (classical)* or *SAM 2.1 (AI)* when its model is installed (addendum 04;
   otherwise shown off with the reason).
3. **Build** — the matte, the foreground and the plate through the whole
   shot; reports frames, mean confidence and flicker.
4. **Review & fix** — *Next problem ▸*, *Looks right*, *Flag*; paint on the
   frame shown: *Keep in front* (sky) / *Keep as subject* (background) and
   *Make sky* / *Make background*, a brush size, *Undo last*; the painted
   frames listed with the frames each one reaches. Paint changes the
   settings, so the build is marked stale until built again. Folded under
   *Edge and time*: edge softness, edge detail, grow / shrink, temporal
   smoothing, and whether the sky's (background's) spill is unmixed out of the
   foreground's edge.
5. **Export sky / subject vNNN** — matte, foreground, plate, confidence and
   the sequence manifest into `02_MATTES_ROTO`. Approval is the existing
   per-task approval in Details, which needs an export of that version.

Viewer: **Source**, **Matte**, **Foreground** (over a checkerboard),
**Sky plate** / **Background plate** (what no frame saw, near the edge, in
red), **Overlay** (the sky or background side tinted magenta, the uncertain
edge amber, a doubtful matte red); **A/B wipe** against the source (drag);
paint strokes and the subject's box drawn over the picture; painting draws
with the brush and lands on the frame shown. The timeline is coloured by
each frame's confidence, problem frames underlined red, painted frames marked
green, the seed frame marked. Right panel: frames built, confidence, flicker,
uncertain edge, unseen sky (background), problem frames; this frame's
foreground share, edge, contrast, flicker, unseen plate and its problem;
version, export, engine, settings revision, the frames; supervisor notes; the
task card of the target shown (approve, reopen) and the shot's history.

## 2. The model (`packages/domain/src/isolate.ts`, `isolate-schema.ts`)

A shot carries `isolate: { sky, background }`, each null until started, each
an isolation document: the target; the seed (`auto` | `box` | `paint` |
`roto`, the seed frame or null for the middle, the box in plate pixels, the
roto part); the subject's engine (`track` | `sam2`; the sky is always found by
its cues); the painted key frames (roto's stroke schema: include = in front /
subject, exclude = sky / background; a stroke on a frame the build already
made is a *correction*); the parameters (edge softness and grow in plate
pixels, edge detail, temporal smoothing, protect occluders, sky bias, the
background plate's matte growth, and spill: `auto` | `colour` with a linear
colour | `off`, and an amount); one record per built frame (confidence;
foreground share, uncertain-edge share, separation, contrast, flicker, unseen
plate, camera motion and residual; status, problem, review, note); the last
200 builds; the exports; the working width (960); a **settings revision**
bumped by every change that affects pixels. Mattes, foregrounds and plates
are never in the project.

Mutations — `setIsolateSeed`, `addIsolateStroke`, `clearIsolateStrokes`,
`setIsolateSettings`, `setIsolateWorkingWidth`, `recordIsolateRun`,
`flagIsolateFrame`, `markIsolateFrameReviewed`, `recordIsolateExport` — take
the target, are pure, logged (`isolate.*`, who, when and what in words, the
target first), and refused while the shot is past prep, the task is missing,
or that target is approved (“Sky isolation v001 is approved. Reopen it …”).
A change moves the target's task pending → processing or needs_review →
needs_correction; a build or an export moves it to needs_review; nothing
approves. A background has no automatic seed; a roto seed must name an
existing part; the sky has no AI engine. `recordIsolateRun` refuses a build
made with an older settings revision; `recordIsolateExport` refuses another
target's or another version's record. `approveTask('sky_replacement' |
'background_removal')` needs an export of the task's version; reopening bumps
the version, so the next export is v002 beside the approved v001. Queries:
`isolateConfidence`, `isolateProblemReasons`, `isolateReview`,
`nextIsolateProblem`, `isolateConfidenceSummary`, `isolateSeedFrame`,
`isolateSeedProblem`, `isolateCorrectionRange` (from halfway to the previous
painted frame to halfway to the next, as roto's `propagationRange`),
`isolateNames(target)`, `isolateSettings`, `isolateMetadata`,
`isolateManifest` (the manifest's `isolate` section, sky and background).

**Project format 6.** A version 5 (or 4, or 3) project opens with every
shot's `isolate` empty and is saved as 6; an older VC VFX refuses a 6.

The browser preview needed a shot with a sky: the sample handoff gained a
fourth shot, `030_010` (2nd Unit, a rooftop pan, 48 frames with 4-frame
handles, UHD), whose tasks are the two isolations.

## 3. The engine (`apps/desktop/src/shared/isolate/`)

Pure TypeScript on typed arrays, in linear light (frames decoded as the key
decodes them); the same code runs in the desktop's worker thread and in the
browser preview. It is assembled from what the app already has: the clean
plate's homography alignment and reconstruction, roto's colour models,
max-flow, Track and SAM 2.1 engines and stroke rasteriser, the key's
foreground-colour estimation and display transform.

**3.1 Finding the sky** (`sky.ts`). Per frame, at a cut size (≤ 480 px
wide), each pixel's probability of being sky from four cues that hold for
clear and overcast skies alike: *brightness* within about two thirds of a stop
of the sky's own (the brighter half of the top rows), *colour* close to the
sky's chromaticity, *texture* (low gradient energy of log luminance: a
gradient and soft clouds against facades and branches), and a mild *position*
prior. Combined in logits; the confident pixels of each side train a pair of
colour models (roto's Gaussian mixtures in Lab), whose posterior joins the
cues. Then, per frame:
- a **temporal prior**: the neighbouring frames' (±2) probabilities, aligned
  to this frame by the camera's homography (the clean plate's alignment to
  the seed frame, §3.4), averaged by nearness and added in logits (weight
  0.9 × temporal smoothing);
- **occluders**: where the frame differs from where the camera says the
  world was (log luminance more than half a stop off in most neighbours),
  something moves in front of the sky — a bird, a plane, a head. There the
  temporal prior is not used (it would wipe the occluder into the sky) and,
  with *keep what moves in front* on, the pixel is pushed towards foreground
  unless it is plainly sky-coloured;
- **paint**: on its own frame, hard; carried to the frames it reaches
  (`isolateCorrectionRange`) through the homographies as a strong prior;
- a **graph cut** (roto's max-flow) with a contrast-sensitive smoothness
  term, decisive pixels held so the flow only works where the label is open;
- clean-up: sky that does not reach the top of the frame is foreground unless
  strongly sky (a pocket between branches stays sky), and specks barely
  called foreground are sky; painted pixels are kept as painted;
- the labels guided-filtered by the picture into a soft foreground
  probability (kept on their side of ½), the input of the matte.

**3.2 A subject** (`engine.ts`). The seed frame segmented by the roto engine
chosen — Track, or SAM 2.1 through the same factory roto's worker uses
(`main/roto/engines.ts`), only when its model files and onnxruntime are
there: from a box (the middle of the box painted in, a frame round it painted
out), from paint, or from a roto part (its mattes used as they are; frames
without one carried from the nearest that has). Propagated frame to frame in
both directions by the engine's step (flow, band re-segmentation, its own
temporal smoothing). Each painted correction re-segments its frame around the
paint (the engine's edit mode, the matte it had as the reference) and is
propagated to halfway to its neighbouring painted frames (the seed frame
counts as one), nearest the seed first — locally, as roto does.

**3.3 The matte** (`matte.ts`), at the size asked for (the working size for
review; the plate's for export, the probabilities upsampled). The cut decides
where the edge is; the edge is **unmixed** in linear light. With B the sky
(background) colour and F the foreground's near the pixel — normalised
convolution of the clearly-sky and clearly-foreground pixels with a coarse
fill where none are near (the key's `estimateForeground`) — a pixel on the
edge is P = α·F + (1 − α)·B, and

    α = ((P − B)·(F − B)) / ‖F − B‖²

For the sky, pixels the cut called sky that are not sky-coloured (a wire or a
twig too thin for the cut) are found against a first sky estimate, left out
of the sky's samples and added to the edge. On the sky side, only what lies on
the line from B to F, and adds more than 6 % of the sky's level, is
foreground (a cloud's texture and edge are not twigs). For the sky, the
foreground's samples count by how far their colour is from the sky beside
them: inside a branch two pixels wide there is still sky, so the trunk speaks
for the twigs. Where F and B
are too alike, or the pixel lies off the line (F or B guessed wrong), the
cut's soft edge is kept and the pixel's confidence drops. **For a subject, B
is the background plate itself** (§3.5): the background really behind the
edge, seen in other frames, not a guess from its neighbours — on the textured
wall this halved the edge error. The edge is then softened (edge softness)
and **smoothed in time**: the previous frame's matte warped by the camera's
homography, blended in (0.6 × temporal smoothing) only where the picture
agrees (relative luminance within ~5 %), so static edges are steadied and
nothing that moved is dragged. The **foreground** is premultiplied and
unmixed: P − (1 − α)·B on the edge — the sky's spill removed exactly when the
model holds — with, in the channels the sky leads, what is left above the
foreground's own colour limited to it (a matte a little too solid on a twig
leaves some sky in it). Spill *colour* uses the artist's colour as B; *off*
keeps α·P.

**3.4 Alignment.** The clean plate's `alignShot` (addendum 10 §3.1): KLT +
RANSAC homographies chained from the seed frame, refined directly against it,
residual and motion measured, a static camera detected. For the sky nothing is
left out (the flat sky has no corners to mislead it); for a subject, its
segmentation is.

**3.5 The plate.** The clean plate's `ShotCleaner` (addendum 10 §3.2–3.4),
told the foreground is what to remove: every pixel behind it rebuilt by a
robust vote of the aligned frames that see it, gain-matched, and what no frame
saw filled by pull–push from what is around it. For the **sky**, the
foreground is the refined matte (> 0.02, thin wires and twigs included), and
the plate is made at the working size (the sky is smooth; the export lays it
under the plate-resolution frame wherever the sky is seen); a pixel never
seen gets a confidence falling off with its distance from seen sky (e^(−d/3
px)), so the sky just behind an edge — filled from the sky beside it — is
trusted, and *unresolved* (red) is only what is never seen within 12 px of the
seen sky (deeper behind buildings the plate is filled too, but nobody will
see it). For a **background**, the foreground is the subject's segmentation,
grown by 4 plate pixels, at any size; it is built before the matte, frame by
frame, so the matte can unmix against it.

**3.6 Per-frame confidence and problems** (`isolateConfidence`,
`isolateProblemReasons`). Measured per frame: foreground share; uncertain
edge (0.05 < α < 0.95) share; separation (sky: mean |2p − 1| of the cut's
probabilities; subject: the engine's confidence); contrast (median relative
‖F − B‖ across the edge); flicker (mean |Δα| against the motion-compensated
previous frame on the agreeing edge, after smoothing); unseen plate (sky: the
share of edge pixels whose plate was never seen; background: the share of the
removed area). Confidence = separation, lowered by flicker above 1 %, by
contrast under 0.15, by an uncertain edge above 4 % of the frame, by an
alignment residual above 1 px. Problems: confidence < 0.6; flicker > 4 %;
uncertain edge > 8 %; contrast < 0.06; unseen plate > 10 % (sky; filled from
beside it, reliable) or > 2 % (background); residual > 1.5 px; and — because
nothing found is never taken as an answer — under 1 % of the frame in front of
the sky, or a subject under 0.05 % (lost).

## 4. Processing (`apps/desktop/src/main/isolate/`)

- Frames are read as the key and the clean plate read them (the newest plates,
  else the source, in linear light); a subject's roto mattes from the roto
  cache.
- Builds and exports run in `worker_threads` (`out/main/isolate-worker.js`,
  its own electron-vite entry) with progress and Cancel, through a worker-job
  runner now shared with the clean plate (`main/worker-job.ts`). A build
  caches each frame's matte, display foreground, confidence and edge band, and
  its display plate and unresolved mask, deflated, in `userData/Isolate
  Cache/<project>/<shot>/<target>/v001/r<revision>/`; a new build clears the
  older revisions. The viewer reads the source frame live and the rest from
  that cache when the last build of the task version exists (marked stale when
  the settings changed since).
- Exports are made again from source + settings: analysed at the working size
  (as the review build was), the mattes refined at plate resolution, the
  background plate rebuilt at plate resolution, the sky plate rebuilt at the
  working size and laid under the plate-resolution frame wherever the sky is
  seen (read back from the matte just written). The output root is checked
  against every source file first.
- SAM 2.1 is used only when the subject's engine is set to it and its model is
  installed and (in a packaged build) verified — roto's own check
  (`sam2Files`); the session lists the engines as roto does.
- Looking (session, review frame) is allowed read-only; building and exporting
  need a licence.

## 5. What is written (§11, §17)

```
02_MATTES_ROTO/<shot>_sky_v001/                   (<shot>_bg_v001 for background removal)
  <shot>_sky_matte_v001.1001.png …                16-bit straight alpha of the foreground (sky matte = 1 − it)
  <shot>_sky_matte_v001.1001.exr …                the same, one half-float channel
  <shot>_sky_fg_v001.1001.exr …                   RGBA half float, premultiplied, spill unmixed, scene-linear, no look
  <shot>_sky_plate_v001.1001.exr …                RGB half float: the sky (background) alone
  <shot>_sky_conf_v001.1001.png …                 16-bit confidence of the matte
  <shot>_sky_plateconf_v001.1001.png …            16-bit confidence of the plate (black: never seen, filled)
  <shot>_sky_v001.json                            vcvfx.isolate/1, the sequence manifest: target and task, engine,
                                                  every setting (revision), the seed and every painted stroke,
                                                  the alignment of every frame (homographies in plate pixels,
                                                  residual, motion), per-frame confidence, measurements and
                                                  problems, builds, approval
  README.txt                                      what each file is and how it was made
```

When the source encoding is unknown the foreground and plate are written as
16-bit RGB PNG of code values (the foreground premultiplied, its alpha in the
matte) and no matte EXR. Versioned, never overwritten: an approved version on
disk is refused; an unapproved one has only its own files (`<shot>_sky_` /
`<shot>_bg_` of that version, and its README) cleared and written again. The
manifest's `isolate` section has, per target, the version, state and
approval, the folder and every pattern, frames, resolution, format and
encoding, algorithm, engine and revision, the seed, the painted frames, the
parameters and a confidence summary.

## 6. Measured

Synthetic shots (`shared/isolate/synthetic.ts`): a sky — clear (a blue
gradient) or overcast (grey), with soft clouds — over a city skyline (lit
windows, antennas), a bare tree whose branches thin to a third of a pixel,
two poles carrying a power line 0.55 px wide, a bird flying across the sky
and a runner crossing a low roof with the sky behind his head and shoulders
(a stride every 16 frames), seen by a camera that pans 25 % of the frame and
pushes in 3 % (a true homography per frame, known exactly). Static layers
are tabulated at two samples per pixel with box-filtered coverage, so the
truth (α, the sky alone, the frame without the runner) is exact. Noise σ
0.002 linear. For background removal also the clean plate's textured brick
wall with a crew member walking across (addendum 10 §7), its light stand off.
IoU on α ≥ ½; edge error = mean |α − truth| over the truth's partial pixels.

| Shot | Matte | Thin structures, occluders | Plate | Speed (one thread) |
| --- | --- | --- | --- | --- |
| sky, clear, pan, 320 × 180, 24 frames | IoU ≥ 0.990 (mean 0.994), edge error 0.048 | power line Σα/Σtruth 1.18, max α 0.80 (fractional, never solid); branches under a pixel 1.16; bird and runner kept 100 % | behind the bird (seen in other frames) 0.2 % error; 2 px under a roofline (never seen, filled from above) 2.2 %; 12 px under it flagged 100 % | ≈ 320 ms/frame |
| sky, clear, pan, 480 × 270 | IoU 0.998, edge 0.026 | line 1.14, branches 1.03 | — | 549 ms/frame |
| sky, clear, pan, 960 × 540 | IoU 0.998, edge 0.027 | line 1.07, branches 1.07 | — | 1.22 s/frame |
| sky, overcast, 320 × 180, 12 frames | IoU ≥ 0.993, edge 0.039 | — | — | — |
| flicker (clear, 320 × 180) | 0.47 % mean | | | |
| subject on the wall, box on one frame, 320 × 180, 24 frames | IoU ≥ 0.977 (mean 0.983), edge 0.17 (dark clothes on dark brick: low contrast, kept on the cut's edge) | | behind the subject 1.8 % | 125 ms/frame |
| the same at 960 × 540 | IoU ≥ 0.992 (mean 0.994) | | 0.34 % | 738 ms/frame |
| runner from his roto part, 320 × 180, 16 frames | IoU ≥ 0.968, edge 0.032 (0.014 at 960 × 540) | | 1.8–2.9 % | — |
| runner, box on one frame, 640 × 360 | IoU mean 0.951, min 0.894 | | 2.6 % | 319 ms/frame |
| real pipeline: EXR ACEScg → worker → EXR export, 320 × 180, 12 frames | matte IoU 0.991 read back from the 16-bit PNG; the foreground EXR's alpha equals the matte | | sky behind the bird 0.17 % (read back from the EXR) | ≈ 430 ms/frame export |

Corrections: on the sky, paint *keep in front* on a patch of open sky on
frame 1012 with another painted frame at 1004 — the patch (followed by the
true camera motion) is foreground on 1009, 1012 and 1016 and sky before
1009, and frames 1001–1008 are bit-for-bit the build without it. On the
runner (box seed), paint on the worst frame raised its IoU 0.79 → 0.97;
frames on the seed's side of halfway changed by under 2·10⁻⁴ mean |Δα| (only
the camera alignment, which leaves the subject out, moved by a hair).

A hazy skyline half a stop under an overcast sky, the same grey, is called
sky (0.5 % found against 40 % true): a failure of the cues that is not
silent — every frame is flagged “almost nothing found in front of the sky”.

Browser preview (Chromium, the sample shot 030_010 at 480 × 270, 56 frames):
the sky in ≈ 30 s, the runner from his sample roto in ≈ 11 s (progress
reports throttled as the clean plate's are).

## 7. Tested (`pnpm test`)

- Domain (`isolate.test.ts`): both tasks available in `02_MATTES_ROTO`; every
  mutation and refusal (no task, a background with no seed or an unknown roto
  part, a bad box, the sky with SAM, a spill colour missing, out-of-range
  parameters, an empty build, a stale build, another target's export, another
  version's), logging with who/when/what and the target, task moves, revision
  bumps only on real changes, paint as seed and correction with its range,
  problem reasons (flicker, edge, contrast, unseen plate, nothing found,
  subject lost), the review order, approval needing an export, the approved
  lock while the other target stays editable, reopening to v002 beside v001,
  names, the sequence manifest, the package manifest, formats 5, 4 and 3 → 6,
  the round trip, a newer project refused.
- Engine (`isolate-engine.test.ts`): the measurements above as assertions —
  clear and overcast skies through a pan, thin structures fractional, the bird
  and the runner kept, flicker, the sky plate behind the bird and under the
  roofline, never-seen sky flagged, the hazy skyline flagged, a sky correction
  carried by the homographies and no further, a subject from a box with the
  engine injected (as SAM is), from a roto part, a subject correction
  re-segmented and local, the box prompt.
- Main, real ffmpeg (`isolate.test.ts`): a linear EXR source → session →
  review frame → build in the worker → an output root among the camera media
  refused → export (16-bit matte PNG and EXR, RGBA foreground EXR, plate EXR,
  both confidence PNGs, manifest, README; the matte and plate read back against
  the truth) → approval → manifest → the approved version refused → reopened
  as v002 beside v001, v001 untouched → the source folder unchanged; a
  background removal from the roto cache exported to `<shot>_bg_v001`; worker
  cancel.
- Renderer (jsdom): the workspace with the preview engine: the sky built with
  no seed (needs review, never approved), a frame flagged, a stroke painted
  with the pointer and undone, the subject from the sample roto built, the
  sky's work untouched, a setting reopening the review; the missing task
  offered; every view composed with the A/B wipe. Layout: the tab between
  Clean Plate and Camera Track, ⌘/Ctrl+1…9 and the View menu, its steps and
  task in Details, the two-task missing card.

Checked by hand with screenshots of the built browser preview at 1440 × 900
and 1280 × 800 (the start, building, overlay, matte, foreground, the sky plate
with the A/B wipe, a painted correction, the subject's start, foreground and
plate), with the centre zone measured (nothing past `.module-center`'s right
edge, the timeline row included). They led to the overlay's magenta (cyan
vanished on a blue sky), the step-1 title naming the target, the unseen sky
shown only near the edge, the spill limit and the foreground colour sampled
away from the sky (thin branches had a blue fringe; cloud edges a faint
alpha), the session kept
while a setting is applied (the Build button flickered off), text selection
prevented while painting, and the stale hint hidden while a tool is in use.

## 8. Browser preview

The sample's sky shot (030_010) is the synthetic rooftop pan rendered in the
page (480 × 270, linear ACEScg, the shot's 56 frames). The sky needs nothing
to start. The runner comes already rotoscoped: *Use the runner (sample roto)*
adds him as a roto part (the Roto task added if missing) and seeds the subject
from it; a box or paint seed him too. Builds, review, paint corrections and
every view run for real in the page; SAM 2.1 is shown off (it runs on the
desktop once its model is downloaded); nothing is written; exporting says it
is the desktop app's.

## 9. Not verified, and limits

- Run end to end in the real app ([addendum 15](addendum-15-verification.md)):
  OpenEXR 3.5.2 reads the foreground as RGBA half premultiplied with α equal
  to the matte EXR (one half channel `Y`), the plate as RGB half. On the
  synthetic rooftop the chart's 90 % white patch was taken for sky (flagged).
- **Not yet tried on production footage.** Only the synthetic shots (and an
  EXR encode of one) were isolated: real skies (sunsets, haze, sun glare,
  lens flare, gradients through a graduated filter), foliage moving in wind,
  hair, motion blur, rolling shutter, compression noise and grain are
  untested; the thresholds come from the synthetic shots.
- The sky's cues assume a sky brighter than what is in front of it and of its
  own hue: a backlit or night skyline, bright cloud against dark sky at
  sunset, or haze close to the sky's grey can be mis-labelled. A frame with
  almost nothing found is flagged, not fixed.
- Unmixing on thin dark structures with no solid foreground near them
  (a power line far from its poles) borrows the foreground colour from
  further away and overestimates their coverage by 5–20 % (more at low
  resolution, where the line is under a pixel).
- One homography per frame: a skyline with depth seen by a translating camera
  (a drone flying past buildings) has parallax the alignment cannot follow; it
  is measured (the residual) but not corrected; the temporal prior and
  smoothing then work less well.
- A subject's edge on a low-contrast background (dark clothes on a dark wall)
  keeps the cut's edge (edge error 0.17 on the wall): confidence drops, but
  hair and motion blur there want the artist.
- The temporal smoothing of the final matte follows the camera only; a
  subject's own motion is followed by the segmentation engine's smoothing, so
  the smoothing gate leaves a moving edge to its own frame.
- The sky plate is built at the working size and laid under the full-
  resolution frame; behind the foreground it is a smooth fill, without cloud
  detail where the sky was never seen.
- The UI offers *unmix it* / *leave it* for spill; the model and the engine
  take a fixed spill colour too, not yet pickable in the viewer.
- Speed: ≈ 1.2 s/frame for the sky at the 960-px review size, single thread
  (4-core Xeon @ 2.1 GHz, Node 22);
  a 4K export refines every matte at plate resolution (minutes per hundred
  frames, not seconds).
- SAM 2.1 for a subject runs through roto's runtime: tested here only by
  injecting an engine; the ONNX path is roto's own (addendum 04).
- Packaged Electron with the worker entry, Windows and macOS; a signed build.
