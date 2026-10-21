# Addendum 06 — Camera tracking and 2D tracking

Master spec §10 asks for camera tracking (matchmove) with a camera database
and lens data (§10.1), LiDAR / survey constraints (§10.2) and exports to the
packages a VFX vendor uses (§10.3); §9 asks for 2D and planar tracking with a
"highlight the surface" workflow and a replacement preview. §15 and §19 apply
as everywhere: processing never approves, outputs are versioned, every change
is logged, nothing leaves the machine. This addendum records what was built,
how, what is proved and what is not.

## 1. What the operator does

Open a shot with a Camera track or 2D track task (**Track…** in the shot
panel, or the **Track** tab of the viewer, next to View and Roto; a shot
without the task offers to add it). The workspace has two sub-modes.

**Camera solve**

1. **Camera & lens.** The camera comes from the handoff (body, sensor mode,
   film back) matched against the camera database (§4); it can be changed or a
   custom body added. Focal length from the slate starts as *approximate*;
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

**Camera database** (`camera-db.ts`): 28 bodies, 54 recording modes (ARRI,
RED, Sony, Canon, Blackmagic, Panasonic, iPhone), each with film back in mm,
pixel size and aliases; each body names its source. 17 modes are marked
`verified: true` (checked against the manufacturer's published figures by
web search in October 2026: ALEXA 35 modes, ALEXA Mini LF / LF open gate,
V-RAPTOR 8K VV, VENICE 2 8.6K 3:2 and 6K 3:2, URSA Mini Pro 12K); the rest are
the commonly published figures, marked unverified in the interface, to be
checked or overridden. Matching uses body, sensor mode, film back and
resolution aspect, and says why it chose a mode.

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
  camera's spec sheet before relying on them.
