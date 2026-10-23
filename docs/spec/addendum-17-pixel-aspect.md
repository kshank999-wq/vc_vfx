# Addendum 17 — Pixel aspect (non-square pixels)

[Addendum 16](addendum-16-real-footage.md) put "non-square pixels are not
modelled anywhere" at the top of what remained: the DVCPRO HD plates of the
real-footage run (1280 × 1080 at 1.5, 960 × 720 at 1.333) were solved,
rectified and shown as square pixels. Productions also deliver anamorphic
plates kept squeezed (2×, 1.8×, 1.65×, 1.5×, 1.3×, 1.25× on ARRI, RED, Sony,
Canon) and legacy formats (HDV 1440 × 1080 at 1.333, NTSC / PAL DV at
0.909 / 1.212 / 1.093 / 1.459). This addendum records how VC VFX now carries
a shot's **pixel aspect** (the width of one stored pixel over its height) end
to end, what was verified, and the limits.

## 1. The principle

**Plates are never resampled.** They stay the camera's pixels at the stored
resolution (§4, §19). The pixel aspect is metadata that travels with the shot:

- written into the plates' own headers — EXR `pixelAspectRatio`, DPX, TIFF,
  PNG `pHYs` — by an ffmpeg `setsar` at the end of the filter graph, which
  changes no pixel (test: the same graph as a square shot's, with only the
  stamp added; a real-ffmpeg plate reads back `3:2` and 64 × 54);
- honoured in every computation that measures shape or angle (the camera
  solve, textures, lighting directions, comp transforms);
- applied in the **view only**: every picture of a shot is drawn de-squeezed;
- declared in every export in the receiving application's own terms (§5).

## 2. Where it comes from

`shotPixelAspect` (domain, `pixel-aspect.ts` / `project.ts`) decides, in this
order, and records which source was used:

| # | Source | Read from |
| --- | --- | --- |
| 1 | The artist's override | `ShotState.pixelAspect` (value, note, who, when; logged as `shot.pixel_aspect`) |
| 2 | The handoff | `camera.pixelAspect`, the shot's `pixelAspect`, or a lens squeeze `camera.anamorphicSqueeze` / `camera.lensSqueeze` (a number or "3:2"). A lens squeeze on a raster the handoff's film back and resolution show was desqueezed in camera counts as 1 |
| 3 | The camera database | the mode chosen in Camera Track, else the handoff's camera text matched with confidence: `modePixelAspect` = squeeze × film-back aspect ÷ raster aspect, so ALEXA Mini "6:5 ARRIRAW 2.6K" is 2 and "6:5 ProRes 4K Cine Anamorphic" (desqueezed to 4096 × 1716 in camera) is 1; else a camera-track lens squeeze |
| 4 | The clip | ffprobe's `sample_aspect_ratio` (QuickTime `pasp`, MXF, PNG `pHYs`, DPX / EXR header), recorded as `probe.sampleAspect`; `0:1` / absent = unknown. Texture references read the same from `ffmpeg -i` |
| 5 | Square | — |

Disagreements are **warnings, never a silent pick**: "The clip says 1 (square)
(a.mov says 1); the handoff's 2 is used." A raster that is almost never square
(1280 × 1080, 1440 × 1080, 960 × 720, 720 × 480 / 486, 720 × 576) left at 1 is
flagged with a one-click suggestion ("Use 1.5"), not changed: the hcw PNGs, for
one, carry no `pHYs`.

Shown: the Plates tab (a Pixel aspect stat, and a panel with the decision, its
source, every source that spoke, the warnings, the override and Clear), the
shot detail, the viewer's info line ("Pixel aspect 1.5 · 1280×1080 shown
1920×1080", ⚠ on a warning), the Camera Track stats (a warning when the active
solve was made at another aspect: "Solve again"), the prep report, the
manifest (`shot.pixelAspect`: value, source, summary, display resolution,
warnings), the plate record (`pixelAspect`) and its colour JSON
(`pixelAspect.inHeader`, `resampled: false`), and the AI assistant's shot
context.

Project format **10**: `ShotState.pixelAspect`, `probe.sampleAspect`,
`PlateRecord.pixelAspect`, solve `intrinsics.pixelAspect` (1 for older
solves), texture references' `pixelAspect` / `pixelAspectFrom`. A format-9
project opens with none of them (tests for every earlier format updated).

## 3. The display

`frame-fit.ts` fits a frame of W × H stored pixels into its stage at
W × a by H (contained, centred) and maps pointer ↔ image pixels both ways;
`FrameBox` sizes the picture's box so canvases fill it and overlays (SVG
`viewBox` in image pixels, `preserveAspectRatio="none"`) are drawn through the
same box. Overlays, corners, paint strokes, ball circles and track points stay
stored in **image (stored) pixels**. Used by the viewer and every module
picture: Key, Clean plate, Sky & BG, Comp, Textures (a reference photo at its
own pixel aspect; textures and panoramas are square), Lighting (the analysis
frame arrives de-squeezed and is drawn as such), Roto and Track (their boxes;
strokes drawn in plate pixels through the box's x / y scale, so the footprint
shown is the one painted). Markers drawn as ellipses of r / a, r read as
circles. A "PAR 1.5 · de-squeezed" tag on non-square pictures toggles **Show
squeezed** for the session (the stored raster, to check).

## 4. The maths

**Camera.** `Intrinsics.a`: u = (f / a)·x_d + c_x, v = f·y_d + c_y. f is the
vertical focal in plate pixels = the focal in de-squeezed (square) pixels, so
**fx = f / a, fy = f** (the brief's "fy = fx / PAR" has it inverted: a squeezed
pixel spans more angle horizontally). Brown–Conrady distortion acts on the
de-squeezed normalised coordinates — the 3DEqualizer / Nuke anamorphic
convention. Geometry, pose, triangulation, bundle adjustment (Jacobians ÷ a on
the u row), STMaps and the synthetic renderer all honour it. A non-square shot
is solved in two passes (`solveNonSquare`): the tracks are de-squeezed
(x′ = a·(x + ½) − ½, pixel centres) and solved as square pixels — keyframes,
self-calibration and the initial pair see the picture the camera saw — then
that solve warm-starts a final adjustment in plate pixels, so residuals,
outlier thresholds and the reported RMS are plate pixels, as tracked. (A
single native pass found the same answers on synthetic shots but on the real
survey started from a poor pair; the two-pass start is the robust one.)

Focal length in millimetres uses the film back of the **de-squeezed picture**
(`effectiveFilmBack`): a back already that shape (W·a / H within 3 %: a DV
camera's 16:9 sensor sampled 1280 × 1080) as it is; otherwise the sensor area
behind an anamorphic lens × the squeeze. f_mm = f × back ÷ (W·a). Checkerboard
calibration measures fx ≠ fy; `measuredPixelAspect` = fy / fx checks the
shot's figure and `calibrationIntrinsics(c, a)` gives the solver f and the
(already physical) distortion.

**Textures.** Corners and the focal length are measured on de-squeezed
corners: the rectangle's aspect from the focal length (Zhang & He), and — new,
when no lens is known — from the focal length at which the four corners are a
rectangle (`rectangleFocal`, both vanishing points finite; null when one side's
vanishing point is at infinity), else the corners' edge lengths. The
homography itself is found in stored pixels: a pixel-aspect scaling is a
homography, so the warp is the same and the photo is sampled as stored.
`photoIntrinsics` takes the picture's pixel aspect; the panorama match uses
the de-squeezed photo. A reference frame from the shot's own clip folder takes
the shot's pixel aspect on ingest; otherwise the file's own; the artist can set
it per photo (logged).

**Lighting.** The analysis reads the frame (and mattes, further frames, a ball
held up in the plate) **de-squeezed** — ffmpeg is asked for W·a by H at the
analysis size — so the silhouette normals, shading fit, shadows and vanishing
points work on square pixels; a ball marked on the plate is stored as its
centre in plate pixels and its radius measured vertically, and maps to the
analysis frame by x and y apart (`plateCircleToAnalysis`). The lens priors use
the de-squeezed film back.

**Clean plate, Sky & BG, Roto, Key.** Alignment homographies are found in
stored pixels; they are exactly S⁻¹·H·S of the physical ones (S = diag(a, 1)),
so nothing changes and every output stays at native resolution. Checked: a pan
stored 2× squeezed aligns to S⁻¹HS within 0.04 px.

**Comp.** The node graph's format carries the pixel aspect (`CompIO.pixelAspect`):
Transform rotates and scales on the de-squeezed picture, as Nuke's does
(M = S⁻¹·M_phys·S; translate and centre stay stored pixels); CornerPin is a
homography (unchanged). The Nuke export declares every format with it.

## 5. Exports

| Target | Pixel aspect declared as | Film back / focal |
| --- | --- | --- |
| Nuke `.nk` (camera) | Root and both STMap Reads: `format "W H 0 0 W H a name"` | Camera2 `haperture` = de-squeezed picture, `vaperture` = haperture·H/(W·a), `win_translate` y over W·a |
| Maya `.ma` | `defaultResolution` `.pa` a, `.dar` W·a/H, `.al` yes | `.cap` = squeezed film (haperture ÷ a) × `.lsr` (lensSqueezeRatio) a |
| Blender `.py` | `render.pixel_aspect_x` a | `sensor_width` de-squeezed, fit HORIZONTAL; `shift_y` over W·a |
| After Effects `.jsx` | new comp made at pixel aspect a | zoom = the vertical focal in comp pixels (= f) |
| 3ds Max `.ms` | `renderPixelAspect` a | fov across the de-squeezed width |
| FBX 7.4 | `PixelAspectRatio` a | `FilmWidth` squeezed × `FilmSqueezeRatio` a |
| Houdini `.py` | cam `aspect` a | `aperture` de-squeezed |
| Fusion `.setting` / `.comp` | frame format `AspectX` a | `ApertureW` de-squeezed |
| Unreal `_unreal.py`, Unity `.cs` | — (engines render square pixels; the script says so: render W·a × H and squeeze in comp) | filmback / sensor of the de-squeezed picture |
| USD `.usda` | customData `pixelAspect`; a `/Render/PlateSettings` RenderSettings with `resolution` (W, H) and `pixelAspectRatio` a, its `camera` rel to the camera | `horizontalAperture` de-squeezed: aperture aspect = W·a/H |
| `.chan` | — | vertical FOV (unaffected) |
| JSON | `plate.pixelAspect`, `displayWidth`; lens `fxPx`, `fyPx`; `filmBackMm.sensor` and `desqueezed`; distortion normalisation stated | |
| STMaps | squeezed plate pixel space (stored resolution, u across the stored width); distortion computed de-squeezed | |
| Camera report / README | the pixel aspect, the shown size, both focals in plate pixels, the sensor × squeeze | |
| 2D: Nuke CornerPin2D, AE `.jsx` | values in stored pixels (a corner pin is a homography); the plate format named in the header | |
| 2D: Mocha / AE keyframe text | `Source Pixel Aspect Ratio` and `Comp Pixel Aspect Ratio` a | |
| 2D: JSON | `plate.pixelAspect` | |
| Comp `.nk` | every `format` (Root, Reformat, Constant) with pixel_aspect | |
| Plates | header pixel aspect (setsar) | |

Square shots are written exactly as before (golden checks).

## 6. Verified

Synthetic (in `pnpm test`):

- Domain: priority, disagreement warnings, the raster hint, camera-mode pixel
  aspect, handoff reading (ratios, desqueezed rasters, unreadable values),
  override logging and locks, manifest, format-10 migration
  (`pixel-aspect.test.ts`).
- Camera (`camera-anamorphic.test.ts`): a scene through a 2× (1224 × 1024)
  and a 1.5× (1280 × 1080) camera, focal self-calibrated: path within 0.5 % of
  the scene, rotation 0.2°, focal 1 %, RMS < 0.7 plate px — and the same
  tracks as square pixels fit measurably worse; 2× with anamorphic barrel
  distortion (k1 within 0.015, < 1.5 px at the corner); a 1.5× nodal pan;
  checkerboard calibration measuring fy / fx = 1.5; the command layer end to
  end on rendered 2× frames (focal mm on the de-squeezed back within 2 %, the
  `.nk` format and haperture, the JSON, the report).
- Exports: golden checks of every field in §5 at 2× and unchanged square
  output (`camera-export-par.test.ts`).
- Textures (`texture-anamorphic.test.ts`): a known 4:3 rectangle from 1.5× and
  2× frames comes out 1.333 de-squeezed (0.979 / 0.820 read squeezed); the
  build end to end at the true aspect with and without a lens;
  `rectangleFocal` exact on de-squeezed corners, wrong (1.128 for 1.6) on
  squeezed ones.
- Lighting (`lighting-anamorphic.test.ts`): a scene stored 2× squeezed: key
  3.7° from the truth read de-squeezed, 6.6° read as square pixels.
- Alignment (`align-anamorphic.test.ts`): S⁻¹HS within 0.04 stored px.
- Comp: rotation on a 2× format keeps circles round; the Nuke formats.
- Plates: `setsar` only, and a real-ffmpeg plate's header; ffprobe SAR parsing.
- Renderer (`pixel-aspect.test.tsx`, jsdom): screen ↔ image exact both ways at
  2, 1.5, 0.909 and 1; the Viewer draws 1280 × 1080 at 1.5 as 16:9, labels it,
  toggles to squeezed, and flags a 1280 × 1080 shot left square.

Third-party (the real export of the survey below; scripts in the scratch
area, not in the repository):

- Blender 4.5.3 (bpy): the `.py` builds a 1280 × 1080 render at pixel aspect
  1.5; Blender's own projection (`world_to_camera_view`) of 302 track points
  over 8 frames matches the VC VFX camera model to 0.0003 px.
- usd-core 26.08: aperture ratio 1.7778 = W·a/H, RenderSettings
  `pixelAspectRatio` 1.5 with the camera bound; Gf frustum projection of the
  same points within 0.0009 px; no UsdValidation errors.

Real footage (the addendum-16 project, in the real app under Xvfb):

| Shot | Before (square pixels) | After (pixel aspect 1.5, set from the "Use 1.5" suggestion) |
| --- | --- | --- |
| 050_060 glasses survey, camera solve (same 1137 tracks) | 59 / 146 frames, RMS 1.48 px, confidence 0.21 | **146 / 146 frames, RMS 1.05 px, confidence 0.73**; f 2161 de-squeezed px (47.9° horizontal); exported (Blender / USD above) |
| 050_020 painting card, texture (same region, no lens known) | aspect 0.69 (706 × 1024); its square blue markers √(var x / var y) 0.60 | **aspect 1.03 (1024 × 996); markers 0.90**. The remaining 10 % is perspective the four corners cannot resolve without a focal length (the region overshoots the card's bottom edge, so `rectangleFocal` has no rectangle to work from) |
| 050_010 licence plate, planar track | 102 / 145 tracked, lost from 1103 | reopened, re-tracked: **identical corners** (difference 0 over 408 points) — homographies are aspect-invariant — and v002 declares 1.5 in the `.nk` header, the Mocha text and the JSON |
| Viewer | squeezed: the card's square markers tall, the plate narrow | de-squeezed: markers square, the plate the shape of a licence plate |

## 7. Limits

- The file rarely says: none of the hcw PNGs carry `pHYs`; DV and HDV rasters
  are flagged, but someone must confirm the figure. A DV 720 × 480 / 576 frame
  could be 4:3 or 16:9: the hint names both.
- Brushes (roto, isolate paint) paint circles in stored pixels; on a 2× plate
  they show (truthfully) as 2:1 ellipses on the de-squeezed picture.
- Not opened in Nuke, Maya, After Effects, 3ds Max, Houdini, Fusion, Unreal or
  Unity: their fields follow each application's documented convention (golden
  checks only). Nuke's Transform taking the format's pixel aspect into account,
  AE's zoom being the vertical focal, and Houdini's `aspect` being pixel aspect
  are from the documentation, not a run.
- Unreal and Unity render square pixels: their filmback is the de-squeezed
  picture; the plate must be desqueezed (or CG squeezed) for comparison there.
- A changed pixel aspect does not re-make work already exported: each record
  says the aspect it was made at, and Camera Track asks for a new solve.
- The 960 × 720 embassy plates (1.333) were not re-run; the camera solve of
  soft, compressed DV is still sensitive to tracking quality.
