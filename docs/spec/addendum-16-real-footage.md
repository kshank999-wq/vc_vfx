# Addendum 16 — The first run on real footage

Until now every module had been tested on synthetic shots (addenda 03–14)
and, end to end, on a synthetic drive ([addendum 15](addendum-15-verification.md)).
This addendum records the first pass of every module over **real footage**,
in the real desktop app, what it found, what was fixed, and what remains.

## 1. The footage

Ken's test drive (Google Drive "Vc VFX/PLATES"), downloaded and checked by
size; nothing from it is in the repository (Ken's own clips and the HDRIs are
not ours to commit; the Hollywood Camera Work plates are free to practise
with but may not be redistributed — the tests use synthetic fixtures that
reproduce what the footage showed).

| Source | What it is | Used for |
| --- | --- | --- |
| `GREEN SCREEN.mov` | ProRes 422 HQ, 2048×1080, 10-bit, Rec.709 tagged, 23.976, timecode track; astronaut walking to camera on an unevenly lit, low-saturation green | plates, key, despill, comp |
| `GREEN SCREEN.mp4` | the same take as H.264 4:2:0 8-bit, untagged, no timecode, starts 15 frames later | plates, key (no timecode, clip-relative frames) |
| `GUY RUNNING - ROTO CLEAN PLATE.mov` | ProRes 422 HQ 1920×1080; a runner crossing a car park, camera panning with him | roto, clean plate, camera track (added in the app), 2D |
| `SOLDIERS(-/MED/CUP)-SKY REPLACE.mov` | ProRes 422 HQ 2048×1080, overcast sky behind soldiers on a roof, handheld | sky |
| `PF0044-12…-1_REC709_2K.mov` | ProRes, chrome ball, grey ball and a colour chart on green | lighting |
| HDRI `087`, `177` (hdrmaps, 10000×5000 EXR) | an interior and an exterior | lighting, textures (panorama) |
| Hollywood Camera Work: embassy HD (960×720 PNG, DVCPRO HD 1.333 pixel aspect) and SD (720×480) green-screen plates, the 720×486 3D render; licence plate, painting card, green cloud card, cola / glasses dot sheets, glasses floor survey (1280×1080 PNG, DVCPRO HD, 1.5 pixel aspect) | key, comp, 2D track, camera track, textures, clean plate |

Every movie ends in a 24-frame ActionVFX card; the hcw "actor highlight"
pass is entirely black (no use as matte ground truth), the Maya IFF z-buffer
is not readable by ffmpeg and was not used, and the F15 and drone folders
were empty at the start and at the end of the run.

The handoff (VC VFX's own format, as VCDIT would send it after editorial)
names 15 shots in 6 scenes with the tasks each needs, timecode-based frame
ranges for the movies (`timecodeIn` = the clip's first frame, as
`clipRange` assumes), file-number ranges for the PNG sequences, Rec.709 as
the source encoding, the HDRIs as `hdri` / `panorama` / `background_plate`
references and the 3D render as the background plate of the embassy shots.
One shot (030_010) deliberately keeps the whole take, so its 8-frame tail
handle reaches one frame into the slate.

The app was built and driven under Xvfb with Playwright's `_electron`, as in
addendum 15; outputs were read back with OpenEXR / numpy and looked at as
contact sheets.

## 2. Per module

| Module | Footage | Result | Numbers | Verdict |
| --- | --- | --- | --- | --- |
| Plates | all 15 shots: ProRes, H.264, PNG | every shot written; frame-exact; colour exact | frame 1009 of 010_010 = clip frame 20 (TC 01:12:46:12) and every sampled frame matches an independent decode (neighbours differ by 0.007 mean); ACEScg within 2.4e-4 at the 99th percentile; 22–42 s per 2K shot of 112–170 frames | good, after the super-white fix |
| Key | 010_010 (ProRes), 010_020 (H.264), 040_010/040_020 (embassy), 050_030 (cloud), 050_020 (card) | backgrounds clean after the fix; the astronaut's suit stays part-transparent | confidence (4 frames, before → after): SD 0.45 → 0.77, HD 0.26 → 0.58, cloud 0.61 → 0.68, astronaut 0.00 → 0.03; clean screen SD 56 → 79 %, HD 54 → 76 %, astronaut 62 → 80 %; whole shots after: SD mean 0.76 (37 / 136 problem frames), HD 0.63 (60 / 136), cloud 0.76 (33 / 195), astronaut 0.04 (all frames), H.264 copy 0.23; 1.6 s/frame at 1920 working | usable on the embassy and cloud plates; the astronaut needs a holdout from roto |
| Roto | 020_010 runner (Track engine; SAM 2.1 not downloadable here) | follows the runner from 3 key frames; misses feet; leaks onto the wall/bushes he passes; blobs left on the road after he exits | 129 frames, 94 s first propagation; 81 frames flagged | a rough first matte; needs a key frame every ~10 frames for delivery |
| Clean plate | 020_010 (from that roto) | the runner removed, background rebuilt from the panning shot; his shoes remain where the roto missed them | per-frame mode, 100 % of the removed area seen elsewhere, alignment residual 0.62 px; 129 frames | good where the roto is good |
| Sky & BG | 030_010 (whole take incl. a slate frame), 030_020, 030_030 | matte follows soldiers, chimney, treeline well; the slate frame had pasted the ActionVFX logo into the sky plate (fixed) | 170 frames in 358 s (2.1 s/frame at 2K); unseen sky 93 % → 0 % flagged on the overcast sky; 164 / 170 frames still flagged for an 11–16 px alignment residual (handheld parallax) | matte good; problem flags still too eager on handheld shots |
| 2D track | 050_010 licence plate, 050_020 painting card (hand occluding) | planar tracks hold through scale and perspective; lost honestly when the plate leaves frame / the card shrinks to a corner of the frame | plate 102 / 145 tracked (lost from 1103, when it exits); card 119 / 136; ~0.5 s/frame | good |
| Camera track | 020_010 runner (square pixels), 050_060 glasses survey, the two dot sheets (anamorphic DVCPRO HD) | runner: nodal pan solved | runner 129 / 129 frames, RMS 0.64 px, focal 7470 px (≈ 140 mm on the nominal 36 mm back), nodal; survey 59 / 146 frames RMS 1.48 (300 features) — 109 / 146, RMS 1.37 with 600; dot sheets 30 / 58 and 28 / 71 (planar, moving objects: degenerate for a camera solve) | good on the square-pixel pan; poor on the soft, anamorphic DV survey |
| Textures | 050_020: two plate frames, the 10K HDRI as panorama | the card rectified; panorama loads in ~1 s | texture 706 × 1024; light flattened 1.11 → 0.29 stops; aspect 0.69 from the corners (the frame's 1.5 squeeze — see §4) | works; no pixel aspect for stills from anamorphic plates |
| Lighting | 060_010 chrome + grey ball in frame; 050_060 with the 10K HDRI | key from −118° azimuth, 46° elevation (63 %) — matches the grey ball's lit edge and the chrome ball's highlights | analysis 8 s; rig exported (Unreal, USD, Blender, report) | good |
| Comp | 040_020 SD key over the 720×486 embassy render | composites; 136 frames rendered at 4.8 fps; Nuke export | — | works; the background reference is one still (§4) |

Screenshots of each module on this footage were taken from the real window.

## 3. Found and fixed

1. **Rec.709 / sRGB plates clipped super-whites at 1.0.** ProRes from the
   camera carries codes above video white (10-bit 941–1019); the decode LUT
   ffmpeg's `lut1d` applies covered 0–1 and clamps, so a lamp or flare lost
   up to 0.29 in linear (422 pixels of one frame of 010_010). The decode
   cube of a video encoding now covers 0–1.25 (`VIDEO_CODE_MAX`, same step
   between points); the residual against an independent decode fell from
   0.29 to 0.02 (what remains is sub-black chroma overshoot, clamped at 0).
   Tests: `color.test.ts`; a real-ffmpeg ProRes 422 with a Y-1000 super-white
   in `colour-pipeline.test.ts` (fails without the fix).
2. **The key followed the screen only coarsely.** The clean-plate model is a
   64-column grid made from five frames: real cloth folds, the fall-off to
   the floor and shadows on the screen are finer, and a pixel of screen 30 %
   darker than the model keys 30 % solid — grey hazes and streaks over the
   whole background, every frame a "problem". The keyer now refines the
   screen per frame (**Screen detail**, `params.screenDetail`, on by
   default): the frame's own screen pixels (the model's chromaticity within
   0.04, 0.25–2 × its brightness, eroded) give a fine per-channel ratio to
   the model, filled across the subject by pull–push — the per-frame clean
   plate an artist pulls with IBK. A pixel the key against the model already
   calls more than half solid is never taken for screen (the guard against a
   costume the bounce has made screen-coloured). A shadow cast on the screen
   keys out (turn the option off to keep it). The frame-vs-model residual
   that finds lighting changes is still measured against the model. Numbers
   in §2. Tests: `key-engine.test.ts` (folds finer than the grid; a
   screen-coloured costume stays solid; the guard).
3. **The screen gain could be measured off the screen.** Per-frame gain was
   the median ratio over every screen-coloured pixel against the model —
   including grass and trees round a green card held up outdoors, where the
   model is only inpainted; on the green cloud plate it pinned at the 2×
   limit. Gain is now measured only where the model saw the screen (its
   per-cell support, carried through the export job). Test: `screenGain`
   with grass of the screen's chromaticity.
4. **A slate in the handles was pasted into the sky plate.** The sky (and
   clean) plate borrows hidden background from other frames; the slate frame
   in 030_010's tail handle aligned with a 246 px residual (others 12–16 px)
   but still contributed at the lowest weight, and where only it "saw"
   behind the soldiers it filled the plate with the ActionVFX logo. Frames
   whose alignment failed (residual over 8 px and 4 × the shot's median) are
   no longer borrowed from (`ShotCleaner.unaligned`). The isolate engine's
   scaled alignment now scales the shot median with the frames. Test:
   `cleanplate-engine.test.ts`, a slate as the last frame (fails without).
5. **Every frame of an overcast sky was a problem.** The sky behind the
   soldiers' edge is never seen in any frame (they move with the camera) and
   counted as unresolved: 93 %, all 170 frames flagged. Behind an edge, a
   featureless sky (overcast, a clear gradient) is filled from the sky beside
   it as well as any frame could show it; the share now counts only in
   proportion to the detail of the sky next to the foreground (median
   relative step in a ring w/256–w/128 away: 0.4 % → none counted, 2 % →
   all). Test: `skyFlatness` on an overcast and a clouded sky.
6. **A new roto key frame could not propagate over a stale matte.** Frames
   propagated earlier from a further key (the runner's matte left on the wall
   behind him, confidence 0.6) "won" against the new key's propagation
   (confidence rule, `rivalFrames`), so the backward run from a key frame
   painted to fix them stopped after one frame. A matte now competes only if
   it reached its frame without passing the new key frame and its own key
   still exists. Test: `roto.test.ts`.
7. **Lighting:** adding the second ball left the first selected, so marking
   the grey ball moved the chrome ball's circle; the reference just added is
   now selected. The Reference view kept showing the previous shot's picture
   while the new shot's 10K HDRI loaded; it is cleared first. Test:
   `lighting.test.tsx`.

The key, clean-plate and isolate engines are now `1.1.0` (their output
differs); the run records say which made a matte.

## 4. What remains, by how much it matters to a facility

1. **Non-square pixels are not modelled anywhere.** The DVCPRO HD plates
   (1280×1080 at 1.5, 960×720 at 1.333) — and any anamorphic camera without
   a database mode — are solved, rectified and shown as square pixels: the
   camera solver's focal is one value (`geometry.ts`: squeeze recorded, not
   modelled), textures come out squeezed (aspect 0.69 on the card), the
   viewer shows the squeezed picture. Needs a pixel aspect in the handoff /
   shot, a separate fx, fy in the solver and every exporter's film back.
2. **Keys of bright, screen-lit costumes.** The astronaut's suit, lit by the
   green floor's bounce, has the screen's chromaticity at 40 % of its
   brightness: by colour alone it is a shadow on the screen. A chromaticity
   core was tried and dropped (it made motion blur and hair solid: synthetic
   edge error 0.022 → 0.095). Today: holdout or repair from roto. A learned
   matte (or a subject segmentation as a prior) is the real answer.
3. **Roto on fast movers with the Track engine** sticks to background it
   passes (wall, bushes), loses feet, and keeps blobs after the subject has
   left frame (no "lost" detection); SAM 2.1 could not be tried (the model
   download is blocked here). Plan a key frame every ~10 frames.
4. **The background reference is one file.** A rendered or shot background
   *sequence* (the embassy render moves with the camera) is read as its first
   frame for despill, light wrap and the comp.
5. **Problem flags are still too eager on handheld sky shots** (alignment
   residual over 1.5 px from parallax: 164 / 170 frames) and on hard keys
   (every frame of the astronaut): the review list stops being a short list.
6. **Engine upgrades do not mark a processed key stale** — the panel showed
   "done" until *Process again*; settings changes do.
7. **Camera solves of soft, compressed, handheld DV** (the survey) register
   about half the frames at 300 features; more features help (109 / 146 at
   600).
8. The planar dot sheets are object (not camera) tracks; the camera solver
   is not the tool and says so only through unsolved frames.
9. Performance at 2K: key 1.6 s/frame, sky 2.1 s/frame, roto 0.7 s/frame,
   plates ~5 frames/s — usable for 5-second shots, slow for long takes.

## 5. Not covered

The F15 and drone folders were empty. Packages from this run were checked
with `verify-package-files.py` and `verify-package-exr.py` (§6); Nuke,
Unreal and the other DCCs were not run (addendum 15 §6 still applies).
