# Addendum 04 — Paint-to-roto

Master spec §5 asks for roto by painting rather than splines: the operator
marks what belongs to the matte, computer vision finds it and carries it
through the shot, and the result is reviewed and corrected by painting
again (§5.2). §5.1 asks for component parts combined into the subject matte;
§15 and §19 for review, human approval, versioned outputs, reproducibility,
confidence on AI-derived mattes, local processing and a log of everything.
This addendum records what was built, how, what is proved and what is not.

## 1. What the operator does

Open a shot with a Paint-to-roto task in the **Roto** tab of the top toolbar
([addendum 08](addendum-08-layout.md); *Open Roto* in the shot panel); a shot
without the task offers to add it. The steps below are the tab's numbered
steps: 1 Paint, 2 Propagate, 3 Review (with Correct), 4 Export.

1. **Paint** on a frame with **Include** (green) over the subject and
   **Exclude** (red) over what is not; **Eraser** removes paint. `[` and `]`
   change the brush, I / E / X the tool. The frame becomes a key frame and its
   matte appears as you paint (the key frame is re-segmented after each
   stroke).
2. **Propagate** ◀ / ▶ / both: the engine carries the matte frame by frame,
   up to the neighbouring key frames.
3. **Review**: the timeline strip is coloured by confidence per frame (red
   below 0.6, through amber to green), key frames are marked ◆, flagged
   frames outlined. **Next problem ▸** (N) jumps to the frames most likely to
   need correction. **Contact sheet** shows the mattes on representative
   frames plus the lowest-confidence ones. Overlays: tinted matte (opacity),
   alpha, outline, source.
4. **Correct** by painting on any frame: it becomes a correction key frame and
   re-propagates locally — towards its neighbouring keys, stopping where the
   frames already there (from another key) are better. **Mark as key frame**
   accepts a frame's matte as it stands as a reference; **Flag** (F) and
   **Mark reviewed** record a look.
5. **Parts** (§5.1): add parts under the subject or under another part
   (torso, arm, hair, prop…), each with its own strokes, engine, colour,
   visibility and refinement (feather, shrink/grow, temporal smoothing, edge
   snap), combined into its parent by **union** or **subtract**.
6. **Export mattes vNNN** writes the versioned sequences into the shot package
   and puts roto up for review. Approval is the existing per-task approval in
   the shot panel — a named person's act; roto made here can only be approved
   once the mattes of that version have been exported.

## 2. The model (`packages/domain/src/roto.ts`, `roto-schema.ts`)

A shot's `roto` document lives in the project file: parts (id, name, parent,
combine mode, colour, visibility), each part's key frames with their strokes
(include/exclude, brush radius and a polyline, in **plate pixels**),
refinement, engine (id, version, settings), and one record per frame with a
matte: status (`key` / `corrected` / `propagated` / `flagged`), confidence,
the engine that made it, the key frame it came from, review and note. Plus the
last 500 runs (which part, engine and settings, direction, frames, mean/min
confidence, roto version) and the exports. Strokes are simplified
(Ramer–Douglas–Peucker to ¼ of the brush radius, ≤ 1 px) and rounded to half
pixels, so a painted key frame is a few hundred bytes. **Masks are never in the
project**: they are files.

Mutations — `addPart`, `renamePart`, `removePart`, `setPartSettings`,
`addStroke`, `eraseStrokes`, `clearStrokes`, `setKeyFrame`, `removeKeyFrame`,
`recordPropagation`, `markFrameReviewed`, `flagFrame`, `recordRotoExport`,
`setRotoWorkingWidth` — are pure, logged with who and when (`roto.*` actions),
and refused while the shot is past prep or the roto task is approved
("Roto v001 is approved. Reopen it (Needs correction) to make v002"). Reopening
is the existing `setTaskState`, which bumps the task version, so the next
export writes `v002` beside the approved `v001`. Task states: painting moves
`pending → processing` (and `needs_review → needs_correction`); a finished
propagation or an export moves it to `needs_review`; nothing moves it to
`approved` except `approveTask`, which for roto also requires an export of the
current version (approval approves the files a vendor receives).

Pure queries: `propagationRange` (local re-propagation: a key frame owns the
frames up to halfway to its neighbouring keys), `rivalFrames` (frames whose
matte came from another key), `reviewFrames` (representatives, lowest
confidence, problems: flagged, below 0.6, or dropping > 0.2 from both
neighbours; reviewed and key frames left out), `nextProblemFrame`,
`combineAlpha` / `combineAlpha16` (part = own ∪ union children − subtract
children, recursively; subject = root), `rotoConfidenceSummary`,
`rotoNames` (file names) and `rotoMetadata` (the JSON written beside the
mattes).

**Project format 2.** The project's `version` is now 2. A version 1 project
opens (every shot `roto: null`) and is saved as 2; an older VC VFX refuses a 2
rather than silently dropping roto it does not know about.

## 3. Engines (`apps/desktop/src/shared/roto/`)

Pure TypeScript on typed arrays, so the same code runs in the desktop's worker
thread and in the browser preview. `engine.ts` defines `SegmentationEngine`
(`key()` segments a key frame from strokes or adopts a reference matte;
`step()` makes the next frame from the previous one) and `runRoto`, which
drives an engine over a part from one key frame, through `RotoRunIO` (frames
in, mattes out), checking for cancellation between frames. Refinement is a
separate chain of `MatteRefiner`s (`refine.ts`: shrink/grow, edge snap,
feather; each recorded by id and version). A new model — or a matting
refiner for hair — is one class registered beside these.

### Track (classical, always available) — `track.ts`

*Key frame.* GrabCut-style energy minimisation: Gaussian mixture colour models
(5 components, full covariance, CIE Lab; `color-model.ts`, tabulated over
32³ RGB bins so a pixel's cost is a lookup) for what was painted in and what
was painted out (plus pixels far from the include paint when there is little
exclude), a spatial prior fading with distance from the include paint, a
contrast-sensitive Potts smoothness term (γ = 50, β from the image), and the
painted pixels as hard constraints. Solved exactly by min-cut — Boykov–
Kolmogorov max-flow on the 4-connected grid (`maxflow.ts`) — three times,
refitting the models to the result, on a ≤ 480 px copy; then refined at
working resolution in a band around the coarse edge; small islands dropped,
small holes filled (holes with exclude paint in them are kept).

*Propagation.* The subject's motion is measured where the subject is: its
shift by masked block matching (SSD over the matte's pixels, coarse-to-fine,
sub-pixel) — robust for flat-coloured subjects, where Lucas–Kanade only sees
edges (aperture problem) — then grid points on and around the matte are
tracked with pyramidal Lucas–Kanade (Bouguet, 4 levels, seeded with that
shift) and checked forward–backward; when ≥ 12 consistent tracks spread over
the subject, a robust affine (IRLS, Tukey) carries it and a smoothed residual
field carries parts that move on their own (an arm). Background points are
never used (`flow.ts`). The previous matte is warped by the inverse of that
motion; a band around the warped edge (≈ width/240 px plus the motion
uncertainty) is re-segmented with the key frame's colour models and the warped
matte as prior, everything outside held. When the cut pushes against the
band's rim — a limb moving further than the band — the band is re-centred on
the cut and solved again (up to four times). Held pixels are not graph nodes:
their edges become terminal capacities on the band nodes, so max-flow works on
the band only. The edge is softened with a guided filter (He et al.) of the
frame; optional temporal smoothing blends the warped previous edge.

*Confidence* per frame = 0.40 · colour separation along the edge (how far the
colour models agree with the side each edge pixel is on) + 0.20 · motion (how
well the subject's appearance matched after the shift, and the share of
forward–backward-consistent tracks) + 0.25 · shape (IoU of the warped matte
and the result) + 0.15 · (1 − 4 · leak), where leak is the share of the ring
just outside the matte whose colour says subject (a limb cut off); times a
penalty for area change beyond 15 %; 0 for an empty matte. Key frames carry
their separation score.

### SAM 2 (AI, optional) — `sam2.ts`, `main/roto/sam2-ort.ts`, `main/roto/models.ts`

Segment Anything 2.1 Hiera Tiny, image encoder + prompt decoder exported to
ONNX in **vietanhdev/samexporter**'s layout (checked against its
`export_sam2.py` and `sam2_onnx.py`):

| Model | Tensor | Shape | Meaning |
| --- | --- | --- | --- |
| encoder in | `image` | float32 [1, 3, 1024, 1024] | RGB resized to 1024² (aspect **not** kept), (x/255 − ImageNet mean)/std |
| encoder out | `high_res_feats_0`, `high_res_feats_1`, `image_embed` | [1,32,256,256], [1,64,128,128], [1,256,64,64] | |
| decoder in | `point_coords`, `point_labels` | [L,N,2] in 1024² input pixels, [L,N] | 1 positive, 0 negative, 2/3 box corners |
| decoder in | `mask_input`, `has_mask_input` | [L,1,256,256], [L] | previous low-resolution logits |
| decoder out | `masks`, `iou_predictions` | [L,3,256,256] logits, [L,3] | multimask |

Key frame: up to 6 positive points from the include strokes and 4 negative
from the exclude strokes (farthest-point sampling). Propagation: each frame is
prompted from the previous matte — its box (labels 2/3), up to 3 interior
points at its deepest pixels, and the previous decoder logits as mask input.
The mask with the best predicted IoU is upsampled (bilinear, align-corners
false) and passed through a sigmoid. Confidence = 0.6 · predicted IoU + 0.4 ·
IoU with the previous frame. **This is per-frame prompting, not SAM 2's
memory-attention video predictor** (memory encoder + memory attention), which
would track through occlusion far better; it is the planned upgrade and needs
those modules exported too.

onnxruntime-node (CPU) runs the sessions, in the worker thread. Session tensor
names are checked on load; a model that is not a samexporter SAM 2 export is
refused with the missing names.

## 4. Processing (`apps/desktop/src/main/roto/`)

- **Frames** (`frames.ts`): the shot's newest plates when there are any (they
  are what the mattes go with), else the source, decoded by ffmpeg through the
  viewer's Rec.709 (approx.) view at the working size as raw RGB, a dozen
  frames per ffmpeg run, read ahead in the direction of travel. The view is for
  analysis only — nothing read this way is written as a plate or baked into a
  matte.
- **Working size**: ≤ 1920 px wide by default (`roto.workingWidth`; 960 /
  1280 / 1920 / 2560 or the plate's own width in the panel). Exports are always
  at plate resolution.
- **Worker threads** (`worker.ts`, `service.ts`): propagation and export run in
  `worker_threads` (`out/main/roto-worker.js`, its own electron-vite entry),
  one job per worker, with progress events into the status bar and **Cancel**:
  the worker stops between frames, and is terminated if it has not stopped
  within 3 s. Running and exporting need an active licence; looking does not.
- **Working mattes** (`store.ts`): 8-bit greyscale PNG per (project, shot,
  part, roto version, frame) at working resolution in
  `userData/Roto Cache/<project hash>/<shot>/<part>/v001/<frame>.png`, never
  beside the media or in the package. A frame not in the current version is
  read from the newest earlier version, so v002 starts from v001's mattes.

## 5. What is written (§5.2 final bullet, §17)

```
02_MATTES_ROTO/
  010_020_matte_v001/010_020_matte_v001.1001.png …          the subject matte (combined)
  010_020_roto_subject_v001/010_020_roto_subject_v001.1001.png …
  010_020_roto_right_arm_v001/010_020_roto_right_arm_v001.1001.png …
  010_020_roto_v001.json                                     metadata
```

16-bit greyscale PNG (straight alpha), plate resolution, every frame of the
shot (zero where a part has no matte), the same frame numbers as the plates.
Working mattes are scaled up, their edges snapped to the full-resolution frame
(guided filter), then refined per part in plate pixels and combined by the
hierarchy, in float, so soft edges keep 16-bit precision. Optional half-float
EXR beside each PNG (one channel, named Y by ffmpeg's EXR encoder; ZIP16).
`<shot>_roto_vNNN.json` (`vcvfx.roto/1`) carries the parts (hierarchy, combine
rule, engine and settings, refinement, key frames, per-frame status and
confidence), the runs of that version, the frame source and the refiners that
ran — the matte is reproducible from source + strokes + settings (§19).

Versioned, never overwritten: an unapproved version is cleared (only its own
files) and written again; an approved version already on disk is refused. The
package manifest's `roto` section has the version, state and approval, whether
and where it was exported, the combined pattern, the engines, the parts and a
confidence summary; the PNGs are checksummed with everything else.

## 6. The SAM 2 model: download and pinning

The model is never shipped. **Download model (≈ 156 MB)** fetches the encoder
and decoder into `userData/models/sam2.1_hiera_tiny/`, hashing as it streams.

- **Default source — to be confirmed before release:**
  `https://huggingface.co/nrl-ai/samexporter-onnx-models/resolve/main/sam2.1_hiera_tiny/`
  with `sam2.1_hiera_tiny.encoder.onnx` and `…decoder.onnx`. samexporter's
  README names this repository as publishing SAM 2.1 Tiny with checksums; the
  folder and file names inside it could not be checked from the build
  environment (huggingface.co unreachable). Override: `VCVFX_SAM2_URL`, or
  `modelBaseUrl` in Settings.
- **SHA-256 pins are placeholders (`null`) in `SAM2_MODEL`
  (`main/roto/models.ts`) and must be filled before a release.** A packaged
  build refuses to download or run an unpinned model ("This build of VC VFX has
  no pinned checksum for the SAM 2 model…"), and checks the files against
  their pins before every run. A development build downloads, writes the
  hashes it got to `PINS.json` beside the files, and runs.
- Licence: SAM 2 weights Apache-2.0 (Meta); samexporter MIT. Put both on the
  download page with the ffmpeg notices.

**onnxruntime-node** is not a workspace dependency: its package carries
binaries for every platform (~190 MB unpacked), which every `pnpm install`,
the website's on Vercel included, would download. `scripts/fetch-onnxruntime.mjs`
fetches onnxruntime-node and onnxruntime-common **1.20.1** from npm, checks
each tarball against its pinned SHA-512, keeps only the target platforms'
binaries (no CUDA/TensorRT providers) in `resources/onnxruntime/`, and
`package:mac` / `package:win` run it; electron-builder copies it beside
app.asar (a native module cannot load from the archive). Without it the SAM 2
engine shows "The SAM 2 runtime (onnxruntime-node) is not installed with this
copy" and Track works as before.

## 7. Browser preview

`/preview` has no media, so the sample project's roto shot (010_020) is a
synthetic one — a figure walking across a textured wall, arm and legs
swinging, rendered frame by frame at 640 × 338 (`synthetic.ts`) — and the
Track engine runs in the page on it for real (`renderer/roto-preview.ts`):
paint, propagate, parts, review, correct. Mattes stay in memory. Export and
SAM 2 say they are the desktop app's. The page's CSP is unchanged (frames are
`blob:` images, already allowed).

## 8. What is proved, and what is not

Tested (`pnpm test`):

- Domain: every mutation and its refusals, logging and task moves; versioning
  (approval needs an export; approved roto locked; reopening makes v002;
  re-run belongs to v002); review-frame selection; local propagation ranges and
  rivals; part combination (union, subtract, nested; 8- and 16-bit); file
  names; metadata; the manifest section; project v1 → v2 migration and refusal
  of a newer project.
- Max-flow against Edmonds–Karp on 60 random grids (flow value and cut cost).
- Optical flow on known sub-pixel translations (up to 14 px), robust affine
  through outliers, masked block matching on a flat disc.
- Track engine on a moving textured-background disc with noise: IoU ≥ 0.9 on
  every frame from one painted key frame (measured 0.995–0.998); backward from
  a middle key; an injected failure (the disc jumps) surfaces as the problem
  frames, and a correction key frame there fixes every frame while leaving the
  earlier key's frames untouched; a component part (the arm) segmented and
  tracked; cancellation between frames.
- Refiners (grow/shrink/feather in plate pixels; edge-snapped upscale).
- SAM 2 pre/post-processing (resize/normalise, coordinate transforms, prompts
  from strokes and mattes, logit upsampling, best-mask choice, confidence) and
  the engine's plumbing with a stand-in runtime; **the real onnxruntime-node**
  (1.20.1, Linux x64) loading and running stand-in ONNX models with exactly
  samexporter's tensor names and shapes (`scripts/make-sam2-test-models.py`;
  trivial maths, not SAM 2), in-process and inside the worker thread.
- PNG 8/16-bit round trip (and ffmpeg reads ours as gray16be); the mask store;
  model download, hashes, pin mismatch and the packaged refusal.
- Integration with real ffmpeg: a ProRes 4444 clip → plates → simulated strokes
  → worker-thread propagation → export with EXR → files named
  `R1_matte_v001.1001.png` … at plate resolution, 16-bit, IoU > 0.9 against
  ground truth; task `needs_review`; approval; package manifest with roto
  version, engine and confidence; the approved version refused on re-export.
- Renderer (jsdom): the workspace opens from the task, paints in plate pixels,
  propagates for real with the preview's engine, records 120 frames of
  confidence, puts roto in review, adds and combines parts; the browser bridge.

Checked by hand, with screenshots: the built browser preview (paint, propagate,
flag, parts, contact sheet, alpha, outline) and the real Electron app under
xvfb on a 1280 × 676 ProRes project (paint, worker propagation, export of 193
files, review in the shot panel). Exported mattes of that run: IoU against
ground truth mean 0.990, min 0.946.

**Not verified:**

- End to end ([addendum 15](addendum-15-verification.md)) the Track engine ran
  in the real app (28 frames, lowest confidence 0.99) and its PNG + EXR
  mattes were exported and read by OpenEXR. SAM 2.1 could not: huggingface.co
  is blocked here and the files are unpinned, so the app refuses the
  download; onnxruntime itself loads in Electron.
- **SAM 2 on real weights.** No SAM 2 inference has run here; the model source,
  file names and the actual segmentation quality are unconfirmed. Pins are
  placeholders.
- onnxruntime-node packaged on **Windows and macOS** (and its signing and
  notarisation inside the app bundle, and whether 1.20.1's macOS binaries
  meet `minimumSystemVersion: 11.0`); only Linux x64 was run. Both macOS
  arches' binaries currently land in each macOS build (one copy too many).
- Real production footage: hair, motion blur, transparency, occlusion and
  lighting changes. The Track engine's colour models are fixed per key frame
  (no adaptation), and there is no matting network; edge detail comes from the
  guided filter only.
- Packaged Electron (asar) with the worker entry; a signed build.

### On real footage ([addendum 16](addendum-16-real-footage.md))

A runner crossing a panning car park (ProRes 1920×1080, Track engine, three
key frames): the matte follows him but misses feet, sticks to wall and bushes
he passes and leaves blobs on the road after he exits (no "lost" detection);
plan a key frame every ~10 frames. Fixed: a matte propagated from a further
key *through* a newer key frame no longer blocks that key's propagation
(`rivalFrames` counts only mattes that reached their frame without passing
the new key, from a key that still exists).

## 9. Performance

Measured on a 4-core Intel Xeon @ 2.1 GHz (this environment), Node 22, one
worker:

| Case | Key frame | Propagation |
| --- | --- | --- |
| Disc (r = 160 px) at 1920 × 1080, engine only | 0.9 s | 291 ms/frame — **3.4 fps** |
| Figure (≈ ⅔ of frame height) at 1920 × 1080, engine only | 0.9 s | 654 ms/frame — **1.5 fps** |
| Figure at 1920 × 1080 end to end (ProRes 4444 → ffmpeg → worker → PNG cache) | 1.8 s incl. worker start | 701 ms/frame — **1.4 fps** |
| Figure at 1280 × 676 | | ≈ 350 ms/frame — 2.9 fps |
| Figure at 640 × 338 (the preview), engine only | 0.5 s | ≈ 110 ms/frame — 9 fps |

Time scales with the subject's size more than the frame's (the work is in a
region around the subject). Large subjects at 1920 are the slow case; 1280 is
the practical setting when speed matters (exports are still at plate
resolution). Remaining cost is spread: distance transforms over the subject's
box, the graph cut, garbage collection. Running parts in parallel workers is
an easy next step.

## Open questions

- Confirm the SAM 2.1 ONNX source and pin it; decide whether to host the files
  on the release bucket instead.
- SAM 2 memory-attention video propagation (needs the memory encoder and
  memory attention exported).
- Per-frame colour-model adaptation for lighting changes; a matting refiner for
  hair and motion blur.
- EXR mattes as a named `A` channel (needs an EXR writer of our own; ffmpeg
  names a single channel Y).
- The website's FAQ and roadmap still say roto is not done.
