# Addendum 13 — The prep compositor and the Nuke handoff

Master spec §14 ("a lightweight node-based compositor sufficient to inspect
and combine prep operations … connect prep stages, preview results and
package work for finishing"), MVP priority 17. §19 applies throughout: the
source media is only read, the comp is reproduced from source + graph, its
outputs are versioned, processing never approves, every change is logged,
everything runs on the artist's machine.

The `composite` task becomes available. It is worked on in a new **Comp** tab
between Textures and Camera Track.

## 1. What a comp is

A per-shot document (`ShotState.comp`, `packages/domain/src/comp-schema.ts`;
mutations in `comp.ts`), small and the artist's own work:

- **nodes**: id, type, a Nuke-safe unique name, a position in the graph
  editor, the parameters that differ from the defaults, *bypassed*, a note;
- **edges**: an output into a named input (`{ from, to, input }`, one per
  input), in Nuke's input order (Merge: B, A, mask);
- **viewer**: the two nodes the viewer shows (1 and 2);
- **render settings**: range (null = the shot), the review encode (JPEG, PNG,
  none);
- **renders** and **exports**: one record per task version (folder, patterns,
  frames, size, encoding, the graph revision, the module versions read, how
  long it took, who and when);
- **revision**: bumped by every change that changes pixels.

Pixels — plates, module outputs, the rendered comp — are files, never here.
Project format 8; formats 3–7 open with `comp: null` (tested).

### Node library

One table (`COMP_NODES`) drives validation, the parameters panel and the
Nuke translation. Each node type has its inputs (with the kind each asks
for), its parameters (number / int / enum / bool / colour / 2-vector /
track / roto part, with ranges and defaults; some in plate pixels, scaled
with the proxy), the input a bypassed node passes on (Nuke's input 0) and a
one-line description.

| Category | Nodes |
| --- | --- |
| Image | Read (plate, background reference, or any module output), Write, Constant |
| Module | Roto (a part with its children, or all), Keyer (the despilled foreground, or the alpha), CleanPlate, Isolate (sky or subject: foreground, matte or plate) |
| Merge | Merge (over, under, plus, minus, multiply, screen, stencil, mask, in, out, atop, difference, max, min, average, copy; mix; mask), LightWrap |
| Colour | Grade, ColorCorrect, Saturation, Despill |
| Filter | Blur, Erode |
| Transform | Transform, CornerPin (a planar track — match-move or stabilise — or typed corners), Track (a point track, or a planar track's centre), Crop |
| Channel | Shuffle, Copy, Premult, Unpremult |
| Utility | Switch, Dot |

**Module nodes are references, not re-creations.** Roto, Keyer, CleanPlate
and Isolate are the modules' own results, made by the module with its own
settings: on the desktop they are read from the module's newest export at or
below its task version (the files a vendor receives); a module that has not
been exported says which tab to export from ("The key has not been exported:
Key tab › Export, then the comp can read it"); a module reopened as v002 with
no export yet is read at v001, with a warning. Their settings are changed in
their tab. Despill and LightWrap are real operations in the graph on any
input, with the Key tab's maths (`shared/key/despill.ts`, `look.ts`).

### Kinds and validation

What flows on a connection is **rgb** (opaque colour: a plate), **alpha** (a
matte: alpha meaningful, colour = the matte) or **rgba** (a premultiplied
foreground), inferred from node types, parameters and inputs
(`compOutputKind`; a Transform of an opaque plate exposes transparent black,
so it puts out rgba). An input asks for colour (refuses a bare matte), a
matte (refuses a plate, whose alpha is 1 everywhere), both (LightWrap's fg),
or anything. `validateCompGraph` reports, worst first: loops, connections to
nothing, required inputs not connected, kinds that do not fit, parameters out
of range, missing or wrong-kind tracks, missing roto parts, a Switch on an
unconnected input, a despill asking for a background that is not connected,
the Write node (exactly one), and — as information — nodes the render does
not use. `connectComp` refuses loops and unfit kinds outright. The render and
the export refuse a graph with an error, naming it.

### The suggested graph

`suggestedCompGraph` starts from what the shot has: a key → the key's
foreground, light-wrapped by the background, over the clean plate, the
background reference (handoff or Key tab), or a grey card; a subject or the
sky isolated → the foreground over the plate behind it; roto → the plate with
the roto matte copied into its alpha, premultiplied, over grey; a clean plate
alone → the clean plate; otherwise the plate. Always a Write, the viewer on
the result (1) and the plate (2), laid out as Nuke's autoplace would (the
Write at the bottom, B straight under its Merge).

### Mutations, the log and undo

Every change is a pure, logged mutation — `startComp`, `addCompNode`
(inserted after the selected node as Nuke inserts), `removeCompNodes` (what
went through a deleted node's main input is joined up again), `moveCompNodes`
and `layoutComp` (layout only, no revision), `connectComp`, `disconnectComp`,
`setCompParams` (stores only what differs from the defaults), `resetCompParams`,
`setCompDisabled`, `renameCompNode`, `setCompViewer`, `setCompRenderSettings`,
`restoreCompGraph` (undo), `recordCompRender`, `recordCompExport`. One log
line per change, compact enough that a slider release is one line
(`Grade1.gain 1 → 1.2`, `Merge1.operation over → screen, Merge1.mix 1 → 0.5`).
The workspace keeps the graph before each change (per shot, a hundred deep);
⌘/Ctrl+Z restores it through `restoreCompGraph`, logged as
`comp.undo — undid: Grade1 reset`.

The task rules are the other modules': a change starts the task or reopens a
review for correction; a render or an export puts it up for review; nothing
approves. `approveTask('composite')` needs an export of the task version. An
approved comp refuses every edit until reopened, which bumps the version, so
the next render and export write v002 beside the approved v001.

## 2. The engine (`apps/desktop/src/shared/comp/`)

Pure TypeScript, the same in the desktop (main process for the preview, the
worker for renders) and the browser preview.

- **Pictures** (`image.ts`): four floats a pixel, premultiplied, scene-linear
  in the plates' encoding (ACEScg for converted plates); pixel centres at
  +½, y down. A plate has alpha 1; a matte is (m, m, m, m). Resampling is area
  average when shrinking 2× or more, bilinear otherwise; warps sample
  impulse, bilinear or Catmull–Rom cubic with transparent black outside.
- **Evaluation** (`evaluate.ts`): pull — asking for a node on a frame asks its
  inputs, up to the sources (`CompIO`). Each result is cached under a key of
  the node's type, its filled-in parameters, the scale, its inputs' keys and —
  only where time matters (a moving source, a track) — the frame, plus the
  source's version (export and file time). A parameter change changes that
  node's key and those downstream, so only they are computed again; a
  Constant's key has no frame, so it is made once per shot; a bypassed node's
  key is its main input's. Least-recently-used pictures are dropped past a
  byte budget. Errors name the node (`Keyer1: The key has not been exported…`).
- **Proxy**: the evaluator works at any scale of the plate; parameters in
  plate pixels (translate, blur, erode, light wrap width, despill blur,
  crop softness, tracks) are scaled with it. The preview asks for a 960-px
  long edge (480 in the browser), halved with *Proxy*. Region-limited
  evaluation is not done (see §9).
- **Maths** (`ops.ts`): every Merge operation on every channel, alpha
  included, then blended back towards B by mix × the mask's alpha (Nuke's
  definitions; screen is A + B − AB while both are 0…1, else the larger);
  Grade is Nuke's (A = multiply·(gain − lift)/(whitepoint − blackpoint),
  B = offset + lift − A·blackpoint, then ^1/gamma for positive values, black
  and white clamps, optional unpremult; *exposure* scales the multiply by
  2^stops, so it translates exactly); ColorCorrect in Nuke's order
  (saturation, contrast about 0.18, gamma, gain, offset); Saturation about
  Rec.709 luminance (as Nuke); Transform about its centre, scale then rotate
  (counter-clockwise on screen) then translate; CornerPin by the homography
  of four corners (from a planar track: the reference frame's corners onto
  the frame's to match-move, the other way to stabilise; tracked points are
  pixel indices, so +½); Track by the point's (or the planar centre's)
  offset from the reference frame; Blur as three box passes approximating a
  gaussian of σ = size / 2.355; Erode as a separable min (or max for a
  negative size), a fractional size blending the two nearest radii; Shuffle,
  Copy, Premult, Unpremult (alpha 0 left as is), Crop (feathered inwards),
  Constant, Switch, Dot. The mask input of colour and filter nodes blends the
  result back towards the input.

## 3. Rendering and exporting (`apps/desktop/src/main/comp/`)

`io.ts` reads the sources: the plate as the other modules read it (newest
plates, else the source, decoded to linear by the colour module); module
exports from the shot package (RGBA EXR as written; RGB files read as RGB and
RGBA as RGBA — ffmpeg's RGB → RGBA float conversion clips above 1, which a
test caught); a PNG matte's grey as alpha; the background reference as the
Key tab reads it. Everything only read.

**Render** (`render.ts`, in the comp worker, progress and cancel): the Write
node at plate resolution over the range, as

    08_PREVIEWS/<shot>_comp_vNNN/<shot>_comp_vNNN.%04d.exr          half float, ZIP16, linear, premultiplied, no look
    08_PREVIEWS/<shot>_comp_vNNN/<shot>_comp_review_vNNN.%04d.jpg   review encode, Rec.709 (approx.) view

The rendered comp is a preview of how the prep fits together — not a final,
which is the vendor's — so it goes to `08_PREVIEWS`, not `10_DELIVERY`. The
review encode goes through the viewer's own view transform and says so; no
look is in any EXR or plate.

**Export** (needs the render of this version and revision; in the worker for
the baking):

    09_PROJECT_DATA/<shot>_comp_vNNN/
      <shot>_comp_vNNN.vcvfxcomp.json      the graph: every node, parameter and connection
      <shot>_comp_vNNN.nk                  the Nuke script
      <shot>_comp_vNNN_manifest.json       the graph manifest
      baked/<shot>_comp_<node>_vNNN.%04d.exr   Despill / LightWrap as VC VFX rendered them
      README.txt

The graph and its renders go with the task's folder (`09_PROJECT_DATA`, as
`tasks.ts` files it); the rendered sequence with the previews.

Versioned, never overwritten: an approved version on disk is refused in both
folders; an unapproved one has only its own files cleared and written again.
The output root is refused when it is inside a source media folder (§19).

## 4. The Nuke translation (`shared/comp/nuke.ts`)

The script mirrors the graph node for node, positions as xpos/ypos (× 0.75),
`disable true` for bypassed nodes, notes as labels. Paths are relative to the
script (`[file dirname [value root.name]]/../../03_KEYS/…`), so the package
can move; a camera file read straight from the drive is absolute. Root:
first/last frame, fps, the plate format, OCIO with the aces_1.2 config and
the working space when the plates are linear.

| VC VFX | Nuke | Notes |
| --- | --- | --- |
| Read (plate, module output) | Read | colourspace from the plates' colour record (ACEScg → `ACES - ACEScg`, ACES2065-1, linear Rec.709 → `Utility - Linear - sRGB`); a matte PNG `raw true` + Shuffle (red → rgba); a still: hold before/after + Reformat (distort) to the plate format; premultiplied RGBA EXRs `premultiplied true` |
| Roto / Keyer / CleanPlate / Isolate | Read of the module's export | + a StickyNote naming the VC VFX node and the module's settings ("The module's own exported, versioned output is read here; change it in VC VFX's Key tab") |
| Despill, LightWrap | Read of `baked/…` | no Nuke class does the same maths: VC VFX renders the node and the script reads it; its inputs stay in the script, unconnected; StickyNote with every parameter; listed as *baked* |
| Write | Write | EXR, 16-bit half, Zip (16 scanlines), the working colourspace, the render range — into `nuke_render/` beside the script, never over VC VFX's render |
| Merge | Merge2 | operation by name, mix, mask (`maskChannelInput rgba.alpha`), inputs B, A, mask |
| Grade | Grade | blackpoint, whitepoint, black (lift), white (gain), multiply (× 2^exposure), add (offset), gamma, clamps, `unpremult rgba.alpha` |
| ColorCorrect | ColorCorrect | master saturation, contrast, gamma, gain, offset |
| Saturation | Saturation | `mode "Rec 709"` |
| Transform | Transform | translate y negated, centre y flipped (Nuke is y-up), rotate as is; cubic → Keys (Catmull–Rom), impulse → Impulse, bilinear → Cubic (listed) |
| CornerPin | CornerPin2D | to1…to4 keyed every frame of the range from the track (y-up, +½), from1…from4 the reference frame's corners (swapped to stabilise); typed corners as constants |
| Track | Transform | translate keyed every frame (signs per mode), centre at the reference point |
| a mask on Transform / CornerPin / Track | Keymix | Nuke's Transform has no mask: Keymix (B = the input, A = the moved, mask) is the same blend |
| Blur | Blur | size; channels rgba / alpha; listed (three-box vs Nuke's gaussian) |
| Erode | FilterErode | size, channels; listed (square min/max vs Nuke's filter) |
| Shuffle | Shuffle | red/green/blue/alpha/black/white |
| Copy | Copy | `from0` / `to0` |
| Premult, Unpremult, Crop, Constant, Switch, Dot | the same | Crop's box in y-up pixels, `reformat false`, `crop true` |

The .nk text is a stack machine: each node pushes itself, a node with
`inputs N` takes the top N, input 0 on top. So inputs are written last to
first, a missing one as `push 0`, and a node used twice is named with
`set N… [stack 0]` and pushed again with `push $N…`. Sticky notes are nodes
too, so they are all written first. `parseNukeTopology` runs that stack
machine to read a script back; the tests check that the topology of the
written script is the graph's (inputs in order, Merge2 B as input 0 and A as
input 1, masks, Keymix, shared nodes, the module and baked Reads).

**The graph manifest** (`shared/comp/manifest.ts`), written always: every node
with every parameter and how it was translated (`native`, `module-output`,
`baked`, `approximate`, `bypassed`) and the Nuke node carrying its output;
the connections in Nuke's input order; the viewer and render settings; the
module versions read; every asset — each source frame in the render's range,
the baked sequences, the render and the review, the graph and the script —
with its SHA-256 and size (a camera original is listed by path only; the
handoff's checksums cover it); the tracks used; colour; and the list of what
the script does not carry exactly, also in the README.

## 5. The Comp tab

Steps (left): **1 Start the graph** (from the suggested graph, its nodes
named, or empty: Read → Write) · **2 Edit the graph** (the keys; every
problem as a link that selects its node) · **3 Preview** (1 and 2, proxy, the
time and how many nodes were computed or taken from the cache) · **4 Render**
(range, review encode) · **5 Export for Nuke**.

Centre, split and resizable: the **viewer** (1, 2, A/B wipe with the line
dragged, RGB / alpha, timeline) above the **node graph** (plain React and
SVG, no new dependency): nodes coloured by category, inputs on the top edge
and the output at the bottom as Nuke draws them, connections coloured by
what they carry (colour, colour + alpha, matte), red / amber outlines on
nodes with errors / warnings, dimmed nodes the render does not use, a
diagonal stroke on bypassed nodes, 1 / 2 badges on the viewed ones. Drag a
node (or the selection) to move it; drag the background to pan; the wheel
zooms about the pointer; drag from an output onto an input (or onto a node:
its first free input); drag a connected input away to move or drop the
connection. **Tab** opens the searchable add-node menu (at the pointer;
inserted after the selected node), **D** bypasses, **Delete** removes, **1** /
**2** view, **L** lays out, **F** frames, **⌘/Ctrl+Z** undoes; the same as
buttons.

Details (right): the selected node's **parameters** — name, bypass, view as
1 / 2, every parameter (sliders, number fields, menus, the shot's 2D tracks
and roto parts) with its own reset and *Reset all*, only those that apply
(typed corners when typed), what it reads and its problems — then nodes,
problems, preview time, rendered; version, graph revision, export, plate,
colour; the module outputs read; the task card and history.

**Browser preview** (`renderer/comp-preview.ts`): on the sample's green-screen
shot (010_020, after *Add Comp to this shot*) the graph is evaluated in the
page by the same evaluator: the plate is the Key tab's synthetic shot, the
Keyer is the key engine with the Key tab's settings (or its Auto key), the
background the night street, Roto the sample's matte. Rendering and exporting
say they are the desktop app's.

## 6. Tabs

Eleven tabs now; see addendum 08 §1 for the digits (Textures has none) and
the narrower toolbar (short labels from 1360 px).

## 7. Measured

Engine, one core, synthetic 1920 × 1080 green-screen frames in memory
(`greenScreenScene`), the suggested graph (key foreground → light wrap → over
the background → Write):

| | 1920 × 1080 | 960 × 540 (preview) | 480 × 270 (proxy) |
| --- | --- | --- | --- |
| a new frame | 578 ms (1.7 fps) | 138 ms (7.3 fps) | 42 ms (24 fps) |
| light-wrap parameter changed | 851 ms | 129 ms | 34 ms |
| Merge mix changed (only the Merge and the Write) | 142 ms | 28 ms | 10 ms |
| + Grade, Transform (cubic), Blur — a new frame | 2097 ms (0.5 fps) | 420 ms (2.4 fps) | 114 ms (8.7 fps) |

The light wrap (two gaussians) is the expensive node; a change downstream of
it costs a sixth of a frame. In the browser preview (the key engine included,
480-px source, 240-px proxy): the first picture 2.4–2.7 s (the screen model
and the first key), each new frame 315–490 ms (the key engine on the new
frame), a light-wrap change 27–28 ms (2 nodes computed, 4 from the cache).

Rendering through the worker with real ffmpeg, the suggested graph reading
the key's EXR export and an EXR background: 192 × 108, 6 frames in 0.5–1.0 s
(worker start included); 1920 × 1080, 8 frames in 13.4 s (0.6 fps, EXR and
JPEG encode and the source reads included). The rendered EXR equals the same
graph evaluated in process to half-float precision (< 2·10⁻³ relative), the
background is exact outside the subject, the subject opaque inside.

## 8. Tests

- Domain (`packages/domain/src/__tests__/comp.test.ts`): every node type
  described; the suggested graph for each kind of shot and its layout;
  adding (insert after), connecting (loops and kinds refused, replacing),
  compact parameter logging, defaults not stored, reset, bypass, rename,
  move without a revision, delete joining through, undo; validation (loops,
  missing inputs, kinds, tracks, Writes); kind inference; module references
  (exports only, which tab, an older version noted); renders and exports
  (revision checks, review), approval needing the export, approved locked,
  v002; the manifest section and graph data; formats 3–7 open, a round trip.
- Engine (`shared/__tests__/comp-engine.test.ts`): every Merge operation
  against the reference formulas on all four channels; premultiplied over
  against the straight blend, mask and mix; Grade; Transform (exact
  translate, the turn's direction); corner pin = the homography of its
  corners, a planar track match-moving, stabilising and at a proxy; blur
  keeps the total and spreads by σ; erode / dilate / fractional areas; the
  cache — a Grade change recomputes the Grade, Merge and Write only, the
  plate and foreground hit, returning to the old settings computes nothing, a
  Constant is made once over two frames; bypass from the cache; proxy size;
  errors naming the node; the Nuke script against a golden file
  (`fixtures/comp-golden.nk`) and read back (Merge2 B / A order, masks, Grade
  knobs, CornerPin2D curves y-up, raw matte + Shuffle, module and baked Reads,
  Reformat for a still, Transform y flip, Keymix for a masked transform, a
  shared node pushed again, a missing A as `push 0`).
- Main, real ffmpeg (`main/__tests__/comp.test.ts`): session and sources;
  preview at half size (5 nodes computed, then 2 after a light-wrap change);
  output root among the media refused; export before a render refused; the
  render in the worker read back (equal to in-process evaluation, background
  exact outside the subject, RGBA half); the export (files, the script read
  back, the baked light wrap, the manifest's translations and checksums, the
  README); approved never rewritten; the missing-export messages.
- Renderer (`renderer/__tests__/comp.test.tsx`, jsdom, the browser preview's
  engine): start from the suggestion, the preview's counts, select a node and
  change and reset a parameter (logged), Tab menu insert after, drag to
  connect (logged with what it replaced), D, 2, Delete joining through,
  ⌘/Ctrl+Z (logged), drag to move; the compositing of A, B, wipe and alpha.
  `layout.test.tsx`: eleven tabs, each tab's digit, the View menu command.

## 9. Limits

- The end-to-end comp's script passes an offline structural check
  ([addendum 15](addendum-15-verification.md), `verify-package-nk.py`):
  Nuke's classes and input counts, the stack (Merge1: B the clean plate, A the
  baked light wrap), curve syntax, every Read's file present. OpenEXR reads
  the render as RGBA half ZIP16, premultiplied. Still not Nuke.
- **Not checked against a running Nuke.** No Nuke here. The script follows
  the .nk format as documented and as other exporters here write it, and its
  stack topology is verified by our own reader; the knob names (`black`,
  `white`, `add`, `maskChannelInput`, `mode "Rec 709"`, Keymix's
  `maskChannel`, CornerPin2D `to1…from4`, Shuffle's `red/green/blue/alpha`)
  and the aces_1.2 OCIO names are from knowledge of Nuke 13, not from loading
  the script. The first real handoff should be opened in Nuke and checked.
- Module nodes on the desktop need the module's export; they do not re-run
  the module (that keeps the comp equal to what the vendor receives, and is
  why Despill and LightWrap — which are re-run — are baked for Nuke).
- No region-of-interest evaluation: every node computes the whole frame at
  the chosen scale. A 1080p render of a heavier graph is under 1 fps on one
  core; the preview stays interactive through the proxy and the cache.
- Blur and Erode approximate Nuke's filters (listed in the manifest); a
  bilinear transform filter becomes Nuke's Cubic.
- No animation of parameters (a track is the only thing that moves); no
  multi-channel layers beyond RGBA; one Write per comp; no 3D.
- A camera file read as the plate (no plates generated) is written as an
  absolute, raw Read; generate plates for a portable script.
- The browser preview evaluates the sample's green-screen shot only; on other
  sample shots it says so.
