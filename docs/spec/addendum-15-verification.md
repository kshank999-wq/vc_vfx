# Addendum 15 — End-to-end verification against §22

Master spec §22: a successful handoff gives the vendor a package in which
every VFX shot is identified, converted into the correct working plates,
documented and — where asked — already keyed, rotoscoped, clean-plated or
tracked, so the facility starts from organised, validated prep. Until now
every module had been tested on synthetic data with VC VFX's own readers.
This addendum records a pass that ran the **real desktop app** end to end
and opened its outputs in **third-party software**, what that found and
fixed, and what is still unverified.

## 1. The drive

A cut-down copy of the sample handoff ("Night Shift", three shots) with
real media on a drive, built with the domain's own colour transforms:

| Shot | Media | Tasks run |
| --- | --- | --- |
| 010_020 | 28 frames, 960×540, 10-bit DPX in ARRI LogC4 / AWG4 (an actor on green, tracking markers, a C-stand), files `A012C004_0086398.dpx …`, handoff SHA-256 | plates, roto, key, despill, clean plate, comp |
| 030_010 | 40 frames, LogC4 DPX, rooftop pan with a moving sun, a chart and a poster; files `C007C011_0001996.dpx …`, **no timecodeIn** | plates, sky, 2D planar track |
| 020_010 | 48 sRGB JPEGs of the camera-track room (the preview's track sample), its LiDAR PLY; three storeroom stills, a 2048×1024 EXR 360 (named as panorama and as HDRI) and a coloured scan | plates, camera track + LiDAR import, textures, lighting |

The app was built (`pnpm build`), launched under Xvfb and driven with
Playwright's `_electron` through its own UI: real main process, workers,
bundled ffmpeg, real file system. Dialogs were answered by stubbing
Electron's `dialog` in main; the licence standing was a cached `active`.

## 2. What ran in the app

Open the handoff (project saved beside it) · verify sources (the two shots
with checksums: verified) · plates for all three shots · Roto: include /
exclude strokes on one key frame, Track engine, propagated 28/28 frames
(lowest confidence 0.99), exported PNG + EXR · Key: auto key (green, 76 %
of the frame), 28 frames processed (quality 100 %), exported foreground,
alpha EXR, core and edge · Clean plate: the roto subject removed, a still
in frame 1015, 100 % of the removed area seen in other frames · Comp: the
suggested graph (6 nodes), rendered 28 frames, exported for Nuke · Sky:
built 40 frames, exported · 2D track: a planar surface on the poster,
tracked 40/40 frames at confidence 1.00, following the 3 px/frame pan
exactly; Nuke, AE `.jsx`, AE keyframe text and JSON · Camera track:
auto-track (635 tracks), solve RMS 0.33 px over 48/48 frames, focal
22.73 mm on the VENICE 2 7.6K 16:9 back (32 mm) — the 25.5 mm the room was
rendered with on a 35.9 mm back, exactly; LiDAR PLY imported (14,982
points, m, Z-up); all 14 formats exported · Textures: the three stills,
the 360 and the scan (48,640 points, set to Z-up), one region marked by
dragging its four corners (brick wall, 1.6 × 1.2 m), built at 640 px/m,
placement on the scan accepted (wall facing +Y, 84 %), exported · Lighting:
the HDRI from the handoff, analysed (3 lights), exported Unreal / USD /
Blender / report · every task approved by a named person, each shot
approved, three packages written; 010_020 packaged again (v002); the
camera track reopened after approval and exported again (v002).

Screenshots of every tab were taken from the real window and looked at.

## 3. The packages on disk (`scripts/verify-package-files.py`)

- The eleven §17 folders, `manifest.json`, `manifest_vNNN.json`,
  `prep_report(_vNNN).html` in each shot folder.
- Every file on disk is listed in the manifest and every listed file exists
  with the recorded size and SHA-256: 379 / 289 / 100 files for 010_020 /
  030_010 / 020_010, no problems; every package-relative path the manifest
  names exists.
- Versions: `manifest_v001.json` and `prep_report_v001.html` byte-identical
  after packaging v002; the camera track's v001 folder byte-identical after
  the reopened v002 export.
- Source media: all 123 files on the drive hashed before the run and after —
  identical, and nothing new written on the drive (the project was saved
  outside it).
- The prep reports, the camera-track report and the light-rig report open in
  Chromium with no script errors and no broken images.

## 4. In third-party software

| Output | Tool | Checked | Result |
| --- | --- | --- | --- |
| Camera `.py` | Blender 4.5.3 (bpy) | every frame's world matrix vs the JSON (Y-up → Z-up), lens, sensor, fit, range, fps, resolution, 631 track empties | pass: 1.2e-7 m, 1.0e-7 |
| Camera `.usda` | Blender 4.5.3 USD importer | lens, sensor, position | pass (exact) |
| Camera `.usda` | usd-core 26.08 | upAxis, metersPerUnit, time codes, 48 time samples vs the JSON, focal and apertures in tenths of a unit, every registered UsdValidation validator (26; usd-core 26 has no ComplianceChecker) | pass, no validation errors |
| Camera `.fbx` (ASCII 7.4) | Blender 4.5.3 | import | **refused: Blender reads binary FBX only.** Not a target (Blender has the `.py` and `.usda`); still unchecked in an FBX SDK application |
| Camera `.chan` | Python against the JSON | 48 rows, translate, ZXY rotation, vfov | pass: 5e-7; the eulers rebuild the matrix as Ry·Rx·Rz to 1e-8 (Z applied first); vfov 43.2038° = 2·atan(9 / 22.729) |
| Lighting `_blender.py` | Blender 4.5.3 | light types, positions and aim (scene → Z-up), energy from candela / lux, camera | pass: 5e-7 |
| Lighting `.usda` | usd-core 26.08 | RectLight ×2 + DomeLight as the rig, position, −Z aim, intensity relative to the key, colorTemperature, the camera's focal, the DomeLight texture resolving, UsdValidation | pass |
| Textures OBJ / MTL | Blender 4.5.3 OBJ importer | one mesh per region, UVs 0…1, the PNG resolved on disk and wired to the BSDF, the patch 1.6 × 1.2 m | pass |
| Every EXR (14 sequences) | OpenEXR 3.5.2 (ASWF bindings) | channels and type, data / display window, compression, every frame alike, finite values, premultiplication | pass: plates RGB half ZIP16; roto, key and sky mattes one half channel `Y`; key, sky and comp foregrounds RGBA premultiplied (no colour where α = 0); clean plate, sky plate, texture RGB half; plate values: the chart's 18 % / 90 % / 3 % patches read 0.1804 / 0.9038 / 0.0297 in ACEScg |
| STMaps | OpenEXR 3.5.2 | RGB float, uncompressed, window, the centre pixel's UV | pass |
| `.nk` (comp, camera ×2, 2D track) | offline (`verify-package-nk.py`) | braces, Nuke classes and input counts, the TCL stack, curve syntax, every Read / ReadGeo2 file present | pass. **Not opened in Nuke.** |
| Unreal `_unreal.py` (camera, lights) | Python against a recording stub `unreal` module (`verify-package-unreal.py`) | the scripts run end to end; every `unreal.*` name and method used is one of UE 5.x's; spawned actors (1 CineCameraActor + 631 markers; 2 RectLight + SkyLight + CineCameraActor); 336 keys (48 × 7); keyed locations and rotators reproduce the JSON through Unreal's FRotationMatrix (location 7e-6 cm, axes 1e-8) | pass. **Not run in Unreal.** |

The scripts are in `apps/desktop/scripts/verify-package-*.py`; each says how
to set up its environment.

## 5. Found and fixed

1. **Image sequences numbered in the handoff's frames, with no
   `timecodeIn`, read the wrong files.** `C007C011_0001996.dpx …` with
   frameIn 2000: the range was taken as clip-relative, so plates were
   refused ("the plan needs 2036 frames") and the viewer, roto and key asked
   for `…_0003996.dpx`. `sourceInputFor` now reports the first file's number
   as `clipStart` when the handoff's range is in file numbers (frameIn at or
   after the first file, no timecode), and `clipRange` / `viewerTimeline`
   place the shot by it. A timecode, or a range below the first file number,
   keeps the old reading. Tests: `ffmpeg-args.test.ts`, a real-ffmpeg
   `sequence.test.ts` case comparing plate pixels with the right source files.
2. **The prep report said the plates were PIZ** (the handoff's wish) when
   ffmpeg writes ZIP16, and so did the Plates panel. Both now name the
   compression in the files and what was asked (`exrCompressionWritten`);
   the manifest's `plates.notes` carries how the request was honoured (PIZ →
   ZIP16, missing head handles). Tests: report, domain manifest.
3. **The Deliver tab's "What goes where" promised what packaging does not
   write**: references and source checksums "in" `00_SOURCE_REFERENCE`,
   contact sheets in `08_PREVIEWS`, the report and manifest in
   `09_PROJECT_DATA`, hand-off notes in `10_DELIVERY`. It now says what is
   there.
4. **A 360 named twice in the handoff** (as the panorama and as the HDRI)
   was offered twice in Textures and Lighting; adding both raised "already
   here". One file is now one reference. Tests: texture, lighting.
5. **Texture regions were numbered by the id sequence the references
   share** (the first region of a shot with five references was "Region 6").
   Now by the regions. Test: domain texture.
6. The output folder's path, squeezed beside its buttons in a narrow column,
   wrapped one character per line; it now has its own line. "1 textures" →
   "1 texture".

## 6. Still not verified, and limits

- **Nuke** (comp, camera, CornerPin scripts), **Unreal Engine** (both
  scripts), **Maya, 3ds Max, After Effects, Houdini, Fusion / Resolve,
  Unity** and any **FBX SDK** application: structural and stub checks only.
  Unreal names to confirm on first use: binding the CineCameraComponent with
  `add_possessable(component)` without `set_parent` to the actor's binding;
  `get_binding_id` vs `get_portable_binding_id` across 5.x; the transform
  section's channel order; an `.exr` HDRI imports as a 2D texture, not a
  `TextureCube` (the script warns and leaves the sky light on the captured
  scene).
- **The HDRI is not in the package.** The light rig's USD DomeLight, Unreal
  and Blender scripts name it by a path relative to the package that leads
  back to the drive (`../../../../../../DRIVE/…`); a vendor given only the
  package folder lacks it. Likewise `00_SOURCE_REFERENCE` holds nothing: the
  references and source checksums are listed in the manifest. Whether the
  package should carry copies is a product decision (sizes: LiDAR, 360s).
- The Blender light rig sets the world's colour and strength from the dome
  but does not load the HDRI as an environment texture.
- **LiDAR alignment** was not driven in the app: picking three
  correspondences means clicking points in the 3D view. Import was; the
  alignment, constrained solve and ICP are covered by the camera tests.
- **SAM 2.1** did not run: huggingface.co is blocked here and the model files
  have no pinned checksum, so the app refuses the download (by design). The
  onnxruntime runtime loads in Electron once fetched for linux-x64.
- **Timecode reading.** `clipRange` takes the handoff's `timecodeIn` as the
  timecode of the clip's first frame. The sample handoff gives
  `timecodeIn`/`timecodeOut` equal to `frameIn`/`frameOut`, i.e. the shot's
  in and out — read that way every head handle is "missing" (numbering then
  starts at 1009, as the plates' notes say). VCDIT's meaning must be settled.
- The Sky engine took the chart's 90 % white patch for sky on this synthetic
  rooftop (flagged: 40 problem frames, confidence 0.64); a quality limit of
  the cues on synthetic footage, not a pipeline fault.
- Texture placement needs a rebuild after accepting a placement (the decision
  is part of the settings revision); it keeps the decision.
- Windows and macOS: not run here (paths with drive letters, `\`, the
  macOS sandbox and notarised builds, code signing).
- Real camera originals (ProRes, MXF, ARRIRAW transcodes) and production
  footage: not tried; the media here are synthetic.
