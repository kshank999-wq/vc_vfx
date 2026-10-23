# Addendum 18 — The hybrid key: a subject segmentation as the core prior, and the shadow pass

Master spec §6 asks for "green/blue key + hybrid roto": a key that assumes the
plate is imperfect and leans on segmentation where colour cannot decide.
[Addendum 16](addendum-16-real-footage.md) §4.2 showed where colour cannot
decide on real footage: Ken's `GREEN SCREEN.mov` astronaut wears a white suit
lit by the green floor's bounce, so the suit has the screen's chromaticity at
about 40 % of its brightness — by colour it *is* a shadow on the screen — and
it keyed part-transparent, while the deep cast shadow on the floor (also about
40 %) stayed solid in the matte. A chromaticity core was tried and dropped (it
made hair and motion blur solid). This addendum records the three things built
to answer it — SAM 2.1 enabled with pinned, verified models; the subject prior
in the keyer; the shadow pass — what was measured, and the limits.

## 1. SAM 2.1: source, licence, pins

### Where the model comes from

| | Default: SAM 2.1 Hiera Tiny | Optional: SAM 2 Hiera Base+ |
| --- | --- | --- |
| Repository | <https://huggingface.co/nrl-ai/samexporter-onnx-models> | <https://huggingface.co/vietanhdev/segment-anything-2-onnx-models> |
| Pinned revision | `5050a79cd4b912dd745fff83047c4ef6fbd97be5` | `071f58077599431edd0e5d2ac52ecca4c78f1cab` |
| Folder | `sam2_1_hiera_tiny/` | (root) |
| Publisher | NRL.ai — the Hugging Face organisation of samexporter's author (its one member is `vietanhdev`, samexporter's maintainer) | samexporter's author |
| Provenance | the repository's `PROVENANCE.md`: exported with samexporter from Meta's official checkpoint `sam2.1_hiera_tiny.pt`, `facebookresearch/sam2` at `2b90b9f5ceec907a1c18123530e92e794ad901a4`, ONNX opset 18; split image encoder + dynamic-prompt decoder; graphs pass `onnx.checker` | the repository README: samexporter exports of Meta's SAM 2 (2.0) checkpoints, used by AnyLabeling |
| Licence | SAM 2.1 weights Apache-2.0 (Meta); the folder ships the Apache-2.0 text (the repository is `license: other` only because it also holds SAM 3 under Meta's SAM licence); samexporter MIT | Apache-2.0 (repository), SAM 2 weights Apache-2.0 |
| Encoder | `sam2.1_hiera_tiny.encoder.onnx`, 109 471 931 bytes, SHA-256 `3d5ae796097a6afb1198ceea4187ecaa82736242d07f5658541829d6dfc3f871` | `sam2_hiera_base_plus.encoder.onnx`, 339 781 223 bytes, SHA-256 `53b79cec15f2078b3c7410f00f00950a09ef02007dccf238859fec156e42cc8d` |
| Decoder | `sam2.1_hiera_tiny.decoder.onnx`, 16 519 561 bytes, SHA-256 `197f1c7c8fd070aaf6f15ffc635f4c384422ba5eaa0f8c9e543e3d4b8e0e8e87` | `sam2_hiera_base_plus.decoder.onnx`, 20 640 886 bytes, SHA-256 `666f00ce2664de31211a71068b6b74c3fc5aeee089ebeb2fc9c37834b9ce03b4` |

**How the pins were verified.** Each hash was read from the hosting service's
own metadata before downloading — the Hugging Face API's `lfs.sha256` for the
pinned revision (`/api/models/<repo>?blobs=true`) and the `x-linked-etag` and
`x-linked-size` headers of the `resolve/<revision>/…` URL — and, for the
default model, also from the publisher's `CHECKSUMS.sha256`; all agreed; the
files as downloaded hashed the same (`sha256sum`), and so did the copies the
real app downloaded through its own **Download model** button. No hash was
pinned from a file alone.

The tensor layout was read from the graphs (`onnx`): encoder `image`
[1, 3, 1024, 1024] → `high_res_feats_0` [1, 32, 256, 256], `high_res_feats_1`
[1, 64, 128, 128], `image_embed` [1, 256, 64, 64]; decoder inputs as
addendum 04 §3 records, `masks` [L, 3, 256, 256] (logits, clipped) and
`iou_predictions` [L, 3]. The encoder starts with a convolution — the
ImageNet normalisation is not embedded, so `sam2Preprocess` keeps doing it.

Other sources looked at: `onnx-community/sam2.1-hiera-{tiny,small,base-plus,large}-ONNX`
(transformers.js layout — vision encoder + prompt-encoder/mask-decoder with
other tensor names; Apache-2.0) would need a second runtime adapter and was
not adopted; many single-user exports had no provenance. No SAM 2.1
Small/Base+ export in samexporter's layout with stated provenance exists, so
the higher-quality option is SAM 2 (2.0) Base+. If one is needed, the route
is samexporter's own: `python -m samexporter.export_sam2 --checkpoint
sam2.1_hiera_base_plus.pt --model_type sam2.1_hiera_base_plus …` from Meta's
checkpoint (SHA-256 recorded), the hashes of the exported pair pinned and the
export hosted by us.

### In the code

`main/roto/models.ts`: `SAM2_MODEL` (tiny, default) and
`SAM2_BASE_PLUS_MODEL`, each with its exact sizes, SHA-256s, licence, source
repository, revision and provenance; `defaultBaseUrl` is a
`resolve/<revision>/` URL, never `main`. The download checks size and hash of
every file before moving it into place (a mismatch installs nothing); a
packaged build checks the files against the pins before every run. Settings
`sam2Model` (or `VCVFX_SAM2_MODEL`) chooses the model; `VCVFX_SAM2_URL` /
`modelBaseUrl` still override the host, never the pins. The engine version
records the model (`sam2.1_hiera_tiny/onnx/2`).

### It runs in the real app — in a process of its own

The first real run inside Electron crashed the app (SIGTRAP) on the second
encoder call: onnxruntime-node 1.20.1 hands back output tensors over memory
that V8's sandbox does not allow in a **worker isolate**, and collecting one
kills the process. Reproduced outside VC VFX with a ten-line Electron app:
the same code runs in plain Node, in Electron's main thread, and in a process
started with `ELECTRON_RUN_AS_NODE`, and crashes only in an Electron worker
thread. (So the SAM 2 roto engine of addendum 04, which runs in the roto
worker, never could have run in the app.) Inside Electron, inference now runs
in a child process — the app's own binary as Node
(`HostedSam2Runtime`, `main/roto/sam2-ort.ts`): it keeps the image embedding
and sends back only the decoder's masks over IPC. Tests: the stand-in models
through the hosted runtime; on real weights, the hosted and in-process
runtimes give the same mask (IoU > 0.99).

`scripts/fetch-onnxruntime.mjs` was run here and fetched 1.20.1 with its
pinned SHA-512s.

**Speed** (4-core Xeon @ 2.1 GHz, CPU): SAM 2.1 Tiny encoder 0.93–1.4 s per
frame (1024² input; any frame size), decoder 66 ms; SAM 2 Base+ encoder 2.5 s.
In the app: 112 astronaut frames in 152 s (1.36 s/frame, seed included).

### Propagation fixes found on real frames

- Per-frame prompting from where the subject *was* fails on fast movers: on
  a walking figure the IoU fell to 0 by the second frame. The engine now
  measures the subject's own motion (masked block matching, `subjectShift`)
  and prompts with the previous matte moved by it: 0.96 → 0.90 IoU over five
  frames of the synthetic walker, 12 frames > 0.8 in the real-weight test.
- Of SAM's three masks, propagation takes the one that best agrees with where
  the subject should be (0.4 · predicted IoU + 0.6 · IoU with the shifted
  previous matte); a subject that has left the frame, or whose best mask
  barely overlaps where it should be (< 0.15), is **lost** (empty, confidence
  0) instead of SAM latching onto something else.
- Up to 5 interior clicks spread over the previous matte (was 3).
- A box seed with clicks gets SAM's most confident mask; clicks alone get the
  largest mask SAM is nearly as sure of (the whole astronaut, not his helmet).

## 2. The hybrid key

### The subject

`key.subject` (domain, `key-schema.ts`): **None**, a **Roto part** (with its
children), or **Auto** — SAM 2 (or Track when SAM 2 is not installed, the
fallback recorded) run over the whole shot from a seed on one frame: the
operator's box or clicks (Key tab › Subject: *Box the subject*, *Click the
subject*, Alt-click for "not the subject"), or by default the key's own
confident foreground on the middle frame. Masks go to the key cache
(`Key Cache/…/subject/v00N/`), at ≤ 1024 px; the run (engine, seed, per-frame
confidence, fallback) is in the document and logged (`key.subject`,
`key.subject_run`). Changing the seed or engine makes the run stale; changing
the subject or the margin bumps the key's settings revision like any
setting. The artist's roto is trusted as drawn (confidence 1).

**Seeding from the key** (`seedFromKey`): alpha ≥ 0.9, opened (light stands,
cables and hair go), the largest component weighted to the centre; then what
the key joins to it (alpha ≥ 0.2) within its columns widened by a quarter —
so the box reaches the astronaut's part-solid legs, while his shadow running
sideways does not stretch it; a box round that and clicks at its deepest
points. A foreground that fills the frame (a small card of screen in a scene,
the green cloud plate) is refused: draw a box. The run's confidence is lowered
when the engine's mask leaves out seed clicks or much of what the key joined.

### How it is used (`shared/key/subject.ts`, `keyer.ts`)

A prior, never the matte. With the segmentation S (≥ 0.5), the margin m
(plate pixels, default 12, scaled to the key) and the frame's confidence c:

- **Core.** Inside S deeper than m·(1 + 2t), where t (0…1) is how much fine
  structure the key has nearby (the high-frequency part of the raw key,
  averaged — hair), the core is solid whatever the colour — unless the key
  calls the pixel clean screen (a segmentation spilling over the screen), and
  except on slopes of the key (a motion-blur ramp; ≥ 0.05 per pixel), so a
  segmentation a few pixels too wide does not make blur solid. Deep inside
  (three times the margin) a clean-screen reading is the clean plate's error,
  not the segmentation's.
- **The band.** Between the core and S's edge the key decides, as without a
  prior — but the unmixing edge refinement now takes the foreground colour of
  a costume from deep inside it (where the costume leads the screen channel
  more than the colour found near the edge, and not in hair), lets that
  foreground lead the screen channel more (up to 0.5 + 0.4·c of the screen's
  lead, was 0.5), and an unmixed α above 0.85 inside S goes to solid by 0.95:
  a screen-lit suit's edge unmixes against the suit.
- **Outside** S, beyond 2m·(1 + 2t), keyed things fade out (a soft garbage
  matte) — unless the key joins them to the subject: soft ones within
  max(6m, 0.2·√area)·(1 + 2t), solid ones (raw ≥ 0.8, across gaps up to m —
  a head over a thin neck) within 0.75·√area. Light stands are not joined;
  hair beyond a segmentation that stops short is. This removal acts only for
  a sure segmentation: it fades in between c = 0.5 and 0.8. The artist's
  garbage, holdout and repair mattes apply after it, unchanged (a holdout
  still wins).
- **Clean plate.** The subject (grown) is left out of the clean-plate model's
  samples and of the per-frame screen detail: a screen-lit costume standing
  in most frames had darkened the model where it stood. The model's first
  pass takes a bright quantile (0.75) over frames instead of the median: a
  shadow cast on the screen only darkens it, and must not become the clean
  plate where it lingers.
- **Confidence.** `subjectPrior` lowers c when S's core covers what the key
  calls clean screen (1 % → full, 10 % → none). Per frame:
  `subjectConfidence`, `subjectDisagree` (S over clean screen),
  `subjectOutside` (what the key alone calls solid outside S, relative to
  S's area). Matte confidence is multiplied by 0.6 + 0.4·c, less 3 ×
  disagreement; the core-rescue measure no longer counts what S vouches for
  or what it removed; the screen-vs-model residual ignores shadows and what
  the key does not read as screen. Problem frames: S over clean screen
  (> 3 %), S unsure (< 0.5), or the key solid outside S far more than on the
  frames around it.

## 3. The shadow pass

`params.shadowPass` (off by default; Key tab › Subject). Shadow = the
screen's chromaticity (within 0.05), darker than the clean screen, outside
the subject: density = 1 − L(pixel) / L(clean screen), ignored below 0.08
(the clean plate's own error), specks opened away, small ones dropped, holes
(floor marks) filled from the shadow round them, lightly smoothed. The clean
screen here is a **static fine screen**: per pixel, the 0.75 quantile of the
analysis frames that saw screen there (folds, the cove's fall-off, at the
key's size) — a shadow that moves with the subject is in few of them — with
the coarse model where too few frames saw it. With a subject, a shadow must
touch it (within 4m) and reach beyond its band; without one, it must be well
away from the key's core. Shadows leave the alpha only beside a sure subject
(weighted like the outside garbage): without one, a screen-lit costume reads
exactly as a shadow, so the pass is written but the matte keeps it.

The foreground is zero where the shadow took the alpha, so despill never
colours the shadow; the pass carries no colour — the compositor multiplies
the new background by (1 − density), or a tinted version.

Written (`03_KEYS/<shot>_key_vNNN/`): `<shot>_key_shadow_vNNN.####.png`
(16-bit density), and with *Alpha as EXR too* a half-float
`<shot>_key_mattes_vNNN.####.exr` with channels `A` (alpha) and `shadow.A`
(the shadow layer; written by VC VFX's own EXR writer — ffmpeg's cannot name
channels). README and metadata say how to use them; the manifest and the
export record name the pass. The viewer's **Shadow** mode shows it; **Over
background** multiplies the background by it; **Subject** shows the
segmentation (cyan) and the soft edge (yellow).

**Comp.** The Keyer node's *Output* gains *Shadow pass*
(source `key_shadow`); a Merge with *stencil* (B × (1 − a)) puts it on the
background. The suggested graph does this when the key has a shadow pass
(Key_shadow → Shadow_on_bg → light wrap → over), and the Nuke export reads
the PNG (Read + Shuffle red → alpha, as every matte) into a Merge2
`operation stencil`.

## 4. Measured

### Synthetic (`key-hybrid.test.ts`)

`greenScreenScene({ screenLitSuit: 0.4, castShadow: 0.6, travel: 0.25 })`:
the figure's trousers become a white suit lit by the screen's bounce — the
screen's colour at 40 % (± 6 % fold shading) — beside a cast shadow at 40 %
of the screen's light with a soft penumbra; hair strands, fly-away halo and
the motion-blurred arm as before. Frames 1, 5, 9 of 12, margin 4 px:

| | Suit α | Core α | Shadow α | Shadow density error | Edge MAE |
| --- | --- | --- | --- | --- | --- |
| No prior | 0.28 (0.43 without the shadow pass) | 0.78 | 0.21 without the pass | — | 0.075 |
| Exact segmentation | 0.94 | 0.989 | 0.000 | 0.015 | 0.067 |
| Dilated 6 px | 0.93 | 0.987 | 0.03 | 0.06 | 0.067–0.085 |
| Eroded 6 px | 0.69 | 0.92 | 0.000 | 0.014 | 0.074 |
| Shifted 6 px | 0.83 | 0.957 | 0.03 | 0.05 | 0.060 |

Hair (the hair test shot, no spill, frames 1, 5, 9): edge MAE without a
prior 0.0287 / 0.0324 / 0.0321; with the exact segmentation 0.0290 / 0.0326 /
0.0325; dilated 0.0267 / 0.0305 / 0.0308; eroded 0.0287 / 0.0324 / 0.0321;
shifted 0.0250 / 0.0292 / 0.0289 — never more than 1 % worse (the test asserts
5 %). (Addendum 09's 0.022 is the mean of four other frames of a 24-frame
shot; on these frames the plain key measures 0.029–0.032 before and after this
change.) A segmentation over clean screen is not trusted (its confidence goes
to 0, the screen stays clean, the frame says why). The artist's holdout still
wins. Shadow density 1 − 0.4 recovered to 0.015 mean error.

### Real footage (in the real app and the same engine offline)

Ken's footage stays out of the repository (and the Hollywood Camera Work
plates may not be redistributed). Before = engine 1.2.0 without a subject;
after = Auto subject (SAM 2.1 Tiny, seeded from the key) + shadow pass.

| Shot | Before: confidence / clean screen | After | Subject |
| --- | --- | --- | --- |
| 010_010 astronaut (app, whole shot, 112 frames, 1920 working) | mean 0.049 (112 problem frames), clean 77.4 % | mean **0.735** (min 0.50, 19 problem frames), clean **89.1 %** | SAM, 152 s, mean confidence 0.973 (min 0.926) |
| 010_010, frames 1009 / 1040 / 1070 / 1100 (1024 working) | 0 / 0 / 0.12 / 0; 80 / 81 / 79 / 74 % | 0.58 / 0.77 / 0.91 / 0.82; 94 / 92 / 88 / 83 % | |
| 040_010 embassy HD, 1010 / 1040 / 1070 / 1100 | 0.56 / 0.25 / 0.76 / 0.81; 69 / 74 / 82 / 79 % | 0.83 / 0.91 / 0.88 / 0.85; 95 / 94 / 90 / 83 % | SAM 1.53 s/frame, mean 0.977 |
| 040_020 embassy SD, same frames | 0.66 / 0.85 / 0.82 / 0.81; 78 / 83 / 81 / 74 % | 0.89 / 0.95 / 0.90 / 0.86; 92 / 91 / 87 / 79 % | SAM 1.38 s/frame, mean 0.977 |
| 050_030 green cloud | 0.83 / 0.65 / 0 / 0.83 | unchanged — the key's foreground is the whole scene (the screen is a card); Auto refuses to seed it | — |

Looked at: on the astronaut the suit is solid head to boots, the light
stands, rigging and markers are gone, the cast shadow is out of the alpha and
in the shadow pass (density ≈ 0.6 in its core) — with, near his feet, the
floor/cove junction where the camera's dolly moves the fall-off (a light,
low-density band). On the embassy plates the rigging, stands, fan and frame
are gone; a mic boom touching the actress's arm and the ceiling rig her
raised hands reach are kept (the key joins them to her): a garbage box takes
them. Screenshots of the real window (source, alpha before and after, Subject, Shadow, Over background, the exported frames, the model installed in the Roto tab) and of the browser preview's Subject step were looked at; like the footage, they are not in the repository.

**GUY RUNNING roto, SAM 2.1 Tiny vs Track.** In the app, a *Runner SAM* part
(SAM engine, one include stroke on 1015, propagated both ways at 1920 px):
129 frames in 188 s (1.45 s/frame), mean confidence 0.93, no frame lost. It
keeps the hoodie and head but drops the jeans from about 1040, and after the
runner leaves (~1088) it holds a patch of road (1100–1129) — per-frame
prompting has no memory. The Track part of addendum 16 (three key frames)
follows the whole runner, feet included, and leaves its own blobs on the road
after he exits. Offline, Track from the same single box seed (0.1 s/frame at
960 px, mean 0.41) follows the whole runner and correctly loses him when he
leaves. On this shot Track with key frames remains the better roto; SAM is
what makes the astronaut possible (Track cannot separate a costume the colour
of the screen from the screen). (Compared on screenshots of the Roto tab at 1040, 1078 and 1100 with both
parts shown.)

**Speed** (1920 working, one thread): plain 1.7 s/frame; with a subject
2.4–2.7 s; with the shadow pass too 3.5 s (wide blurs are worked on a smaller
copy and the shadow's clean-up at half size at 2K; before that it was 2.6 /
3.7 s, and the in-app processing of the astronaut took 486 s for 112 frames,
the export at plate resolution about 40 s a frame; after, the export of the 112 frames at 2048 × 1080 — alpha PNG + EXR, foreground, shadow PNG and the mattes EXR — took 51 min, 27 s a frame, with other work running). Exports read back: `A` and `shadow.A` half channels (OpenEXR 3.5.2), density 0…0.81 on 1009.

## 5. Tests

Domain (`key-subject.test.ts`): the subject in the document (defaults,
logging, revision, task state), a roto subject needs a real part, runs and
staleness (an old seed refused), processed keys going stale, confidence and
problem reasons, metadata / manifest / comp resolution and the suggested
graph, project format 11 (a format-10 project opens with no subject and the
pass off; round trip; a newer project refused). Engine
(`key-hybrid.test.ts`): the failure reproduced, solved with the exact
segmentation, robustness to dilated / eroded / shifted segmentations, the
hair test, a segmentation over clean screen, holdout semantics, the prior's
and the shadow pass's units. Main (`key.test.ts`): clip → plates → Auto
subject (Track, no SAM 2: fallback recorded; SAM 2 asked for and missing
fails loudly) → shadow pass → process → export (16-bit shadow PNG, the
mattes EXR's channels, metadata, README). SAM: the pins (format, revision
URLs, licence, sizes), mismatch and unpinned refusals, the stand-in models
through the hosted runtime, and — when `VCVFX_SAM2_DIR` points at the
downloaded model — the real weights (hashes, a box seed and propagation on
the synthetic walker, hosted = in-process). Renderer: Subject and Shadow
modes composed.

**Project format 11; key engine 1.2.0** (`vcvfx-cdk@1.2.0`).

## 6. Limits

- SAM 2 here is per-frame prompting, not SAM 2's memory-attention video
  predictor: it can drop a part (the runner's jeans) and, once the subject is
  gone, hold onto something else; lost-subject detection is geometric. The
  memory modules exported and pinned would fix both.
- Track cannot segment a costume the colour of the screen; an Auto subject
  made with Track is a prior for ordinary subjects only (the run says when
  Track was used; check the Subject view).
- The shadow pass measures against the screen where it does not move: a
  shadow that never moves (a still actor) is in the clean screen and not
  found; a camera move makes static shading (the cove) read as light shadow
  near the subject. Only shadows touching the subject are kept — not a
  stand's shadow.
- What the key joins to the subject (a boom touching an arm, rigging the
  hands reach) is kept; outside garbage removes only what is apart.
- The hybrid key is slower (above); SAM 2 on CPU adds ~1.4 s per frame once
  per shot.
- Packaged builds on Windows and macOS (the hosted ORT process uses the app
  binary with `ELECTRON_RUN_AS_NODE`; a build that disables that fuse must
  ship a separate host) are not verified.
