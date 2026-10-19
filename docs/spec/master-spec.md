**Independent-Production VFX Preparation, Automation & Handoff System**

Version 1.0 • September 11, 2026

VCVFX is designed first as a VFX preparation package rather than an
attempt to replace every high-end visual-effects application. Its job is
to take organized production media from VCDIT, understand what each VFX
shot requires, perform or accelerate the repeatable preparation work,
and hand clean, documented, production-ready assets to an independent
artist or professional VFX house.

# 1. Product Positioning and Core Objective

VCVFX is a companion to VCDIT. VCDIT identifies, organizes and
duplicates VFX-designated source shots while preserving the untouched
editorial camera originals. A machine-readable handoff specification
travels with the drive and tells VCVFX what each shot is, where it
belongs, and which prep operations are requested.

The product should make sophisticated VFX preparation practical for
independent productions. Tasks that traditionally consume artist
hours---image-sequence generation, keying, roto, clean plates, tracking,
texture preparation and shot packaging---should be automated where
reliable, with human review and correction rather than blind automation.

The architecture must remain expandable. V1 is a prep system; later
releases can grow toward a broader VFX pipeline and compositor while
retaining export to established finishing applications.

# 2. VCDIT → VCVFX Handoff

At the end of production/data management, the DIT hands off a drive
containing source media, the mirrored VFX folder structure, metadata and
a VCVFX handoff specification. VCVFX reads the specification and builds
a shot queue automatically.

-   Scene-based organization, with setup/take information retained.

-   VFX shots duplicated into a dedicated VFX hierarchy while originals
    remain untouched for editorial.

-   Circle takes/selects retained as metadata and optionally surfaced as
    filters.

-   Per-shot VFX instructions entered from the VFX supervisor/production
    notes.

-   Requested prep operations encoded as structured tasks: sequence
    conversion, key, roto, clean plate, 2D track, camera track, texture
    extraction, sky/background work, etc.

-   Status, source path, output path, frame range, handles, camera/lens
    metadata, color information and notes carried into VCVFX.

# 3. DIT / VFX Prep Shot List

VCVFX must provide both an interactive queue and a printable shot list.
The printable version is important on independent productions because
the DIT, VFX supervisor or prep artist can physically review every shot
and confirm what has or has not been completed.

  ------------------------------------------------------------------------------------
  Shot       Scene/Setup   Frames       Required   Notes         Status     Approval
                                        Prep                                
  ---------- ------------- ------------ ---------- ------------- ---------- ----------
  010_020    12A / Setup 3 1001--1128   DPX +      Actor exits   In Prep    ---
                                        Key + Roto screen                   

  010_030    12A / Setup 4 1001--1082   2D Track   Monitor       Ready      Approved
                                                   replacement              
  ------------------------------------------------------------------------------------

# 4. Ingest and Image-Sequence Generation

The first VCVFX processing stage takes the designated VFX footage and
generates the image-sequence format required by the production. The
original media is never overwritten.

-   Support DPX, TIFF and other production-approved image-sequence
    formats; EXR should be supported as a modern high-dynamic-range
    option.

-   Preserve frame numbering and allow configurable start frame (for
    example, 1001).

-   Optional head/tail handles around the editorial range.

-   Carry source timecode, reel/clip name, scene, take, camera and lens
    metadata into manifests/sidecars.

-   Color-management settings must be explicit and non-destructive; do
    not silently bake display looks into VFX plates.

-   Checksum source and generated deliverables and record validation
    results.

# 5. AI-Assisted Rotoscoping -- Paint-to-Roto

The roto module replaces spline-first operation with a paint-guided
subject-selection workflow. The user indicates what belongs to the matte
by painting over/around the desired subject or edge. Computer vision
interprets the marked subject, generates the matte, propagates it
through the shot, and presents the result for review.

## 5.1 Part-Based Roto

-   Create an overall subject matte first.

-   Allow interior/component regions to be painted and treated as
    separate tracked roto parts---e.g., torso, arm, hand, hair, prop,
    foreground object.

-   Each part may have independent matte refinement, feathering, motion
    behavior and correction.

-   Maintain a hierarchy so component mattes can be combined into the
    final subject matte.

## 5.2 Propagation and Approval

-   Propagate the approved selection forward and backward across the
    image sequence.

-   Generate confidence/error indicators and surface frames most likely
    to need correction.

-   Provide a contact-sheet or timeline review showing representative
    frames across the entire sequence.

-   User approves, corrects with the paint tool, or marks a new
    reference/key frame; corrections re-propagate locally.

-   Final output can include alpha/matte image sequences plus project
    metadata for downstream use.

# 6. Green-Screen / Blue-Screen Keying

The keying module supports both green and blue screens. The initial key
is automated, but the system must assume real production plates are
imperfect and therefore combine chroma keying with paint-guided roto.

-   Automatic screen-color detection with manual green/blue selection
    and sampling.

-   Core matte, edge matte and garbage/holdout matte support.

-   Hybrid key + roto: areas outside the screen, subjects exiting the
    screen, occlusions or failed key regions can be repaired using the
    same paint-to-roto workflow.

-   Edge refinement for hair, motion blur and semi-transparent detail
    where feasible.

-   Matte review modes: source, alpha, premultiplied result, edge view
    and problem-frame review.

# 7. Despill, Background Matching and Light Wrap

Keying prep must include intelligent despill. A background plate---or
even a representative frame from the intended background---can be
supplied so VCVFX removes green/blue contamination in a way that is
compatible with the destination environment rather than applying a
generic neutral despill.

-   Analyze keyed foreground and supplied background reference.

-   Remove chroma contamination while protecting legitimate foreground
    colors.

-   Estimate background color/lighting influence and create a suggested
    foreground color match.

-   Generate adjustable light-wrap treatment based on background
    luminance/color near the subject edge.

-   Allow prep-only output: despilled foreground + alpha + suggested
    match metadata, without forcing a final composite.

# 8. Clean Plate Generation / Object Removal Prep

For shots in which a moving subject must be removed from the background,
the artist identifies the subject with the paint-to-roto tool. VCVFX
propagates the matte and reconstructs the missing background by
analyzing unobstructed portions of other frames.

-   Temporal clean-plate reconstruction from neighboring frames.

-   Camera-motion-aware alignment before borrowing background pixels.

-   Patch/reference-frame selection when the automated reconstruction
    needs guidance.

-   Output clean plate as a still when sufficient, or a
    stabilized/moving clean-plate sequence when necessary.

-   Show unresolved/low-confidence regions for human paint or patch
    correction.

# 9. 2D Tracking and Replacement Prep

VCVFX includes automated 2D/planar tracking for screens, signs, posters,
labels and other surface replacements. The objective is to hand the
compositor an already isolated and tracked target rather than requiring
tracking to begin from scratch.

-   Point and planar tracking modes with four-corner/corner-pin output.

-   User defines the surface; system tracks translation, rotation,
    scale, perspective and occlusion where possible.

-   Drop-in preview image/video to test the track immediately.

-   Mask/roto integration for objects passing in front of the
    replacement surface.

-   Export track data and/or a precomp/package suitable for downstream
    compositing.

# 10. Camera Tracking / Matchmove

The camera-tracking module combines automated solve methods with known
camera profiles, calibration targets and survey/LiDAR geometry. The goal
is to remove as much guesswork as possible from film-back, lens and
scale setup.

## 10.1 Camera and Lens Profiles

-   Built-in camera database containing sensor/film-back dimensions and
    relevant recording modes.

-   Lens metadata ingestion when available; manual lens entry when not.

-   Calibration workflow using printable checkerboard/calibration
    targets.

-   Store lens-distortion profiles by camera/lens/focal-length
    combination when practical.

## 10.2 LiDAR / Survey-Assisted Solve

-   Import LiDAR point clouds/meshes and survey control/reference
    points.

-   User can pick recognizable features in the footage and corresponding
    features in the LiDAR/survey data.

-   Use those correspondences to constrain camera position, orientation,
    scale and solve accuracy.

-   Visual residual/error display and confidence reporting.

-   Coordinate-system/units controls so survey data can be transformed
    into the VFX scene coordinate system.

## 10.3 Camera Track Export

Camera solves should export to major downstream packages, including
Adobe After Effects, Foundry Nuke, Autodesk Maya, Blender and Autodesk
3ds Max. Where a direct native interchange is impractical, support
industry interchange such as FBX/Alembic plus documented camera/lens
metadata.

# 11. Background Removal and Sky Replacement

-   AI-assisted foreground/background isolation for stills and footage.

-   For footage, process the selection consistently across the image
    sequence rather than treating every frame as unrelated.

-   Prompt/paint/reference-assisted correction when the automated mask
    is wrong.

-   Sky isolation/replacement prep with edge and foreground-occlusion
    handling.

-   Export matte, isolated foreground, background/sky plate and sequence
    manifests separately so downstream artists retain control.

# 12. Texture Extraction and Set Reconstruction Prep

VCVFX should extract usable textures from live-action photography. A
production can LiDAR-scan a set, capture high-resolution photographs and
a 360° panorama, then use VCVFX to derive seamless textures and assist
in mapping those textures back onto the scanned environment.

-   Ingest high-resolution reference photos plus optional panorama and
    LiDAR mesh/point cloud.

-   Correct perspective/lighting variation as needed for texture
    extraction.

-   Generate seamless/tileable texture regions from photographed
    surfaces.

-   Use panorama/spatial context to suggest where source photographs
    belong on scanned geometry.

-   Export texture maps and mapping/reference information for downstream
    3D work.

# 13. AI Lighting and Lens Analysis

A reference-image analysis tool estimates how a shot was photographed so
the look can be reconstructed in a 3D environment such as Unreal Engine.
Results are estimates and should be presented with confidence ranges
rather than false precision.

-   Estimate key, fill, back/rim, practical and background light
    directions/positions.

-   Identify likely motivated sources and visible practicals.

-   Estimate relative intensity, softness, color temperature/color and
    approximate source size.

-   Estimate lens/focal-length and camera characteristics when image
    evidence permits.

-   Generate an editable scene/light rig that can be exported or
    translated for Unreal Engine.

-   Let the artist reposition and tune all inferred lights before
    export.

# 14. Compositor / Node Pipeline

VCVFX should include a lightweight node-based compositor sufficient to
inspect and combine prep operations. Existing VCVFX nodes can form the
initial library. It is not required to match Nuke in V1; the
compositor\'s purpose is to connect prep stages, preview results and
package work for finishing.

-   Read/write image sequences and plates.

-   Key, roto/matte, despill, transform, track, merge, color adjustment
    and utility nodes.

-   Non-destructive parameter changes and cached previews.

-   Node graph saved with the shot package.

-   Export/translation path toward Nuke where technically feasible;
    otherwise export all assets, mattes, tracks and a machine-readable
    graph manifest.

# 15. Shot Workflow and Approval Model

1.  **Ingest:** Read VCDIT handoff spec, verify files/checksums and
    build the VFX shot queue.

2.  **Normalize:** Create requested DPX/TIFF/EXR sequences and preserve
    metadata/color intent.

3.  **Prep:** Run only the operations assigned to the shot.

4.  **Review:** Surface representative frames and low-confidence/problem
    frames.

5.  **Correct:** Use paint-guided corrections, masks, track adjustments
    or reference frames.

6.  **Approve:** Record approval per task and per shot; never infer
    final approval merely because processing completed.

7.  **Package:** Write deliverables, reports, checksums and downstream
    interchange files.

# 16. Suggested Shot Status Model

-   Not Started

-   Ready for Prep

-   Processing

-   Needs Review

-   Needs Correction

-   Prep Approved

-   Packaged

-   Delivered

# 17. Output Package Structure

PROJECT_VFX/\
SCENE_012/\
SHOT_012A_030/\
00_SOURCE_REFERENCE/\
01_PLATES/\
02_MATTES_ROTO/\
03_KEYS/\
04_CLEAN_PLATES/\
05_TRACKS_2D/\
06_CAMERA_TRACK/\
07_TEXTURES_REFERENCES/\
08_PREVIEWS/\
09_PROJECT_DATA/\
10_DELIVERY/\
manifest.json\
prep_report.pdf-or-printable-report

# 18. Metadata / Handoff Specification

The VCDIT/VCVFX handoff file should be human-readable and
machine-readable (JSON is recommended). Minimum fields:

-   Project, unit/day, scene, setup, shot/VFX shot ID, camera roll/clip,
    take and source path.

-   Frame range, timecode, handles, frame rate and resolution.

-   Camera body, sensor mode/film back, lens, focal length, focus/iris
    if available.

-   Color space/gamma/log encoding and intended working/display
    transforms.

-   Requested output sequence type and bit depth.

-   Required VFX prep tasks and VFX supervisor notes.

-   LiDAR/survey/reference-photo/background-plate relationships.

-   Status, operator, processing version, approval identity/date and
    checksum records.

# 19. Non-Destructive and Safety Requirements

-   Never alter or delete original camera media.

-   Every automated operation must be reproducible from source +
    settings.

-   Version outputs rather than silently overwriting approved work.

-   Display confidence/problem areas for AI-derived mattes, clean plates
    and analysis.

-   Keep AI suggestions editable; final approval remains a human
    production decision.

-   Maintain logs of operations, model/version where applicable,
    parameters and approvals.

-   Support local processing where practical because production footage
    may be confidential and extremely large.

# 20. MVP Development Priority

8.  VCDIT handoff parser + shot queue + printable VFX prep list.

9.  Image-sequence generator and metadata/color-safe plate packaging.

10. Paint-to-roto with propagation, component mattes and approval
    review.

11. Green/blue key + hybrid roto + despill/background-reference
    matching.

12. Clean-plate generation.

13. 2D/planar tracking and replacement preview/export.

14. Camera database + camera tracking + LiDAR/survey constraints +
    major-package export.

15. Background/sky isolation.

16. Texture extraction/seamless texture prep.

17. Lightweight node compositor and Nuke-oriented handoff.

18. Lighting/lens reference analysis and Unreal-oriented scene export.

# 21. Future Expansion

The long-term architecture should allow VCVFX to grow from a preparation
system into a more complete VFX pipeline without breaking the VCDIT
handoff model. Future modules can add deeper compositing, paint,
advanced 3D integration, render management, review/dailies,
asset/version management and facility collaboration. The guiding
principle remains the same: production data should arrive organized,
shots should be prepared once, and every downstream artist should
inherit useful work rather than rebuilding it.

# 22. Definition of Success

A successful VCVFX handoff means a small production can give an artist
or VFX facility a drive/project package in which every VFX shot is
identified, converted into the correct working plates, documented,
and---where requested---already keyed, rotoscoped, clean-plated or
tracked. The professional facility remains free to redo any creative or
technical operation, but it starts from organized, validated prep
instead of raw, ambiguous camera media.
