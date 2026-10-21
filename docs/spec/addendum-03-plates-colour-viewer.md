# Addendum 03 — Plates from production footage, explicit colour, and the frame viewer

Master spec §4 asks for plates that are made from the production's real media
with colour settings that are "explicit and non-destructive", never a baked
display look. §5.2 and §15.4 ask for review: representative frames across the
shot and a way to flag the ones that need correction. V1 wrote plates with
whatever ffmpeg the operator had installed and applied no colour at all; it had
no way to look at a frame. This addendum records what was built and why.

## 1. ffmpeg ships with the app

**Decision.** The installer carries its own ffmpeg and ffprobe. Resolution order
(`apps/desktop/src/main/ffmpeg-tools.ts`):

1. the path in Settings — an explicit choice: if it does not run, VC VFX says
   so instead of quietly using another;
2. the bundled copy (`Resources/ffmpeg/` beside `app.asar`; in development
   `apps/desktop/resources/ffmpeg/<platform>-<arch>/`);
3. `ffmpeg` / `ffprobe` on PATH.

ffprobe comes from the same place as the ffmpeg in use. Settings shows which
one was found ("Bundled with VC VFX: ffmpeg version …"). The result, including
which filters the build has (`zscale`, `lut1d`, `colorchannelmixer`), is cached
until Settings change.

**Which binaries.** The static builds the `ffmpeg-static` npm package installs:
release `b6.1.1` of github.com/eugeneware/ffmpeg-static — macOS from
osxexperts.net (6.0 arm64, 6.1.1 x64), Windows from gyan.dev (6.1.1
essentials), Linux from johnvansickle.com (7.0.2, development and CI only). All
have the EXR encoder and libzimg. `scripts/fetch-ffmpeg.mjs` downloads them,
checks each file against a pinned SHA-256 and writes them to
`resources/ffmpeg/<platform>-<arch>/` with their LICENSE and README; nothing is
committed. `package:mac` fetches both macOS arches and `package:win` the Windows
one before electron-builder runs; `extraResources` in `electron-builder.yml`
copies `resources/ffmpeg/${platform}-${arch}` per arch built, so the arm64 and
x64 DMGs each get their own binary from one job.

**Why not an npm dependency.** The only per-platform npm packages with the
binary inside the tarball (`@ffmpeg-installer/<platform>`) carry a 2018
ffmpeg 4.1 with no EXR encoder (added in 4.4) — it could not write the default
plate format. `ffmpeg-static` itself downloads in an install script, for the
host arch only, so a macOS job could not package the other arch; and any
binary dependency would put ~250 MB into every workspace install, the
website's on Vercel included. A pinned fetch step avoids all three. A mirror
can be set with `FFMPEG_BINARIES_URL`.

**Licence.** These are GPL builds, run as a separate program. Their LICENSE
and README files ship beside them in `Resources/ffmpeg`. Before a public
release, confirm the source-offer obligation is met (link to the upstream
source for the exact versions on the download page).

**Verified here.** `electron-builder --dir --linux` packs the binaries outside
the asar with the executable bit kept, and the packaged binary runs from
`process.resourcesPath/ffmpeg`. **Not verified here:** a signed, notarised macOS
build (electron-builder's signing walks the bundle and should sign the two
Mach-O binaries with the hardened runtime; check with
`codesign --verify --strict` on `Contents/Resources/ffmpeg/ffmpeg`), and a
Windows installer.

## 2. Plate colour: explicit and recorded

The model (`packages/domain/src/color.ts`) is the one every camera vendor
publishes: code value → transfer⁻¹ → scene-linear in the camera gamut → 3×3
matrix → scene-linear in the target gamut.

**Encodings.** ARRI LogC3 (EI 800) / AWG3, ARRI LogC4 / AWG4, Sony S-Log3 /
S-Gamut3.Cine and / S-Gamut3, RED Log3G10 / REDWideGamutRGB, Canon Log 3 /
Cinema Gamut, Panasonic V-Log / V-Gamut, Blackmagic Film Gen 5 / Wide Gamut,
Rec.709 (video), sRGB, ACEScg, ACES2065-1, linear Rec.709. Each transfer
function uses the manufacturer's published constants (cited in the source) and
is tested against their reference values (LogC3 18 % → 0.391, LogC4 → 0.278,
S-Log3 → 420/1023, Log3G10 → ⅓, V-Log → 0.423, BMD Gen 5 → 0.384, Canon Log 3
→ 34.3 % IRE) and for round trips. Matrices are computed from primaries and
white points (SMPTE RP 177), with chromatic adaptation to the ACES white: CAT02
for ARRI, Sony and Canon, Bradford otherwise — which reproduces ARRI's, Sony's,
Canon's and RED's published ACES input matrices to 1e-6 (RED 2e-4) and the
Academy's Rec.709→AP1 and AP0→AP1. Curves are applied to normalised full-range
code value (code / 1023) as the vendors publish them; Canon's IRE-based curve is
converted to that domain as Canon's own IDT does.

**Reading the handoff.** `color.sourceColorSpace` (and `gamma`) is free text.
`parseColorEncoding` recognises the encodings above in the ways people write
them ("ARRI LogC4 / AWG4", "LogC3", "S-Log3 / S-Gamut3.Cine", "Log3G10 RWG",
"C-Log3"…). Where the text names only half ("LogC", "S-Log3") the usual
partner is assumed and says so ("LogC without a version is read as LogC3 (EI
800) / AWG3"). Anything else — ACEScct, S-Log2, Cineon, P3 — is unknown, never
guessed from the camera body. The operator can override the reading per shot
(`ShotState.sourceEncoding`).

**Policy.** `{ mode: 'as_shot' } | { mode: 'convert', from, to: ACEScg |
ACES2065-1 | linear Rec.709 }`, decided by `decidePlateColor`:

| Delivery | Default | Why |
| --- | --- | --- |
| EXR | Convert to the project default (ACEScg) when the source encoding is known | EXR is the scene-linear interchange format; ACEScg is what comp works in. |
| EXR, encoding unknown | As shot, with a warning | Never convert from a guess. |
| DPX / TIFF / PNG / JPEG | As shot (camera log kept) | Linear does not fit an integer format without clipping above 1.0. An explicit request to convert one is refused with the reason. |

The project default (`Project.plateColorDefault`, in Settings when a project is
open) and each shot's choice (`ShotState.plateColor`: Project default / As
shot / Convert to …) are stored in the project and logged
(`project.plate_colour`, `plates.colour`). Changing a shot's choice is refused
once its plates are approved; reopening makes a new version that takes it.
The shot panel says the outcome in one line: "Writes ACEScg linear EXR half
from ARRI LogC4 / AWG4; no look applied."

**How it is applied.** Because every conversion is a per-channel curve and one
matrix, the plates are made exactly that way in ffmpeg, in 32-bit float:
`zscale` (exact integer/YCbCr → float), `format=gbrpf32le`, `lut1d` (a
4096-point decode `.cube`, under 5e-5 relative error), `colorchannelmixer`
(the matrix; split into M/s and a gain where a coefficient exceeds ffmpeg's
±2), into float EXR. A 65³ 3D LUT was the first idea and was rejected: its
trilinear interpolation of a log→linear curve is off by ~0.3 % between grid
points, and its input domain clamps; the separable form is exact and keeps
linear values above 1.0 (LogC3 code 1.0 → 55.08). swscale is avoided for the
float conversion because its integer→float path is off by up to ~5e-4; with an
ffmpeg that lacks zscale the plate is still written, with a note saying so.
YCbCr sources are read with their tagged matrix and range; untagged YCbCr is
read as Rec.709, limited range, and the note says so.

**Reproducible (§19).** Each plate version writes into `09_PROJECT_DATA`:
`<shot>_plate_vNNN_colour.json` (policy, source and plate encodings and where
the encoding came from, the transform's curve, matrix rows and adaptation, the
exact ffmpeg filter graph and arguments, notes, `lookApplied: false`) and, for
a conversion, `<shot>_plate_vNNN_decode.cube`. ffmpeg runs with
`09_PROJECT_DATA` as its working directory and names the LUT by its bare
file name, so no path ever needs escaping inside a filter graph. The project
records a `PlateRecord` per version (`recordPlates`; logged as
`plates.written` with the transform and filter graph verbatim) and the
manifest's `plates.color` carries it — or the planned decision, marked
`written: false`, when no plates exist yet. The prep report shows it.

**Never a look.** No display transform, CDL or LUT from the handoff's
`lookReference` is ever applied to a plate. The tests assert that "as shot"
writes no colour filter and that every summary ends "no look applied".

**Proved with real ffmpeg** (`apps/desktop/src/main/__tests__/colour-pipeline.test.ts`,
run against the ffmpeg on PATH and the bundled one): a LogC3 18 % grey DPX
sequence becomes 0.18 ± 0.2 % in the ACEScg EXR and code 1.0 becomes 55.08;
a ProRes 4444 clip of the same grey reads 0.18 ± 2 %; a 10-bit DPX sequence
written as shot to DPX is bit-identical to its source frames, from the right
frames of the sequence.

## 3. Camera raw is refused; image sequences are read

R3D, BRAW, ARRIRAW (`.ari`, `.arx`), Canon RAW (`.crm`), CinemaDNG (`.dng`) and
Nikon N-RAW (`.nev`) are refused, for plates and for the viewer, with:
"Camera raw — transcode to ProRes 4444 XQ or EXR in VCDIT (or the camera
vendor's tool) first; VC VFX reads the result." ffmpeg either cannot decode
these or cannot debayer them with the vendor's colour science, and plates
made any other way would not match what editorial and the grade see. The
vendor SDKs are not redistributable in a way that suits VC VFX, and VCDIT is
where transcoding already happens on set.

Image-sequence sources (DPX, EXR, TIFF, PNG, JPEG, Cineon — as VCDIT mirrors
them) are read with ffmpeg's image2 demuxer: the handoff names the first frame;
the sequence is the unbroken run of same-named, same-padded numbered files from
it (`image-sequence.ts`). Plates enter the sequence at the first wanted file
(`-start_number`) instead of decoding from the head, and a plan that needs
frames past a gap is refused with the count. Probing a sequence takes its
length from the files and its pixel format from the first frame.

## 4. The frame viewer and contact sheet

Double-click a shot (or **View frames** in its panel). Since
[addendum 08](addendum-08-layout.md) the viewer is the picture of the
**Plates** tab (and of Key), between its steps and its details; the shot bar
above it replaces the narrowed queue.

- **Show**: the source, or a plate version found in the shot's `01_PLATES`.
- **Compare**: Single, **Wipe** (source left, plate right, drag across the
  image) or **A/B** (press B to swap).
- Frames are numbered as delivered — the numbers the plates carry, computed
  with the same `clipRange` the plates are made with
  (`shared/viewer.ts`), so the viewer's 1009 is plate 1009 — with the clip's
  timecode beside them and handles marked.
- ←/→ one frame, Shift ten, Space play (at the shot's rate, best effort: a
  frame is shown once it has arrived; the next eight are fetched ahead), Esc
  back to the queue. Neighbours (±1, ±2, ±10) are fetched ahead.
- **Contact sheet**: the first and last frames and twelve spread between
  (`contactSheetFrames`); a tile jumps there.
- **Mark for correction** adds a review mark to the shot — frame, what was
  being looked at, an optional note, who and when (`toggleReviewMark`,
  logged as `review.marked` / `review.unmarked`). Marks show on the scrub bar,
  the contact sheet, in the shot's notes and in the manifest's `review.marks`.
  They are the groundwork for roto review (§5.2).

**Views are for viewing only.** "Rec.709 (approx.)" decodes the encoding to
scene-linear, converts to Rec.709 primaries, applies a filmic tone curve
(Narkowicz's fit of the ACES RRT+ODT) and the 2.4 display gamma. It is labelled
as an approximation of the vendors' own Rec.709 LUTs, which it is. "Raw values"
shows the code values as stored. Display-referred sources are shown as they
are; an unknown encoding falls back to raw, labelled so. Every frame is labelled
"viewing only". The view is built from the same domain transforms but is never
used to write a plate.

**How frames reach the screen.** Main extracts a frame with ffmpeg (an input
seek half a frame early for a clip, the file itself for a sequence), scales it
to at most 480/960/1280/1920 px wide, applies the view, writes a JPEG into the
frame cache (`userData/Frame Cache`) and returns a `vcvfx-frame://cache/<sha256>.jpg`
URL. The key covers the file, its size and modification time, the frame, the
view and the size, so a re-rendered plate is never shown stale. The cache is
least-recently-used with a 512 MB cap; extraction runs two at a time, frames the
viewer is waiting for go before prefetches, and stale prefetches are dropped.
The renderer never gets `file://`: the scheme is registered privileged (secure,
standard), its handler serves only a 64-hex-digit `.jpg` directly inside the
cache folder and refuses dot segments and backslashes in any spelling, other
hosts, queries and anything else (unit-tested, and checked through the real
handler in Electron). The renderer's CSP allows the scheme in `img-src` only;
`connect-src` stays `'self'`.

**Browser preview.** `/preview` has no media. For the sample project it shows
stand-in frames (`src/renderer/assets/sample-frames`, 20 small JPEGs made by
`scripts/make-sample-frames.mjs` through the same transforms: a synthetic
LogC4 scene and ACEScg plates from it, raw and Rec.709), labelled "sample
frames". A real project's viewer says frames are read from the drive by the
desktop app.

## Open questions

- **Legal vs full range for camera log in YCbCr files.** The curves are applied
  to the signal as ffmpeg decodes it (video-range YCbCr expanded by its tag).
  That is how Resolve treats ProRes on "auto" levels and matches ARRI's
  legal-range ProRes recording; a camera that writes full-range code values
  into a file tagged video range would read ~0.06 stop off. A grey card on the
  first job will settle it per camera; a per-shot range override is cheap if
  needed.
- **ACEScct / ACEScc sources** are recognised but not converted.
- **CDL / look from VCDIT** (`color.look`, proposed for `vcdit.vfx-handoff/2`)
  could be offered as a *view* in the viewer — never on plates.
