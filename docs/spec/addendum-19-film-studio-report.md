# Addendum 19 — The VFX status report, and VC Film Studio

Everyone on the production who is not at the VFX machine needs to know what
has been processed, what has not, what is ready to hand off to the VFX
company, and what is working and what is not. VC VFX is the only place those
facts exist. This addendum records how VC VFX now says them: on paper, as
files, and sent to the production's VC Film Studio, which shows them on its
VFX status board and prints them as a log for the VFX supervisor to sign.

The contract is VC Film Studio's: `docs/VFX_STATUS.md` on its branch
`claude/vfx-status` (618a180), the format `vc-film-studio.vfx-status/1`, read
by its `lib/vfx-status.ts`. Its brief for VC VFX
(`docs/VFX_STATUS_VC_VFX_BRIEF.md`) is what was built from.

## 1. One document

`buildFilmStudioStatus(project, { generatedAt, appVersion, operator })`
(`packages/domain/src/film-studio.ts`, pure) turns the whole project into the
document. Every send, export and printed log is made from it, so the paper,
the file and Film Studio's board cannot disagree.

Per shot, from the model:

| Field | From |
| --- | --- |
| `handoffShotId`, `vfxShotId`, slate, roll, clip, unit, `shootDay` | the handoff shot and `vfxShotId`, as they are (`take` stays text) |
| `shootDate` | the handoff origin's day date, else the date inside `shootDay` |
| `frames` | `planFor` / `shotTiming`: delivered in–out, handles, count, `rangeFrom`; absent while the range is unknown |
| `frameRate`, `timecodeIn/Out`, `camera`, `pixelAspect` | `shotTiming`, the handoff, `shotPixelAspect` |
| `status` | `shotStatus` and its label |
| `source` | `sourceVerified`, at the time of the last `source.verified/mismatch/missing/unchecked` log entry |
| `plates` | the `PlateRecord` of the current plate version, with its colour summary and "no look baked" |
| `tasks[]` | kind, label, state, version (a number), approval (only when approved), notes, confidence, problems, exported / exportVersion |
| `approval` | the shot approval |
| `packaged` | version, the time of the last `shot.packaged` entry, the shot folder relative to the output root, and `taskVersions` (below) |
| `delivered` | the time of the `shot.delivered` entry and, new, who it went to |
| `problems[]` | below |
| `supervisorNotes`, `notes` | the handoff's and VC VFX's |

**Confidence**, in the contract's counts: roto (frames, mean, min, low,
flagged, reviewed over the combined frames), key (despill shares it), clean
plate, sky, background removal; 2D tracks as the mean and minimum over every
tracked frame; the camera track as the active solve's own confidence over the
frames it solved (one number, so mean = min).

**Problems** are sentences somebody can act on — what is wrong, where, what to
do — with the frames:

- a source that no longer matches the DIT's checksum, or is missing: `error`,
  on the shot;
- a source not yet verified (when the handoff carries a checksum): `info`;
- frames marked for correction in review: `warn`, with the notes;
- per task still open: flagged frames, and low-confidence (roto) or problem
  frames (key, clean plate, sky, background) not yet reviewed: `warn`;
  camera-solve warnings: `warn`; comp graph validation at its own severity
  (`warning` → `warn`); plate notes ("PIZ written as ZIP16"): `info`;
- pixel-aspect warnings before the shot is approved: `info`.

Work a named person has approved is not second-guessed: its review is over.

**Limits.** Film Studio refuses a whole report if one text field is longer
than the contract allows (scene 40, setup 20, …). Free text is shortened with
an ellipsis instead; identities are short by construction.

## 2. Ready to hand off, exactly

`readiness(shot)` is a port of Film Studio's own function, applied to the
document's shot, reasons included:

> approved as a shot, packaged and still `packaged` (not reopened), every task
> approved at the version that was packaged, nothing needing correction, and
> not yet delivered. Delivered shots are counted as delivered, not ready.

and the same six sections, in the order they print: Ready to hand off, In
review, Needs correction, In progress, Not started, Delivered.
`summary.readyToHandOff` is its count. The Deliver tab shows the shot's hand
off ("Ready", "Held" with what holds it, "Delivered") and the project's counts
in the same words.

**The package's task versions.** `markPackaged` now records each task's
version in the shot (`packagedTaskVersions`) and in the `shot.packaged` log
entry ("package v002 from roto v003, key v001"). A shot reopened after
packaging keeps them, so its package is reported as out of date. Projects
packaged before format 12 have none; the report then omits `taskVersions` and
Film Studio relies on `status.key` being `packaged`, which VC VFX already
guarantees goes back to prep on reopening.

**Project format 12**: `packagedTaskVersions`, `deliveredTo` (Mark delivered
now asks who it went to; it may be left empty) and the project's
`filmStudioProduction`. An older project opens with these empty; a newer one
is refused.

## 3. On paper and as files

`vfxStatusReportHtml(document)` (`film-studio-report.ts`): landscape; the
sentence first (Film Studio's `vfxSays`), the counts, task states and problem
totals; a note said word for word on three or more shots ("the source has not
been verified") once, above, with the shots it is on; then each section with a
tick box per shot, the shot, slate and roll, shoot day, status and shot
approval, every task with its state, version, approver and confidence, the
package (marked out of date when reopened), and what holds it or is not
working; supervisor's notes, then a signature block with the handoff's VFX
supervisor. No script, so it prints from the browser preview unchanged.

- **Print / Save as PDF**: File › Print VFX Status Report…, Save VFX Status
  Report as PDF…; the Shots tab's "VFX status report…"; the Deliver tab. The
  desktop prints through the same sandboxed offscreen window as the shot list
  (`main/print.ts`), with the HTML made in main from the re-validated project.
- **Export for VC Film Studio…**: the document as `.json`, for productions
  without a key or a network; Film Studio imports it on its data desk.
- **Export VFX Status as CSV…**: Film Studio's own CSV columns, UTF-8 with a
  byte-order mark, a cell starting `= + - @` written as text.

## 4. Send to VC Film Studio

`POST {site}/api/vfx/status`, `Authorization: Bearer vcvfx_…`, the document as
the body, from the **main process only** (`main/film-studio.ts`,
`main/film-studio-send.ts`, Electron's `net.fetch`, 30 s timeout).

- **The site**: Settings → VC Film Studio. Default
  `https://www.vcfilmstudio.com` — Film Studio's canonical host
  (`proxy.ts` redirects the bare domain to it). Only https, except
  `http://localhost` for a Film Studio run on this computer.
- **The upload key** is made on Film Studio's data desk (From VC VFX → Send
  from VC VFX) and pasted once. It is kept in the main process, encrypted with
  the OS keychain through Electron `safeStorage` (as the sign-in session is),
  in its own file in userData — never in `settings.json`, the project file,
  the log, an error or an answer to the renderer, which only learns whether
  there is one and its last four characters (`vcvfx_…7f3a`). Where the OS
  offers no keychain (some Linux desktops) it is kept as text in VC VFX's
  settings folder and Settings says so. A `vcdit_` key, or one that is not
  complete (Film Studio's keys are `vcvfx_` + 43 characters), is refused when
  pasted, saying where to make the right one. Every string that comes back
  from a send is scrubbed of the key.
- **The production**: the project's `filmStudioProduction`, sent as
  `filmStudio.production` (Film Studio checks it against the key's production
  and refuses a mismatch with a 409).
- **Answers**, shown as Film Studio wrote them: on success its `says`, the
  production, its counts and warnings, and whether a newer report was already
  there; on refusal its `error` verbatim, the field paths it lists and the
  HTTP status, with Export for VC Film Studio… and (for 401 and 409)
  Settings… offered. An answer that is not Film Studio's (a wrong address, a
  proxy's page) says to check the address.
- **Offline** (a set often is): "Not sent: VC Film Studio could not be
  reached … Nothing was queued and nothing was sent. Send again when there is
  a connection, or export the report…". Nothing is queued silently.
- **Logged**: every attempt goes into the project log as `filmstudio.sent`,
  `filmstudio.refused` or `filmstudio.not_sent` — who, when, the counts and
  Film Studio's answer, never the key. A send not attempted (no key yet)
  writes nothing. The Deliver tab shows the last one.
- **Automatically**: Settings → VC Film Studio → Send the status after each
  package (off unless turned on), at most once a minute; a failure is a notice
  with the file offered, not a dialog.

Sending is allowed in read-only mode: it changes no work.

## 5. The browser preview

The report prints, and the JSON and CSV download, exactly as on the desktop.
Sending is shown disabled with "Available in the desktop app: sending to VC
Film Studio uses an upload key kept in the computer's keychain", and the
Settings section says the same.

## 6. Verified

- **Contract, in CI**: a verbatim copy of Film Studio's reader
  (`packages/domain/src/__tests__/fixtures/film-studio-vfx-status.ts`, with
  its source and commit in the header, `@ts-nocheck` because Film Studio
  compiles without `noUncheckedIndexedAccess`) reads the document of the
  sample project and of a synthetic project with a shot in every status and
  every section, a stale package, a reopened task with a bumped version, a
  delivery to a vendor, a broken source, review marks, low-confidence roto, a
  key with problem frames, an invalid comp graph and over-long fields. For
  every shot our `readiness` equals Film Studio's (ready, section and every
  reason), the summary equals its `summarise`, and the port is also checked on
  Film Studio's two demo reports. A drift in either fails here.
- **The sender** against a local server answering exactly as Film Studio's
  route does: the POST, the header, the body read by Film Studio's reader;
  every refusal (401 no key / unknown key, 413, 400 with issues, 409, 502,
  500) shown verbatim; a non-Film-Studio answer; offline; the timeout; the key
  never in an answer or the logged project.
- **The renderer**: the Deliver step, print and export with the operator, a
  send's answer and its log line, a refusal verbatim with the file offered,
  no key, the desktop-only state, and the key stored through main and shown
  only by its hint.
- **Against Film Studio's own code** (not in CI; run from its checkout with
  its `tools/ts-resolve.mjs`): documents generated by this domain go through
  its reader, its readiness and `summarise`, its import plan against a
  production shaped like its demo (every shot linked to its scene and, by
  date, its day), its board and printed log, and its route logic
  `receiveVfxStatus` with the database calls faked as its own test fakes them
  — 200, 401 (no key, a DIT key, an unknown key), 413, 400, 409, 502, 500.
  Not exercised: Film Studio's Postgres functions (`app_vfx_status_context`,
  `app_vfx_status_upload`) and the deployed endpoint, which need a database
  and a real key.

## 7. What a production does

1. On Film Studio's data desk: From VC VFX → Send from VC VFX → make a key
   (shown once).
2. In VC VFX: Settings → VC Film Studio → paste the key; set the production
   as Film Studio names it if the VFX project is named differently.
3. Deliver tab → Send status to VC Film Studio (or turn on the send after each
   package). Without a key or a network: Export for VC Film Studio… and import
   the file on the data desk.
