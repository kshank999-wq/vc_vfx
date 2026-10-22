# Addendum 12 — Texture extraction and set reconstruction prep

Master spec §12 asks VC VFX to extract usable textures from live-action
photography: a production LiDAR-scans a set, takes high-resolution
photographs and a 360° panorama, and VC VFX derives seamless textures and
helps map them back onto the scanned environment — ingest the photos with an
optional panorama and scan, correct perspective and lighting, make tileable
regions, use the panorama and the scan to suggest where each photograph
belongs, and export texture maps with mapping and reference information for
downstream 3D work. §15, §17 and §19 apply as everywhere: review and named
human approval, versioned outputs (here in `07_TEXTURES_REFERENCES`),
reproducibility from source + settings, a log of every change, local
processing, never a write near the source media — and here the photographs,
the panorama and the scan are source media too. This addendum records what
was built, how, what is measured and what is not.

The prep task `texture_extraction` (*Texture extraction*, MVP priority 16)
is now `available: true`.

## 1. What the artist does (the Textures tab)

The Textures tab sits after Sky & BG and before Camera Track (⌘/Ctrl+7). With
ten tabs, the shortcuts are ⌘/Ctrl+1…9 and **0** for the tenth (Deliver;
addendum 08). Six numbered steps on the left, the viewer in the centre, the
numbers on the right.

1. **Add references** — *Photos…*, *Panorama…*, *Scan…* (open dialogs, read
   only), or the references the handoff names for the shot (*3 photos from
   the handoff*, *Scan from the handoff*); in the browser preview, *Use the
   sample set*. Each reference is listed with its kind, size, lens and, when
   it is missing from the drive or its size changed since it was added, a
   warning. Folded under *Lens, colour, scan and panorama*: the selected
   photo's focal length, film back and k1 (from its EXIF and the project's
   lens profile when there is one), how it is read (sRGB for a JPEG, a TIFF or
   a PNG; linear Rec.709 for an EXR or HDR, changeable to any encoding the
   colour module knows), the panorama's heading (empty: found from the scan),
   the scan's units and up axis.
2. **Mark a region** — *Drag a new region on <photo>*: drag a box round the
   surface, then drag its four corners onto the surface's corners (top-left,
   top-right, bottom-right, bottom-left; a crossing or degenerate quadrilateral
   is refused). The regions are listed (on/off, remove); the selected one has
   its name and its **real size** (top edge × left edge, in m, cm, mm, ft or in).
3. **Correct and build** — per region: *Take out the lens distortion* (needs
   the photo's lens), *Square it up (rectify)*, *Flatten the light* (strength)
   and its *Shading scale*, *One exposure across the surface*, the output as a
   long edge in pixels or a texel density (texels per metre; needs the real
   size). *Build textures* builds every region (a job with progress and
   Cancel).
4. **Make seamless** — *No / Across / Across and down*, the overlap; the seam
   score after the build.
5. **Placement on the scan** — for the photo shown: the suggestion (the scan
   plane, the panorama direction, the confidence, whether it is decided);
   *Accept*, *Reject*, *Undo*, or *Put <photo> on* a plane of your choice; for
   the region: *goes on* (the suggestion, or a plane). *Next problem ▸*,
   *Looks right*, *Flag*. Every decision is logged and is part of the
   settings (a new revision): the export uses exactly what was decided.
6. **Export textures vNNN** — the texture maps, masks, the mapping file and
   the mesh into `07_TEXTURES_REFERENCES`. Approval is the per-task approval in
   Details, and needs an export of that version.

Viewer: **Photo** (the region quads, the selected one with corner handles —
drag a corner to move it; click inside another quad to select it), **Rectified**,
**Delit** (with an **A/B wipe** against the rectified original), **Tiled 3×3**
(the tile repeated, or the texture repeated as it is when it was not made to
tile, said so), **Panorama** (each photo's suggested direction pinned and
named, decided ones green, the shown photo amber), **Scan** (the point-cloud
view of the camera tracker, the region's plane highlighted, the patches and
where the panorama was marked). Under the picture, a strip of the photos
(regions and placement state). Textures are shown through a plain sRGB view —
what a 3D package's viewport shows and what the PNG holds; the region outside
the photo is dimmed. Right panel: regions built, texel density (median),
seam score (worst), light left (worst, stops), placement (mean confidence),
problems; the region's texture size and density, the photo's own density
(and the upsampling), light before → after and detail kept, seams, the
photo's sharpness, clipping and glints, exposure gain, aspect and where it
came from, its surface and confidence and the problem in words; the photo's
placement note and decision; version, export, settings revision; supervisor
notes; the task card and the shot's history.

## 2. The model (`packages/domain/src/texture.ts`, `texture-schema.ts`)

A shot carries `texture`, null until started: a document with

- **references** — kind (`photo` | `panorama` | `scan`), name, path
  (absolute on disk, handoff-relative, or the sample's name), where it came
  from (`disk` | `handoff` | `sample`), format, **SHA-256 and size** as read,
  picture size or point count, colour encoding, the photo's camera (body,
  lens, focal mm, film back mm, Brown–Conrady distortion, lens profile id),
  the scan's units and up axis, the panorama's heading and position (each
  null: found by the build), who added it and when;
- **regions** — the photo, four corners in photo pixels, the real size, the
  artist's plane (or null: the suggestion), the settings (undistort, rectify,
  delight strength and radius, exposure match, tile none/x/xy and overlap,
  output resolution or density), on/off;
- **planes** (from the newest build) — normal, offset, centroid, in-plane
  axes, extent, inliers, RMS, a label by which way it faces;
- **placements** — per photo, the build's suggestion (panorama direction,
  plane, hit point, confidence, score, method and a note in words) and the
  artist's decision (`pending` | `accepted` | `rejected` | `edited` with their
  own direction and plane), by whom and when;
- **panoramaPose** — where the build put the panorama and which way it faced,
  and whether each came from the artist, the scan or a default;
- **records** — per built region: confidence and the measurements of §5,
  status, the problem in words, review and note;
- the last 200 **runs**, the **exports**, the working width (1024: the review
  build's longest texture edge) and a **settings revision** bumped by every
  change that affects the outputs (references, regions, settings, placement
  decisions).

Textures, masks and meshes are never in the project; neither are the
references — only what identifies them.

Mutations — `addTextureReference`, `setTextureReference`,
`removeTextureReference` (its regions and placement go with it; the file is
untouched), `addTextureRegion`, `updateTextureRegion`, `removeTextureRegion`,
`setTextureWorkingWidth`, `decideTexturePlacement`, `recordTextureRun`,
`flagTextureRegion`, `markTextureRegionReviewed`, `recordTextureExport` — are
pure, logged (`texture.*`: who, when and what in words — a reference's path,
size and checksum prefix, a region's corners and size, a setting's old and new
value, a decision with the suggestion it was about), and refused while the
shot is past prep, the task is missing, or the textures are approved
(“Textures v001 are approved. Reopen them …”). A change moves the task pending
→ processing or needs_review → needs_correction; a build or an export moves it
to needs_review; nothing approves. A texel density needs the real size; a
region needs a photo; a placement can only be accepted or rejected once there
is a suggestion. `recordTextureRun` refuses a build made with an older
settings revision, and keeps the artist's decisions — an accepted suggestion
stays accepted only while the build still suggests the same plane.
`approveTask('texture_extraction')` needs an export of the task's version;
reopening bumps the version, so the next export is `v002` beside the approved
`v001`. Queries: `textureConfidence`, `textureProblemReason`, `textureReview`
(problems worst first, placements still pending), `nextTextureProblem`,
`textureSummary`, `textureBuildProblem`, `texturePlacementOf` (the placement
that holds), `textureRegionPlane`, `textureSizeMetres`, `textureUpsample`,
`textureNames`, `textureSettings`, `textureMetadata` (the mapping file) and
`textureManifest` (the package manifest's `texture` section).

**Project format 7.** A version 6 (or 5, 4, 3) project opens with every
shot's `texture` null and is saved as 7; an older VC VFX refuses a 7.

The browser preview needed a shot with a set: the sample handoff gained a
fifth shot, `040_010` (a storeroom, 72 frames with 8-frame handles), whose
task is texture extraction and whose references name three stills, a 360°
EXR and an E57 scan.

## 3. The engine (`apps/desktop/src/shared/texture/`)

Pure TypeScript on typed arrays, in linear light (ACEScg; stills decoded from
sRGB, linear files converted from their primaries); the same code runs in
the desktop's worker thread and in the browser preview. It is assembled from
what the app already has: the camera tracker's lens model, homography DLT,
point-cloud readers, voxel downsampling, linear algebra and point-cloud view;
the key's linear-light decode and luminance; roto's filters; the clean
plate's worker runner.

### 3.1 Rectification (`rectify.ts`)

The corners are taken to the ideal pinhole picture when the lens is known
(Brown–Conrady inverted by Newton steps), the homography from the texture's
rectangle to that quadrilateral solved by normalised DLT, and every texel is
the photo seen through it: texture pixel → H → undistorted photo pixel → the
lens → the photo pixel, sampled with Keys' cubic (a = −½, clamped at zero)
and averaged over up to 4 × 4 sub-samples wherever the photo has more than
one pixel per texel (a texture smaller than the photo is filtered, not
aliased). The texture's aspect comes from the real size; else, once the
region is placed, the scan; else the focal length — the rectangle's aspect
from its vanishing points (Zhang & He, “Whiteboard scanning”); else the
corners' mean opposite edges. Measured with it: the photo's own texel density
where the region is sampled most sparsely (the Jacobian's smaller singular
value over a 5 × 5 grid, times the output density), and the share of the
texture that came from inside the photo. Without *rectify*, the corners'
bounding box is resampled as it is.

### 3.2 Flattening the light (`delight.ts`)

A photographed surface is albedo × irradiance; light from a set's lamps
changes slowly across a surface, albedo carries the detail. The shading is the
large-scale geometric mean of the luminance — a Gaussian of log luminance at
*radius* × the short side (masked, so texels outside the photo do not count;
large scales on a reduced grid) — normalised to its median and divided out
with *strength*. Division keeps colour and every detail finer than the radius;
what it also takes is the surface's own colour variation at that scale and
above, which is why the radius and strength are the artist's (defaults 0.2
and 1). Measured: the large-scale light variation left — the 5–95 % spread of
log₂ luminance smoothed at a fixed fifth of the short side, in stops, before
and after — and the detail kept (high-pass energy after / before).

**One exposure across a surface:** a quick pass rectifies and delights every
region small (128 px), takes its median luminance, and regions on the same
plane (the artist's or the suggestion) are brought to the geometric mean of
theirs before the full pass.

### 3.3 Seamless tiling (`seamless.ts`)

To tile across x, the texture's ends overlap by *overlap* of its width; the
seam is the minimum-cost connected path through their difference (perceptual
colour difference plus a gradient term, kept away from the overlap's edges)
— the optimal monotone cut of image quilting, by dynamic programming; for a
texture that also tiles in y the path is made periodic. Left of the seam the
texels come from the right end, right of it from the left end, feathered over
about one photo pixel; the tile is the texture minus the overlap, so its
right edge runs straight on into its left edge (they were neighbours in the
photo). In the gradient domain, the two ends' low-frequency difference along
the seam is not switched at the cut but spread over the whole overlap as the
1-D Poisson solution between its two edges (a ramp with no change at either),
smoothed along the seam. x and y: x, then the same down the result's columns.
Measured: the **seam score** — the step across the cut (over the feather) and
across the tile's wrap, each against the texture's own steps over the same
distance; 1 is invisible; the worse of the two.

### 3.4 Placement (`planes.ts`, `panorama.ts`, `placement.ts`)

1. **The scan's planes** — sequential RANSAC on the scan voxel-downsampled
   to about 60 000 points (400 proposals of three points, inliers within 2 cm,
   least-squares refit to the inliers twice, inliers removed, until what is
   left is under 3 % of the scan), normals facing the scan's middle, u
   horizontal on a wall, the extent from the inliers' 1–99 % spread, a label
   (floor, ceiling, wall facing ±X/±Y/±Z in the scan's own axes).
2. **The panorama in the scan** — its heading, when not given, from a
   coloured scan: the points seen from the panorama's position are splatted
   into an equirectangular grey (z-buffered) and correlated with the panorama
   over every heading (refined to a parabola's peak). Its **position**, when
   not given: the position that makes the scan look most like the panorama —
   a grid over the room at 1.2, 1.5 and 1.8 m above the floor plane, then
   coordinate steps at 256 and 1024 px wide with the heading searched near the
   current one.
3. **Each region on the scan** — a photo and the panorama see a surface from
   different places, so their pictures differ by parallax; but a plane mapped
   onto itself looks the same from anywhere. So every plane gets a **plane
   map**: the panorama projected onto it (for each point of the plane, the
   panorama pixel in its direction where that ray meets this plane first;
   grazing and hidden parts left out), at about the panorama's own texels per
   metre. The region, rectified from its photo at the same density, is found
   in the maps by normalised cross-correlation of perceptual luminance minus
   its local mean (with a quarter of the local mean kept when the real size is
   known — the light across a surface is the same for both and places it
   roughly): coarse (about 28 texels across) over every plane, every quarter
   turn on a floor or ceiling; then texel by texel round the best few overall
   and the best two on every plane. Without a real size, the photo's direction
   from the panorama (below) says roughly which plane and how big, and a
   range of sizes round that is searched there.
4. **What is suggested** — per region: the plane, the planar patch (its
   corners in scan coordinates, at the real size) and a confidence (the
   correlation, how far it stands above the best on another plane, and above
   the best elsewhere on this plane — a brick wall half a region along looks
   much like itself). Per photo: the panorama direction of its best-placed
   region and that plane, with a note in words. The artist's plane for a
   region, or their placement for a photo, wins; a rejected photo's regions
   get no suggested plane.
5. **Direction matching** (`matchToPanorama`) — used for a region without a
   real size and when there is a panorama but no scan: perspective views of
   the panorama (a pyramid level matched to the view's pixel size, so a small
   view is not aliased) compared with the photo, undistorted, by NCC of
   normalised luminance over the whole sphere at 32 px, then of luminance and
   detail together at 80 px round the best few, with roll and, when the lens
   is unknown, the field of view. Exact for a photo taken where the panorama
   was; rough under parallax, and its suggestion says so.

### 3.5 Problems (`problems.ts`)

Measured on the photo where the region is (resampling would hide them):
**sharpness** — mean |g − G₁(g)| over mean |G₁(g) − G₂.₅(g)| on perceptual
luminance inside the region (shrunk by 8 px), mapped so a crisp photo of a
textured surface reads 1; **clipped** highlights — a channel at the picture's
white (1 for a display-encoded still; the plateau at the maximum of a linear
one); and on the delit texture, **specular glints** — over 2.2 × the local
brightness (glints held down when measuring it), over 1.6 × the surface's own
brightest material (97th percentile: mortar, grout) and nearly colourless.

## 4. Main process (`apps/desktop/src/main/texture/`)

`api.ts` (no Electron; tested against a temporary folder with the real
ffmpeg): the session (the task, ffmpeg, the handoff's references and whether
they are on the drive, the recorded references' status); **ingest** —
`sha256File` streams each file read-only, ffmpeg's banner gives a picture's
size, the first 256 KB its EXIF (`exif.ts`: make, model, lens, focal and
35 mm-equivalent focal, so the film back follows), the project's lens profile
for that lens and focal its distortion; a scan is parsed for its point count;
camera raw stills are refused (“convert it to TIFF or EXR first”); the
renderer records each result with `addTextureReference`. The **build** and
**export** run in a worker thread (`worker.ts`, `service.ts` on the shared
worker-job runner, `texture-worker.js` an entry of the main build) with
progress and Cancel; `io.ts` reads a picture through ffmpeg as float code
values (no seek: a seek can skip a still's only frame), decodes it with the
colour module to ACEScg, at most 4096 px for the review build and at full
size for the export; scans through the camera tracker's readers. The review
build's textures (8-bit sRGB, at most 1024 wide, with their masks) and the
scan view (at most 150 000 points, each tagged with its plane, the patches,
the panorama) go into a review cache per project, shot, task version and
settings revision (`cache.ts`, `userData/Texture Cache`), never beside the
references and never in the package. `ipc-texture.ts` registers the channels
with the clean plate's rules: looking (the session, a picture, the scan) is
allowed read-only; choosing, ingesting, building and exporting need a
licence; every argument is validated by zod and the project re-parsed.

## 5. Confidence

A region's confidence (`textureConfidence`) starts at 1 and is lowered by
softness (below 0.5 sharpness), clipping (from 0.1 %), glints (from 0.2 %),
light left (from 0.1 stops), a visible seam (from 1.2), upsampling (texels
per photo pixel above 1) and texture outside the photo. A region is a
problem (`textureProblemReason`, in words) below 0.6, or when the photo is
soft (sharpness < 0.3), clipped (> 0.5 %), glinting (> 1 %), upsampled by more
than 1.25 (“too low a texel density in the photo: 124 px/m for 200 px/m”),
when light still varies more than 0.25 stops, its tile's seams show (> 1.6),
more than 2 % is outside the photo, or — with a panorama — no surface or only
an uncertain one (< 0.4) was found for it.

## 6. Export

`07_TEXTURES_REFERENCES/<shot>_tex_vNNN/`:

| File | What |
| --- | --- |
| `<shot>_tex_<region>_vNNN.png` | the texture, 16-bit sRGB |
| `<shot>_tex_<region>_vNNN.exr` | the same, RGB half-float, scene-linear ACEScg, no look |
| `<shot>_tex_<region>_vNNN_orig.png` | before delighting (rectified, exposure matched), when delit |
| `<shot>_tex_<region>_vNNN_tile3x3.png` | the tile three by three (each at most 1024 wide), when made to tile |
| `<shot>_tex_<region>_vNNN_mask.png` | white where the texture came from inside the photo |
| `<shot>_tex_vNNN.json` | the mapping: every reference with its checksum; the planes; the panorama's pose; every placement suggestion and decision; per region its source photo and corners, real size, settings, the homography photo → texture and whether undistorted, the lens, the texture's size and texel density, its surface (plane, normal, offset, chosen by the artist or suggested), its panorama direction, its patch in scan coordinates, its files, confidence, measurements, status and problem; the summary, the runs of this version, the approval |
| `<shot>_tex_vNNN.obj` / `.mtl` | the planar patches with UVs 0–1 across each texture (v up), one object and material per region, `map_Kd` the PNG, in the scan's coordinates and units |
| `README.txt` | what is here and how it was made |

Made again from source + settings at each region's own output size from the
photos at full resolution. An approved version on disk is never rewritten
(refused before the worker starts, and again by the worker); an unapproved
one has only its own files cleared and written again. The output root is
refused inside any folder holding camera media **or a reference**. The
record (`recordTextureExport`) lists every texture, the mapping and the mesh;
the package manifest's `texture` section points at them.

## 7. §19 as it applies here

- **Source media untouched** — references are opened read-only (hashing,
  ffmpeg, the scan readers); the test checks every file's SHA-256 and mtime
  after ingest, build and two exports.
- **Reproducible** — the mapping file carries every setting, every decision,
  every reference's checksum; the export recomputes from them.
- **Versioned** — `<shot>_tex_vNNN`, never overwritten once approved.
- **Confidence and problems shown** — per region, in words, on the steps and
  in the mapping file.
- **AI suggestions editable** — placement is a suggestion with a confidence;
  accept, reject, or put it elsewhere, all logged.
- **Processing never approves** — a build or an export puts the task up for
  review; approval is the named per-task act, then per shot.
- **Logged** — every reference, region, setting, decision, build and export.
- **Local** — nothing leaves the machine.

## 8. Tests and what they measure

`packages/domain/src/__tests__/texture.test.ts` (8): references, regions,
corner checks, settings, placement decisions, builds, problems and confidence,
approval and versions, names, the mapping and the manifest, project format 7
(formats 3–6 open). `apps/desktop/src/shared/__tests__/texture-engine.test.ts`
(11) on the synthetic storeroom (`synthetic.ts`: procedural brick, plaster,
plank and tile albedo with millimetre detail, two lamps, photos ray-cast with
perspective, Brown–Conrady distortion, exposure and clipping, an
equirectangular panorama, a coloured scan Y- or Z-up — every texel's truth
known). `apps/desktop/src/main/__tests__/texture.test.ts`: JPEG stills, a
half-float EXR panorama and an ASCII PLY on a temporary drive through ingest,
the worker build, the review pictures and scan, two versioned exports read
back with ffprobe and the OBJ reader, approval, and the references
unchanged. `apps/desktop/src/renderer/__tests__/texture.test.tsx`: the
workspace with the preview's engine (the sample set, its regions, a size
edit, tiling, a build, placement accept / reject / undo, a plane by hand,
the delit view, export the desktop's) and the viewer's compositing.

Measured (the tests print these):

| What | Result |
| --- | --- |
| Rectification of a 1.6 × 1.2 m brick region from a 960 × 720 still with k1 −0.08, at 200 px/m (320 × 240) | 2.55 % RMS against the lit truth (both low-passed σ 1 texel); misregistration 0.023 texel; without undistortion 12.2 % |
| Aspect from the focal length alone (no real size) | 1.3333 for 1.3333 |
| Light across the region → after delighting (the albedo's own) | brick 0.99 → 0.17 stops (0.10); plaster 0.90 → 0.13 (0.02); floor 0.42 → 0.07 (0.08); detail kept 1.000–1.001 |
| Correlation of the texture's detail with the albedo, before → after delighting | brick 0.744 → 0.964; floor 0.750 → 0.962; plaster 0.113 → 0.567 (its albedo is low-contrast detail at the photo's resolution limit) |
| Two photos of one wall, one at 0.55 × the exposure | measured 0.546; matched to 1.004 |
| Seamless tile x+y, 320 × 240, 20 % overlap | seam score 0.84; wrap steps 0.51 (x) and 0.20 (y) of the texture's own; the same texture repeated as it is 7.7 (15.2 not delit) |
| Problem flags | sharpness 1.00 → 0.28 for a σ 2.5 px blur; clipping 0 % → 37 % at 5 × exposure; glints 0.00 % → 2.00 % for spots covering 2.00 % |
| Scan planes (Y- and Z-up) | all 6 surfaces, RMS < 2 mm, labels right |
| A photo taken where the panorama was, matched to its direction | yaw within 0.13°, pitch within 0.12° (NCC 0.93–0.97) |
| The panorama's pose from a coloured scan (2048 panorama, 48 640 points) | 2.9 cm from where it was, heading 24.72° for 25°, 6.3 s |
| End to end: 3 stills 800 × 600 from 0.6–1.2 m away from the panorama, a 2048 panorama, 48 640 scan points, the panorama's position surveyed | every region on the right plane: 1.3, 1.6 and 0.1 cm from the truth, panorama directions within 0.32°, heading 25.27°; seams 0.98–1.10, light left 0.08–0.17 stops; 7.9 s |
| The same with the panorama's position found from the scan | regions 4.0 and 5.3 cm from the truth (the pose's own error carried through) |

## 9. The browser preview

`renderer/texture-preview.ts` builds the sample shot's set in the page:
three stills 960 × 720 (a brick wall with barrel distortion, a plaster wall
under-exposed, the tiled floor), a 2048 panorama and a scan of the room
(5 cm, Z-up, coloured), and runs the same engine for the build (textures at
most 768 px): planes, the panorama's heading from the scan (its position is
given, as surveyed — finding it adds seconds the page should not spend),
rectification, delighting, exposure, tiling, placement. *Mark the sample's
three regions* marks them with their measured sizes at 200 px/m — the floor's
photo has only about 124 px/m there, and is flagged as upsampled. Nothing is
written; exporting says it is the desktop app's.

## 10. Decisions

- **Planes, not meshes.** A scan becomes its dominant planes; textures go
  back as planar patches. Walls, floors and ceilings are what set textures are
  for; curved surfaces and props are out of scope here.
- **Placement by plane maps, not by direction.** Matching a photo's direction
  against the panorama fails under parallax (a photo of a wall taken a metre
  from where the panorama was points elsewhere); a surface mapped onto its own
  plane does not care where it was seen from. Direction matching stays for a
  region without a real size and for a panorama without a scan, and says how
  rough it is.
- **Real size first.** A measured size makes the aspect exact, fixes the
  search to one scale, and gives the texel density; without it the aspect
  comes from the lens and the placement is a range-of-sizes search round the
  photo's direction. The tab says so.
- **Delighting divides out the large scale.** Simple, reproducible, keeps
  every detail finer than the radius; it cannot tell a surface that really
  gets darker from one that is lit less, hence the strength and radius.
- **Decisions are settings.** Accepting, rejecting or placing a photo bumps
  the revision, so what is exported is exactly what was decided, and the
  mapping file records it.
- **Textures in ACEScg.** The EXR is scene-linear ACEScg like every other
  linear output; the PNG is sRGB because that is what texture slots expect.

## 11. Limits

- Opened outside VC VFX ([addendum 15](addendum-15-verification.md)): the OBJ
  + MTL of a region built in the real app imports into Blender 4.5.3 as one
  patch of its real size with UVs 0…1 and the PNG texture resolved and wired;
  OpenEXR reads the texture EXR as RGB half. A placement accepted needs a
  rebuild (it is part of the settings revision); the decision is kept.
- **Not yet tried on production photography** — every number above is on the
  synthetic storeroom.
- Lambertian surfaces: speculars are flagged, not removed; delighting cannot
  separate albedo from shading at the radius's scale and above.
- Equirectangular panoramas only; one panorama and one scan per shot (more
  are kept as references but not used).
- The panorama's position from the scan needs a coloured scan and is good to
  a few centimetres; a surveyed position is better. Without colour the heading
  and position default (0°, the scan's middle) and the placement confidence
  says so.
- Planar patches only; a region straddling two planes is placed on one.
- Exposure is matched across regions on the same plane, so it needs the scan
  (or the artist's planes); without one, each region keeps its photo's
  exposure.
- Placement of a region without a real size depends on the photo's direction
  match, which parallax can mislead.
- The review build reads photos at most 4096 px wide; sharpness is measured
  at that size.
- Lens distortion is Brown–Conrady (k1, k2, k3, p1, p2); fisheye stills are
  not modelled.
- On real footage ([addendum 16](addendum-16-real-footage.md)): a frame of an anamorphic DVCPRO HD plate used as a
  photo rectifies to the squeezed aspect (0.69 for a square card): photos have
  no pixel aspect. A 10000×5000 EXR panorama loads in about a second.
