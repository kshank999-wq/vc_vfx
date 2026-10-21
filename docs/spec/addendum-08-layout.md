# Addendum 08 — Module tabs: one screen per job

VC VFX grew module by module — plates and the viewer (addendum 03), roto
(04), camera and 2D tracking (06), the AI assistant (07) — and each landed
where there was room: buttons in the shot panel, sub-tabs inside the viewer,
a panel docked over the Track view. It all worked, but a first-time user could
open a handoff, see the shots, and not know where anything was. Ken's ask:
every module in its own tab along the top, big screens, information that is
easy to read, a picture for roto and keying, and a layout that makes it
obvious what is going where.

This addendum is the renderer's layout. No feature, IPC call or file format
changed; the same components do the same work inside new frames.

## 1. The top toolbar

`Shots · Plates · Roto · Key · Clean Plate · Camera Track · 2D Track · Deliver`
(Clean Plate added with [addendum 10](addendum-10-clean-plate.md)), each an
icon and a word (`components/Layout.tsx` `ModuleTabs`, definitions in
`renderer/modules.ts`), then **Help** (the tour), the licence pill (Account)
and **Settings** on the right. The brand block shows the project's name and an
unsaved-changes dot.

- Each tab tied to a prep task carries a **dot** in that task's state colour
  for the current shot (hollow: pending; purple: processing; yellow: needs
  review; red: needs correction; green: approved). Deliver's dot is the
  shot's status.
- A tab whose task the shot does not have is **greyed**, with the reason in
  its tooltip ("010_030 has no Roto task. Open the tab to add it."). It still
  opens, and inside offers **Add Roto to this shot** (`TaskMissing`), logged
  like any added task. Plates still shows the source frames without the task,
  with the offer at the top of its steps.
- ⌘/Ctrl+1…8 switch tabs (Clean Plate is 5), in the browser preview too: the renderer owns the
  keys, and the desktop's new **View** menu lists the tabs (and Previous /
  Next Shot) with their accelerators shown but not registered
  (`registerAccelerator: false`), so nothing fires twice. Menu commands
  `show-shots` … `show-deliver` (with `show-cleanplate`) and `show-tour` were added to
  `MENU_COMMANDS`; **Help › Show the Tour** reopens the tour.

## 2. The shot bar

Under the toolbar on every tab except Shots (`ShotBar`): previous / next
buttons (and ⌘/Ctrl+↑/↓), the shot's name large (26 px), scene, setup, take,
circle take, camera and lens and clip, the shot's status pill and the module's
task pill, a **Shot** dropdown and "2 of 3". It walks the Shots tab's
filtered list, so filters carry over.

Selecting a shot on Shots and clicking a tab opens that tab on it.
Double-clicking a shot opens the last module used if the shot has that task,
else its first task module (Plates, Roto, 2D Track, Camera Track, Key, Clean Plate), else
Deliver (`moduleToOpen`).

## 3. Every module: three zones

`ModuleLayout`: **Steps** on the left, the **picture** in the middle with its
timeline and transport running the full width under it, **Details** on the
right. Both side panels collapse to a labelled strip (remembered per viewer in
`localStorage`, try/catch), leaving the picture the room. Panel widths follow
the window (`clamp()`), from 1280 × 800 up.

**Steps** (`StepList`) are numbered cards, each with a one-line purpose. The
first step not done is marked **next** and opened; done steps get a green
tick and fold away when the next one starts; optional steps say so; a step
that needs earlier work says which ("Propagate first (step 2)") instead of
showing dead buttons. Each step's big action is a full-width button.

**Details** shows the numbers that matter as large tiles (24 px values), then
the task's card — state, version, approval, *Submit for review*,
*Approve…*, notes — then the shot's **History** (its log), folded.

### The step lists

| Tab | Steps | Details |
| --- | --- | --- |
| **Plates** | 1 Check source & colour (sequence plan, *Read from clip*, source encoding, plate colour) · 2 Generate plates (with the output folder) · 3 Review in the viewer (Wipe / A/B, Mark for correction, then approve) | Frames, format, resolution, plates written, frames marked to fix, source check; the colour decision in one line; marks; task; camera & colour and source files (folded) |
| **Roto** | 1 Paint the subject (key-frame actions; parts, engine and working size folded) · 2 Propagate · 3 Review problem frames (Next problem, flag, mark reviewed, matte contact sheet) · 4 Export mattes (refine edges folded, EXR) | Frames with a matte, key frames, frames to check, lowest confidence, this frame, mattes exported; the part being painted; task |
| **Key** | Eight steps ([addendum 09](addendum-09-keying.md)): pick the screen (Auto key / eyedropper, green/blue), key, garbage & holdout, repair with roto, despill against a background reference, light wrap & match (preview only), process & review problem frames, export. The centre is the key viewer (review modes, A/B wipe, eyedropper, box drawing, confidence timeline). | Screen swatch; matte quality of the frame and the shot, frames keyed, problem frames; version and approval; the frame's measurements; the suggested match; the Key (and Despill) task cards |
| **Clean Plate** | Five steps ([addendum 10](addendum-10-clean-plate.md)): choose what to remove (roto parts, boxes, matte growth) · still or sequence, alignment and reference frame · build · review & fix (next problem, prefer / leave out a frame, patch a region from a chosen frame) · export. The centre is the clean-plate viewer (source, plate, unresolved in red, confidence, what is removed, A/B wipe, a timeline coloured by confidence). | Frames built, mode, seen in other frames, low confidence, alignment residual, problem frames; the camera's motion and exposure; this frame's measurements; version; the Clean plate task card |
| **Camera Track** | 1 Choose camera & lens (distortion and profiles folded) · 2 Find & track features (tracker settings folded) · 3 Solve · 4 Review errors (worst tracks, delete, 3D view) · 5 Align to LiDAR *(optional)* · 6 Export (scene orientation and formats folded) | RMS error, focal length, frames solved, confidence, tracks, exported; solve number, nodal, warnings, alignment; task |
| **2D Track** | 1 Draw a surface or point · 2 Track it · 3 Fix drifting frames (corrections, *Hidden by* roto parts) · 4 Preview an insert *(optional)* · 5 Export | Tracks, frames tracked, lowest confidence, lost frames, key frames, exported; the selected track; task |
| **Deliver** | 1 Verify sources (all shots) · 2 Approve (each task, then the shot) · 3 Package (output folder, Mark delivered, Reopen) · 4 Print shot list *(optional)* | Shot status, tasks approved, source check, package version; all shots' totals; history |

Deliver's picture is the package itself, **What goes where**: the shot's
folder path and the eleven package folders, each with the tasks that fill it
(and their states, a click away from their tab) or what the package writes
there (references and checksums, previews, the colour transform and
manifest), unused folders dimmed.

The picture area keeps each module's own overlays: the A/B wipe and contact
sheet (Plates, Key), mattes, paint and the confidence strip (Roto), tracks
coloured by error, rectangles, the error graph and the 3D view (Camera Track),
corner pins, the drop-in and the confidence strip (2D Track). Roto's brush
tools and size sit right above the picture; Next problem and the contact sheet
right below it.

**The AI assistant** is the right panel's second tab on Camera Track and 2D
Track (**Details | AI assistant**), with an **AI assistant** button at the
top of the steps. It stays mounted while hidden, so a run carries on and comes
back as it was. It no longer floats over the viewer.

## 4. The Shots tab

Project head (name; production, day, VFX supervisor and DIT; file and save
state; *Open handoff…*, *Open project…*, *Sample project*), the **What's
here** strip (one card per tab, a line each; a card opens that tab on the
selected shot; *Got it — hide this* is remembered per viewer), the filters,
the shot table and the shot's details on the right (the full panel as before:
approval and packaging, every task including the tracked ones, notes, VFX shot
number, sequence plan, plate colour, camera, source, log), with *Open ‹tab›*
on each task.

The table is set larger (15 px rows, 17 px shot names) and its prep column is
now **Prep and progress**: one icon per module in its state colour (dashed:
not needed), with the required-prep text under it. Approval moved to the
status pill's tooltip.

## 5. Readability

Base type 15 px (was 13), labels ≥ 13 px, details numbers 22–26 px, shot name
26 px; buttons and fields at least 36 px tall, the steps' main actions 46 px;
muted text lightened for contrast on the dark theme. Keyboard shortcuts are in
the tooltips (⌘ on a Mac, Ctrl elsewhere) and the status bar shows the two
that matter most.

Keys: ⌘/Ctrl+1…8 tabs; ⌘/Ctrl+↑/↓ shot; ↑/↓ shot on the Shots tab; ←/→
frame (Shift: ten) in every picture; Space play and B swap in Plates and
Key; Esc back to Shots (in Camera Track it first cancels a picking tool);
Roto's I / E / X, [ ], N, F and Camera Track's 3 and Delete as before.

Toasts (at most three, repeats collapsed, information gone after 5 s, errors
kept until dismissed) are docked at the top of the viewer, under its toolbar,
on every module screen, so they never cover the steps or the details panel
and its Approve buttons. On the Shots tab they sit at the top centre of the
window. Hovering a toast holds it; leaving gives it another 2.5 s.

## 6. First-run tour

The first time a project is open, a four-step tour (`Tour`): Shots is home →
pick a shot → one tab per job → follow the steps. Each step spotlights what
it describes. Skip or Done is remembered (`vcvfx.tour.done`); Help and
Help › Show the Tour bring it back.

## 7. What moved, what went

- The viewer's **View / Roto / Track** sub-tabs are gone: they are the Plates,
  Roto, Camera Track and 2D Track tabs. The Track view's *Camera solve /
  2D planar* switch is gone: they are two tabs.
- The queue no longer narrows beside the viewer (and the « Queue collapse is
  gone): the shot bar's dropdown and prev/next replace it.
- *Verify Sources*, *Print* and *Export PDF* left the top bar for Deliver
  (and stay in the File menu). *Open Handoff* moved to the Shots tab head.
- The shot panel's *View frames*, *Paint roto…* and *Track…* became
  *View frames* and *Open ‹tab›* buttons.
- The frame is the App's, shared by the tabs (moving from Plates to Roto
  stays on the frame), reset to the editorial in-point per shot.

## 8. Code

`renderer/modules.ts` (module definitions, `moduleStatus`, `moduleToOpen`,
per-viewer preferences); `components/Layout.tsx` (tabs, shot bar,
`ModuleLayout`, `StepList`, `Stat`, `TaskMissing`, *What's here*, tour);
`components/Modules.tsx` (Plates, Key, Clean Plate, Deliver); `components/Icons.tsx`;
`RotoWorkspace` and `TrackWorkspace` (`mode: 'camera' | '2d'`) render their
own steps and details into `ModuleLayout`; `Viewer` is the frame viewer only,
its frame controlled by the App; `AiAssistant` renders inline;
`ShotDetail` exports its pieces (`TaskCard`, `ApprovalPanel`, `SequencePlan`,
`PlateColorPanel`, `SourceDetails`, `ShotLog`…). Tests:
`__tests__/layout.test.tsx` (tabs, keys and menu, shot bar, task-missing,
Key and Clean Plate panels, tour and *What's here* persistence); `__tests__/setup.ts` starts
renderer tests with the tour dismissed.
