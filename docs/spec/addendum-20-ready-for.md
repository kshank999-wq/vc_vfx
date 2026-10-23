# Addendum 20 — Where each shot goes once it is ready

A finished shot goes somewhere: to a VFX company, to hand off, or into
another program, such as Nuke, to be worked on next. Which one is decided
shot by shot. Ken, 2026-10-23: the operator picks per shot.

VC VFX now records that pick, prints it, and sends it to VC Film Studio, so
the production can see what is ready for which company or program.

## 1. The model

A shot carries `readyFor` (`packages/domain/src/project.ts`):

- `{ kind: 'vendor', name }`: a VFX company, by name;
- `{ kind: 'software', name }`: the software it is opened in next. Nuke,
  Fusion, Flame, After Effects, Houdini, Blender and DaVinci Resolve are
  offered (`READY_FOR_SOFTWARE`), and any other name may be typed;
- `null`: not said.

`setReadyFor(project, shotId, value | null, actor, now)` sets or clears it.
The name is trimmed and capped at 120 characters, and a blank name clears
it. The change is logged as `shot.ready_for`, for example "Nuke (software)",
"Northlight VFX (VFX company)" or "cleared". Setting the same value again
changes nothing and logs nothing. A delivered shot has already gone, so it
is refused: reopen it first. `setReadyForShots` sets one destination for
several shots and skips delivered ones with their reason, as adding one task
to several shots does.

`readyForNames(project, kind)` offers names already used in the project. For
companies this includes the names recorded on deliveries (`deliveredTo`); for
software it also includes the usual programs. Duplicates differing only in
case are offered once.

**It says where, never whether.** `readyFor` is no part of "ready to hand
off". The rule stays VC Film Studio's, as in addendum 19, and the tests
check that setting a destination changes no shot's readiness and no count.

Project format 13. An older project opens with nothing said for any shot.

## 2. On screen

- **The shot** (Shots tab and Deliver tab): under Package, Mark delivered
  and Reopen, a "Ready for" choice of *Not said*, *A VFX company* or
  *Software (Nuke…)*, then the name, with the names above offered. The
  button reads *Set where it goes*, *Change where it goes* or *Clear where it
  goes*. On a delivered shot the choice gives way to a line saying who it was
  delivered to and what it had been ready for.
- **The queue**: "for Nuke" under the shot's status, until it is delivered.
- **Several shots picked** (Shift- or Ctrl/⌘-click): the same choice in the
  bar above the queue, *Set for N shots*.
- **Mark delivered**: when the shot was ready for a VFX company, the prompt
  starts with that company's name.

## 3. To VC Film Studio

The status report's shot gains `readyFor: { kind, name }`, omitted when not
said. VC Film Studio added it to its contract (`docs/VFX_STATUS.md`) and its
reader at main f58a891. The vendored copy of that reader and its demo reports
here (`__tests__/fixtures/`) are refreshed from that commit, and CI reads
VC VFX's output through it.

The field adds to `vc-film-studio.vfx-status/1` without changing it. An
older Film Studio ignores and keeps it. Film Studio refuses a `kind` that is
neither `vendor` nor `software`, and a `readyFor` with no name, giving the
path to the field.

Film Studio shows the destination beside each shot on its VFX board and in
the open shot. The board can be narrowed to one destination: `?for=nuke`, or
with `?ready=yes` for what can go there now. A change of destination between
reports is listed in "what changed".

## 4. On paper

The printed log puts "for Nuke (software)" under the shot's package, until
the shot is delivered. The CSV gains a *Ready for* column after *Delivered*,
matching Film Studio's CSV.
