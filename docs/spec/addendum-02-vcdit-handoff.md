# Addendum 02 — Opening the handoff VCDIT actually writes

Master spec §2 and §18 describe a rich handoff: shot IDs, frame ranges,
timecode, camera and lens, colour, requested tasks. V1's parser
(`packages/domain/src/handoff.ts`) was written to that description. VCDIT, as
built, writes something smaller. VC VFX now opens both, and this addendum
records how the smaller one is read, what it lacks, and a cheap `/2` that
would close the gap.

## What VCDIT writes

"Send to VC VFX Prep" (vc-dit `apps/desktop/src/main/vfx/vfx-service.ts`,
`sendToPrep`) writes, on every destination drive that holds the day's VFX
mirrors:

    <drive>/<PRODUCTION>/SHOOT_DAY_###_YYYY-MM-DD/VFX/VC_VFX_PREP_<CODE>_D###_<stamp>.json   (+ .csv)

beside the mirrored take folders `VFX/SCENE_014/SETUP_B/T03_A015C002/…`.
One file per drive; each describes the same shots, with paths relative to
its own VFX folder. A take is sent once: later sends carry only takes not
yet sent.

```jsonc
{
  "schema": "vcdit.vfx-handoff/1",
  "createdAt": "2026-10-07T20:15:00.000Z",
  "tool": { "name": "VC DIT", "version": "1.4.0" },
  "production": { "name": "HALCYON", "code": "HLC", "frameRate": "23.976 fps" }, // free text
  "day": { "number": 1, "date": "2026-10-07" },
  "shots": [{
    "scene": "14", "setup": "B",            // "—" when there is no setup
    "take": "03",                           // two digits
    "clip": "A015C002",                     // one entry per camera clip of a flagged take
    "note": "Sky replacement",              // the script supervisor's VFX note, or the DIT's
    "flaggedBy": "Script sup.",             // or "DIT tag"
    "mirror": { "method": "Hard link", "folder": "SCENE_014/SETUP_B/T03_A015C002" },
    "editorialFolder": "../CAMERA_ORIGINALS/A015",   // the card folder
    "checksumMethod": "xxHash64",           // or "MD5", "SHA-1"
    "files": [{ "path": "A015R1AB/A015C002_261007_R1AB.mxf", "size": 200000, "checksum": "8d1c…" }]
  }]
}
```

`files[].path` is relative to the **card folder**. A hard-linked or
physically copied mirror reproduces those card-relative paths inside the take
folder, so the media is at `mirror.folder/path`. A `Reference` mirror holds
only `VFX_REFERENCE.json/.txt`; its media is the editorial copy at
`editorialFolder/path`. `checksum` is lowercase hex (xxHash64: 16 digits,
seed 0), or null when the card was not hashed.

## How VC VFX reads it

`parseHandoff` recognises the document by `schema: "vcdit.vfx-handoff/N"` and
converts it with `fromVcditHandoff` (`packages/domain/src/vcdit.ts`), then
validates the result as an ordinary handoff. A newer `/N` is read as `/1`
with a warning; unknown fields are kept. A `vcdit.vfx-reference/1` file
(the per-take reference) is refused with a pointer to the day's
`VC_VFX_PREP_….json`.

| VC VFX field | From VCDIT | Notes |
| --- | --- | --- |
| `project` | `production.name` (else `code`) | |
| `generator`, `generatedAt` | `tool.name tool.version`, `createdAt` | |
| `origin` (new, optional) | `schema`, tool, `production.code`, `day` | Shown in the header ("Day 1 · 2026-10-07") and the printed shot list. |
| `shotId` | derived: `<scene>_<setup>_<take>` | Sanitised (`[A-Za-z0-9_-]`); no setup → `14_01`. Takes that share an ID (several cameras) **all** get the clip added: `14_B_03_A015C002`, `14_B_03_B007C002`. Stable across re-opens. |
| `scene`, `setup`, `take` | same | `setup: "—"` → absent; empty scene → "—". |
| `clip` | `clip` | |
| `cameraRoll` | parsed from the clip name | `A015C002` → `A015`; `A001_C002_…` → `A001`; otherwise absent. |
| `shootDay` | `day` | `Day 001 · 2026-10-07`. |
| `circled` | — | Always false (not sent). |
| `sourcePath` | `mirror.folder` + primary file | `editorialFolder` + file for `Reference`. Primary = largest movie file (mov, mxf, mp4, m4v, r3d, braw, ari, crm, avi, mkv, mts); first segment of a spanned R3D; else first frame of an image sequence (dng, exr, dpx, tif, cin); else the largest file. |
| `sourceFiles` (new, optional) | the take's other files | Sidecars, further R3D segments, further frames. Count as source media for the "never write inside a source folder" rule. |
| `frameIn`, `frameOut` | — | Now optional. An image sequence gets `0 … n−1` from its file count. Otherwise read from the clip (below). |
| `handles` | — | 0: a whole take has no handles beyond itself. |
| `frameRate` | `production.frameRate` | Parsed from free text: "23.976 fps", "24", "25p", "29.97 DF", "24000/1001", "23.98" → 23.976. Unreadable → 24 with a warning. The probed clip rate wins once read. |
| `checksums` | `files[].checksum` + `checksumMethod` | `xxHash64`→`xxh64`, `MD5`→`md5`, `SHA-1`→`sha1`; size kept as `bytes`. Null checksums are dropped with a warning. |
| `supervisorNotes` | `note` | |
| `flaggedBy` (new, optional) | `flaggedBy` | Shown in the source panel, report and manifest. |
| `tasks` | — | Empty; one warning says to assign them in VC VFX. |
| `camera`, `color`, `resolution`, `timecodeIn/Out`, `references`, `output` | — | Empty / project defaults (EXR 16-bit from 1001). |

The handoff stored in the project is the converted one; nothing is written
to the drive.

### Frame ranges: ffprobe

`frameIn`/`frameOut` are optional in `HandoffShotSchema` (both or neither).
Where the handoff gives none, VC VFX reads the source clip with **ffprobe**
(beside the ffmpeg in Settings, or on PATH; `apps/desktop/src/main/probe.ts`):
frame count (`nb_frames`, else duration × rate), start timecode (video
stream, then a tmcd stream, then the container), frame rate, resolution and
codec. The result is stored per shot as `ShotState.probe` by the domain
mutation `setProbedMedia` and logged (`source.probed`), so the handoff stays
as received. `shotTiming(project, shot)` is the one place that decides the
range: the handoff's own when given, else the probed clip as `0 …
frameCount−1` (clip-relative; its timecode labels it but is not used to
offset the ffmpeg selection), else null. `planFor` returns null for an
unknown range.

- Probing runs when a project is created from a handoff with unknown
  ranges, and from "Read from clip" in a shot's sequence-plan panel. It is
  read-only, so it works in read-only licence mode.
- Plate generation probes first when the range is still unknown, and the
  renderer records what it read.
- Unknown ranges show as "—" in the queue and the printed shot list; the
  manifest's plate fields are null and `shot.rangeFrom` is null; the prep
  report says "unknown".
- No ffprobe: a notice says so, ranges stay "—", and plate generation
  refuses with the install hint.
- Camera raw ffmpeg cannot decode (R3D, BRAW, Canon RAW, ARRIRAW `.ari`)
  is flagged on open: make those plates in the vendor's tool and record the
  task here. Plates from image-sequence sources are not generated yet.

### VFX shot numbers

The derived IDs are for the queue. The VFX editor's numbers are assigned in
the shot panel ("VFX shot number"), stored as `ShotState.vfxShotId` by
`setVfxShotId`, and used wherever the shot is named: queue, detail, printed
list, search and sort, package folder (`SHOT_<number>`), plate file names,
manifest (`shot.shotId`, with `handoffShotId` beside it) and prep report.
It must be unique in the project, is letters, digits, `_ - .`, and is fixed
once work has started under the old name (any task past pending, or a
package), so nothing already written is orphaned. An empty value clears it.

### Assigning tasks in bulk

Since VCDIT sends no tasks, the queue takes Shift-click (range) and
Ctrl/Cmd-click (add/remove), and a bar above it adds one task to every
picked shot (`addTaskToShots`: shots that already have it, or are past prep,
are skipped and reported). Each addition is logged per shot.

### Checksums

`ChecksumRecord.algorithm` now accepts `sha256`, `md5`, `sha1`, `xxh64`,
`xxh128`, `xxh3`. Verification (`apps/desktop/src/main/verify.ts`) computes
sha256, MD5, SHA-1 and xxh64 (`xxhash-wasm`, the library VCDIT itself hashes
with) in one streamed read per file, checks the stated size too, and
reports xxh128/xxh3 as not computed.

### Native format

VC VFX's own format is unchanged apart from the now-optional range and the
optional `sourceFiles`, `flaggedBy`, `origin` fields and wider checksum
algorithms. Older project files open; `vfxShotId` and `probe` default to
null.

## What VCDIT does not send, and a proposed `vcdit.vfx-handoff/2`

Every field below is additive, so a `/2` reader can still take `/1` and VC
VFX's converter can take `/2` without breaking. "In VCDIT already" means the
data is in its production database today (`production-db.ts`) and only needs
writing out.

| Proposed field (per shot unless noted) | Meaning | In VCDIT already? |
| --- | --- | --- |
| `media.frameRate` `{num, den}` | the clip's own rate | **Yes** — `clip.meta` (`MediaMeta.rate`), read at ingest for sync; `EditorialRow.rate`. |
| `media.durationSec` / `media.frameCount` | clip length | **Yes** — `MediaMeta.durationSec` (frame count = duration × rate). |
| `media.tcIn` `{frames, base, dropFrame}` | first-frame timecode | **Yes** — `MediaMeta.tc` (header or LTC); `EditorialRow.tc`. Null for R3D/BRAW/ARI/CRM, which VCDIT says so for. |
| `media.resolution` `{width, height}` | picture size | No — `MediaMeta` has none. The QuickTime and MXF readers already open the picture descriptors; width/height are a small addition there. |
| `log.tcIn`, `log.tcOut` | the script supervisor's in/out for the take | **Yes** — `script_entry.tc_in`, `tc_out`. VC VFX would take these as the editorial range (frameIn/frameOut against `media.tcIn`). |
| `circled`, `printed` | circle / print take | **Yes** — `script_entry.circle`, `print`; `camera_report.circle`. |
| `camera.slot` | camera letter (A, B…) | **Yes** — `script_match.camera`. |
| `camera.body`, `camera.format` | e.g. "ARRI ALEXA 35", "ARRIRAW 4.6K · LogC4" | **Yes** — `production.devices[{slot, name, format}]`, by `camera.slot`. |
| `camera.lens` | lens / focal length as logged | **Yes**, as text — `script_entry.lens`, `camera_report.lens`. (A parsed `focalLengthMm` would be VCDIT's or VC VFX's job.) |
| `camera.roll` | camera roll / card | **Yes** — the card (`clip.card`, `script_entry.roll`); VC VFX now guesses it from the clip name. |
| `color.look` `{name, kind}` and `color.cdl` `{slope, offset, power, saturation}` | the look the dailies used — reference only, never baked into plates | **Yes** — `lut` + `lut_rule` (Project/Camera/Day/Scene/Setup/Clip), `lut.cdl`; `EditorialRow.look`, `.cdl`. |
| `color.sourceColorSpace` | log / gamut | Partly — the device `format` text carries it ("LogC4"); no structured field. |
| `description` | the log row's description | **Yes** — `script_entry.description`. |
| `notes` | general notes beyond the VFX note | **Yes** — `script_entry.notes`, `camera_report.notes`. |
| `sound` `{roll, file, syncFrames}` | synced production sound | **Yes** — `script_entry.sound_roll`, `sync_record`. |
| `vfxShotId` | the VFX editor's shot number | No — nothing in VCDIT holds one. A nullable column on the VFX flag (or a `VFX ID` column read from the script log) would carry it; VC VFX would use it as the shot ID and keep the take ID beside it. |
| `tasks` `[{kind, notes}]` | requested prep | No — VCDIT has only the free-text note. Could stay VC VFX's job. |
| top level: `production.frameRate` `{num, den}` | structured project rate | Partly — stored as free text; the editorial exports already parse it. |

The cheapest useful step is the first five rows plus `circled` and
`camera.*`: they come from tables `EditorialRow` already joins for the
ALE/FCPXML exports, and they let VC VFX skip ffprobe and offer the script
supervisor's range instead of the whole take.

## Open questions about VCDIT

- Can a VFX shot reach the handoff with an empty scene (a DIT tag on a clip
  no log or camera report placed)? VC VFX lists such takes under "—".
- Does an image-sequence clip (DNG, ARRIRAW `.ari`, DPX) list every frame in
  `files`? VC VFX assumes so and takes the count as the range.
- A take is sent once (`vfx_handoff`). A note corrected in VCDIT after the
  send never reaches VC VFX; should a re-send replace or append?
- Each day is its own handoff, so each day opens as its own VC VFX project.
  Merging days into one production project is not done yet.
- `production.frameRate` is free text: is "23.976 fps" the only form the
  VCDIT UI produces, or can operators type anything?
