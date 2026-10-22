import { COMP_NODES, compInput, compNodeParams, compSourceOf, type ColorEncodingId, type CompDocument, type CompKind, type CompNode, type Track2d } from '@vcvfx/domain';
import { trackPointsAt, trackReference } from './ops';

/**
 * The comp as a Nuke script (master spec §14 "export/translation path toward
 * Nuke"; addendum 13 §6).
 *
 * The graph is written node for node with Nuke's own classes where they
 * exist — Read, Write, Merge2 (operation, mix, mask), Grade, ColorCorrect,
 * Saturation, Transform, CornerPin2D, Blur, FilterErode, Shuffle, Copy,
 * Premult, Unpremult, Crop, Constant, Switch, Dot (Keymix for a mask on a
 * transform, which Nuke's Transform lacks). What Nuke has no class for is not
 * re-created: the Roto, Keyer, Clean Plate and Isolate nodes Read the
 * module's exported, versioned files; the Despill and LightWrap nodes Read
 * their output as VC VFX rendered it ("baked"); each with a sticky note
 * naming the VC VFX node and its settings. Positions become xpos/ypos.
 *
 * The .nk text format is a stack machine: each node pushes itself; a node
 * with `inputs N` takes the top N entries, input 0 on top. So a node's
 * inputs are written last-to-first (input 0 last, just above the node),
 * a missing one as `push 0`, and a node used more than once is named with
 * `set N… [stack 0]` and pushed again with `push $N…`.
 *
 * Paths are written relative to the script (`[file dirname [value
 * root.name]]/…`), so the package can move. Colour: OCIO (aces_1.2 names)
 * on every Read and the Write, consistent with the plates' colour record;
 * mattes and PNGs are read raw.
 */

export interface NukeSource {
  /** Path as written into the script: relative to the script's folder, or absolute (a camera file on the drive). */
  path: string;
  relative: boolean;
  first: number;
  last: number;
  still: boolean;
  /** How the pixels are: colour, a one-channel matte (shuffled to alpha), premultiplied RGBA. */
  kind: CompKind;
  /** The file's encoding (null: code values / unknown / a matte: read raw). */
  encoding: ColorEncodingId | null;
  label: string;
}

export interface NukeInfo {
  shot: string;
  version: number;
  generator: string;
  writtenAt: string;
  fps: number;
  first: number;
  last: number;
  width: number;
  height: number;
  /** The working encoding (the plates'); null: unknown, no colour management written. */
  working: ColorEncodingId | null;
  /** Per node id: where a Read (or a module node) reads. */
  sources: ReadonlyMap<string, NukeSource>;
  /** Per node id: a node rendered by VC VFX and read back (Despill, LightWrap). */
  baked: ReadonlyMap<string, NukeSource>;
  /** Where the script's Write renders (relative to the script): never VC VFX's own render. */
  writePath: string;
  tracks: ReadonlyMap<string, Track2d>;
  /** A one-line summary of a module's settings for its sticky note, per node id. */
  moduleNotes?: ReadonlyMap<string, string>;
}

export interface NukeScript {
  text: string;
  /** What the script does not carry exactly, one line each. */
  untranslated: string[];
  /** Per VC VFX node: the Nuke class it became and the name of the Nuke node carrying its output. */
  nodes: { id: string; name: string; type: string; nukeClass: string; output: string; translation: 'native' | 'module-output' | 'baked' | 'approximate' | 'bypassed' }[];
}

/** OCIO colourspace names in the aces_1.2 config. */
export const OCIO_NAMES: Partial<Record<ColorEncodingId, string>> = {
  acescg: 'ACES - ACEScg',
  aces2065_1: 'ACES - ACES2065-1',
  linear_rec709: 'Utility - Linear - sRGB',
  srgb: 'Output - sRGB',
  rec709: 'Output - Rec.709',
};

const num = (v: number, d = 6) => {
  if (!Number.isFinite(v)) return '0';
  const s = v.toFixed(d);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};
const q = (s: string) => `"${s.replace(/\\/g, '/').replace(/"/g, "'")}"`;
const pathKnob = (s: NukeSource) => (s.relative ? `"[file dirname [value root.name]]/${s.path.replace(/"/g, "'")}"` : q(s.path));
/** printf %04d is what Nuke reads too; kept. */

const TAB: Record<string, string> = { roto: 'Roto', key: 'Key', clean_plate: 'Clean Plate', sky_replacement: 'Sky & BG', texture_extraction: 'Textures' };
const FILTERS: Record<string, string> = { impulse: 'Impulse', bilinear: 'Cubic', cubic: 'Keys' };
const SHUFFLE_NAMES: Record<string, string> = { r: 'red', g: 'green', b: 'blue', a: 'alpha', '0': 'black', '1': 'white' };
const CHANNEL: Record<string, string> = { r: 'rgba.red', g: 'rgba.green', b: 'rgba.blue', a: 'rgba.alpha' };

function curve(frames: number[], values: number[]): string {
  return `{curve ${frames.map((f, i) => `x${f} ${num(values[i]!, 4)}`).join(' ')}}`;
}

export function writeCompNuke(doc: Pick<CompDocument, 'nodes' | 'edges'>, info: NukeInfo): NukeScript {
  const out: string[] = [];
  const untranslated: string[] = [];
  const nodesOut: NukeScript['nodes'] = [];
  const yUp = (y: number) => info.height - y;
  const consumers = new Map<string, number>();
  for (const e of doc.edges) consumers.set(e.from, (consumers.get(e.from) ?? 0) + 1);
  const written = new Set<string>();
  const varName = (id: string) => `N${id}`;
  const frames: number[] = [];
  for (let f = info.first; f <= info.last; f += 1) frames.push(f);
  const pos = (n: CompNode, dx = 0, dy = 0) => [` xpos ${Math.round(n.x * 0.75 + dx)}`, ` ypos ${Math.round(n.y * 0.75 + dy)}`];
  const colourKnobs = (s: NukeSource) => {
    if (s.kind === 'alpha' || !s.encoding) return [' raw true'];
    const name = OCIO_NAMES[s.encoding];
    return name ? [` colorspace ${q(name)}`] : [' raw true'];
  };
  // Sticky notes are nodes too (they push onto the stack), so they are all written first, before the graph.
  const notes: string[] = [];
  const sticky = (n: CompNode, text: string) => {
    notes.push('StickyNote {', ' inputs 0', ` name ${n.name}_note`, ` label ${q(text)}`, ' note_font_size 14', ...pos(n, 120, -10), '}');
  };
  const readNode = (n: CompNode, s: NukeSource, disabled: boolean): string => {
    const name = n.name;
    const fit = s.still;
    const alpha = s.kind === 'alpha';
    const readName = fit || alpha ? `${name}_read` : name;
    out.push(
      'Read {',
      ' inputs 0',
      ` file ${pathKnob(s)}`,
      ` format "${info.width} ${info.height} 0 0 ${info.width} ${info.height} 1 ${info.shot}_plate"`,
      ` first ${s.still ? 1 : s.first}`,
      ` last ${s.still ? 1 : s.last}`,
      ` origfirst ${s.still ? 1 : s.first}`,
      ` origlast ${s.still ? 1 : s.last}`,
      ' origset true',
      ...(s.still ? [' before hold', ' after hold'] : []),
      ' on_error black',
      ...colourKnobs(s),
      ...(s.kind === 'rgba' ? [' premultiplied true'] : []),
      ...(disabled ? [' disable true'] : []),
      ` name ${readName}`,
      ` label ${q(s.label)}`,
      ...pos(n, 0, alpha && fit ? -80 : fit || alpha ? -40 : 0),
      '}',
    );
    let last = readName;
    if (fit) {
      const fitName = alpha ? `${name}_fit` : name;
      out.push('Reformat {', ` format "${info.width} ${info.height} 0 0 ${info.width} ${info.height} 1 ${info.shot}_plate"`, ' resize distort', ` name ${fitName}`, ...pos(n, 0, alpha ? -40 : 0), '}');
      last = fitName;
    }
    if (alpha) {
      // A matte file reads as grey: its red becomes the alpha, and the colour the matte (premultiplied white), as the comp holds it.
      out.push('Shuffle {', ' red red', ' green red', ' blue red', ' alpha red', ` name ${name}`, ` label "matte to alpha"`, ...pos(n), '}');
      last = name;
    }
    return last;
  };

  /** Write node `id` (and, first, what it needs); leaves exactly one entry on the stack. */
  const emit = (id: string) => {
    if (written.has(id)) {
      out.push(`push $${varName(id)}`);
      return;
    }
    const n = doc.nodes.find((x) => x.id === id);
    if (!n) {
      out.push('push 0');
      return;
    }
    const info0 = COMP_NODES[n.type];
    const p = compNodeParams(n);
    const source = compSourceOf(n);
    const baked = info.baked.get(n.id);
    const record = (nukeClass: string, output: string, translation: NukeScript['nodes'][number]['translation']) => nodesOut.push({ id: n.id, name: n.name, type: n.type, nukeClass, output, translation });

    // Inputs a Nuke node takes, in Nuke's order.
    const pushInputs = (names: (string | null)[]) => {
      let count = names.length;
      while (count > 0 && (names[count - 1] === null || !compInput(doc, n.id, names[count - 1]!))) count -= 1;
      for (let i = count - 1; i >= 0; i -= 1) {
        const name = names[i];
        const src = name ? compInput(doc, n.id, name) : undefined;
        if (src) emit(src.id);
        else out.push('push 0');
      }
      return count;
    };
    const head = (cls: string, inputs: number, extra: string[]) => {
      out.push(`${cls} {`, ...(inputs !== 1 ? [` inputs ${inputs}`] : []), ...extra, ...(n.disabled ? [' disable true'] : []), ` name ${n.name}`, ...(n.note ? [` label ${q(n.note)}`] : []), ...pos(n), '}');
    };
    const maskKnobs = (count: number) => (count >= 2 ? [' maskChannelInput rgba.alpha'] : []);

    if (source) {
      const s = info.sources.get(n.id);
      if (!s) {
        out.push('Constant {', ' inputs 0', ' color {0 0 0 0}', ` name ${n.name}`, ` label ${q('VC VFX could not resolve this source')}`, ...pos(n), '}');
        untranslated.push(`${n.name}: its source was not available when the script was written (a black Constant stands in).`);
        record('Constant', n.name, 'approximate');
      } else {
        const last = readNode(n, s, n.disabled);
        if (info0.module) sticky(n, `VC VFX ${info0.label} node ${n.name}: ${s.label}${info.moduleNotes?.get(n.id) ? `\n${info.moduleNotes.get(n.id)}` : ''}\nThe module's own exported, versioned output is read here; change it in VC VFX's ${TAB[info0.module] ?? info0.label} tab.`);
        record('Read', last, info0.module ? 'module-output' : 'native');
      }
    } else if (baked && !n.disabled) {
      // No Nuke class: what VC VFX rendered for this node is read back. Its inputs stay in the script, unconnected (written at the end).
      const last = readNode(n, baked, false);
      const settings = info0.params.map((x) => `${x.key} ${JSON.stringify(p[x.key])}`).join(', ');
      sticky(n, `VC VFX ${info0.label} node ${n.name} (${settings})\nNuke has no ${info0.label} node: this Read is VC VFX's render of it (baked), made from the inputs drawn above it.`);
      untranslated.push(`${n.name} (${info0.label}): no Nuke node; baked — VC VFX's render of it is read (${baked.path}).`);
      record('Read', last, 'baked');
    } else {
      switch (n.type) {
        case 'write': {
          const count = pushInputs(['src']);
          const enc = info.working;
          head('Write', count, [
            ` channels ${p['channels'] === 'rgb' ? 'rgb' : 'rgba'}`,
            ` file "[file dirname [value root.name]]/${info.writePath}"`,
            ' file_type exr',
            ' datatype "16 bit half"',
            ' compression "Zip (16 scanlines)"',
            ...(enc && OCIO_NAMES[enc] ? [` colorspace ${q(OCIO_NAMES[enc]!)}`] : [' raw true']),
            ' create_directories true',
            ' use_limit true',
            ` first ${info.first}`,
            ` last ${info.last}`,
          ]);
          record('Write', n.name, 'native');
          break;
        }
        case 'dot': {
          head('Dot', pushInputs(['src']), []);
          record('Dot', n.name, 'native');
          break;
        }
        case 'merge': {
          const count = pushInputs(['B', 'A', 'mask']);
          head('Merge2', count, [` operation ${String(p['operation'])}`, ...(count >= 3 ? [' maskChannelInput rgba.alpha'] : []), ...(Number(p['mix']) !== 1 ? [` mix ${num(Number(p['mix']))}`] : [])]);
          record('Merge2', n.name, 'native');
          break;
        }
        case 'grade': {
          const count = pushInputs(['src', 'mask']);
          const mult = Number(p['multiply']) * 2 ** Number(p['exposure']);
          head('Grade', count, [
            ` blackpoint ${num(Number(p['blackpoint']))}`,
            ` whitepoint ${num(Number(p['whitepoint']))}`,
            ` black ${num(Number(p['lift']))}`,
            ` white ${num(Number(p['gain']))}`,
            ` multiply ${num(mult)}`,
            ` add ${num(Number(p['offset']))}`,
            ` gamma ${num(Number(p['gamma']))}`,
            ` black_clamp ${p['blackClamp'] ? 'true' : 'false'}`,
            ` white_clamp ${p['whiteClamp'] ? 'true' : 'false'}`,
            ...(p['unpremult'] ? [' unpremult rgba.alpha'] : []),
            ...maskKnobs(count),
          ]);
          record('Grade', n.name, 'native');
          break;
        }
        case 'colorcorrect': {
          const count = pushInputs(['src', 'mask']);
          head('ColorCorrect', count, [` saturation ${num(Number(p['saturation']))}`, ` contrast ${num(Number(p['contrast']))}`, ` gamma ${num(Number(p['gamma']))}`, ` gain ${num(Number(p['gain']))}`, ` offset ${num(Number(p['offset']))}`, ...(p['unpremult'] ? [' unpremult rgba.alpha'] : []), ...maskKnobs(count)]);
          record('ColorCorrect', n.name, 'native');
          break;
        }
        case 'saturation': {
          const count = pushInputs(['src', 'mask']);
          head('Saturation', count, [` saturation ${num(Number(p['saturation']))}`, ' mode "Rec 709"', ...maskKnobs(count)]);
          record('Saturation', n.name, 'native');
          break;
        }
        case 'blur': {
          const count = pushInputs(['src', 'mask']);
          head('Blur', count, [` channels ${p['channels'] === 'alpha' ? 'alpha' : 'rgba'}`, ` size ${num(Number(p['size']))}`, ...maskKnobs(count)]);
          untranslated.push(`${n.name} (Blur): Nuke's gaussian is matched by size; VC VFX's three-box approximation differs from it by a few per cent on the falloff.`);
          record('Blur', n.name, 'approximate');
          break;
        }
        case 'erode': {
          const count = pushInputs(['src', 'mask']);
          head('FilterErode', count, [` channels ${p['channels'] === 'rgba' ? 'rgba' : 'alpha'}`, ` size ${num(Number(p['size']))}`, ...maskKnobs(count)]);
          untranslated.push(`${n.name} (Erode → FilterErode): VC VFX erodes with a square min/max; Nuke's FilterErode with its filter, so edges differ slightly.`);
          record('FilterErode', n.name, 'approximate');
          break;
        }
        case 'shuffle': {
          head('Shuffle', pushInputs(['src']), [` red ${SHUFFLE_NAMES[String(p['r'])]}`, ` green ${SHUFFLE_NAMES[String(p['g'])]}`, ` blue ${SHUFFLE_NAMES[String(p['b'])]}`, ` alpha ${SHUFFLE_NAMES[String(p['a'])]}`]);
          record('Shuffle', n.name, 'native');
          break;
        }
        case 'copy': {
          head('Copy', pushInputs(['B', 'A']), [` from0 ${CHANNEL[String(p['from'])]}`, ` to0 ${CHANNEL[String(p['to'])]}`]);
          record('Copy', n.name, 'native');
          break;
        }
        case 'premult':
        case 'unpremult': {
          const cls = n.type === 'premult' ? 'Premult' : 'Unpremult';
          head(cls, pushInputs(['src']), []);
          record(cls, n.name, 'native');
          break;
        }
        case 'crop': {
          const [x0, y0] = p['min'] as number[];
          const [x1, y1] = p['max'] as number[];
          head('Crop', pushInputs(['src']), [` box {${num(x0! * info.width, 3)} ${num(yUp(y1! * info.height), 3)} ${num(x1! * info.width, 3)} ${num(yUp(y0! * info.height), 3)}}`, ` softness ${num(Number(p['softness']))}`, ' reformat false', ' crop true']);
          record('Crop', n.name, 'native');
          break;
        }
        case 'constant': {
          const c = p['color'] as number[];
          head('Constant', 0, [` color {${c.map((v) => num(v)).join(' ')}}`, ` format "${info.width} ${info.height} 0 0 ${info.width} ${info.height} 1 ${info.shot}_plate"`]);
          record('Constant', n.name, 'native');
          break;
        }
        case 'switch': {
          const count = pushInputs(['in0', 'in1', 'in2', 'in3']);
          head('Switch', count, [` which ${Math.round(Number(p['which']))}`]);
          record('Switch', n.name, 'native');
          break;
        }
        case 'transform':
        case 'cornerpin':
        case 'track': {
          const mask = compInput(doc, n.id, 'mask');
          // Nuke's Transform and CornerPin2D have no mask: a Keymix (B = the input, A = the moved, mask) does it exactly.
          const src = compInput(doc, n.id, 'src');
          if (mask) emit(mask.id);
          if (src) {
            emit(src.id);
            if (mask && (consumers.get(src.id) ?? 0) <= 1) out.push(`set ${varName(src.id)} [stack 0]`);
          } else out.push('push 0');
          const filter = String(p['filter']);
          if (filter === 'bilinear') untranslated.push(`${n.name}: bilinear filtering has no Nuke equivalent; Nuke's Cubic is used.`);
          const xformName = mask ? `${n.name}_moved` : n.name;
          const knobs: string[] = [];
          let cls = 'Transform';
          if (n.type === 'transform') {
            const t = p['translate'] as number[];
            const c = p['center'] as number[];
            const s = p['scale'] as number[];
            knobs.push(` translate {${num(t[0]!)} ${num(-t[1]!)}}`, ` rotate ${num(Number(p['rotate']))}`, ` scale {${num(s[0]!)} ${num(s[1]!)}}`, ` center {${num(c[0]! * info.width)} ${num(yUp(c[1]! * info.height))}}`, ...(p['invert'] ? [' invert_matrix true'] : []), ` filter ${FILTERS[filter]}`);
          } else if (n.type === 'cornerpin') {
            cls = 'CornerPin2D';
            const order = [3, 2, 1, 0]; // to1 BL, to2 BR, to3 TR, to4 TL (our corners: TL, TR, BR, BL)
            if (p['source'] === 'manual') {
              const corners = (['to1', 'to2', 'to3', 'to4'] as const).map((k) => p[k] as number[]);
              const fromFrame = [
                [0, 0],
                [info.width, 0],
                [info.width, info.height],
                [0, info.height],
              ];
              order.forEach((ci, k) => knobs.push(` to${k + 1} {${num(corners[ci]![0]! * info.width)} ${num(yUp(corners[ci]![1]! * info.height))}}`));
              order.forEach((ci, k) => knobs.push(` from${k + 1} {${num(fromFrame[ci]![0]!)} ${num(yUp(fromFrame[ci]![1]!))}}`));
            } else {
              const t = info.tracks.get(String(p['track']));
              if (!t) {
                untranslated.push(`${n.name}: its track “${String(p['track'])}” is missing; the CornerPin2D is left at identity.`);
              } else {
                const ref = trackPointsAt(t, trackReference(t, Math.round(Number(p['reference']))))!;
                const per = frames.map((f) => trackPointsAt(t, f)!);
                const X = (pt: readonly number[]) => pt[0]! + 0.5;
                const Y = (pt: readonly number[]) => yUp(pt[1]! + 0.5);
                const moving = order.map((ci) => `{${curve(frames, per.map((ps) => X(ps[ci]!)))} ${curve(frames, per.map((ps) => Y(ps[ci]!)))}}`);
                const still = order.map((ci) => `{${num(X(ref[ci]!), 4)} ${num(Y(ref[ci]!), 4)}}`);
                const [to, from] = p['mode'] === 'stabilise' ? [still, moving] : [moving, still];
                to.forEach((v, k) => knobs.push(` to${k + 1} ${v}`));
                from.forEach((v, k) => knobs.push(` from${k + 1} ${v}`));
              }
            }
            knobs.push(` filter ${FILTERS[filter]}`);
          } else {
            const t = info.tracks.get(String(p['track']));
            if (!t) untranslated.push(`${n.name}: its track “${String(p['track'])}” is missing; the Transform is left at identity.`);
            else {
              const ref = trackPointsAt(t, trackReference(t, Math.round(Number(p['reference']))))!;
              const mean = (ps: readonly (readonly number[])[]) => {
                const use = t.kind === 'point' ? ps.slice(0, 1) : ps;
                return [use.reduce((s, x) => s + x[0]!, 0) / use.length, use.reduce((s, x) => s + x[1]!, 0) / use.length];
              };
              const r = mean(ref);
              const sign = p['mode'] === 'stabilise' ? -1 : 1;
              const per = frames.map((f) => mean(trackPointsAt(t, f)!));
              knobs.push(` translate {${curve(frames, per.map((c) => sign * (c[0]! - r[0]!)))} ${curve(frames, per.map((c) => -sign * (c[1]! - r[1]!)))}}`, ` center {${num(r[0]! + 0.5)} ${num(yUp(r[1]! + 0.5))}}`, ` filter ${FILTERS[filter]}`);
            }
          }
          out.push(`${cls} {`, ...knobs, ...(n.disabled ? [' disable true'] : []), ` name ${xformName}`, ` label ${q(n.type === 'transform' ? 'image y down in VC VFX; y-up here' : `${n.type === 'track' ? 'track' : 'corner pin'} ${String(p['track'] ?? '')} ${String(p['mode'] ?? '')}`.trim())}`, ...pos(n), '}');
          if (mask) {
            out.push(src ? `push $${varName(src.id)}` : 'push 0');
            out.push('Keymix {', ' inputs 3', ' maskChannel rgba.alpha', ...(n.disabled ? [' disable true'] : []), ` name ${n.name}`, ` label "mask of ${n.name}"`, ...pos(n, 0, 40), '}');
          }
          record(cls, n.name, filter === 'bilinear' ? 'approximate' : 'native');
          break;
        }
        case 'despill':
        case 'lightwrap': {
          // Bypassed (else it would be baked): a Dot on its main input does exactly that.
          const count = pushInputs([info0.pass]);
          head('Dot', count, []);
          record('Dot', n.name, 'bypassed');
          break;
        }
        default:
          out.push('push 0');
      }
    }
    written.add(id);
    if ((consumers.get(id) ?? 0) > 1) out.push(`set ${varName(id)} [stack 0]`);
  };

  // The Write's tree first (in Nuke's order), then whatever is not connected to it.
  const write = doc.nodes.find((n) => n.type === 'write');
  if (write) emit(write.id);
  const roots = doc.nodes.filter((n) => !doc.edges.some((e) => e.from === n.id) && n.id !== write?.id);
  for (const r of roots) if (!written.has(r.id)) emit(r.id);
  for (const n of doc.nodes) if (!written.has(n.id)) emit(n.id);

  const ocio = info.working && OCIO_NAMES[info.working];
  const header = [
    `#! nuke file written by ${info.generator} at ${info.writtenAt}`,
    'version 13.0 v1',
    `# ${info.shot} prep comp v${String(info.version).padStart(3, '0')}: ${doc.nodes.length} VC VFX nodes. See the graph manifest beside this script for every parameter and asset.`,
    'Root {',
    ' inputs 0',
    ` name "[file dirname [value root.name]]/${info.shot}_comp_v${String(info.version).padStart(3, '0')}.nk"`,
    ` first_frame ${info.first}`,
    ` last_frame ${info.last}`,
    ` fps ${num(info.fps, 3)}`,
    ` format "${info.width} ${info.height} 0 0 ${info.width} ${info.height} 1 ${info.shot}_plate"`,
    ...(ocio ? [' colorManagement OCIO', ' OCIO_config aces_1.2', ` workingSpaceLUT ${q(ocio)}`] : []),
    '}',
  ];
  if (!ocio) untranslated.push('The plates’ encoding is unknown: no colour management is written; every Read is raw (code values).');
  for (const [id, s] of info.sources) if (s.kind !== 'alpha' && s.encoding && !OCIO_NAMES[s.encoding]) untranslated.push(`${doc.nodes.find((n) => n.id === id)?.name ?? id}: ${s.label} is in ${s.encoding}, which has no aces_1.2 name here; read raw — set its colourspace by hand.`);
  return { text: `${[...header, ...notes, ...out].join('\n')}\n`, untranslated: [...new Set(untranslated)], nodes: nodesOut };
}

// ---------------------------------------------------------------------------
// Reading a script back (for tests and checks): the topology only
// ---------------------------------------------------------------------------

export interface NukeTopologyNode {
  cls: string;
  name: string;
  /** Input i's node name (null: `push 0`). */
  inputs: (string | null)[];
  knobs: Record<string, string>;
}

/** Run the .nk stack machine and return every node with its inputs, in Nuke's input order. */
export function parseNukeTopology(text: string): NukeTopologyNode[] {
  const lines = text.split('\n');
  const stack: (string | null)[] = [];
  const vars = new Map<string, string | null>();
  const nodes: NukeTopologyNode[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith('#') || line.startsWith('version')) continue;
    let m;
    if ((m = /^push \$(\S+)$/.exec(line))) {
      stack.push(vars.get(m[1]!) ?? null);
      continue;
    }
    if (line === 'push 0') {
      stack.push(null);
      continue;
    }
    if ((m = /^set (\S+) \[stack 0\]$/.exec(line))) {
      vars.set(m[1]!, stack[stack.length - 1] ?? null);
      continue;
    }
    if ((m = /^(\w+) \{$/.exec(line))) {
      const cls = m[1]!;
      const knobs: Record<string, string> = {};
      let depth = 1;
      for (i += 1; i < lines.length; i += 1) {
        const l = lines[i]!;
        const t = l.trim();
        if (t === '}' && depth === 1) break;
        const k = /^\s(\w+) (.*)$/.exec(l);
        if (k && depth === 1) knobs[k[1]!] = k[2]!;
        depth += (l.match(/\{/g)?.length ?? 0) - (l.match(/\}/g)?.length ?? 0);
        if (depth < 1) break;
      }
      if (cls === 'Root') continue;
      const count = knobs['inputs'] !== undefined ? Number(knobs['inputs']) : 1;
      const inputs: (string | null)[] = [];
      for (let k = 0; k < count; k += 1) inputs.push(stack.pop() ?? null);
      const name = knobs['name'] ?? cls;
      nodes.push({ cls, name, inputs, knobs });
      if (cls !== 'StickyNote') stack.push(name);
      continue;
    }
  }
  return nodes;
}
