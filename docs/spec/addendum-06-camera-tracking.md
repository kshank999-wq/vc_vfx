# Addendum 06 — Camera tracking and 2D tracking

Master spec §10 asks for camera tracking (matchmove) with a camera database
and lens data (§10.1), LiDAR / survey constraints (§10.2) and exports to the
packages a VFX vendor uses (§10.3); §9 asks for 2D and planar tracking with a
"highlight the surface" workflow and a replacement preview. §15 and §19 apply
as everywhere: processing never approves, outputs are versioned, every change
is logged, nothing leaves the machine. This addendum records what was built,
how, what is proved and what is not.

## 1. What the operator does

Open a shot with a Camera track or 2D track task in the **Camera Track** or
**2D Track** tab of the top toolbar ([addendum 08](addendum-08-layout.md);
*Open Camera Track* / *Open 2D Track* in the shot panel); a shot without the
task offers to add it. The two sub-modes below are those two tabs, and their
numbered lists are the tabs' steps (coordinate system now sits inside
Export).

**Camera solve**

1. **Camera & lens.** The camera comes from the handoff (body, sensor mode,
   film back) matched against the camera database (§13) when the match is
   confident ("matched from handoff: …"). The picker searches by maker, model
   or alias, grouped by maker, with Cinema / Mirrorless / Drone / Broadcast /
   Phone / Action chips; then the recording mode ("4.6K 3:2 Open Gate —
   27.99 × 19.22 mm · 4608×3164"). Unverified figures carry a **verify** badge
   (the notes and the source link). A fixed-lens drone or phone camera fills
   the focal length (approximate); an anamorphic raster sets the squeeze.
   **Custom…** adds a body (sensor mm and pixels) to the project's cameras. Focal length from the slate starts as *approximate*;
   it can be *known* (held fixed), *approximate* (refined) or *unknown*
   (searched). Distortion k1/k2 can be entered, refined, or taken from a
   project lens profile. **Print checkerboard…** writes a calibration target
   (PDF at exact size and a 300 dpi PNG).
2. **Features.** **Auto-track** detects corners and tracks them through the
   shot. **Add in region** detects and tracks inside a dragged rectangle both
   ways. **Exclude / Include** rectangles and roto parts (people, cars) keep
   features off moving things.
3. **Solve camera.** The result shows RMS reprojection error, frames solved,
   tracks used, focal (mm and px), confidence and any warnings (nodal, pure
   dolly with unknown focal, few tracks…). The **error graph** shows RMS per
   frame (keyframes in amber; click to go there); **worst tracks** lists the
   tracks by error, to mark and delete (or delete everything above a
   threshold), then solve again. Solves are numbered; any can be made active.
4. **3D view** (3): the solved points coloured by error, the camera path, the
   frustum on the current frame, and LiDAR clouds. Orbit, pan, zoom, pick.
   It frames itself whenever the content leaves the view or changes size
   (a LiDAR-constrained solve or an alignment moves the scene into the scan's
   coordinates, far from the origin); **Frame all** (F) frames the cameras,
   tracks and clouds on demand.
5. **LiDAR / survey.** **Import…** a scan (§5); until it is aligned it is
   shown at the solve's size and centre. **Pick correspondence**: click a
   feature (in the frame or the 3D view), then the same point in the cloud;
   repeat. **Align** (similarity, robust to a wrong pick), **ICP** (refine onto
   the scan's surface) and **Solve with LiDAR** (bundle adjustment with the
   correspondences as constraints, in the scan's coordinates). Each
   correspondence shows its residual in px and mm.
6. **Coordinate system.** Units, export up axis, origin at a track, ground
   plane from three tracks, scale from two tracks a known distance apart.
7. **Export camera vNNN** writes the chosen formats into `06_CAMERA_TRACK`
   (§6) and puts the camera track up for review.

**2D / planar**

1. **New planar**: click the surface's four corners (clockwise from top
   left). **New point**: click a feature.
2. **Track** ◀ Back / ◀ Around ▶ / Forward ▶ from a key frame. The timeline
   strip is coloured by confidence per frame; lost frames are red.
3. **Correct** any frame by dragging a corner: it becomes a key; re-track
   around it (both ways to the neighbouring keys, blended).
4. **Hidden by**: roto parts that pass in front of the surface are masked out
   of the tracking.
5. **Drop-in preview**: an image or video pinned to the surface (CSS
   homography), to judge the track.
6. **Export tracks vNNN** into `05_TRACKS_2D` (§7).

Approval is the existing per-task approval in the shot panel, a named act;
it needs an export first. Reopening approved work bumps the version
(`camtrackTaskVersion`, `track2dTaskVersion`); an approved version's folder
is never rewritten.

## 2. The model (`packages/domain/src/camtrack.ts`, `camtrack-schema.ts`, `camera-db.ts`)

`ShotState.camtrack` (camera, lens, tracker settings, masks, the track-set
reference, numbered solves, LiDAR references, correspondences, alignment,
coordinate system, exports) and `ShotState.track2d` (tracks with keys,
per-frame corners, status and confidence, occluders, exports). The project
gains `lensProfiles` and `customCameras`. **Project format 3**; formats 1–2
load unchanged (the new fields default).

Small data lives in the project; large data (feature tracks, solves, point
clouds) lives in the track cache (`userData/Track Cache/<project>/<shot>/`)
as `.vcvx` files — a JSON header and typed arrays (`shared/camera/codec.ts`)
— referenced by id, as roto mattes are.

Every mutation is a pure function in the domain that writes a log entry
(`camtrack.*`, `track2d.*`). Task states follow the existing rules:
tracking / solving moves the task to *processing* → *needs review*; nothing
here approves.

## 3. The command layer (`apps/desktop/src/shared/camera/commands.ts`)

Everything the workspace does is a `CameraCommand` (`auto_track`,
`detect_features`, `delete_tracks`, `set_camera`, `set_lens`, `solve`,
`import_lidar`, `add_correspondence`, `align_to_lidar`,
`set_coordinate_system`, `export_camera`, `track2d_*`, …), described in
`COMMAND_SPECS` (summary, heavy, mutates, scope) so a future AI tracking
assistant can call the same verbs. `dispatch(session, command)` runs it over
a `CameraSession` (the shot's documents, frame IO, the track store, the
solver) and returns a summary, data, and **ops**; the renderer applies the
ops with `applyOps` through the domain, so every command is logged. The
dispatcher refuses mutating verbs on an approved (locked) task.

The same dispatcher runs in three places: the desktop's camera worker thread
(`main/camera/worker.ts`: ffmpeg frames, roto masks from the roto cache, files
on disk), the browser preview (§9), and the tests.

## 4. Algorithms (`apps/desktop/src/shared/camera/`)

All in TypeScript, no native dependency.

- **Linear algebra** (`linalg.ts`): dense matrices, Cholesky, an envelope
  (skyline) Cholesky for the reduced camera system, QR, one-sided Jacobi SVD,
  symmetric eigen, 3×3 helpers, nearest rotation.
- **Features and tracking** (`features.ts`, `klt.ts`): Shi–Tomasi minimum
  eigenvalue corners with non-maximum suppression, sub-pixel peaks, minimum
  distance and per-bucket spread; pyramidal Lucas–Kanade (the roto engine's
  pyramid), with a forward–backward check, an NCC check, velocity prediction,
  pyramid depth from image size, and re-detection to keep the count up.
- **Two-view geometry** (`two-view.ts`): normalised 8-point, RANSAC
  fundamental / homography / essential, GRIC model selection for the initial
  pair, essential decomposition with cheirality, triangulation.
- **Pose** (`pose.ts`): DLT and RANSAC PnP, Huber Levenberg–Marquardt pose
  refinement, robust triangulation.
- **Bundle adjustment** (`bundle.ts`): Levenberg–Marquardt with point
  elimination (Schur complement), Huber or Cauchy loss, optional focal,
  k1/k2, k3, p1/p2, fixed cameras or points, point priors (LiDAR
  correspondences), gauge fixed by the first camera and scale.
- **Solver** (`solver.ts`, behind the `CameraSolver` interface): choose
  keyframes; score candidate pairs (essential from F with the focal guess);
  search focal when unknown; detect a nodal (rotation-only) move and solve it
  as such with a warning; grow the reconstruction keyframe by keyframe (PnP,
  triangulation, local BA), then a global BA; register every other frame by
  PnP; final BA over all frames; reject outliers between passes. Reports RMS,
  per-frame and per-track error, and a confidence (coverage × error ×
  support). `TsCameraSolver` (`vcvfx-ts` 1.0.0) is the shipped
  implementation; a Ceres or COLMAP back end can replace it behind the same
  interface.
- **Alignment** (`align.ts`): Umeyama similarity, RANSAC over triples for a
  wrong pick (`robustSimilarity`), point-to-plane ICP with normals from a
  voxel grid.
- **Planar and point tracking** (`planar.ts`): homography from the key quad;
  per frame, KLT features inside the surface and RANSAC homography from the
  key, then direct refinement of a 10-parameter model (homography + gain and
  bias) by Gauss–Newton with Huber weights, coarse to fine; lost-track
  detection by NCC. Point tracking: affine-warped NCC search with a distance
  penalty, then affine Lucas–Kanade with gain and bias.
- **Calibration** (`calibration.ts`): checkerboard PDF/PNG writer, saddle-
  point corner detection with X-junction test and sub-pixel refinement, grid
  ordering, Zhang's closed form then LM over all intrinsics and poses.
- **Rendering for tests and the preview** (`render.ts`, `synthetic.ts`): a
  small ray caster of textured quads through a distorted lens, synthetic
  camera paths and observations with noise and outliers.

**Camera database** (`camera-db.ts`, data in `camera-db-data.ts`): 189
camera entries and 602 recording modes from 19 makers, each with film back in
mm, pixel size, aliases, notes and sources; matching uses body, sensor mode,
film back and resolution aspect, and says why it chose a mode. §13 has the
coverage, how the figures were found, the conflicts and what is unverified.

## 5. LiDAR and survey (`lidar.ts`, `coords.ts`)

Readers: PLY (ASCII, binary LE/BE), E57 (pages with CRC-32C checked, XML,
compressed vectors of float or scaled integers, the scan's pose), LAS 1.0–1.4
point formats 0–3, OBJ vertices, XYZ / PTS, and CSV survey points (named).
Files are read whole (≤ 2 GB), kept relative to an origin in Float64, voxel
downsampled for display and alignment. Not read: LAZ (compressed LAS), E57
scans stored only as spherical coordinates or images.

Coordinates: the scene is Y-up internally; a scan's units and up axis are
declared at import; exports follow the coordinate system (units, up axis,
origin, ground, scale).

## 6. Camera exports (`export-formats.ts`, `stmap.ts`)

Into `06_CAMERA_TRACK/<shot>_camtrack_vNNN/`, each the undistorted pinhole
camera, every Euler track unwrapped:

| File | For | Axes, units, rotation |
| --- | --- | --- |
| `.nk` | Nuke | Camera2, rot_order ZXY, haperture/vaperture mm, win_translate; ReadGeo2 of the points; STMap Reads |
| `.ma` | Maya | rotateOrder xyz, film back in inches, locators |
| `.py` | Blender | Z-up metres, XYZ radians, sensor fit horizontal |
| `.jsx` | After Effects | pixels (100 per unit), Orientation, zoom from the film back, nulls |
| `.ms` | 3ds Max | Z-up matrix3 keys, horizontal FOV |
| `.fbx` | FBX 7.4 ASCII (Maya, Max, Houdini, Unreal, Unity) | Y-up, cm unit scale, camera along +X, named, TimeMode and frame rate set |
| `_unreal.py` | Unreal Engine 5.x | Level Sequence + CineCameraActor: Z-up, left-handed, cm; FRotator per frame; filmback and focal per frame; camera cut; optional track spheres |
| `_Unity.cs` | Unity 2022 LTS / 6 | Editor script: Physical Camera (sensor mm, focal, gate fit), AnimationClip (position, quaternion, focal) and Timeline; Y-up, left-handed, metres |
| `.usda` | USD (usdview, Solaris, Maya, Blender, Nuke 14+, Unreal/Unity USD) | UsdGeomCamera with time-sampled `matrix4d xformOp:transform`; upAxis and metersPerUnit from the project; lens and filmback in tenths of a scene unit; UsdGeomPoints of the tracks |
| `_houdini.py` | Houdini | `/obj/<shot>_cam`, rOrd xyz, xOrd srt, metres, focal and aperture mm, resolution, frame range and fps; a Python SOP with the points |
| `_fusion.setting`, `_fusion.comp` | Fusion / DaVinci Resolve | Camera3D, Transform3DOp.RotOrder XYZ, BezierSpline keys, aperture in inches, gate fit Width; the .comp also sets range, rate and frame size |
| `.chan` | Nuke, Houdini File CHOP | frame tx ty tz rx ry rz vfov (ZXY) |
| `_points.obj` | everything | solved track points |
| `_undistort.exr`, `_redistort.exr` | Nuke STMap | float UV maps of the lens (own uncompressed OpenEXR writer) |
| `.json` | anything | cameras (matrices and Euler), lens with distortion, solve, alignment, correspondences |
| `_report.html`, `_README.txt` | people | error graph, worst tracks, warnings; how to bring each file into each application |

**Engine conversions.** Unreal: Unreal X = scene −Z (forward), Y = scene X
(right), Z = scene Y (up), centimetres (determinant −1: the handedness
flip); the rotator follows `FRotationTranslationMatrix` (forward = (cP·cY,
cP·sY, sP), right.z = −sR·cP, up.z = cR·cP). Unity: z flips, metres; a camera
looks down its +Z, so its quaternion is built from (right, up, −z) and kept
sign-continuous. USD: cameras are always Y-up locally, looking down −Z
(UsdGeomCamera); for a Z-up stage the transform carries the rotation.

**USD lens units.** `focalLength`, `horizontalAperture`, `verticalAperture`
and the aperture offsets are in **tenths of a scene unit** — millimetres only
when `metersPerUnit` is 0.01 (OpenUSD, `pxr/usd/usdGeom/schema.usda`, class
Camera, section "Units of Measure for Camera Properties"). The writer converts
mm to tenths of the project's scene unit (`usdLensValue`): 25.5 mm is 25.5 in
a centimetre stage and 0.255 in a metre stage. Prim names are prefixed
`VCVFX_` because USD identifiers cannot start with a digit (shot names often
do — caught by opening the file with the USD library).

## 7. 2D exports (`track2d-export.ts`)

Into `05_TRACKS_2D/<shot>_track2d_vNNN/`: Nuke CornerPin2D (to1..to4 = bottom
left, bottom right, top right, top left; y up), an After Effects script
applying ADBE Corner Pin, Mocha-style "Adobe After Effects 6.0 Keyframe Data"
text, and JSON with per-frame corners, status and confidence.

## 8. Desktop processing (`apps/desktop/src/main/camera/`)

`api.ts` (session, frames, view data, command), `service.ts` (one worker
thread per command, cancellable, progress), `worker.ts` (frames through
ffmpeg at the working size, roto masks, LiDAR files read-only, exports
written into the package — an unapproved version's folder is cleared and
rewritten; an approved one is refused), `store.ts` (the track cache).
IPC (`ipc.ts`): mutating verbs need full capability (licence), exports need an
output root outside the source media.

## 9. Browser preview

The preview has no media, so the sample project's tracking shots (020_010
camera track, 010_030 2D track) run on a bundled synthetic shot
(`renderer/assets/track-sample`, made by `scripts/make-track-sample.ts`): 48
JPEG frames at 640×360 of a textured room on a truck-and-pan move, rendered
through the sample's lens (25 mm on the VENICE 2 film back, 2 % long, as a
real lens is against its engraving), and a 15 k-point LiDAR scan of the room
in survey coordinates (Z-up, metres, ×1.7, turned, ~1.5 km from the origin) —
1.7 MB together. The dispatcher runs in the page (`camera-preview.ts`):
detect → track → solve → 3D → import the scan → correspondences → align →
LiDAR-constrained solve, and planar tracking with the drop-in. Exports say
they are the desktop app's.

Measured in headless Chromium (software WebGL): auto-track 3.3–4 s, solve
3.8–4.9 s (RMS 0.31 px, focal 25.51 mm against 25.50 true); six
correspondences picked on the scan (whose points are 0.46 m apart) → similarity
RMS 74 mm, LiDAR-constrained solve 29 mm; planar track forward 47 frames in
1.5–1.7 s.

## 10. What is proved, and what is not

**Proved by tests** (`apps/desktop/src/shared/__tests__/camera-*.test.ts`,
`renderer/__tests__/track.test.tsx`, `packages/domain/src/__tests__/camtrack.test.ts`):

- Synthetic solves (90 frames, 1920×1080, f = 1600 px, 0.5 px RMS noise as a
  2D displacement, 10 % outliers): dolly (known focal), pan, handheld and nodal
  (unknown focal) solve with RMS 0.49–0.51 px, camera positions within 0.05 %
  of scene scale, rotations within 0.05°, focal within 0.05 %; nodal is
  detected and warned; pure dolly with unknown focal is warned as ambiguous.
  With k1/k2 refined: focal 0.18 %, position 0.27 %, rotation 0.07°.
  (The bar: 0.5 % / 0.2° / 1 % / RMS < 0.7.)
- End to end on rendered frames (640×360, 48 frames, KLT → solve): RMS
  0.33 px, path 0.08 % (known focal) and focal within 1 % when unknown (bar:
  RMS < 1, path < 2 %).
- Calibration: rendered checkerboards through a known distorted lens →
  corners < 0.35 px, focal < 0.5 %, distortion at the frame corner < 0.5 px.
- Planar corners and point tracks < 0.5 px on rendered sequences.
- LiDAR: every reader on fixtures written by independent libraries (pye57 /
  libE57Format, laspy; `scripts/make-lidar-fixtures.py`); alignment and the
  LiDAR-constrained solve against ground truth in the command test.
- Every export format: a known move written and parsed back (positions after
  axis and unit conversion, rotation recomposed in the application's order,
  focal, film back, frame range); EXR STMaps decoded by ffmpeg; the Unreal and
  Houdini Python parsed by Python's `ast`; the Fusion files loaded as tables
  by Lua 5.4 when installed.

**Opened in the real application** (by hand, scripts in `apps/desktop/scripts/`):

- **Blender** 4.5.3 (bpy): the `.py` export run and every frame's camera
  matrix compared — position 5e-8 m, rotation 1.4e-7 (`verify-blender-export.py`).
- **USD**: `.usda` exports (cm and m stages, Y and Z up) opened with Pixar's
  USD library (usd-core 26.08): stage metadata, every time sample's
  local-to-world matrix (4.8e-7), focal and apertures back in mm through
  GfCamera, points and ids — PASS (`verify-usd-export.py`). Also imported with
  Blender 4.5.3's USD importer: lens 25.5 mm and sensor 35.9 mm in both unit
  settings, positions converted correctly.
- The Unity C# compiled with Mono against stand-ins for the Unity API
  members it uses — a syntax and consistency check, not Unity.
- End to end ([addendum 15](addendum-15-verification.md)): a track solved in
  the real app (RMS 0.33 px, the rendered focal recovered exactly) and its
  exports checked — Blender `.py` 1.2e-7 m over 48 frames, the `.usda` in
  Blender's importer and in usd-core 26.08 with every UsdValidation validator,
  `.chan` against the JSON (ZXY = Z applied first), STMaps read by OpenEXR,
  the `.nk` structurally, the Unreal script against a recording stub (API
  names, 336 keys, locations and rotators through FRotationMatrix to 1e-8).
  Blender refuses the ASCII FBX (it reads binary only): Blender users have the
  `.py` and `.usda`.

**Not opened in the application here** — structurally validated only: Nuke,
Maya, After Effects, 3ds Max, FBX (no FBX SDK), Unreal Engine, Unity,
Houdini, Fusion / Resolve, and the 2D exports. Specific assumptions to
confirm on first use: Unreal's transform-section channel order and
`add_key` defaults across 5.x; Unity's `m_FocalLength` curve binding and
`TimelineAsset.editorSettings.frameRate`; Houdini's `winx`/`winy` window
offset convention; Fusion's input names (`PerspFocalLength`, `ApertureW/H`,
`FilmGate`, `ResolutionGateFit`) and that its XYZ order applies X first.
No Alembic is written (no Alembic library in pure TypeScript); `.chan` +
`.json` + FBX + USD cover its uses.

## 11. Performance

4-core Xeon 2.1 GHz, Node, one thread; synthetic 200-frame truck-and-pan of
the textured room, focal unknown:

| Working size | Auto-track | Solve | of which final BA |
| --- | --- | --- | --- |
| 1920×1080 (full 1080p) | 26.0 s (7.7 fps), 711 tracks | 42.4 s (RMS 0.54 px, focal 0.15 % off) | 37.1 s |
| 960×540 (half proxy) | 14.3 s (14 fps), 761 tracks | 31.3 s (RMS 0.92 plate px) | 25.6 s |

The final bundle adjustment over all frames dominates; a native solver
behind `CameraSolver` is the obvious speed-up.

## 12. Limits

- Fixed focal length per shot (no zooms; focal is keyed per frame in the
  engine exports for when it is not).
- Planar scenes are degenerate for the 8-point initialisation (the solver
  warns; a homography-based start is not implemented).
- STMaps cover the plate only (no overscan).
- LiDAR files are read whole; LAZ and image-only E57 are not read.
- The camera database's unverified figures must be checked against the
  camera's spec sheet before relying on them (§13).
- Anamorphic squeeze is recorded (and set from an anamorphic mode) but the
  solver models square pixels.

- On real footage ([addendum 16](addendum-16-real-footage.md)): a nodal telephoto pan (ProRes, runner excluded by
  its roto part) solved 129 / 129 frames at 0.64 px. A soft, compressed,
  handheld DVCPRO HD survey registered 59 / 146 frames at 300 features
  (109 / 146 at 600); its 1.5 pixel aspect is not modelled (above). Planar dot
  sheets moved by hand are object tracks, degenerate for a camera solve.

## 13. Camera database

`packages/domain/src/camera-db-data.ts` (the data) and `camera-db.ts` (schema,
lookup, matching). Merged on 2026-10-21 from the earlier hand-checked table
(28 bodies, 54 modes, 17 modes verified) and a researched table (189 entries,
597 modes). Tests: `packages/domain/src/__tests__/camera-db.test.ts` (unique
ids and aliases, a default mode for every model, mm aspect against pixel
aspect, verification honesty, fixed focal lengths, fuzzy matching of 20
handoff strings across makers).

### Coverage

| Maker | Models | Verified models | Modes | Verified modes |
| --- | --- | --- | --- | --- |
| DJI | 37 | 8 | 82 | 12 |
| RED | 22 | 18 | 112 | 45 |
| Sony | 22 | 12 | 68 | 34 |
| Blackmagic Design | 21 | 15 | 74 | 21 |
| Canon | 18 | 10 | 49 | 21 |
| ARRI | 16 | 13 | 85 | 55 |
| Panasonic | 12 | 5 | 35 | 7 |
| Apple | 8 | 4 | 16 | 1 |
| Z CAM | 5 | 0 | 10 | 0 |
| Nikon | 4 | 2 | 14 | 2 |
| GoPro | 4 | 0 | 8 | 0 |
| Vision Research (Phantom) | 3 | 3 | 8 | 2 |
| Fujifilm | 3 | 1 | 9 | 1 |
| Samsung | 3 | 1 | 6 | 0 |
| Google | 3 | 1 | 6 | 0 |
| Panavision | 2 | 1 | 6 | 1 |
| Kinefinity | 2 | 0 | 5 | 0 |
| Freefly | 2 | 0 | 4 | 0 |
| Leica | 2 | 0 | 5 | 0 |
| **Total** | **189** | **94** | **602** | **202** |

By category: cinema 106, broadcast 6, mirrorless 22, drone 31, gimbal 3,
action 7, phone 14. Multi-camera drones and phones are one entry per camera
(e.g. Mavic 3 Pro wide / 70 mm / 166 mm), each with its own film back and
fixed focal length.

**What `verified` means.** On a model: its default mode's millimetres and
pixels appeared in a manufacturer or reputable source (manufacturer docs
preferred; FDTimes, Newsshooter, CineD and Panavision accepted as
cross-checks). On a mode: that, and the mode's own figures are not derived,
assumed, nominal or in conflict (its `notes` say so otherwise) — or it was
verified in the earlier table. The picker shows a **verify** badge on
anything else.

**Fixed lenses.** `equivFocalMm` is the published 35 mm equivalent;
`fixedFocalMm` is derived (equivalent × active diagonal / 43.27) unless
`fixedFocalNotes` says it came from the maker or image metadata. It is set as
an *approximate* focal, refined by the solve. Interchangeable-lens bodies have
none.

**Anamorphic.** `anamorphicSqueeze` is set only where the recorded raster
itself is anamorphic (squeezed, or desqueezed output). Modes designed for 2×
lenses but recorded unsqueezed (ARRI 3.3K 6:5, Sony 4K 6:5 …) say so in
`notes` instead.

**What the notes prefixes mean.**

| Prefix | Meaning |
|---|---|
| (none) | The mm are published for that mode, by the manufacturer or the cited source. |
| `derived: WxH photosites × P µm pitch` | A 1:1 readout. mm = pixels × pitch, with the pitch from the manufacturer's full-sensor mm / pixels. ARRI and RED publish their tables this way, so the result matches their own rounding. |
| `derived: crop of full sensor` | A 1:1 crop. mm = full mm × crop px / full px. |
| `scaled/binned: mm is the sensor source area` | The pixels are the *output* raster. The mm are the sensor area it was scaled from. |
| `full-width readout, height derived` / `assumes full-width readout` | Mirrorless, drone and phone video. The manufacturer does not publish the video active area, so it is modelled as the full sensor width cut to the output aspect. **Treat this as a starting value.** Stabilisation (EIS) and high-frame-rate crops change it. |
| `nominal X-inch type size` | Small sensors where the maker publishes only the optical format (1/1.3", 1/2", …). The mm are the conventional values for that type. 1/1.3" (9.69 x 7.27) is cross-checked against DJI's Zenmuse H30 wide camera spec: 6.72 mm actual = 24 mm equivalent, which gives a 12.1 mm diagonal. |

### Method, and the caveat

Every researched figure came from **web-search result extracts** — the
search service reads a page and quotes it. Direct fetches of manufacturer
sites were refused by the network in that session, so **the PDFs listed in
`sources` were not opened**. Many searches were restricted to manufacturer
domains (`docs.red.com`, `arri.com`, `blackmagicdesign.com`, `pro.sony`,
`canon-europe.com`, `enterprise.dji.com`). The AliceVision `cameraSensors.db`
was used as a sensor-width cross-check for mirrorless bodies. Many drone,
mirrorless and phone video areas are **modelled** (full sensor width cut to
the output aspect) because the makers do not publish them: treat them as a
starting value; stabilisation and high-frame-rate crops change them.

**Merging.** Bodies were matched by maker and model (and aliases); the
earlier ids (`arri-alexa-35`, `sony-venice-2-8k` …) and mode ids are kept,
since projects store them. Where a mode was verified in the earlier table its
figure was kept and the research's alternative recorded in the mode's notes
(no such disagreement arose). Where the earlier figure was unverified, the
researched figure replaced it and the earlier one is in the notes:

| Camera / mode | Researched (used) | Earlier table |
| --- | --- | --- |
| Sony VENICE 2 6K / 6K 17:9 | 35.94 × 18.95 mm | 35.9 × 18.9 |
| Sony VENICE 2 8K / 8.2K 17:9 | 34.1 × 18.0 mm (Sony) | 35.9 × 18.9 |
| Sony PXW-FX9 / FF 6K → UHD | 33.42 × 18.8 mm | 33.4 × 18.8 |
| Panasonic LUMIX S1H / 6K 3:2 | 35.32 × 23.61 mm | 35.6 × 23.8 |
| Panasonic LUMIX S1H / 4K full width | 35.6 × 20.02 mm | 35.6 × 20.0 |
| Panasonic VariCam LT / 4K DCI | 24.576 × 12.96 mm (Panasonic sensor document) | 26.68 × 14.07 |
| Apple iPhone 15 Pro, 16 Pro main / 4K UHD | 9.76 × 5.49 mm | 9.8 × 5.5 |

Modes in the earlier table and not in the research are kept and say so:
ALEXA Mini and AMIRA HD and 4K UHD (scaled from 2.8K / 3.2K), BURANO 8.6K 3:2.
The earlier table's "VENICE / VENICE 2 6K" body is now **VENICE 2 6K** (same
id, `sony-venice-6k`); the original VENICE is its own entry.

### Conflicts between sources (both values listed)

| Camera / mode | Value A | Value B | Used |
|---|---|---|---|
| ARRI ALEXA 35 4.6K 3:2 OG | 27.99 x 19.22 mm (format poster) | 28.00 x 19.20 mm (brochure) | Poster (= 6.075 µm × photosites) |
| ARRI ALEXA 35 2.7K 8:9 / 2K S16 | 16.66 x 18.75 / 12.44 x 7.00 (poster) | 16.70 x 18.70 / 12.40 x 7.00 (brochure) | Poster |
| ARRI ALEXA 35 Xtreme | ALEXA 35 lists 4K 2:1, 3K 1:1, 2.7K 8:9 | SUP 5.0 notes: those modes removed | Removed from the Xtreme entry |
| ARRI Mini LF 3.4K S35 3:2 | 28.25 x 18.16 | 28.25 x 18.17 | 18.17 |
| ARRI ALEXA 65 height | 25.58 | 25.575 / 25.59 | 25.58 |
| ARRI SXT 6:5 ARRIRAW 2.6K | 2578 x 2160 px (ARRI FAQ) → 21.27 mm | 21.38 x 17.82 mm (extract, = 2592 px) | 2578 px, derived |
| ARRI Mini 2.39:1 2K Ana | 2560 x 2145 (ARRIRAW Converter notes) | 2560 x 2146 (SXT data sheet) | 2146, 21.12 x 17.70 |
| ARRI D-20 / D-21 | 24.9 x 18.15 mm (Wikipedia; aspect 1.37 does not fit 2880x2160) | 23.76 x 17.82 (ALEV-pitch figure) | 23.76 x 17.82, unverified |
| RED V-RAPTOR 8K S35 | diagonal 29.63 (spec) | 29.64 (format table) | 26.21 x 13.82 |
| RED EPIC/SCARLET MX 5K | 27.7 x 14.6 (spec sheet) | 27.65 x 14.58 (format table) | Format table |
| RED RAVEN | 23.0 x 10.8 (RED) | 23.04 (= 4608 × 5 µm) | 23.0 |
| RED ONE (MX) | 4520x2540 max recordable / 4700x2540 active (secondary) | 4480x1920 4.5K WS 24.19 x 10.37 (vfxcamdb) | vfxcamdb modes |
| Sony VENICE full sensor | 36.2 x 24.1 (sensor spec) | 35.9 x 24.0 (6K 3:2 recording area) | 35.9 x 24.0 (active area) |
| Sony VENICE 6K 2.39:1 | 6048 x 2534 (Sony poster) | 6048 x 2530 (rental) | 2534 |
| Sony VENICE 6K 1.85 / 17:9 | 36.0 mm width (vfxcamdb) | 35.94 (pitch-derived) | Pitch-derived |
| Sony VENICE 2 4K 4:3 | 4096 x 3432 (poster text) | 4096 x 3024 (product page, manual) | 3024 |
| Sony VENICE 2 8K 5.8K 17:9 | 5792 x 3056 (Sony) | 5434 x 3056 (rental) | 5792; the 5434 row is 5.4K 16:9 |
| Sony BURANO S35 5.8K | 5760 x 3036 (17:9, FR-CA table) | 5760 x 3240 (16:9, same page intro) | Both kept as separate modes |
| Sony BURANO FFc 6K | 6052 px over 33.6 mm (Sony) | 1:1 at 4.16 µm would be 25.2 mm | Published 33.6 mm, marked scaled (inference) |
| Sony F65 photosites | 8192 x 2160 | 8182 x 2160 (vfxcamdb) | 8192 |
| Sony FS7 / FS7 II sensor | 24.0 x 12.7 (Abelcine) | 23.6 x 13.3 (vfxcamdb); 25.5 x 15.6 (mhohner) | 24.0 x 12.7, unverified |
| Canon C400 FF | 36.0 x 19.0 (Canon effective) | 38.4 x 20.2 (Newsshooter, likely full readout) | Canon |
| Canon C100 Mark II | 24.6 x 13.8 (Wikipedia C100; = 3840 × 6.4 µm) | 26.2 x 13.8 (Wikipedia C100 II) | 24.6 x 13.8 |
| Canon C300 II UHD width | 23.06 (1:1 crop of 24.6 @ 4096) | 24.6 (Canon multiplier 1.53 = 28.3 mm diagonal) | 24.6 (DCI 26.2) |
| Blackmagic URSA Mini 4K | 22.0 x 11.88 | 21.12 x 11.88 | 22.0 (= 4000 × 5.5 µm) |
| Blackmagic Pocket 6K 3.7K 6:5 | 3728 x 3104 | 3624 x 3020 | 3728 x 3104 |
| Blackmagic URSA Cine 17K 65 | 50.81 x 23.32 (spec) | "51 x 24" (store) | 50.81 x 23.32 |
| Phantom Flex4K / VEO 4K | 27.6 x 15.6 (datasheet) | 15.55 (= 2304 × 6.75 µm) | 15.6 |
| Phantom TMX 7510 | 23.7 x 15.4 (datasheet) | 23.7 x 14.8 (= 800 × 18.5 µm) | 14.8 |
| Kinefinity MAVO Edge 8K OG | 8192 x 5456 | 8192 x 5460 / 8192 x 5288 | 5456, unverified |
| Kinefinity MAVO Edge 6K OG | 6016 x 3984 | 6016 x 4016 | 3984, unverified |
| Z CAM E2-F6 sensor | 37.09 x 24.75 (Z CAM/CineD, full array) | 35.9 x 24.0 (Mark II listing) | Pitch from 37.09/6244 |
| Freefly Ember S5K | 5120 x 4096 full | 5120 x 2880 (recording table) | Both as modes |
| Fujifilm X-H2S sensor | 23.5 x 15.6 (AliceVision) | 24.3 x 13.9 (one spec table) | 23.5 x 15.6 |
| DJI X9-8K | 36.0 x 19.0 (max video area) | 36.00 x 24.00 (full array) | 36 x 19 for video |
| DJI X9-8K pixel count | 35.4 MP | 44 MP (Procam) | n/a (video raster 8192x4320) |
| DJI Mavic 3 Pro medium tele | 1/1.3" (DJI) | 1/2" (PickDrones) | 1/1.3" |
| DJI Avata | 12 MP (DJI support page) | 48 MP (DJI FAQ) | 4000x3000, unverified |
| Apple iPhone 16 Pro tele | 1/3.2" 15.3 mm² (DPReview) | 1/3.06" (Notebookcheck) | 15.3 mm² |
| Google Pixel 9 Pro main sensor name | GNK (PhoneArena) | GN2 (others) | n/a (size 1/1.31", 1.2 µm) |
| GoPro HERO11–13 raster | 5599 x 4927 (B&H) | 5568 x 4872 (common quote) | 5599 x 4927 |

The aspect check (mm aspect against pixel aspect within 2 %, an anamorphic
raster against 1 or 1/squeeze) has two documented exceptions: the Sony F65
8K photosite mode (a rotated Q67 photosite grid: 8192 × 2160 photosites do
not map 1:1 onto 24.7 × 13.1 mm — use the 4K mode) and the GoPro HERO10
stills raster (a nominal 1/2.3" size against 5568 × 4192; the true active mm
are unknown).

### Unverified entries, and why

- ARRI ALEXA Classic (16:9: EV / Plus / HS): Original 16:9 Classic bodies read 2880x1620 (HD and 2K ProRes scaled from it). From ARRI Classic recording-areas doc title/known behaviour; individual body list not re-confirmed.
- ARRI ARRIFLEX D-21: Pixel count 2880x2160 confirmed; physical mm not confirmed from ARRI.
- ARRI ARRIFLEX D-20: Same body and sensor as D-21. mm unverified.
- RED RED ONE (MYSTERIUM): Sensor 24.4 x 13.7 mm (4520x2540 max recordable) per secondary sources; mode mm from vfxcamdb. Same 5.4 µm pitch as MX. Not confirmed on a RED page this session.
- RED RED ONE MX: Mode mm from vfxcamdb only (RED ONE body caps recording at 4.5K WS / 4K; full MX sensor 27.65 x 14.58 not reachable on RED ONE).
- RED SCARLET DRAGON: DRAGON sensor read at max 5K: area assumed = SCARLET-W 5K FF row (25.6 x 13.5). Not separately confirmed.
- RED WEAPON 8K VV (DRAGON VV): RED DRAGON 8K VV (2016) - dimensions assumed equal to MONSTRO 8K VV (same 8192x4320 VV, 5 µm). No RED page for the DRAGON VV sensor was retrievable.
- Sony ILME-FX6: Sensor 35.6 x 23.8 mm, 10.2 MP effective (video). Exact 16:9 active height not published by Sony; derived.
- Sony FR7: PTZ cinema camera with the FX6 sensor (Sony). Area derived as for FX6.
- Sony ILME-FX3: Sensor 35.6 x 23.8 mm, 4240 x 2832 (same as A7S III). 16:9 active height derived.
- Sony ILME-FX30: APS-C 26 MP sensor; 23.3 x 15.5 mm is Sony-typical but not confirmed this session.
- Sony PXW-FS7 / FS7 II: Sensor dimension sources conflict (see notes). 8.8 MP effective fits 4096x2160.
- Sony PXW-FS5 / FS5 II: Area unverified.
- Sony F35: Indirect source only.
- Sony F23: No F23 spec page reached (source is for the generic 2/3-inch 16:9 area only).
- Sony HDC system cameras (2/3-inch, e.g. HDC-3500, HDC-5500, HDC-3200): Sony does not publish mm for HDC imagers; standard 2/3" 16:9 area used for B4 lenses.
- Canon EOS C80: Canon: same 6K FF BSI 19.05 MP sensor class as C400; mm not confirmed on C80 page.
- Canon EOS C300 Mark II: Canon pixel counts confirmed; per-mode mm not published.
- Canon EOS C200: Not confirmed on a Canon page.
- Canon EOS C300: Secondary sources only.
- Canon EOS C500: Original C500 spec page not found; areas assume the C300-family 6.4 µm sensor.
- Blackmagic Design URSA Cine Immersive: mm from BMD; pixels per eye from memory - unverified.
- Blackmagic Design URSA Mini 4.6K: Same 4.6K sensor as URSA Mini Pro (BMD lineage); not confirmed on BMD page this session.
- Blackmagic Design URSA Mini 4K / URSA 4K: Secondary sources; 22.0 consistent with 5.5 µm pitch.
- Blackmagic Design Pocket Cinema Camera (original) / Micro Cinema Camera: vfxcamdb only.
- Blackmagic Design Cinema Camera 2.5K (original BMCC): Not confirmed by any search result (values from prior knowledge of BMD spec).
- Blackmagic Design Production Camera 4K: Not confirmed by any search result (prior knowledge; 3840 x 5.5 µm).
- Panasonic VariCam Pure: VariCam 35 head with Codex recorder; same sensor (not separately confirmed).
- Panasonic VariCam HS: Panasonic: 2/3-type 3MOS, three 1920x1080 imagers, B4; area is the generic 2/3-inch 16:9 standard, not Panasonic-published.
- Panavision Millennium DXL: Original DXL used the RED DRAGON 8K VV sensor; dimensions assumed equal (8192x4320, 40.96 x 21.6).
- Kinefinity MAVO Edge 8K: Open-gate height unresolved. 5K Wide (S35) and 4K Wide (M4/3) crop pixel sizes not found.
- Kinefinity MAVO Edge 6K: Review data only.
- Z CAM E2-F6: Z CAM lists array 37.09 x 24.75 mm; modes derived from pitch. Mark II lists 35.9 x 24.0 (different sensor?) - conflict.
- Z CAM E2-S6: Sensor ~23.4 x 15.67 mm; mode derived.
- Z CAM E2-F8: Recording modes may be scaled; unverified.
- Z CAM E2-M4: Pitch inferred.
- Z CAM E2C: Area derived.
- Freefly Ember S5K: Retail/rental data; no Freefly page reached.
- Freefly Ember S2.5K: Newsshooter.
- Sony Alpha 1: 8640x5760 confirmed; 35.9 x 24.0 mm not confirmed this session.
- Canon EOS R5 Mark II: New stacked 45 MP sensor; areas assumed equal to R5.
- Canon EOS R6 Mark II: Video areas derived; sensor mm from cross-check only.
- Canon EOS R3: Sensor width per AliceVision (36.00); 6K RAW 6000x3164 from prior knowledge.
- Nikon Z9: Sensor width 35.9 (AliceVision/dxomark). 8.3K N-RAW 8256x4644 from prior knowledge - not confirmed this session.
- Nikon Z8: Same sensor as Z9.
- Fujifilm X-H2: 8K crop factor not found.
- Fujifilm GFX100 II: Sensor 43.8 x 32.9 per spec page; 8K and Premista/35mm crop modes not captured.
- Panasonic LUMIX S1H: Sensor width 35.6 (AliceVision); 6K/5.9K pixel counts from prior knowledge. BS1H (box) shares sensor.
- Panasonic LUMIX S5II / S5IIX: Assumes S1H-class 24 MP sensor readouts; unverified.
- Panasonic LUMIX S5: Sensor width per AliceVision; video areas derived.
- Panasonic LUMIX S1R: Sensor width 36.0 (dxomark via AliceVision).
- Panasonic LUMIX BGH1: CONFLICT: AliceVision lists 19.0 and 17.3 mm widths. Unverified.
- Leica SL2-S: Sensor width per AliceVision (user contribution); video area derived.
- Leica SL3: 4K/C4K crop extent unknown (may be scaled from the 8K window).
- DJI Ronin 4D-6K — Zenmuse X9-6K: 24.1 MP 36x24 sensor confirmed; 6K pixel dimensions not found.
- DJI Mavic 3 — Hasselblad (wide): 4/3 20 MP 24 mm equiv f/2.8-11 confirmed (Mavic 3 Pro page; Mavic 3/Classic/Cine use the same L2D-20c). Video active area not published - derived.
- DJI Mavic 3 Pro — Hasselblad (wide): 4/3 20 MP 24 mm equiv f/2.8-11 confirmed (Mavic 3 Pro page; Mavic 3/Classic/Cine use the same L2D-20c). Video active area not published - derived.
- DJI Mavic 3 Pro — Medium tele 70 mm: DJI: 1/1.3" 48 MP 70 mm equiv f/2.8 (PickDrones says 1/2" - conflict). mm nominal.
- DJI Mavic 3 Pro — Tele 166 mm: DJI: 1/2" 12 MP 166 mm equiv f/3.4. mm nominal.
- DJI Mavic 3 / 3 Cine — Tele 162 mm: 162 mm equiv f/4.4 1/2" 12 MP from prior knowledge (not re-confirmed). Mavic 3 Classic has no tele.
- DJI Mavic 4 Pro — Hasselblad (wide): 100 MP 4/3, 28 mm equiv f/2.0-11; 6K 6016x3384. Video area derived.
- DJI Mavic 4 Pro — Medium tele 70 mm: 48 MP 1/1.3" f/2.8.
- DJI Mavic 4 Pro — Tele 168 mm: 50 MP 1/1.5" f/2.8. Pixel dims assumed.
- DJI Air 2S: 1" 20 MP 22 mm equiv f/2.8 confirmed. Video area derived.
- DJI Air 3 — Wide 24 mm: 1/1.3" 48 MP 24 mm f/1.7.
- DJI Air 3 — Medium tele 70 mm: 1/1.3" 48 MP 70 mm f/2.8.
- DJI Air 3S — Wide 24 mm: DJI: 1" 50 MP 24 mm f/1.8, 8192x6144. mm nominal.
- DJI Air 3S — Medium tele 70 mm: DJI: 1/1.3" 48 MP 70 mm f/2.8, 8064x6048.
- DJI Mini 5 Pro: 1" 50 MP 24 mm f/1.8.
- DJI Mini 4 Pro: 1/1.3" 48 MP 24 mm f/1.7.
- DJI Mini 3 Pro: 1/1.3" 48 MP 24 mm f/1.7 (Mini 4 Pro camera is an evolution).
- DJI Avata 2: DJI: 1/1.3" 12 MP, 155° FOV, 12 mm equiv. Ultra-wide fisheye-like lens: lens distortion dominates; solve for distortion.
- DJI Avata: CONFLICT: DJI support page 12 MP vs FAQ 48 MP. 155° FOV, 12.7 mm equiv.
- DJI FPV: 1/2.3" 12 MP, 150° FOV, 14.66 mm equiv (heliguy).
- DJI Neo: 1/2" 12 MP (Neo 2 data; original Neo assumed same). Equivalent focal not found - no fixedFocalMm.
- DJI Flip: Retail: 1/1.3" 48 MP f/1.7, FOV 82.1° (24 mm equiv inferred from FOV, not stated).
- DJI Osmo Pocket 3: 1"-type CMOS, 20 mm equiv f/2.0 (B&H). Raster and active area unverified.
- DJI Osmo Action 4: DJI store: 1/1.3", 2.4 µm (binned) equivalent pixel, 155°; 10 MP. Raster assumed. Fisheye-class lens.
- DJI Osmo Action 5 Pro: 1/1.3" 40 MP, 155° f/2.8 (retail). Raster assumed.
- DJI Osmo 360: 360 camera: matchmove needs the stitched equirect or per-lens fisheye model, not a film back.
- DJI Zenmuse H30 — Zoom: DJI: 1/1.8" 40 MP, 7.1-172 mm zoom (33.4-809.3 equiv) - not fixed. Pixel dims assumed.
- DJI Zenmuse H20 — Wide: 1/2.3" 12 MP (heliguy). Pixel dims assumed.
- DJI Zenmuse H20 — Zoom: 1/1.7" 20 MP, 23x optical zoom - not fixed.
- Apple iPhone 14 Pro — Main (24 mm): 14 Pro main assumed same 1/1.28" 48 MP sensor class (not confirmed).
- Apple iPhone 16 Pro — Telephoto (120 mm, 5x): DPReview 15.3 mm² (Notebookcheck says 1/3.06" - conflict). 120 mm = 5 x 24 (arithmetic, not a published spec). 15 Pro Max shares the 5x tetraprism (assumed).
- Apple iPhone 16 Pro — Ultra Wide (13 mm): 48 MP 13 mm f/2.2 120°. Sensor size assumed. Strong distortion - solve lens distortion.
- Apple iPhone 13 Pro — Main (26 mm): Values from prior knowledge (12 MP, 1.9 µm, 26 mm equiv); not confirmed this session.
- Samsung Galaxy S24 Ultra — Main (ISOCELL HP2): Same HP2 sensor (sources say main unchanged S23->S25); not separately confirmed.
- Samsung Galaxy S23 Ultra — Main (ISOCELL HP2): Same HP2 sensor (sources say main unchanged S23->S25); not separately confirmed.
- Google Pixel 10 Pro — Main (50 MP): Assumed same 1/1.31" 50 MP main as Pixel 9 Pro; not separately confirmed.
- Google Pixel 8 Pro — Main (50 MP): Assumed same 1/1.31" 50 MP main as Pixel 9 Pro; not separately confirmed.
- GoPro HERO13 Black: Same 1/1.9" 8:7 sensor on HERO11-13 (GoPro comparison). Pixel pitch assumed -> mm unverified. Fisheye-class lens: focal depends on digital lens mode; solve distortion.
- GoPro HERO12 Black: Same 1/1.9" 8:7 sensor on HERO11-13 (GoPro comparison). Pixel pitch assumed -> mm unverified. Fisheye-class lens: focal depends on digital lens mode; solve distortion.
- GoPro HERO11 Black: Same 1/1.9" 8:7 sensor on HERO11-13 (GoPro comparison). Pixel pitch assumed -> mm unverified. Fisheye-class lens: focal depends on digital lens mode; solve distortion.
- GoPro HERO10 Black: mm nominal. HERO9 alias assumed (same 23.6 MP 1/2.3" family). Fisheye lens.

### Gaps

- **Insta360 (all models): not covered.** 360 rigs need per-lens fisheye calibration rather than a film back. DJI Osmo 360 is included only as a placeholder.
- **iPhone:** the 13 Pro is main camera only and unverified. The 14 Pro and 15 Pro have main only (15 Pro 3x tele, 14 Pro tele and 13–15 ultra-wide are missing). No non-Pro iPhones.
- **Samsung:** main camera only, S23–S25 Ultra. **Google:** main only, Pixel 8–10 Pro.
- **Mirrorless:** video active areas are modelled, not published (see the notes prefixes). High-frame-rate crop factors are approximate. Leica SL2-S, Panasonic S5/S5II/S1R/S1H and Nikon Z8/Z9 are not confirmed against maker pages.
- **Sony HDC:** one generic 2/3-inch entry. HDC-F5500 (Super 35) and other S35 system cameras are not covered.
- **Blackmagic:** URSA Mini Pro 12K S16 crop modes and URSA Cine 17K sub-modes are not captured. 4K DCI on the 6K Pocket/Cinema Camera is omitted (scaled or windowed is unconfirmed).
- **Kinefinity:** older models (TERRA, MAVO LF, MAVO 6K S35) are not covered. **Z CAM:** E2-F8/S6/M4 recording modes are pixel-pitch models only.
- **DJI:** the drone video active areas and almost every small-sensor mm are nominal or derived, which is why most DJI entries are `verified: false`. The exceptions are the X9-8K, X7, X5S, P1, H30 wide, L2 and Mini 3.

### How to confirm an entry

1. Open the manufacturer's PDF named in the entry's `sources` (ARRI format
   posters and data sheets, the Sony VENICE posters, RED format tables,
   Blackmagic tech specs) and find the recording mode's active image area in
   mm and its pixel count.
2. For drones, phones and mirrorless video, check a real clip: the focal
   length in its metadata, and a calibration (Print checkerboard…, or a
   solve's lens profile) — a solve with the focal *known* that fits poorly,
   or a solved focal far from the fixed one, means the modelled area is off.
3. Change the entry in `camera-db-data.ts`: the figures, `verified: true` on
   the mode (and on the body if it is the default mode), a `notes` line
   saying where it came from. Keep ids. Run the domain tests (aliases unique,
   aspect check).
4. Until then, override per shot: **Custom…** in the picker (saved to the
   project), or type a film back.
