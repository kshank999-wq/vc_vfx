import { z } from 'zod';

/**
 * The prep compositor's document a shot carries in the project file (master
 * spec §14; addendum 13): a node graph that connects the prep stages, its
 * render settings, and the record of each versioned render and export. Kept
 * apart from `comp.ts` so `project.ts` can embed the schema without importing
 * the mutations.
 *
 * What lives here is small and is the artist's work: the nodes (type, name,
 * position, parameters, bypass), the connections, the viewer's two nodes and
 * the render settings. Pixels — the plates, the modules' outputs, the
 * rendered comp — are files, never here. A node that stands for a module
 * (Roto, Keyer, Clean Plate, Isolate) is a reference to that module's own
 * versioned result; its settings are the module's.
 */

export const COMP_FORMAT_VERSION = 1;
/** Pull evaluation in linear light, premultiplied RGBA (addendum 13 §3). */
export const COMP_ALGORITHM = { id: 'vcvfx-comp', version: '1.0.0' } as const;

export const COMP_NODE_TYPES = [
  'read',
  'write',
  'roto',
  'keyer',
  'despill',
  'lightwrap',
  'cleanplate',
  'isolate',
  'transform',
  'cornerpin',
  'track',
  'merge',
  'grade',
  'colorcorrect',
  'saturation',
  'blur',
  'erode',
  'shuffle',
  'copy',
  'premult',
  'unpremult',
  'crop',
  'constant',
  'switch',
  'dot',
] as const;
export type CompNodeType = (typeof COMP_NODE_TYPES)[number];

/**
 * What flows along a connection:
 *  - rgb: colour, alpha 1 everywhere (a plate);
 *  - alpha: a matte (alpha meaningful, colour = the matte, premultiplied white);
 *  - rgba: colour and a meaningful alpha (a premultiplied foreground).
 * An input asks for: `rgb` colour (refuses a bare matte), `alpha` a matte
 * (refuses a plate, whose alpha is 1 everywhere), `both` colour and matte
 * (refuses either alone), `any` anything.
 */
export type CompKind = 'rgb' | 'alpha' | 'rgba';
export type CompInputKind = 'rgb' | 'alpha' | 'both' | 'any';

/** Module outputs a Read (or a module node) refers to. */
export const COMP_SOURCES = [
  'plate',
  'background',
  'key_foreground',
  'key_alpha',
  'roto',
  'cleanplate',
  'sky_matte',
  'sky_foreground',
  'sky_plate',
  'bg_matte',
  'bg_foreground',
  'bg_plate',
  'texture',
] as const;
export type CompSource = (typeof COMP_SOURCES)[number];

export const COMP_SOURCE_LABELS: Record<CompSource, string> = {
  plate: 'Plate (newest plates, else the source)',
  background: 'Background reference',
  key_foreground: 'Key: despilled foreground',
  key_alpha: 'Key: alpha',
  roto: 'Roto: matte',
  cleanplate: 'Clean plate',
  sky_matte: 'Sky: matte',
  sky_foreground: 'Sky: foreground',
  sky_plate: 'Sky: sky plate',
  bg_matte: 'Background removal: matte',
  bg_foreground: 'Background removal: subject',
  bg_plate: 'Background removal: background plate',
  texture: 'Texture (a still)',
};

export const COMP_SOURCE_KIND: Record<CompSource, CompKind> = {
  plate: 'rgb',
  background: 'rgb',
  key_foreground: 'rgba',
  key_alpha: 'alpha',
  roto: 'alpha',
  cleanplate: 'rgb',
  sky_matte: 'alpha',
  sky_foreground: 'rgba',
  sky_plate: 'rgb',
  bg_matte: 'alpha',
  bg_foreground: 'rgba',
  bg_plate: 'rgb',
  texture: 'rgb',
};

export const MERGE_OPERATIONS = ['over', 'under', 'plus', 'minus', 'multiply', 'screen', 'stencil', 'mask', 'in', 'out', 'atop', 'difference', 'max', 'min', 'average', 'copy'] as const;
export type MergeOperation = (typeof MERGE_OPERATIONS)[number];

export const SHUFFLE_CHANNELS = ['r', 'g', 'b', 'a', '0', '1'] as const;
export const COPY_CHANNELS = ['r', 'g', 'b', 'a'] as const;
export const TRANSFORM_FILTERS = ['impulse', 'bilinear', 'cubic'] as const;

// ---------------------------------------------------------------------------
// Parameters: one table drives validation, the parameters panel and the
// Nuke translation.
// ---------------------------------------------------------------------------

interface ParamBase {
  key: string;
  label: string;
  hint?: string;
}
export type CompParamSpec =
  | (ParamBase & { kind: 'number'; default: number; min: number; max: number; step: number; unit?: string; /** Plate pixels: scaled with the proxy. */ px?: boolean })
  | (ParamBase & { kind: 'int'; default: number; min: number; max: number })
  | (ParamBase & { kind: 'enum'; default: string; options: readonly (readonly [string, string])[] })
  | (ParamBase & { kind: 'bool'; default: boolean })
  | (ParamBase & { kind: 'color'; default: readonly [number, number, number, number] })
  | (ParamBase & { kind: 'vec2'; default: readonly [number, number]; min: number; max: number; step: number; unit?: string; px?: boolean })
  /** A 2D track's id ('' none), a roto part's id ('' all parts), a texture region's id. */
  | (ParamBase & { kind: 'track' | 'part' | 'region'; default: '' });

const num = (key: string, label: string, def: number, min: number, max: number, step: number, extra: { unit?: string; px?: boolean; hint?: string } = {}): CompParamSpec => ({ kind: 'number', key, label, default: def, min, max, step, ...extra });
const choice = (key: string, label: string, def: string, options: readonly (readonly [string, string])[], hint?: string): CompParamSpec => ({ kind: 'enum', key, label, default: def, options, ...(hint ? { hint } : {}) });
const flag = (key: string, label: string, def: boolean, hint?: string): CompParamSpec => ({ kind: 'bool', key, label, default: def, ...(hint ? { hint } : {}) });
const vec2 = (key: string, label: string, def: readonly [number, number], min: number, max: number, step: number, extra: { unit?: string; px?: boolean; hint?: string } = {}): CompParamSpec => ({ kind: 'vec2', key, label, default: def, min, max, step, ...extra });

const sourceOptions = COMP_SOURCES.map((s) => [s, COMP_SOURCE_LABELS[s]] as const);
const opLabels: Record<MergeOperation, string> = {
  over: 'over — A + B(1−a)',
  under: 'under — A(1−b) + B',
  plus: 'plus — A + B',
  minus: 'minus — A − B',
  multiply: 'multiply — AB',
  screen: 'screen — A + B − AB',
  stencil: 'stencil — B(1−a)',
  mask: 'mask — Ba',
  in: 'in — Ab',
  out: 'out — A(1−b)',
  atop: 'atop — Ab + B(1−a)',
  difference: 'difference — |A − B|',
  max: 'max',
  min: 'min',
  average: 'average — (A + B)/2',
  copy: 'copy — A',
};
const shuffleOpts = SHUFFLE_CHANNELS.map((c) => [c, c === '0' ? 'black' : c === '1' ? 'white' : c] as const);
const copyOpts = COPY_CHANNELS.map((c) => [c, c === 'a' ? 'alpha' : c === 'r' ? 'red' : c === 'g' ? 'green' : 'blue'] as const);
const MASK = { name: 'mask', label: 'mask', kind: 'alpha' as const, optional: true };

export interface CompInputSpec {
  name: string;
  label: string;
  kind: CompInputKind;
  optional?: boolean;
}

export interface CompNodeInfo {
  label: string;
  category: 'Image' | 'Module' | 'Merge' | 'Colour' | 'Filter' | 'Transform' | 'Channel' | 'Utility';
  /** In Nuke's order: input 0 first (Merge: B, A, mask). */
  inputs: readonly CompInputSpec[];
  params: readonly CompParamSpec[];
  /** The input a bypassed (disabled) node passes on, as Nuke does (input 0). */
  pass: string | null;
  /** The prep task whose result this node is (module reference nodes). */
  module?: 'roto' | 'key' | 'clean_plate' | 'sky_replacement' | 'texture_extraction';
  /** Its frame does not matter (a constant): cached once for every frame. */
  still?: boolean;
  blurb: string;
}

export const COMP_NODES: Record<CompNodeType, CompNodeInfo> = {
  read: {
    label: 'Read',
    category: 'Image',
    inputs: [],
    params: [choice('source', 'Source', 'plate', sourceOptions), { kind: 'part', key: 'part', label: 'Roto part / texture region', default: '', hint: 'Roto: one part (with its children), or all parts. Texture: which region.' }],
    pass: null,
    blurb: 'The plate, the background reference, or any module’s versioned output.',
  },
  write: { label: 'Write', category: 'Image', inputs: [{ name: 'src', label: 'src', kind: 'any' }], params: [choice('channels', 'Channels', 'rgba', [['rgba', 'RGBA'], ['rgb', 'RGB']])], pass: 'src', blurb: 'What the render writes: a versioned EXR sequence (and a review encode).' },
  roto: { label: 'Roto', category: 'Module', inputs: [], params: [{ kind: 'part', key: 'part', label: 'Roto part', default: '', hint: 'A part with its children, or all parts combined' }], pass: null, module: 'roto', blurb: 'The Roto tab’s matte (alpha).' },
  keyer: { label: 'Keyer', category: 'Module', inputs: [], params: [choice('output', 'Output', 'foreground', [['foreground', 'Despilled foreground (premultiplied)'], ['alpha', 'Alpha only']])], pass: null, module: 'key', blurb: 'The Key tab’s key: the despilled foreground with its alpha, or the alpha.' },
  despill: {
    label: 'Despill',
    category: 'Colour',
    inputs: [{ name: 'src', label: 'src', kind: 'rgb' }, { name: 'bg', label: 'bg', kind: 'rgb', optional: true }],
    params: [
      choice('screen', 'Screen', 'green', [['green', 'Green'], ['blue', 'Blue']]),
      choice('limit', 'Limit', 'average', [['average', 'Average'], ['max', 'Max'], ['min', 'Min'], ['weighted', 'Weighted']], 'Green is limited to this of red and blue (blue: of red and green)'),
      num('weight', 'Red weight', 0.5, 0, 1, 0.05, { hint: 'For Weighted: the weight of red' }),
      num('strength', 'Strength', 1, 0, 1, 0.05),
      choice('restore', 'Put back as', 'neutral', [['neutral', 'Grey'], ['background', 'Background colour (bg input)'], ['none', 'Nothing']]),
      num('restoreAmount', 'Put back amount', 1, 0, 1, 0.05),
      num('backgroundBlur', 'Background blur', 40, 0, 400, 1, { unit: ' px', px: true }),
      flag('protectSkin', 'Protect skin', true),
    ],
    pass: 'src',
    blurb: 'Limits the screen colour, with the Key tab’s despill maths.',
  },
  lightwrap: {
    label: 'LightWrap',
    category: 'Merge',
    inputs: [{ name: 'fg', label: 'fg', kind: 'both' }, { name: 'bg', label: 'bg', kind: 'rgb' }],
    params: [num('width', 'Width', 16, 1, 400, 1, { unit: ' px', px: true }), num('intensity', 'Intensity', 0.6, 0, 2, 0.05), num('lumaWeight', 'Luminance weight', 0.5, 0, 1, 0.05)],
    pass: 'fg',
    blurb: 'Adds the background’s light just inside the foreground’s edge (the Key tab’s light wrap).',
  },
  cleanplate: { label: 'CleanPlate', category: 'Module', inputs: [], params: [], pass: null, module: 'clean_plate', blurb: 'The Clean Plate tab’s plate.' },
  isolate: {
    label: 'Isolate',
    category: 'Module',
    inputs: [],
    params: [choice('target', 'Isolation', 'sky', [['sky', 'Sky'], ['background', 'Subject from background']]), choice('output', 'Output', 'foreground', [['foreground', 'Foreground (premultiplied)'], ['matte', 'Matte'], ['plate', 'Plate (sky / background)']])],
    pass: null,
    module: 'sky_replacement',
    blurb: 'The Sky & BG tab’s matte, foreground or plate.',
  },
  transform: {
    label: 'Transform',
    category: 'Transform',
    inputs: [{ name: 'src', label: 'src', kind: 'any' }, MASK],
    params: [
      vec2('translate', 'Translate', [0, 0], -20000, 20000, 1, { unit: ' px', px: true }),
      num('rotate', 'Rotate', 0, -360, 360, 0.1, { unit: '°' }),
      vec2('scale', 'Scale', [1, 1], 0.01, 20, 0.01),
      vec2('center', 'Centre', [0.5, 0.5], -2, 3, 0.01, { hint: 'Fraction of the frame (0.5, 0.5: the middle)' }),
      choice('filter', 'Filter', 'cubic', TRANSFORM_FILTERS.map((f) => [f, f] as const)),
      flag('invert', 'Invert', false),
    ],
    pass: 'src',
    blurb: 'Moves, rotates and scales (image y down; written y-up for Nuke).',
  },
  cornerpin: {
    label: 'CornerPin',
    category: 'Transform',
    inputs: [{ name: 'src', label: 'src', kind: 'any' }, MASK],
    params: [
      choice('source', 'Corners from', 'track', [['track', 'A planar 2D track'], ['manual', 'Typed corners']]),
      { kind: 'track', key: 'track', label: 'Planar track', default: '' },
      choice('mode', 'Mode', 'matchmove', [['matchmove', 'Match-move (stick to the surface)'], ['stabilise', 'Stabilise (hold the surface still)']]),
      { kind: 'int', key: 'reference', label: 'Reference frame', default: 0, min: 0, max: 100_000_000, hint: '0: the track’s first key frame' },
      vec2('to1', 'Top left', [0, 0], -2, 3, 0.001),
      vec2('to2', 'Top right', [1, 0], -2, 3, 0.001),
      vec2('to3', 'Bottom right', [1, 1], -2, 3, 0.001),
      vec2('to4', 'Bottom left', [0, 1], -2, 3, 0.001),
      choice('filter', 'Filter', 'cubic', TRANSFORM_FILTERS.map((f) => [f, f] as const)),
    ],
    pass: 'src',
    blurb: 'Pins the input onto a tracked surface (or holds it still) with a 2D/planar track.',
  },
  track: {
    label: 'Track',
    category: 'Transform',
    inputs: [{ name: 'src', label: 'src', kind: 'any' }, MASK],
    params: [
      { kind: 'track', key: 'track', label: '2D track', default: '' },
      choice('mode', 'Mode', 'matchmove', [['matchmove', 'Match-move'], ['stabilise', 'Stabilise']]),
      { kind: 'int', key: 'reference', label: 'Reference frame', default: 0, min: 0, max: 100_000_000, hint: '0: the track’s first key frame' },
      choice('filter', 'Filter', 'cubic', TRANSFORM_FILTERS.map((f) => [f, f] as const)),
    ],
    pass: 'src',
    blurb: 'Moves the input with a point track (a planar track’s centre): match-move or stabilise.',
  },
  merge: {
    label: 'Merge',
    category: 'Merge',
    inputs: [{ name: 'B', label: 'B', kind: 'any' }, { name: 'A', label: 'A', kind: 'any', optional: true }, MASK],
    params: [choice('operation', 'Operation', 'over', MERGE_OPERATIONS.map((o) => [o, opLabels[o]] as const)), num('mix', 'Mix', 1, 0, 1, 0.01)],
    pass: 'B',
    blurb: 'Combines A with B by a Porter–Duff / Nuke operation.',
  },
  grade: {
    label: 'Grade',
    category: 'Colour',
    inputs: [{ name: 'src', label: 'src', kind: 'any' }, MASK],
    params: [
      num('blackpoint', 'Black point', 0, -1, 1, 0.005),
      num('whitepoint', 'White point', 1, 0.01, 4, 0.01),
      num('lift', 'Lift', 0, -1, 1, 0.005),
      num('gain', 'Gain', 1, 0, 8, 0.01),
      num('multiply', 'Multiply', 1, 0, 8, 0.01),
      num('offset', 'Offset', 0, -1, 1, 0.005),
      num('gamma', 'Gamma', 1, 0.2, 5, 0.01),
      num('exposure', 'Exposure', 0, -8, 8, 0.05, { unit: ' stops', hint: 'Scales the multiply by 2^stops (Nuke: multiply × 2^stops)' }),
      flag('blackClamp', 'Black clamp', true),
      flag('whiteClamp', 'White clamp', false),
      flag('unpremult', 'Unpremult by alpha', false),
    ],
    pass: 'src',
    blurb: 'Nuke’s Grade in linear light: black/white point, lift, gain, multiply, offset, gamma.',
  },
  colorcorrect: {
    label: 'ColorCorrect',
    category: 'Colour',
    inputs: [{ name: 'src', label: 'src', kind: 'any' }, MASK],
    params: [num('saturation', 'Saturation', 1, 0, 4, 0.01), num('contrast', 'Contrast', 1, 0, 4, 0.01, { hint: 'About 18 % grey' }), num('gamma', 'Gamma', 1, 0.2, 5, 0.01), num('gain', 'Gain', 1, 0, 8, 0.01), num('offset', 'Offset', 0, -1, 1, 0.005), flag('unpremult', 'Unpremult by alpha', false)],
    pass: 'src',
    blurb: 'Nuke’s ColorCorrect (master): saturation, contrast, gamma, gain, offset.',
  },
  saturation: { label: 'Saturation', category: 'Colour', inputs: [{ name: 'src', label: 'src', kind: 'any' }, MASK], params: [num('saturation', 'Saturation', 1, 0, 4, 0.01)], pass: 'src', blurb: 'Saturation about Rec.709 luminance (as Nuke).' },
  blur: {
    label: 'Blur',
    category: 'Filter',
    inputs: [{ name: 'src', label: 'src', kind: 'any' }, MASK],
    params: [num('size', 'Size', 4, 0, 400, 0.5, { unit: ' px', px: true }), choice('channels', 'Channels', 'rgba', [['rgba', 'RGBA'], ['alpha', 'Alpha only']])],
    pass: 'src',
    blurb: 'Gaussian blur.',
  },
  erode: {
    label: 'Erode',
    category: 'Filter',
    inputs: [{ name: 'src', label: 'src', kind: 'any' }, MASK],
    params: [num('size', 'Size', 1, -100, 100, 0.25, { unit: ' px', px: true, hint: 'Positive shrinks the matte, negative grows it' }), choice('channels', 'Channels', 'alpha', [['alpha', 'Alpha'], ['rgba', 'RGBA']])],
    pass: 'src',
    blurb: 'Shrinks (or grows) a matte.',
  },
  shuffle: {
    label: 'Shuffle',
    category: 'Channel',
    inputs: [{ name: 'src', label: 'src', kind: 'any' }],
    params: [choice('r', 'Red from', 'r', shuffleOpts), choice('g', 'Green from', 'g', shuffleOpts), choice('b', 'Blue from', 'b', shuffleOpts), choice('a', 'Alpha from', 'a', shuffleOpts)],
    pass: 'src',
    blurb: 'Rearranges channels.',
  },
  copy: {
    label: 'Copy',
    category: 'Channel',
    inputs: [{ name: 'B', label: 'B', kind: 'any' }, { name: 'A', label: 'A', kind: 'any' }],
    params: [choice('from', 'From A’s', 'a', copyOpts), choice('to', 'Into B’s', 'a', copyOpts)],
    pass: 'B',
    blurb: 'Copies one channel of A into B (a matte into a plate’s alpha).',
  },
  premult: { label: 'Premult', category: 'Channel', inputs: [{ name: 'src', label: 'src', kind: 'any' }], params: [], pass: 'src', blurb: 'Multiplies colour by alpha.' },
  unpremult: { label: 'Unpremult', category: 'Channel', inputs: [{ name: 'src', label: 'src', kind: 'any' }], params: [], pass: 'src', blurb: 'Divides colour by alpha (where alpha is not 0).' },
  crop: {
    label: 'Crop',
    category: 'Transform',
    inputs: [{ name: 'src', label: 'src', kind: 'any' }],
    params: [vec2('min', 'Top left', [0, 0], -1, 2, 0.001, { hint: 'Fraction of the frame' }), vec2('max', 'Bottom right', [1, 1], -1, 2, 0.001), num('softness', 'Softness', 0, 0, 200, 0.5, { unit: ' px', px: true })],
    pass: 'src',
    blurb: 'Black (and transparent) outside a box; the frame size is kept.',
  },
  constant: { label: 'Constant', category: 'Image', inputs: [], params: [{ kind: 'color', key: 'color', label: 'Colour (linear)', default: [0.18, 0.18, 0.18, 1] }], pass: null, still: true, blurb: 'A flat linear colour, frame-sized.' },
  switch: {
    label: 'Switch',
    category: 'Utility',
    inputs: [0, 1, 2, 3].map((i) => ({ name: `in${i}`, label: String(i), kind: 'any' as const, optional: true })),
    params: [{ kind: 'int', key: 'which', label: 'Which', default: 0, min: 0, max: 3 }],
    pass: 'in0',
    blurb: 'Passes one of its inputs.',
  },
  dot: { label: 'Dot', category: 'Utility', inputs: [{ name: 'src', label: 'src', kind: 'any' }], params: [], pass: 'src', blurb: 'A bend in a connection.' },
};

export type CompParamValue = number | string | boolean | number[];
export type CompParams = Record<string, CompParamValue>;

function paramSchema(p: CompParamSpec): z.ZodTypeAny {
  switch (p.kind) {
    case 'number':
      return z.number().finite().min(p.min).max(p.max);
    case 'int':
      return z.number().int().min(p.min).max(p.max);
    case 'enum':
      return z.enum(p.options.map((o) => o[0]) as [string, ...string[]]);
    case 'bool':
      return z.boolean();
    case 'color':
      return z.tuple([z.number().finite().min(-64).max(64), z.number().finite().min(-64).max(64), z.number().finite().min(-64).max(64), z.number().finite().min(0).max(1)]);
    case 'vec2':
      return z.tuple([z.number().finite().min(p.min).max(p.max), z.number().finite().min(p.min).max(p.max)]);
    default:
      return z.string().max(64);
  }
}

/** The zod schema of one node type's parameters (every key optional on input; defaults filled). */
export function compParamsSchema(type: CompNodeType) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const p of COMP_NODES[type].params) shape[p.key] = paramSchema(p);
  return z.object(shape).strict();
}

export function defaultCompParams(type: CompNodeType): CompParams {
  const out: CompParams = {};
  for (const p of COMP_NODES[type].params) out[p.key] = Array.isArray(p.default) ? [...(p.default as readonly number[])] : (p.default as CompParamValue);
  return out;
}

/** A node's parameters with every default filled in (what the engine and the Nuke writer read). */
export function compNodeParams(node: { type: CompNodeType; params: Record<string, unknown> }): CompParams {
  const out = defaultCompParams(node.type);
  const parsed = compParamsSchema(node.type).partial().safeParse(node.params);
  if (parsed.success) for (const [k, v] of Object.entries(parsed.data)) if (v !== undefined) out[k] = v as CompParamValue;
  return out;
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/** Nuke-safe and unique within the graph. */
export const COMP_NAME = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;

export const CompNodeSchema = z.object({
  id: z.string().regex(/^n[0-9]{1,6}$/),
  type: z.enum(COMP_NODE_TYPES),
  name: z.string().regex(COMP_NAME),
  /** Position in the graph editor (graph units, y down). */
  x: z.number().finite().min(-100_000).max(100_000),
  y: z.number().finite().min(-100_000).max(100_000),
  /** Only what differs from the defaults needs to be here; see `compNodeParams`. */
  params: z.record(z.union([z.number(), z.string(), z.boolean(), z.array(z.number())])).default({}),
  /** Bypassed: passes its main input on unchanged (Nuke's `disable`). */
  disabled: z.boolean().default(false),
  note: z.string().max(500).default(''),
});
export type CompNode = z.infer<typeof CompNodeSchema>;

/** Output of `from` into the named input of `to`. */
export const CompEdgeSchema = z.object({ from: z.string(), to: z.string(), input: z.string().min(1).max(16) });
export type CompEdge = z.infer<typeof CompEdgeSchema>;

export const COMP_REVIEW_FORMATS = ['jpeg', 'png', 'none'] as const;
export type CompReviewFormat = (typeof COMP_REVIEW_FORMATS)[number];

export const CompRenderSettingsSchema = z.object({
  /** null: the shot's first / last frame. */
  first: z.number().int().nonnegative().nullable().default(null),
  last: z.number().int().nonnegative().nullable().default(null),
  /** The review encode beside the EXRs: through the viewer's Rec.709 (approx.) view; never applied to the EXRs or the plates. */
  review: z.enum(COMP_REVIEW_FORMATS).default('jpeg'),
});
export type CompRenderSettings = z.infer<typeof CompRenderSettingsSchema>;

/** A module output the render read, by version (for the manifest and for reproducing it, §19). */
export const CompReferenceSchema = z.object({
  node: z.string(),
  source: z.enum(COMP_SOURCES),
  /** The module's task version that was read; null for the plate / source / background reference. */
  version: z.number().int().positive().nullable(),
  /** Package-relative path (folder/pattern) or a handoff-relative / absolute path for the source and references. */
  path: z.string(),
  label: z.string(),
});
export type CompReference = z.infer<typeof CompReferenceSchema>;

/** A versioned render into 08_PREVIEWS (addendum 13 §5). */
export const CompRenderSchema = z.object({
  version: z.number().int().positive(),
  revision: z.number().int().nonnegative(),
  /** Package-relative `08_PREVIEWS/<shot>_comp_vNNN`. */
  folder: z.string(),
  /** printf patterns relative to `folder`. */
  pattern: z.string(),
  review: z.string().nullable(),
  first: z.number().int().nonnegative(),
  last: z.number().int().nonnegative(),
  frames: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  encoding: z.string(),
  write: z.string(),
  references: z.array(CompReferenceSchema).default([]),
  /** Seconds the render took, and frames per second. */
  seconds: z.number().nonnegative(),
  files: z.number().int().nonnegative(),
  algorithm: z.string(),
  writtenAt: z.string(),
  by: z.string(),
});
export type CompRender = z.infer<typeof CompRenderSchema>;
export type CompRenderInput = Omit<CompRender, 'writtenAt' | 'by'>;

/** A versioned export for finishing into 09_PROJECT_DATA (addendum 13 §6). */
export const CompExportSchema = z.object({
  version: z.number().int().positive(),
  revision: z.number().int().nonnegative(),
  /** Package-relative `09_PROJECT_DATA/<shot>_comp_vNNN`. */
  folder: z.string(),
  /** File names inside `folder`. */
  graph: z.string(),
  nuke: z.string(),
  manifest: z.string(),
  readme: z.string(),
  /** Nodes Nuke has no class for, rendered by VC VFX and read back in the script. */
  baked: z.array(z.object({ node: z.string(), name: z.string(), pattern: z.string() })).default([]),
  /** What the .nk does not carry exactly (also in the manifest and the README). */
  untranslated: z.array(z.string()).default([]),
  /** The render it goes with (package-relative folder). */
  render: z.string(),
  files: z.number().int().nonnegative(),
  writtenAt: z.string(),
  by: z.string(),
});
export type CompExport = z.infer<typeof CompExportSchema>;
export type CompExportInput = Omit<CompExport, 'writtenAt' | 'by'>;

export const CompDocumentSchema = z.object({
  formatVersion: z.literal(COMP_FORMAT_VERSION).default(COMP_FORMAT_VERSION),
  algorithm: z.object({ id: z.string(), version: z.string() }).default({ ...COMP_ALGORITHM }),
  nodes: z.array(CompNodeSchema).max(300).default([]),
  edges: z.array(CompEdgeSchema).max(1200).default([]),
  /** The viewer's two nodes (1 and 2), for the A/B wipe. */
  viewer: z.object({ a: z.string().nullable().default(null), b: z.string().nullable().default(null) }).default({ a: null, b: null }),
  render: CompRenderSettingsSchema.default({ first: null, last: null, review: 'jpeg' }),
  renders: z.array(CompRenderSchema).default([]),
  exports: z.array(CompExportSchema).default([]),
  /** Bumped by every change that changes pixels: a render records which revision it used (§19). */
  revision: z.number().int().nonnegative().default(0),
  /** Source of node ids. */
  seq: z.number().int().nonnegative().default(0),
});
export type CompDocument = z.infer<typeof CompDocumentSchema>;
