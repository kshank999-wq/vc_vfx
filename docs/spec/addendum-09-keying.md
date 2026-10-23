# Addendum 09 — Green/blue-screen keying, despill, background match, light wrap

Master spec §6 asks for keying of green and blue screens that assumes real
plates are imperfect and therefore combines the key with paint-guided roto;
§7 for despill that is compatible with the destination background, a
suggested colour match, an adjustable light wrap, and a prep-only output.
§15, §17 and §19 apply as everywhere: review, human approval, versioned
outputs in `03_KEYS`, reproducibility from source + settings, a log of
everything. This addendum records what was built, how, what is measured and
what is not.

## 1. What the operator does (the Key tab)

The Key tab (addendum 08) has eight numbered steps on the left, the key
viewer in the centre, the numbers on the right.

1. **Pick the screen** — **Auto key** finds the screen (green or blue, decided
   automatically), keys with the defaults and, when the handoff names a
   background plate, uses it as the despill reference: one click gives a
   first result over the background. Green/Blue toggle; **Eyedropper**
   (each click adds a sample; the screen becomes their mean); “follow light
   changes frame to frame”.
2. **Key** — screen clip (black), subject clip (white), edge detail, core
   shrink; under *More*: core threshold, edge softness, gamma, balance, the
   clean-plate switch, back to defaults.
3. **Garbage & holdout** — draw boxes on the picture, or use a roto part;
   invert, enable, per-frame range in the model.
4. **Repair with roto** — *Repair frame N with roto* makes a roto part whose
   matte on that frame *is* the current key, accepts it as that part's
   correction key frame, and links it as a repair (replace); *Paint in Roto*
   opens the Roto tab there to paint the corrections, which propagate as any
   roto does. Repairs can also be *more solid* (max) or *less solid* (min),
   from any roto part or a box (a cut-out).
5. **Despill** — background reference (the handoff's background plate, a file,
   or a frame of this shot), replace the spill with *background light*,
   *grey* or *nothing*, strength, the limit, skin protection, protected
   colours picked from the picture.
6. **Light wrap & match** (preview only) — wrap width / intensity / “bright
   areas wrap more”, optionally written as a separate layer on export;
   *Suggest a colour match* records a suggestion (metadata), previewable at a
   chosen strength.
7. **Process shot & review** — keys every frame, records per-frame confidence
   and problems; *Next problem ▸*, *Looks right*, *Flag*.
8. **Export key vNNN** — alpha (16-bit PNG, optionally EXR), the despilled
   premultiplied foreground (EXR), optionally core and edge mattes, and the
   light-wrap layer when asked, into `03_KEYS`. Approval is the existing
   per-task approval, which needs an export of that version.

Since [addendum 18](addendum-18-hybrid-key.md) a **Subject** step (after
*Key*) sets the subject prior — None, a roto part, or Auto (SAM 2 or Track,
from a box, clicks, or the key's own foreground) — its edge band, whether
outside the subject is garbage, and the **shadow pass**; the viewer gains
**Subject** and **Shadow** modes, and the export a shadow PNG sequence and an
alpha + shadow EXR.

Viewer review modes (§6): **Source, Alpha, Premultiplied** (over a neutral
checker), **Over background** (light wrap and match only when asked),
**Edge** (the soft edge highlighted), **Core / edge / garbage** (core green,
soft edge yellow, outside the garbage red, holdout blue, repair regions
purple, over the picture in grey), **Problem frames** (alpha with enclosed
holes in red, the list of problem frames with their reasons). **A/B wipe**
against the source, drag to move. The timeline is coloured by confidence
with problem frames marked. Right panel: screen swatch, matte quality of
the frame and the shot, frames keyed, problem frames, version/approval of
key and despill, the frame's measurements, the suggested match.

## 2. The model (`packages/domain/src/key.ts`, `key-schema.ts`)

A shot's `key` document: screen (kind, auto/manual, linear colour, samples,
coverage, frames looked at, drift tracking), the keyer's parameters, links
(garbage / holdout / repair, from a roto part or a box in plate pixels,
invert, mode, grow, softness, region, frame range, enabled), despill
settings (limit, strength, restore, background reference, skin and colour
protection), light-wrap settings, the match suggestion and its preview
switch, one record per processed frame (confidence, five measurements,
status, problem reason, review, note), the last 200 runs, the exports, the
working width, and a **settings revision** bumped by every change that
affects pixels. Mattes, clean plates and foregrounds are never in the
project.

Mutations — `setKeyScreen`, `addScreenSample`, `clearScreenSamples`,
`setScreenKind`, `setKeyParams`, `resetKeyParams`, `addKeyLink`,
`updateKeyLink`, `removeKeyLink`, `setDespill`, `setKeyBackground`,
`setLightWrap`, `recordBgMatch`, `setMatchPreview`, `setKeyWorkingWidth`,
`recordKeyRun`, `flagKeyFrame`, `markKeyFrameReviewed`, `startKeyRepair`,
`recordKeyExport` — are pure, logged (`key.*`), and refused while the shot is
past prep or the key is approved (“Key v001 is approved. Reopen it …”;
despill settings also while the despill task is approved). A change moves
`key` (and, for despill settings, `despill`) pending → processing or
needs_review → needs_correction; a run or an export moves them to
needs_review; nothing approves. `recordKeyRun` refuses results keyed with an
older settings revision. `approveTask('key')` needs an export of the task's
version, `approveTask('despill')` an export with the despilled foreground.
Reopening bumps the version (`setTaskState`), so the next export is v002
beside the approved v001.

Queries: `keyConfidence(metrics)`, `keyProblemReasons(records)`, `keyReview`,
`nextKeyProblem`, `keyConfidenceSummary`, `keyNames`, `keySettings`,
`keyMetadata`, `keyManifest` (the manifest's `key` section),
`backgroundReferences`, `keyRepairPart`.

**Project format 4.** A version 3 project opens (every shot `key: null`) and
is saved as 4; an older VC VFX refuses a 4. `key` and `despill` are
`available: true` in `tasks.ts`.

## 3. The engine (`apps/desktop/src/shared/key/`)

Pure TypeScript on typed arrays; the same code runs in the desktop's worker
thread and in the browser preview. Deterministic (bit-identical results from
the same frame and settings — tested).

**3.1 Linear light** (`linear.ts`). Frames are read as float code values
(ffmpeg `gbrpf32le`, never through a display view) and decoded with the
colour module: a linear plate (EXR ACEScg / ACES2065-1 / linear Rec.709) is
used as it is; a camera log or display encoding is decoded with its
published curve (4096-step table) and matrix to ACEScg; an unknown encoding
is keyed on its code values and the session says so (“not linear light”).
The viewer's display transform (Rec.709 approx., filmic tone) is applied only
to review images.

**3.2 Screen colour** (`screen.ts`). Chromaticity (r, g, b over their sum)
does not change with brightness, so an unevenly lit screen is one cluster:
the peak of a 64×64 chromaticity histogram of the pixels whose green (blue)
leads the other channels, refined by mean shift; its members' median colour
is the screen. Green vs blue: whichever has more clearly dominant pixels.
Eyedropper: mean colour in a radius at plate pixels.

**3.3 Clean plate** (`cleanplate.ts`). A smooth model of the screen alone on
a grid (64 cells across by default): certainly-screen pixels (chromaticity
within 0.045 of the screen's, eroded 2 px to leave soft edges out) from five
frames spread over the shot, per-cell means, the median across frames (a
frame where the subject crept into a cell does not pull it), cells never
seen filled by pull–push inpainting; built twice, the second pass choosing
its pixels against the first model's brightness. Per frame, an optional
per-channel gain (median ratio over that frame's screen pixels, ½…2) follows
flicker.

**3.4 The key** (`keyer.ts`).
- *Raw key*: colour difference against the screen model S at each pixel,
  d(X) = X_screen − (b·X_a + (1 − b)·X_c), raw = 1 − d(P)/d(S). In linear light
  P = α·F + (1 − α)·S, so raw = α exactly for foregrounds with no screen-colour
  lead; normalising by S per pixel keys a dim corner like a hot spot.
- *Edge matte*: raw clipped between black and white points, then gamma.
- *Core matte*: raw ≥ threshold, optional closing (off by default — it
  bridges hair), enclosed holes filled when tiny or when their raw key says
  mostly foreground (spill holes; a hole of clean screen or soft hair stays),
  eroded by the core shrink; solid.
- *Edge refinement*: wherever the pixel keyed at all outside the core, α is
  solved from the compositing equation along the colour-difference axis,
  α = (d(S) − d(P)) / (d(S) − d(F)), with F estimated from flat, solid
  pixels just inside the core's edge (normalised convolution σ = 3 px, then
  pull–push over the whole core on a 4× smaller grid); d(F) is kept ≤ ½ d(S).
  This removes the colour difference's over-keying of foregrounds that lead
  negatively (a red sleeve's motion blur), while a wrong guess of F matters
  little where F is near neutral (hair over skin). Blended with the clipped
  edge by *edge detail*. (A full 3-D unmixing projection was tried first and
  measured worse on hair, where the nearest core is skin: 0.25 vs 0.02 MAE.)
- α = max(edge, core), then the mattes (`mattes.ts`), in this order:
  **repairs** (inside the region the roto matte replaces / max / min the key;
  the region is a box or the roto matte grown by 12 px by default),
  **garbage** (outside the union of garbage mattes, or inside an inverted
  one, is transparent), **holdout** (inside is solid — a holdout is the
  subject, so it wins even outside the garbage).

**3.5 Foreground and despill** (`despill.ts`). The premultiplied foreground
is the screen subtracted, P − (1 − α)·S (clamped at 0, zero where α = 0) —
exact for the compositing model. Then the screen channel is limited to the
average / max / min / a weighted mix of the other two (homogeneous, so it
works on premultiplied values). The removed luminance is put back in the
**background's colour near the pixel** (the background reference blurred by
`backgroundBlurPx`, normalised to unit luminance), or as grey, or not at all.
Protected hues (±tolerance, fading to 1.5×) are left unchanged; skin (hue
5–45°, saturation 0.12–0.75, judged after a gentle despill) is never limited
harder than the average. The matte is never touched by the despill.

**3.6 Light wrap and match** (`look.ts`). Light wrap = intensity ·
α·min(1, blur(1 − α)) · (the background where visible, blurred and
normalised by how much is visible) · (1 − w + w·min(2, lum/0.18)): zero
outside the subject and deep inside it, at most intensity·(1 + w)·max(bg).
A separate additive layer, never in the foreground. Match suggestion: from
the despilled foreground just inside the edge and the background just
outside it, per channel gain = MAD(bg)/MAD(fg) kept within ½…2 (a busy
background is not a reason to treble the subject's contrast; confidence
halves when it clamps), offset = median(bg) − gain·median(fg), exposure =
log2 of the median luminance ratio, applied at a strength (default 0.5) only
in the preview; recorded as metadata.

## 4. Processing (`apps/desktop/src/main/key/`)

- *Frames* (`frames.ts`): newest plates when there are any, else the source;
  an unprobed movie file is read as YCbCr (Rec.709, video range, as the
  plates read an untagged one).
- *Review frames* are keyed in main at ≤ 960 px (the clean-plate model and
  frames kept warm per shot, size and settings); *detection, processing and
  export* run in `worker_threads` (`out/main/key-worker.js`, its own
  electron-vite entry) with progress and Cancel (between frames; terminated
  after 3 s). Processed mattes are cached as 8-bit PNG in
  `userData/Key Cache`. Looking (session, review frames, samples, detection,
  the match) is allowed read-only; processing, seeding a repair and
  exporting need a licence.
- *Exports* are keyed again at plate resolution from source + settings (not
  scaled review mattes); roto mattes are scaled up with their edges snapped to
  the frame, as roto exports them.

## 5. Confidence and problem frames

Per frame: screen coverage (α < 0.02), core noise (share of the core whose
edge matte is < 0.9 — what the core had to rescue), edge activity (share of
soft pixels), holes (enclosed transparent pixels that do not look like screen,
relative to the subject), residual (mean |P − S| / S over clean screen).
`keyConfidence` = 1 − 2.5·coreNoise − 40·holes − 4·max(0, residual − 0.04) −
2·max(0, edge − 0.12), halved towards zero below 5 % coverage. Problems:
confidence < 0.6, coverage differing > 12 points from the frames around it,
edge activity > max(2.5×, +0.03) the shot's median, residual > max(3×,
+0.05) the median, holes > 0.2 %.

## 6. What is written (§6, §7, §17)

```
03_KEYS/<shot>_key_v001/
  <shot>_key_alpha_v001.1001.png …      16-bit greyscale, straight alpha, plate resolution
  <shot>_key_alpha_v001.1001.exr …      (optional) half float, one channel named Y
  <shot>_key_fg_v001.1001.exr …         RGBA half float ZIP16: despilled foreground, premultiplied,
                                        scene-linear in the plate's (working) encoding, no look
  <shot>_key_core_v001 / _edge_v001 …   (optional) 16-bit PNG
  <shot>_key_lightwrap_v001.1001.exr …  (optional, when a background reference exists) RGB additive layer
  <shot>_key_v001.json                  vcvfx.key/1: screen, every setting (revision), links, background,
                                        suggested match, per-frame confidence and measurements, runs, approval
  README.txt                            what each file is and how to comp it
```

Every frame of the shot, the plates' frame numbers. Versioned, never
overwritten: an approved version on disk is refused; an unapproved one has
only its own files cleared and written again. The manifest's `key` section
has the version, key and despill states and approvals, the folder and
patterns, the encoding, the algorithm and revision, the screen, the links,
the suggested match and a confidence summary.

## 7. Measured

Synthetic shot (`shared/key/synthetic.ts`, 480 × 270, linear ACEScg): skin,
a hair cap with 70 strands 0.3–0.9 px wide (some part-transparent) and a
fly-away halo, a red shirt, an arm motion-blurred over eight shutter samples,
a screen lit 0.57×–1.3× with a darker seam, spill up to ≈ 13 % of the
screen's light at the edge (3 % ambient), noise σ = 0.003. Ground truth:
background ≥ 3 px from the subject, core ≥ 3 px inside, edge = 0 < α < 1
(hair, halo, blur and anti-aliasing: ≈ 2 000–3 000 px a frame). Mean of
four frames, defaults, screen auto-detected:

| Screen | Spill | Background mean α | Core mean α | Edge MAE (worst frame) |
| --- | --- | --- | --- | --- |
| green | none | 0.0007 | 0.9996 | 0.022 (0.024) |
| green | yes | 0.0007 | 0.9991 | 0.045 (0.051) |
| blue | none | 0.0005 | 0.9994 | 0.023 (0.025) |
| blue | yes | 0.0006 | 0.9988 | 0.039 (0.044) |

Without the clean plate the background error on the same shot is > 0.02
(tested: > 10× worse); without edge refinement the edge MAE more than
doubles (tested). Spill on the edge itself is indistinguishable from
transparency in a single pixel, which is most of the remaining edge error.
Through the real pipeline (LogC4 ProRes 4444 → EXR ACEScg plates → worker →
16-bit PNG export at 320 × 180): background < 0.01, core > 0.99, edge MAE
< 0.1 (tested).

**Performance** (4-core Xeon @ 2.1 GHz, Node 22, one thread, warmed):
1920 × 1080 matte only 477 ms/frame (2.1 fps); key + despill + foreground
527 ms/frame (**1.9 fps**). Decoding and the clean-plate model (five frames)
are on top; processing and export use one worker per job.

## 8. Tested (`pnpm test`)

- Domain: every mutation and refusal, logging, task moves (key and despill),
  revision bumps and stale-run refusal, problem reasons on an injected bad
  frame, approval needing an export (and a despilled one for despill),
  approved lock, reopening to v002, Repair with roto (part, seeded key frame
  as a correction, link; roto task added when missing), names, metadata,
  manifest, v3 → v4 migration.
- Engine: screen detection (green and blue, uneven lighting), the clean
  plate within 1 % of the true screen, accuracy above, clean plate and edge
  refinement each shown to matter, determinism, garbage/holdout/repair
  combination (all modes, order, inversion, frame ranges, scaling of boxes,
  roto mattes), a screen-green prop: a hole in the key, rescued by a roto
  repair; despill (spill on the spilled pixels down > 90 %, luminance kept,
  every limit, blue screens, protected colours unchanged to 1e-6, skin under
  the hard limit, background reference moving edge colour towards the
  background, alpha untouched); match recovering a known gain/offset
  (exactly, and within sampling error from different samples); light wrap
  bounded and edge-local; problem detection finding an injected bad frame
  (half the screen light out) and only it; cancellation between frames.
- Main, real ffmpeg: the ffmpeg commands; a LogC4 ProRes clip decoded to
  linear ACEScg within 3 %; worker cancel; clip → plates → detect (worker) →
  despill against the handoff's background EXR → process (worker) → match →
  Repair with roto → export (worker) with alpha PNG + EXR, foreground EXR,
  core, edge, light wrap: names, frame numbers, resolution, premultiplied
  foreground, metadata, README; needs_review; approval; manifest; approved
  version refused.
- Renderer (jsdom): the Key workspace with the preview keyer: Auto key in one
  click (screen, background reference, review numbers), processing the whole
  shot finds the preview's bad frame, Next problem jumps to it, Repair with
  roto links a seeded part; every review mode composed, A/B wipe; the Key
  tab's steps in the layout.

Checked by hand with screenshots of the built browser preview at 1440 × 900:
every review mode, A/B wipe, a garbage box, light wrap and match, processing
and the problem frame.

## 9. Browser preview

The sample's key shot (010_020) is the synthetic shot rendered in the page
(480 × 270, linear ACEScg, the shot's length, one frame with half the screen
light out) — nothing is shipped as files, the frames are generated
deterministically by the same code the tests measure. Auto key, the
eyedropper, mattes, despill against the sample background (a night street),
light wrap, match, processing and problem frames run for real. Exporting and
choosing a background file say they are the desktop app's. Repair with roto
seeds and links the repair in the page; painting it is the Roto tab's on the
desktop (the preview's Roto tab has its own demo shot).

## 10. Not verified, and limits

- Run end to end in the real app on a synthetic LogC4 DPX green screen
  ([addendum 15](addendum-15-verification.md)); OpenEXR 3.5.2 reads the alpha
  EXR as one half channel `Y` and the foreground as RGBA half, premultiplied
  (no colour where α = 0), its α equal to the alpha file.
- Real production green and blue screens: real spill, motion blur, defocus,
  transparency, compression noise, crushed or clipped screens. Only the
  synthetic shot and a ProRes encode of it were keyed.
- A narrow screen feature (a seam a few pixels wide) is finer than the clean
  plate's grid and keys as a faint soft line; raise the screen clip or use a
  garbage matte.
- The foreground colour for edge refinement is extrapolated from the core;
  thin structures far from any core (a wisp detached from the head) fall
  back to the colour difference.
- Screen drift is a global per-frame gain, not a local one; a moving shadow
  on the screen is a problem frame, not compensated.
- The background reference file is read as linear in the working encoding
  when EXR, as sRGB otherwise; other encodings are not offered.
- The match suggestion is a statistics transfer between the edge bands; it is
  often a poor match for busy backgrounds and is metadata only.
- **Real green screens** ([addendum 16](addendum-16-real-footage.md)): the coarse model left real cloth folds,
  floor fall-off and shadows on the screen keying 10–40 % solid; the keyer now
  follows the screen per frame (*Screen detail*, on by default: light shadows
  on the screen key out, a deep one stays), and the per-frame gain is measured only where the
  model saw the screen. A costume lit by the screen's bounce to the screen's
  chromaticity (the astronaut's suit) still keys part-transparent without a
  subject: the **hybrid key** ([addendum 18](addendum-18-hybrid-key.md)) takes a
  subject segmentation (a roto part, or SAM 2 / Track run from the key) as the
  core prior, and the **shadow pass** takes cast shadows out of the alpha into
  a matte of their own. Key engine 1.2.0. A processed key is not marked stale when the engine
  version changes (*Process again*).
- Packaged Electron with the worker entry, Windows and macOS; a signed build.
- Alpha EXR channel is named Y by ffmpeg's encoder (as roto's).
