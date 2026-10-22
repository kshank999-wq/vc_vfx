# Addendum 14 — Lighting and lens analysis, and the rig for Unreal

Master spec §13 ("estimates how a shot was photographed so the look can be
reconstructed in a 3D environment such as Unreal Engine … presented with
confidence ranges rather than false precision"), MVP priority 18. §19
applies throughout: the source media and the references are only read, the
estimate is reproduced from the frame, the references and the settings, the
outputs are versioned, processing never approves, every change is logged,
everything but the optional AI review runs on the artist's machine.

The `lighting_analysis` task becomes available (folder `09_PROJECT_DATA`).
It is worked on in a new **Lighting** tab between Comp and Camera Track
(addendum 08: twelve tabs; Lighting, like Textures, has no digit).

**Not yet tried on production footage.** Every number below is measured on
synthetic scenes with known lights (`shared/lighting/synthetic.ts`). Real
plates bring textured, non-Lambertian subjects, interreflection, grain,
compression and mattes that are not exact. The ranges are built to say so,
but how often a real key falls inside its range is not yet known.

## 1. What is stored

A per-shot document (`ShotState.lighting`,
`packages/domain/src/lighting-schema.ts`; pure, logged mutations in
`lighting.ts`; colour science in `lighting-colour.ts`):

- **settings**: the frames to read (the first places the rig), the subject
  matte's source (*auto* — the first exported of Roto, Background removal,
  Key alpha — or one of them, or none), use the sky, the subject's distance
  (default 3 m), the camera's white balance (blank: from the handoff, else
  assumed unbalanced), and the exposure reference `keyLux` (default 1000);
- **references**: chrome ball, grey ball, HDRI (equirectangular) — from disk,
  the handoff, the plate itself or the preview's sample — with the frame, the
  ball's circle (drawn by the artist), the HDRI's heading (or null: aligned
  by the analysis), size and SHA-256;
- **analysis**: the newest estimate. Each light: id, role (key, fill, rim,
  back, practical, background, ambient, sun, sky), type (directional, point,
  spot, rect, dome), and **azimuth, elevation, distance, intensity (stops
  from the key), size and colour temperature, each a value inside a range**
  (`RangeSchema` refuses a value outside its range), its RGB, where a
  practical sits in the frame, the motivation in words, the evidence (shading,
  shadow, highlight, practical, chrome ball, grey ball, HDRI, fill ratio,
  rim, sky, background) and a confidence. Beside them: the subject (matte
  source, coverage, centre), the sky, the ground, the white balance used and
  its source, overlay marks, warnings, how long it took and the task version;
- **lens**: focal length (a range) and where it came from (artist, camera
  track, metadata, vanishing points, unknown), the checks made against the
  others, film back and its source, horizontal and vertical field of view,
  a distortion hint, an aperture hint, the focus distance, the lines and
  vanishing points found; plus the artist's overrides (focal, film back,
  f-stop);
- **the artist's work, kept apart from the estimate**: per estimated light
  the edited fields and which of them are **locked**; lights the artist
  added; lights taken out. A new analysis never touches them: a locked
  field keeps the artist's value; an edited light the new analysis no longer
  finds is kept as an artist's light;
- **AI reviews** and the decision on each suggestion; **runs** (the last
  200); **exports** (one per task version, with the formats, the camera
  source, the settings and rig revisions written);
- **revision** (bumped by what changes the analysis) and **editRevision**
  (bumped by what changes the rig).

Project format 9. Formats 3–8 open with `lighting: null` (tested for each).

**Approval** waits for an export of the current rig ("Export the light rig
v001 first …" names the version and why). An approved version is locked:
nothing on the tab changes until it is reopened, which bumps the version.

## 2. Conventions (`geometry.ts`)

Camera x right, y up, z towards the camera. A light's direction is given in
the **level frame**: the camera's heading with the world's up (the camera's
pitch and roll from the camera track's solve, else from a vertical
vanishing point, else taken as level with a warning; recorded on the
analysis as `tilt` and used by the overlays, the relight and the placed
camera), so "elevation 30°" means 30° above the horizon whatever
the camera's tilt. Azimuth 0° is from the camera's side, +90° frame right,
±180° behind; elevation from the horizontal. `L = (sin az cos el, sin el,
cos az cos el)`. Intensities are stops relative to the key at the subject.

## 3. The analysis

`shared/lighting/analyse.ts` (`analyseLighting`). The frame is read linear
in the project's working gamut at 320 px wide.

### 3.1 Shading (`shading.ts`)

1. **Normals from the silhouette.** A signed distance field of the subject
   matte (exact Euclidean on both sides, sub-pixel from the matte's
   coverage), smoothed, its gradient the normal's direction in the image;
   how far in from the edge sets how far the normal tilts towards the camera
   (the occluding-contour inflation `ρ = sin α √(1 − k²) / (1 − k cos α)`,
   `k = sin β` for the subject's angular radius β, inverted by table) and
   the view frame is rotated to the ray through the subject's centre, so
   perspective is honoured. Only pixels the matte fully covers are used.
2. **A non-negative fit.** Each pixel's value is modelled as a sum of
   sources: per source a soft terminator (an area light's
   `(x + sin α)² / (4 sin α)` round the edge of the lit side) and a near-field
   term (inverse-square falloff across the subject, `1/distance` in subject
   radii), plus an ambient floor. A global non-negative least squares over
   420 Fibonacci directions (coordinate descent) gives clusters (32° apart);
   from the strongest clusters, and from a photographer's prior (a key, a
   fill at −0.8 × the key's azimuth and 12° up, a source behind), a
   multi-start pattern search refines direction, softness and distance;
   weak and crowding (within 35°) terms are dropped.
3. **Roles.** The key is the source with the largest share of the visible
   light; the fill the frontal one on the other side (key-to-fill ratio
   from their shares); the rim one from behind (`L_z < −0.25`); the ambient
   the floor (its 5th percentile as a ceiling). Colours are fitted per
   channel with the directions held, and read as a colour temperature after
   undoing the camera's white balance (von Kries in the working RGB; §2.6).
4. **Ranges.** 20 bootstrap refits over resampled pixels, widened by how
   well the model fits (R²) and by known blind spots (the fill's direction
   from shading alone is loose; a rim's elevation is poorly seen).

### 3.2 Shadows (`shadows.ts`)

The ground is a horizontal plane below the camera (its height and the
camera's tilt from the camera track, or assumed). Ground pixels near the
subject's contact point are mapped onto it and compared with the lit ground
there (a robust quadratic model of the lit ground's brightness), so a
shadow is a share of the light missing (flood fill from the contact at
0.75). Shadow pixels are gathered by direction; the darkest direction
(darkness² weighting) is the key's shadow, others belong to weaker lights,
ranked by depth. The light's azimuth is the shadow's direction turned
round; its elevation from the shadow's centroid and the subject's height
(tan el ≈ (H/2) / centroid distance, for a sphere on the ground and an
upright pole alike); its angular size from the penumbra's 10–90 % width
across the shadow's sides divided by the distance from the occluder. A
shadow that runs out of frame or behind the subject widens the range rather
than guessing.

### 3.3–3.5 Chrome ball, grey ball, HDRI; practicals (`probes.ts`)

- **Chrome ball** (§3.3): inside the artist's circle, bright clusters are reflected
  sources; the mirror normal at each gives its direction, its extent the
  size, its summed radiance (×π, a sphere sees each direction over half its
  solid angle) the intensity; the upper reflections give the dome. Clipped
  sources are flagged "at least this bright".
- **Grey ball** (§3.4): the shading fit (§3.1) on a sphere with exact normals.
- **HDRI** (§3.5; preferred when present): sources above `max(8 × median,
  0.006 × peak)` are grouped; each one's direction, angular size, colour
  (absolute: the HDRI is not white-balanced) and `E = ∫L dΩ / π`; the rest
  the dome. A null heading is found by aligning the HDRI's key with the
  plate's shading.
- **Practicals**: small, bright, often clipped blobs in the frame off the
  subject (a lamp, a sconce, a screen): position, size and colour. Its depth
  is unknown, so it is placed along its ray at 1.4 × the subject distance
  and its direction, distance and intensity at the subject (radiance × area
  / distance², with a reflectance of 0.2–0.6) carry the spread from 0.6 × to
  3 × that depth; clipped ones are "at least this bright". A chrome ball or
  HDRI that sees the same source places it.

**The key's direction is fused** from every cue that has it — HDRI, chrome
ball, grey ball, shading, the cast shadow (only when it agrees within 60°
with the others: a fill's shadow is not the key's) — each with its own
half-range; when the cues disagree the range covers them and a warning
names them. An HDRI with a given heading is the light itself: it is used as
measured and the other cues only check it. The key's size comes from the
HDRI, else the chrome ball, else the penumbra, else the shading; its colour
from the HDRI, else a ball, else the shading. **Other probe sources** take
over the plate's estimate of a light within 25° / 20° of them (direction,
size, stops, colour), or are added (fill, rim or back by where they are).
Lights from a probe carry it as evidence and a higher confidence.

### 3.6 Colour temperature (`lighting-colour.ts`)

Planckian locus `xy` by Kim et al.; CCT by a mired search along the locus;
a temperature to RGB in the working gamut. A plate pixel is first
"unbalanced" with the camera's white balance (`balancedRgb` /
`unbalancedRgb`), so a 5600 K source reads 5600 K whether the camera was
balanced for 3200 K or 5600 K. With no white balance known the analysis
says it assumed one, and the temperature ranges widen.

### 3.7 The lens (`lens.ts`)

Order of trust: the artist's value, then the camera track's solve, then the
handoff's metadata (with the camera database's film back), then vanishing
points. Edge pixels (Sobel on log luminance, thinned along the gradient)
are grown into line-support regions of one orientation, as LSD does, each
fitted with a line; RANSAC over pairs of lines finds a vanishing point
(scored by the length of lines pointing at it), then another among the
rest. Two vanishing points of perpendicular directions give
`f² = −(v₁ − c)·(v₂ − c)`, its range from a bootstrap over the lines. When
metadata or a solve exists the vanishing points **check** it (agrees /
disagrees, with the figure). Field of view from focal and film back; a
distortion hint from the plumb-line method (the division-model k₁ that
makes the long edges straightest; a k₁ only when conclusive); an aperture
hint from how much wider the background's edges are than the subject's,
through the thin-lens blur (always low confidence, said so).

## 4. The relight, and where it runs

**The relight** (`relight.ts`): the subject's albedo is the plate divided by
the estimated rig's shading on its silhouette normals; the preview is that
albedo under the rig as edited. So the unedited rig gives back the plate,
and every edit shows on the subject at once: the *Relit* view, the A/B
wipe, the grey ball (albedo 0.5) beside the diagram, and the **match
score** — R² of the plate's luminance against one albedo times the rig's
shading, over the subject (below 0.6 shown as a warning).

**Where it runs.** On the desktop the main process reads the plate, the
subject matte (the module's exported, versioned matte) and the references
(`main/lighting/io.ts`), and the analysis and the exports run in a worker
thread with progress and cancel (`main/lighting/worker.ts`); the relight
models are cached per analysis. In the browser preview the same engine runs
on the main thread, yielding between stages.

## 5. Exports and units

Into `09_PROJECT_DATA/<shot>_light_vNNN/`, in a worker with progress and
cancel; refused when the output root is under any source path; versioned,
never overwritten (an approved version on disk is refused; an unapproved
one has only its own files cleared and rewritten):

| File | What |
| --- | --- |
| `<stem>_unreal.py` | Unreal Engine 5 editor script: spawns the lights and a CineCameraActor in an outliner folder named after the version; reads the rig file beside it, else its embedded copy; when an HDRI was used, imports it (by its path relative to the folder) for the sky light, or says how to set it up |
| `<stem>_rig.json` | the rig: every estimate with its range, evidence and motivation; the artist's edits and locks; the placed lights; the lens; units; an `unreal` section the script reads |
| `<stem>.usda` | UsdLux lights (DistantLight, SphereLight with cone shaping for spots, RectLight, DomeLight) and the camera; Y- or Z-up as the camera track says |
| `<stem>_blender.py` | Blender lights and camera (optional) |
| `<stem>_report.html` | printable: the frame with the overlays, the rig from above and from the side, each light's figures with ranges, evidence and motivation, the lens and camera, the notes, the AI reviews and their decisions |
| `<stem>_frame.png`, `README.txt` | the analysed frame for viewing; what each file is and how to use it |

**Placement** (`place.ts`). With a camera-track solve, the camera at the
analysed frame and the lights are in the track's scene (Y-up, right-handed,
its units): the camera and the rig line up with the camera-track exports.
Without one, a level camera at the origin looking down −Z, tilted by the
analysis' pitch and roll. The subject sits along the ray through its centre
at the subject distance; a positional light at its distance along its
direction, aimed at the subject (a background light at the spot it lights).

**Unreal units.** Scene → Unreal as the camera-track export: Unreal X =
scene −Z, Y = scene X, Z = scene Y, centimetres; rotators `(roll, pitch,
yaw)`. The **exposure reference** is the key's illuminance at the subject,
`KEY_LUX` (default 1000 lux; EV100 = log₂(KEY_LUX / 2.5)). A light of
*s* stops gives KEY_LUX · 2ˢ lux at the subject:

| Unreal class | Intensity | Size |
| --- | --- | --- |
| DirectionalLight | that illuminance, lux | source angle = its angular size |
| PointLight, SpotLight | candela I = E · d² (d in metres) | source radius; a spot's cone from its distance |
| RectLight | candela, the same | width = height = 2 d tan(size / 2) |
| SkyLight | a scale relative to the key | — (no absolute unit without a calibrated cubemap) |

Temperature is set with *Use Temperature*. The script's header repeats
this and suggests a manual exposure of the computed EV100; change
`KEY_LUX` and run it again to re-scale everything. USD intensities are
relative (the key 1) with lux and candela in each light's `customData`;
lens values follow the camera-track USD (tenths of a scene unit).

Tested: the Unreal and Blender scripts compile (`py_compile`), carry every
light with its unit, and the camera matches the camera-track export's
conventions; the USD has one UsdLux prim per light, the camera, balanced
braces, Y- and Z-up; the rig JSON parses back.

## 6. The tab

Three zones as every module (addendum 08 §3). Steps: frames and references ·
analyse · review the lights · lens and camera *(optional)* · export. The
centre: the plate with the overlays (each light an arrow from the subject's
centre in its range cone, dashed when behind; practicals circled; shadow
lines; the balls; vanishing points), *Relit*, *A/B wipe* (drag the split),
*Reference*. Beside it the rig from above or from the side — drag a light:
from above its azimuth and distance, from the side its elevation — with the
range wedges, the grey ball lit by the rig and the match. The right panel:
lights found, key confidence, focal estimate, match; the selected light's
role and type and every figure as a slider showing the estimate, its range,
and **Lock**; its evidence and motivation; the AI review.

Arrow and diagram labels step apart when two lights land close together.

The browser preview analyses the sample's storeroom shot (`040_010`):
rendered in the browser from the synthetic studio scene with the handoff's
focal length and the camera database's film back, with a sample chrome
ball, grey ball and HDRI. Exporting and the AI review say they are the
desktop's.

## 7. The AI review (optional)

The existing assistant path (addendum 07: the vc-vfx.com proxy, metering,
sign-in) with the existing per-project consent to let AI see frames. One
request: a downscaled JPEG of the analysed frame and the estimate (lights
with their ranges, evidence and confidence, the lens, the warnings) and one
strict tool, `suggest_light_changes` (prompt version `lighting-review/1`).
Each suggestion (a light, the fields to change, why) is shown for the artist
to **accept** (applied as the artist's edit, logged) or **reject**. Nothing
is applied by the model; the analysis works without it.

## 8. Measured (synthetic, 320 × 180 analysis)

The studio scene: a sphere 0.45 m at 4 m, a 35 mm lens on a 36 mm back, the
camera 1.4 m up pitched −6°; key az 48° el 32° (4300 K, soft), fill −42° /
12° at −2.2 stops (6500 K, large), rim −150° / 28° at −0.6 stops (5600 K),
a 2700 K practical lamp at −5 stops in frame, ambient at −4.5 stops.

| Case | Result (truth) |
| --- | --- |
| Silhouette normals vs the sphere's own | median 1.59°, 90th percentile 3.33° (3717 pixels) |
| Shading only — key | az 51.2° [43.7, 81.6] (48), el 32.5° [27.7, 49.6] (32), 4317 K [3744, 5098] (4300) |
| Shading only — fill | az −49.5° [−79.5, −19.5] (−42), −1.85 stops [−2.65, −1.05] (−2.2), 6534 K (6500) |
| Shading only — rim | az −155.3° [−180.3, −130.3] (−150), el 18.3° [1.7, 35.2] (28), −0.40 stops [−1.30, 0.51] (−0.6), 5472 K (5600) |
| Shading only — practical | at 241.6, 42.2 px (241.8, 42.1), 2705 K (2700), −4.96 stops [−8.41, −3.36] (−5) |
| Ellipsoid subject — key | az 49.8° [33.1, 61.3] (48), el 23.9° [9.6, 39.8] (32) |
| Hard key from the left, camera balanced 3200 K | az −60.5° [−68.0, −51.6] (−60), el 42.9° [23.1, 47.8] (45), 5900 K [4800, 7654] (5600) |
| Chrome ball | key 48.0° / 32.0°, fill −42.0° / 12.0° −2.34 stops, rim −150.0° / 28.1° −0.48 stops |
| HDRI (heading given) | key 48.0° / 32.0° 4298 K; fill −42.0° / 12.0° −2.21 stops 6529 K; rim −150.0° / 28.0° 5600 K; dome −4.58 stops |
| HDRI (heading found) | key az 51.1° [43.6, 81.6] — the alignment inherits the shading's bias |
| Chrome + grey ball in the analysis | key 50.2° / 32.0° 4300 K; fill −42.0° / 12.0°; rim −150.0° / 28.1° |
| Vanishing points (synthetic rooms) | f 403.0 px [378.8, 427.2] (400); 703.8 [661.6, 746.0] (700); 305.1 [270.8, 339.3] (300, with barrel distortion) |
| Relight | match 0.92 for the estimated rig; 0.00 with the key moved to −60° |
| Time | desktop worker with an HDRI 3.8–4.5 s; shading, shadows, practicals and lens 4.1–5.1 s; browser preview (balls + HDRI, headless Chromium) 7.6–9.7 s |

Every case's truth lies inside its range (the ambient's only just); the tests assert it
(`apps/desktop/src/shared/__tests__/lighting-engine.test.ts`; the worker,
exports, approval and AI stub in `main/__tests__/lighting.test.ts`; the
domain in `packages/domain/src/__tests__/lighting.test.ts`; the tab in
`renderer/__tests__/lighting.test.tsx`).

## 9. Limits

- Opened outside VC VFX ([addendum 15](addendum-15-verification.md)): the
  Blender script in Blender 4.5.3 (types, positions and aim to 5e-7, energy
  from candela / lux), the USD in usd-core 26.08 (UsdLux types, −Z aim,
  relative intensity, colour temperature, the DomeLight texture, no
  UsdValidation errors); the Unreal script only against a recording stub. The
  HDRI is referenced on the drive by a relative path, not copied into the
  package; the Blender rig does not load it as the world texture.
- **The shading needs a subject matte** exported by Roto, Key or Sky & BG;
  without one only shadows, practicals and the references speak.
- **The fill's direction from shading alone is rough** (±30°) and the key's
  range skews away from the camera (to ~80° above); a grey or chrome ball
  pins both down, an HDRI best.
- **The ambient from shading alone is weak**: −8.0 stops [−13.8, −2.1]
  against −4.5, at a meaningless 25000 K. The range holds it, the figure
  does not; set it by eye or from a probe.
- **Lambertian assumption.** Glossy, textured or subsurface subjects (skin)
  bias the fit; specular highlights are used only as practicals or
  catchlights, not yet as a separate direction cue on the subject.
- **One frame places the rig.** Several frames can be listed, but moving
  lights or a moving subject are not modelled.
- **Distortion is a hint.** The curvature test rarely reaches a conclusive
  k₁ on short lines; the tests assert only that it never claims one falsely.
- **Depth of field is a hint** (low confidence, said so in the UI).
- **Unreal sky intensity is relative**: no absolute unit without a
  calibrated cubemap.
- **Not yet tried on production footage** (see the top).

## 10. Also changed

`main/comp/io.ts` reads grey (single-channel) PNG mattes with its own
decoder: ffmpeg 6.1 converting a grey PNG to `gbrpf32le` went through YUV
and returned wrong values, which biased mattes read for the comp and for
the lighting analysis.
- On real footage ([addendum 16](addendum-16-real-footage.md)): a chrome and a grey ball held up in a ProRes take
  gave a key from −118° azimuth, 46° elevation, consistent with the grey
  ball's lit edge; a 10K HDRI analyses in about 8 s. Fixed: the reference just
  added is the one selected (marking a second ball moved the first's circle),
  and the Reference view no longer shows the previous shot's picture while a
  new one loads.
