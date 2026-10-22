/**
 * Colour encodings, the plate colour policy and the transforms VC VFX applies
 * (master spec §4: "Color-management settings must be explicit and
 * non-destructive; do not silently bake display looks into VFX plates").
 *
 * Pure and dependency-free. Everything that touches pixels — ffmpeg — is
 * built from what this module returns, so every number that ends up in a
 * plate is tested here.
 *
 * The model is the one every camera vendor publishes:
 *
 *   code value ──transfer⁻¹──▶ scene-linear (camera gamut) ──3×3──▶ scene-linear (target gamut)
 *
 * Each encoding is a transfer function (log curve, display OETF, or linear)
 * plus a gamut (three primaries and a white point). A conversion between two
 * encodings is therefore separable: a per-channel 1D curve, then one 3×3
 * matrix. That is exactly what the plates are made with (a 1D LUT and a
 * matrix in ffmpeg, float throughout), so no 3D-LUT interpolation error and no
 * clamping of linear values above 1.0 is introduced.
 *
 * Code values are normalised full-range (10-bit code / 1023), the domain in
 * which the manufacturers publish their curves. Canon specifies Canon Log 3
 * in IRE and is converted to that domain here, as Canon's own ACES IDT does.
 *
 * Display transforms (`viewTransform`) exist only for the viewer. They are
 * never used to write a plate.
 */

// ---------------------------------------------------------------------------
// Matrices
// ---------------------------------------------------------------------------

/** A 3×3 matrix, row-major: out = M · [r, g, b]. */
export type Matrix3 = readonly [number, number, number, number, number, number, number, number, number];
export type Vec3 = readonly [number, number, number];

export const IDENTITY3: Matrix3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mul3(a: Matrix3, b: Matrix3): Matrix3 {
  const m = (r: number, c: number) => a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
  return [m(0, 0), m(0, 1), m(0, 2), m(1, 0), m(1, 1), m(1, 2), m(2, 0), m(2, 1), m(2, 2)];
}

export function apply3(m: Matrix3, v: Vec3): Vec3 {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}

export function invert3(m: Matrix3): Matrix3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error('Singular matrix');
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

const diag = (v: Vec3): Matrix3 => [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2]];

export function isIdentity3(m: Matrix3, tolerance = 1e-9): boolean {
  return m.every((v, i) => Math.abs(v - IDENTITY3[i]!) <= tolerance);
}

// ---------------------------------------------------------------------------
// Gamuts
// ---------------------------------------------------------------------------

type XY = readonly [number, number];

export interface Gamut {
  label: string;
  red: XY;
  green: XY;
  blue: XY;
  white: XY;
}

/** CIE 1931 xy of the white points used below. */
export const WHITE_D65: XY = [0.3127, 0.329];
/** ACES white, "D60" (SMPTE ST 2065-1). */
export const WHITE_ACES: XY = [0.32168, 0.33767];

/**
 * Primaries and white points, as published:
 *  - ACES AP0 / AP1: SMPTE ST 2065-1:2012; Academy S-2014-004 (ACEScg).
 *  - Rec.709 / sRGB: ITU-R BT.709-6; IEC 61966-2-1.
 *  - ARRI Wide Gamut 3: ARRI, "ALEXA Log C Curve – Usage in VFX" (2017), §"ARRI Wide Gamut".
 *  - ARRI Wide Gamut 4: ARRI, "ARRI LogC4 Logarithmic Color Space Specification" (2022).
 *  - S-Gamut3 / S-Gamut3.Cine: Sony, "Technical Summary for S-Gamut3.Cine/S-Log3 and S-Gamut3/S-Log3".
 *  - REDWideGamutRGB: RED, "White Paper on REDWideGamutRGB and Log3G10" (2017).
 *  - Cinema Gamut: Canon, "Cinema Gamut" white paper / Canon ACES IDTs.
 *  - V-Gamut: Panasonic, "V-Log/V-Gamut Reference Manual" (2014).
 *  - Blackmagic Wide Gamut: Blackmagic Design, "Blackmagic Generation 5 Color Science" (2021).
 */
export const GAMUTS = {
  ap0: { label: 'ACES AP0', red: [0.7347, 0.2653], green: [0.0, 1.0], blue: [0.0001, -0.077], white: WHITE_ACES },
  ap1: { label: 'ACES AP1', red: [0.713, 0.293], green: [0.165, 0.83], blue: [0.128, 0.044], white: WHITE_ACES },
  rec709: { label: 'Rec.709', red: [0.64, 0.33], green: [0.3, 0.6], blue: [0.15, 0.06], white: WHITE_D65 },
  awg3: { label: 'ARRI Wide Gamut 3', red: [0.684, 0.313], green: [0.221, 0.848], blue: [0.0861, -0.102], white: WHITE_D65 },
  awg4: { label: 'ARRI Wide Gamut 4', red: [0.7347, 0.2653], green: [0.1424, 0.8576], blue: [0.0991, -0.0308], white: WHITE_D65 },
  sgamut3: { label: 'S-Gamut3', red: [0.73, 0.28], green: [0.14, 0.855], blue: [0.1, -0.05], white: WHITE_D65 },
  sgamut3cine: { label: 'S-Gamut3.Cine', red: [0.766, 0.275], green: [0.225, 0.8], blue: [0.089, -0.087], white: WHITE_D65 },
  rwg: { label: 'REDWideGamutRGB', red: [0.780308, 0.304253], green: [0.121595, 1.493994], blue: [0.095612, -0.084589], white: WHITE_D65 },
  cinemagamut: { label: 'Cinema Gamut', red: [0.74, 0.27], green: [0.17, 1.14], blue: [0.08, -0.1], white: WHITE_D65 },
  vgamut: { label: 'V-Gamut', red: [0.73, 0.28], green: [0.165, 0.84], blue: [0.1, -0.03], white: WHITE_D65 },
  bmdwg: { label: 'Blackmagic Wide Gamut', red: [0.7177215, 0.3171181], green: [0.228041, 0.861569], blue: [0.1005841, -0.0820452], white: [0.312717, 0.3290312] },
} as const satisfies Record<string, Gamut>;
export type GamutId = keyof typeof GAMUTS;

const xyToXYZ = ([x, y]: XY): Vec3 => [x / y, 1, (1 - x - y) / y];

/** The normalised primary matrix: linear RGB in the gamut → CIE XYZ (Y of white = 1). SMPTE RP 177. */
export function rgbToXyz(g: Gamut): Matrix3 {
  const [xr, yr] = g.red;
  const [xg, yg] = g.green;
  const [xb, yb] = g.blue;
  const P: Matrix3 = [xr / yr, xg / yg, xb / yb, 1, 1, 1, (1 - xr - yr) / yr, (1 - xg - yg) / yg, (1 - xb - yb) / yb];
  const S = apply3(invert3(P), xyToXYZ(g.white));
  return mul3(P, diag(S));
}

/** Chromatic adaptation methods (von Kries-style, in each cone space). */
export type Adaptation = 'bradford' | 'cat02';
const CONE: Record<Adaptation, Matrix3> = {
  bradford: [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296],
  cat02: [0.7328, 0.4296, -0.1624, -0.7036, 1.6975, 0.0061, 0.003, 0.0136, 0.9834],
};

/** XYZ under `from` white → XYZ under `to` white. */
export function adaptationMatrix(from: XY, to: XY, method: Adaptation): Matrix3 {
  const M = CONE[method];
  const s = apply3(M, xyToXYZ(from));
  const d = apply3(M, xyToXYZ(to));
  return mul3(invert3(M), mul3(diag([d[0] / s[0], d[1] / s[1], d[2] / s[2]]), M));
}

const sameWhite = (a: XY, b: XY) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;

/** Linear RGB in one gamut → linear RGB in another, adapting the white where they differ. */
export function gamutMatrix(from: GamutId, to: GamutId, method: Adaptation = 'bradford'): Matrix3 {
  if (from === to) return IDENTITY3;
  const a = GAMUTS[from];
  const b = GAMUTS[to];
  const cat = sameWhite(a.white, b.white) ? IDENTITY3 : adaptationMatrix(a.white, b.white, method);
  return mul3(invert3(rgbToXyz(b)), mul3(cat, rgbToXyz(a)));
}

// ---------------------------------------------------------------------------
// Transfer functions
// ---------------------------------------------------------------------------

export interface Transfer {
  label: string;
  /** Code value (normalised 0–1) → scene-linear (or display-linear for display curves). */
  toLinear(v: number): number;
  /** The inverse. */
  fromLinear(x: number): number;
}

const log10 = Math.log10;
const pow10 = (x: number) => Math.pow(10, x);

/** ARRI LogC3, EI 800 (ARRI, "ALEXA Log C Curve – Usage in VFX", 2017, Table 2/3, SUP 3.x, EI 800). */
const LOGC3 = { cut: 0.010591, a: 5.555556, b: 0.052272, c: 0.24719, d: 0.385537, e: 5.367655, f: 0.092809 };
const logc3: Transfer = {
  label: 'ARRI LogC3 (EI 800)',
  fromLinear: (x) => (x > LOGC3.cut ? LOGC3.c * log10(LOGC3.a * x + LOGC3.b) + LOGC3.d : LOGC3.e * x + LOGC3.f),
  toLinear: (t) => (t > LOGC3.e * LOGC3.cut + LOGC3.f ? (pow10((t - LOGC3.d) / LOGC3.c) - LOGC3.b) / LOGC3.a : (t - LOGC3.f) / LOGC3.e),
};

/** ARRI LogC4 (ARRI, "ARRI LogC4 Logarithmic Color Space Specification", 2022, §3). */
const LOGC4 = (() => {
  const a = (Math.pow(2, 18) - 16) / 117.45;
  const b = (1023 - 95) / 1023;
  const c = 95 / 1023;
  const s = (7 * Math.log(2) * Math.pow(2, 7 - (14 * c) / b)) / (a * b);
  const t = (Math.pow(2, 14 * (-c / b) + 6) - 64) / a;
  return { a, b, c, s, t };
})();
const logc4: Transfer = {
  label: 'ARRI LogC4',
  fromLinear: (x) => (x >= LOGC4.t ? ((Math.log2(LOGC4.a * x + 64) - 6) / 14) * LOGC4.b + LOGC4.c : (x - LOGC4.t) / LOGC4.s),
  toLinear: (e) => (e >= 0 ? (Math.pow(2, (14 * (e - LOGC4.c)) / LOGC4.b + 6) - 64) / LOGC4.a : e * LOGC4.s + LOGC4.t),
};

/** Sony S-Log3 (Sony, "Technical Summary for S-Gamut3.Cine/S-Log3 and S-Gamut3/S-Log3", §2). */
const slog3: Transfer = {
  label: 'Sony S-Log3',
  fromLinear: (x) => (x >= 0.01125 ? (420 + log10((x + 0.01) / (0.18 + 0.01)) * 261.5) / 1023 : ((x * (171.2102946929 - 95)) / 0.01125 + 95) / 1023),
  toLinear: (y) => (y >= 171.2102946929 / 1023 ? pow10((y * 1023 - 420) / 261.5) * (0.18 + 0.01) - 0.01 : ((y * 1023 - 95) * 0.01125) / (171.2102946929 - 95)),
};

/** RED Log3G10, IPP2 / v3 (RED, "White Paper on REDWideGamutRGB and Log3G10", 2017). */
const LOG3G10 = { a: 0.224282, b: 155.975327, c: 0.01, g: 15.1927 };
const log3g10: Transfer = {
  label: 'RED Log3G10',
  fromLinear: (x) => {
    const xc = x + LOG3G10.c;
    return xc < 0 ? xc * LOG3G10.g : LOG3G10.a * log10(xc * LOG3G10.b + 1);
  },
  toLinear: (y) => (y < 0 ? y / LOG3G10.g - LOG3G10.c : (pow10(y / LOG3G10.a) - 1) / LOG3G10.b - LOG3G10.c),
};

/**
 * Canon Log 3, v1.2 (Canon, "Canon Log Gamma Curves", and Canon's ACES IDT).
 * Canon states the curve in IRE (0–1 over legal range) against reflectance
 * where 0.9 is 90 % white; the ACES IDT scales linear by 0.9. Converted here
 * to normalised full-range code value: cv = (ire · 876 + 64) / 1023.
 */
const clog3Ire = (x: number) => (x < -0.014 ? -0.36726845 * log10(-x * 14.98325 + 1) + 0.12783901 : x <= 0.014 ? 1.9754798 * x + 0.12512219 : 0.36726845 * log10(x * 14.98325 + 1) + 0.12240537);
const CLOG3_CUT_LO = clog3Ire(-0.014);
const CLOG3_CUT_HI = clog3Ire(0.014);
const clog3Lin = (ire: number) =>
  ire < CLOG3_CUT_LO ? -(pow10((0.12783901 - ire) / 0.36726845) - 1) / 14.98325 : ire <= CLOG3_CUT_HI ? (ire - 0.12512219) / 1.9754798 : (pow10((ire - 0.12240537) / 0.36726845) - 1) / 14.98325;
const clog3: Transfer = {
  label: 'Canon Log 3',
  fromLinear: (x) => (clog3Ire(x / 0.9) * 876 + 64) / 1023,
  toLinear: (cv) => clog3Lin((cv * 1023 - 64) / 876) * 0.9,
};

/** Panasonic V-Log (Panasonic, "V-Log/V-Gamut Reference Manual", 2014). */
const VLOG = { cut1: 0.01, cut2: 0.181, b: 0.00873, c: 0.241514, d: 0.598206 };
const vlog: Transfer = {
  label: 'Panasonic V-Log',
  fromLinear: (x) => (x < VLOG.cut1 ? 5.6 * x + 0.125 : VLOG.c * log10(x + VLOG.b) + VLOG.d),
  toLinear: (y) => (y < VLOG.cut2 ? (y - 0.125) / 5.6 : pow10((y - VLOG.d) / VLOG.c) - VLOG.b),
};

/** Blackmagic Film Generation 5 (Blackmagic Design, "Blackmagic Generation 5 Color Science", 2021). */
const BMD5 = { A: 0.08692876065491224, B: 0.005494072432257808, C: 0.5300133392291939, D: 8.283605932402494, E: 0.09246575342465753, cut: 0.005 };
const bmdFilm5: Transfer = {
  label: 'Blackmagic Film Gen 5',
  fromLinear: (x) => (x < BMD5.cut ? BMD5.D * x + BMD5.E : BMD5.A * Math.log(x + BMD5.B) + BMD5.C),
  toLinear: (y) => (y < BMD5.D * BMD5.cut + BMD5.E ? (y - BMD5.E) / BMD5.D : Math.exp((y - BMD5.C) / BMD5.A) - BMD5.B),
};

/**
 * ITU-R BT.709 OETF and its inverse. The inverse turns Rec.709 video into
 * scene-linear the way a "Rec.709 camera" input transform does.
 */
const BT709 = { alpha: 1.09929682680944, beta: 0.018053968510807 };
const bt709: Transfer = {
  label: 'Rec.709',
  fromLinear: (x) => (x < BT709.beta ? 4.5 * x : BT709.alpha * Math.pow(x, 0.45) - (BT709.alpha - 1)),
  toLinear: (v) => (v < 4.5 * BT709.beta ? v / 4.5 : Math.pow((v + (BT709.alpha - 1)) / BT709.alpha, 1 / 0.45)),
};

/** IEC 61966-2-1 sRGB. */
const srgb: Transfer = {
  label: 'sRGB',
  fromLinear: (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055),
  toLinear: (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)),
};

const linear: Transfer = { label: 'Linear', fromLinear: (x) => x, toLinear: (v) => v };

export const TRANSFERS = { logc3, logc4, slog3, log3g10, clog3, vlog, bmdFilm5, bt709, srgb, linear } as const;
export type TransferId = keyof typeof TRANSFERS;

// ---------------------------------------------------------------------------
// Encodings
// ---------------------------------------------------------------------------

export const COLOR_ENCODINGS = [
  'arri_logc3_awg3',
  'arri_logc4_awg4',
  'sony_slog3_sgamut3cine',
  'sony_slog3_sgamut3',
  'red_log3g10_rwg',
  'canon_clog3_cinemagamut',
  'panasonic_vlog_vgamut',
  'bmd_film5_bmdwg',
  'rec709',
  'srgb',
  'acescg',
  'aces2065_1',
  'linear_rec709',
] as const;
export type ColorEncodingId = (typeof COLOR_ENCODINGS)[number];

export interface ColorEncoding {
  label: string;
  transfer: TransferId;
  gamut: GamutId;
  /** camera_log: a camera's log encoding; display: display-referred video; linear: scene-linear. */
  kind: 'camera_log' | 'display' | 'linear';
  /**
   * The adaptation the manufacturer's own ACES input transform uses, so the
   * matrices match theirs (ARRI and Sony publish CAT02-derived matrices).
   */
  adaptation: Adaptation;
}

export const ENCODINGS: Record<ColorEncodingId, ColorEncoding> = {
  arri_logc3_awg3: { label: 'ARRI LogC3 (EI 800) / AWG3', transfer: 'logc3', gamut: 'awg3', kind: 'camera_log', adaptation: 'cat02' },
  arri_logc4_awg4: { label: 'ARRI LogC4 / AWG4', transfer: 'logc4', gamut: 'awg4', kind: 'camera_log', adaptation: 'cat02' },
  sony_slog3_sgamut3cine: { label: 'Sony S-Log3 / S-Gamut3.Cine', transfer: 'slog3', gamut: 'sgamut3cine', kind: 'camera_log', adaptation: 'cat02' },
  sony_slog3_sgamut3: { label: 'Sony S-Log3 / S-Gamut3', transfer: 'slog3', gamut: 'sgamut3', kind: 'camera_log', adaptation: 'cat02' },
  red_log3g10_rwg: { label: 'RED Log3G10 / REDWideGamutRGB', transfer: 'log3g10', gamut: 'rwg', kind: 'camera_log', adaptation: 'bradford' },
  canon_clog3_cinemagamut: { label: 'Canon Log 3 / Cinema Gamut', transfer: 'clog3', gamut: 'cinemagamut', kind: 'camera_log', adaptation: 'cat02' },
  panasonic_vlog_vgamut: { label: 'Panasonic V-Log / V-Gamut', transfer: 'vlog', gamut: 'vgamut', kind: 'camera_log', adaptation: 'bradford' },
  bmd_film5_bmdwg: { label: 'Blackmagic Film Gen 5 / Wide Gamut', transfer: 'bmdFilm5', gamut: 'bmdwg', kind: 'camera_log', adaptation: 'bradford' },
  rec709: { label: 'Rec.709 (video)', transfer: 'bt709', gamut: 'rec709', kind: 'display', adaptation: 'bradford' },
  srgb: { label: 'sRGB', transfer: 'srgb', gamut: 'rec709', kind: 'display', adaptation: 'bradford' },
  acescg: { label: 'ACEScg (linear AP1)', transfer: 'linear', gamut: 'ap1', kind: 'linear', adaptation: 'bradford' },
  aces2065_1: { label: 'ACES2065-1 (linear AP0)', transfer: 'linear', gamut: 'ap0', kind: 'linear', adaptation: 'bradford' },
  linear_rec709: { label: 'Linear Rec.709', transfer: 'linear', gamut: 'rec709', kind: 'linear', adaptation: 'bradford' },
};

export function encodingLabel(id: ColorEncodingId | null | undefined): string {
  return id ? ENCODINGS[id].label : 'Unknown';
}

/** Scene-linear targets a plate can be converted to. Linear needs float, so these are EXR only. */
export const PLATE_TARGETS = ['acescg', 'aces2065_1', 'linear_rec709'] as const;
export type PlateTarget = (typeof PLATE_TARGETS)[number];

// ---------------------------------------------------------------------------
// Reading the handoff's free text
// ---------------------------------------------------------------------------

export interface ParsedEncoding {
  encoding: ColorEncodingId | null;
  /** exact: the text named it; assumed: a gamut or curve was filled in; unknown: not recognised. */
  confidence: 'exact' | 'assumed' | 'unknown';
  note?: string;
}

/**
 * The handoff's `color.sourceColorSpace` (and `gamma`) is free text written
 * by people and by VCDIT: "ARRI LogC4 / AWG4", "S-Log3 / S-Gamut3.Cine",
 * "LogC", "Log3G10 RWG", "ACEScg". Recognise the encodings above; anything
 * else is unknown, never guessed at from the camera body.
 */
export function parseColorEncoding(...texts: (string | null | undefined)[]): ParsedEncoding {
  const raw = texts.filter(Boolean).join(' ');
  const t = ` ${raw.toLowerCase().replace(/[^a-z0-9.]+/g, ' ').replace(/\s+/g, ' ')} `;
  const squash = t.replace(/[\s.]+/g, '');
  const has = (re: RegExp) => re.test(t) || re.test(squash);
  if (!raw.trim()) return { encoding: null, confidence: 'unknown' };

  // Encodings VC VFX does not convert, named explicitly so they are not mistaken for a neighbour.
  if (has(/acescct|acescc\b|acescc$/)) return { encoding: null, confidence: 'unknown', note: 'ACEScct/ACEScc is not converted by VC VFX; plates are written as shot' };
  if (has(/slog2|slog1|clog2|clog\b(?!3)|canonlog(?!3)|redlogfilm|log3g12|logc2|filmgen[1-4]|gen4/) && !has(/slog3|clog3|canonlog3|log3g10|logc3|logc4/)) {
    return { encoding: null, confidence: 'unknown', note: `${raw.trim()} is not one of the encodings VC VFX converts` };
  }

  if (has(/logc4|awg4|arriwidegamut4/)) return { encoding: 'arri_logc4_awg4', confidence: 'exact' };
  if (has(/logc3|awg3|arriwidegamut3/)) return { encoding: 'arri_logc3_awg3', confidence: 'exact' };
  if (has(/logc|alexawidegamut|arriwidegamut|\bawg\b/)) {
    return { encoding: 'arri_logc3_awg3', confidence: 'assumed', note: 'LogC without a version is read as LogC3 (EI 800) / AWG3' };
  }
  if (has(/slog3|sgamut3/)) {
    if (has(/sgamut3cine|cine/)) return { encoding: 'sony_slog3_sgamut3cine', confidence: has(/slog3/) ? 'exact' : 'assumed' };
    if (has(/sgamut3/)) return { encoding: 'sony_slog3_sgamut3', confidence: has(/slog3/) ? 'exact' : 'assumed' };
    return { encoding: 'sony_slog3_sgamut3cine', confidence: 'assumed', note: 'S-Log3 without a gamut is read as S-Gamut3.Cine' };
  }
  if (has(/log3g10|redwidegamut|\brwg\b|ipp2/)) return { encoding: 'red_log3g10_rwg', confidence: has(/log3g10/) && has(/rwg|redwidegamut/) ? 'exact' : 'assumed' };
  if (has(/clog3|canonlog3|cinemagamut/)) return { encoding: 'canon_clog3_cinemagamut', confidence: has(/clog3|canonlog3/) && has(/cinemagamut/) ? 'exact' : 'assumed' };
  if (has(/vlog|vgamut/)) return { encoding: 'panasonic_vlog_vgamut', confidence: has(/vlog/) && has(/vgamut/) ? 'exact' : 'assumed' };
  if (has(/bmdfilm|blackmagicfilm|filmgen5|bmdwidegamut|blackmagicwidegamut|gen5/)) return { encoding: 'bmd_film5_bmdwg', confidence: has(/gen5/) ? 'exact' : 'assumed' };
  if (has(/acescg|\bap1\b/)) return { encoding: 'acescg', confidence: 'exact' };
  if (has(/aces20651|aces2065|\bap0\b|^ aces $/) || t.trim() === 'aces') return { encoding: 'aces2065_1', confidence: 'exact' };
  if (has(/(lin|linear|scenelinear)(rec|bt)?709|linearsrgb|lin srgb/)) return { encoding: 'linear_rec709', confidence: 'exact' };
  if (has(/srgb/)) return { encoding: 'srgb', confidence: 'exact' };
  if (has(/rec709|bt709|\br709\b|rec 709/)) return { encoding: 'rec709', confidence: 'exact' };
  return { encoding: null, confidence: 'unknown', note: `“${raw.trim()}” is not an encoding VC VFX recognises` };
}

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------

/** A conversion between two encodings, ready to be applied: a per-channel decode, a matrix, a per-channel encode. */
export interface ColorTransform {
  from: ColorEncodingId;
  to: ColorEncodingId;
  /** Applied first, per channel: code value → linear. `linear` means none. */
  decode: TransferId;
  /** Linear source gamut → linear target gamut. */
  matrix: Matrix3;
  adaptation: Adaptation | 'none';
  /** Applied last, per channel: linear → code value. `linear` means none (scene-linear output). */
  encode: TransferId;
}

/** The exact transform between two encodings. */
export function colorTransform(from: ColorEncodingId, to: ColorEncodingId): ColorTransform {
  const a = ENCODINGS[from];
  const b = ENCODINGS[to];
  const differentWhite = !sameWhite(GAMUTS[a.gamut].white, GAMUTS[b.gamut].white);
  // The source's own adaptation, so a camera's matrix matches its vendor's IDT.
  const adaptation = differentWhite ? a.kind === 'camera_log' ? a.adaptation : b.kind === 'camera_log' ? b.adaptation : 'bradford' : 'none';
  return {
    from,
    to,
    decode: a.transfer,
    matrix: gamutMatrix(a.gamut, b.gamut, adaptation === 'none' ? 'bradford' : adaptation),
    adaptation,
    encode: b.transfer,
  };
}

export function isIdentityTransform(t: ColorTransform): boolean {
  return t.decode === t.encode && isIdentity3(t.matrix, 1e-7);
}

/** Apply a transform to one RGB triple (for tests, the viewer's browser stand-in and reports). */
export function applyTransform(t: ColorTransform, rgb: Vec3): Vec3 {
  const dec = TRANSFERS[t.decode].toLinear;
  const enc = TRANSFERS[t.encode].fromLinear;
  const lin = apply3(t.matrix, [dec(rgb[0]), dec(rgb[1]), dec(rgb[2])]);
  return [enc(lin[0]), enc(lin[1]), enc(lin[2])];
}

/** Number formatting for LUT files: nine significant digits, no exponent surprises for ffmpeg. */
export function lutNumber(v: number): string {
  if (!Number.isFinite(v)) throw new Error('LUT value is not finite');
  const s = Number(v.toPrecision(9)).toString();
  return s.includes('e') ? v.toFixed(12) : s;
}

/**
 * A 1D `.cube` (Adobe/Resolve format, read by ffmpeg's `lut1d`) of a
 * per-channel function over [domainMin, domainMax]. 4096 points keeps the
 * linear-interpolation error of a camera log curve under 5e-5 relative.
 */
export function cube1D(fn: (v: number) => number, options: { size?: number; domainMin?: number; domainMax?: number; title: string }): string {
  const size = options.size ?? 4096;
  const lo = options.domainMin ?? 0;
  const hi = options.domainMax ?? 1;
  const lines = [`TITLE "${options.title.replace(/"/g, "'")}"`, `LUT_1D_SIZE ${size}`, `DOMAIN_MIN ${lutNumber(lo)} ${lutNumber(lo)} ${lutNumber(lo)}`, `DOMAIN_MAX ${lutNumber(hi)} ${lutNumber(hi)} ${lutNumber(hi)}`];
  for (let i = 0; i < size; i += 1) {
    const v = lutNumber(fn(lo + ((hi - lo) * i) / (size - 1)));
    lines.push(`${v} ${v} ${v}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Code values a video encoding carries above 1.0: Rec.709 and sRGB footage
 * in video range keeps super-whites (10-bit codes 941–1019 read as up to
 * 1.09) — speculars, a lamp, the sky. ffmpeg's lut1d clamps to its domain.
 */
export const VIDEO_CODE_MAX = 1.25;

/**
 * The decode curve of a transform as a 1D cube (code value → linear): 0–1,
 * or 0–1.25 for a video encoding so its super-whites are not clipped (the
 * same step between points).
 */
export function decodeCube(t: ColorTransform, size = 4096): string {
  const video = t.decode === 'bt709' || t.decode === 'srgb';
  return cube1D(TRANSFERS[t.decode].toLinear, { size: video ? Math.round(size * VIDEO_CODE_MAX) : size, domainMax: video ? VIDEO_CODE_MAX : 1, title: `${TRANSFERS[t.decode].label} to linear (VC VFX)` });
}

// ---------------------------------------------------------------------------
// The plate colour policy
// ---------------------------------------------------------------------------

/** What is applied to a plate. Never a display transform or look. */
export type PlateColorPolicy = { mode: 'as_shot' } | { mode: 'convert'; from: ColorEncodingId; to: PlateTarget };

/** A shot's choice. `auto` follows the project default for its delivery format. */
export const SHOT_PLATE_COLOR = ['auto', 'as_shot', 'acescg', 'aces2065_1', 'linear_rec709'] as const;
export type ShotPlateColor = (typeof SHOT_PLATE_COLOR)[number];

/** The project's default for EXR plates. DPX/TIFF/PNG/JPEG always keep the camera encoding. */
export const PROJECT_EXR_COLOR = ['acescg', 'aces2065_1', 'linear_rec709', 'as_shot'] as const;
export type ProjectExrColor = (typeof PROJECT_EXR_COLOR)[number];

export const PLATE_COLOR_LABELS: Record<ShotPlateColor, string> = {
  auto: 'Project default',
  as_shot: 'As shot (no conversion)',
  acescg: 'Convert to ACEScg',
  aces2065_1: 'Convert to ACES2065-1',
  linear_rec709: 'Convert to linear Rec.709',
};

export interface PlateColorDecision {
  policy: PlateColorPolicy;
  /** The source encoding the decision used, and where it came from. */
  sourceEncoding: ColorEncodingId | null;
  sourceEncodingFrom: 'operator' | 'handoff' | 'probe' | 'unknown';
  /** The transform, for `convert`; null for `as_shot`. */
  transform: ColorTransform | null;
  /** The encoding the plate's pixels are in once written. */
  plateEncoding: ColorEncodingId | null;
  /** One line, plain English, for the shot panel and the manifest. */
  summary: string;
  warnings: string[];
  /** Set when the plates cannot be written as chosen (e.g. convert with no known source). */
  blocked: string | null;
}

export interface PlateColorInput {
  format: 'dpx' | 'tiff' | 'exr' | 'png' | 'jpeg';
  bitDepth: number;
  /** The operator's choice for this shot, else null (auto). */
  shotChoice: ShotPlateColor | null;
  projectExr: ProjectExrColor;
  /** Operator's pick, overriding the handoff's text. */
  operatorEncoding: ColorEncodingId | null;
  handoffText: (string | null | undefined)[];
  /** The clip's own colour tags as ffprobe read them, used when the handoff names no encoding. */
  probeTags?: { transfer?: string | undefined; primaries?: string | undefined } | null;
}

/**
 * A video file's colour tags as an encoding, when they say it unambiguously:
 * Rec.709 primaries with the BT.709 (or BT.601) curve, the sRGB curve, or
 * linear. A real ProRes or H.264 from a camera or an online is tagged; a
 * VCDIT handoff (which carries no colour) otherwise leaves such a clip
 * "unknown" and its EXR plates would keep the video curve. Null when untagged
 * or anything else (HLG, PQ, wide gamuts): the operator says.
 */
export function encodingFromTags(tags: PlateColorInput['probeTags']): ColorEncodingId | null {
  const t = tags?.transfer?.toLowerCase();
  const p = tags?.primaries?.toLowerCase();
  if (!t || !p || p !== 'bt709') return null;
  if (t === 'bt709' || t === 'smpte170m' || t === 'bt470bg' || t === 'bt2020-10' || t === 'bt2020-12') return t.startsWith('bt2020') ? null : 'rec709';
  if (t === 'iec61966-2-1') return 'srgb';
  if (t === 'linear') return 'linear_rec709';
  return null;
}

const formatLabel = (format: PlateColorInput['format'], bitDepth: number) =>
  format === 'exr' ? `EXR ${bitDepth >= 32 ? 'float' : 'half'}` : format === 'jpeg' ? 'JPEG' : `${format.toUpperCase()} ${bitDepth}-bit`;

/**
 * The colour decision for a shot's plates. Defaults (addendum 03):
 *  - EXR → the project default (ACEScg) when the source encoding is known,
 *    else as shot with a warning;
 *  - DPX / TIFF / PNG / JPEG → as shot, keeping the camera's log encoding
 *    (linear does not fit an integer format without clipping).
 * A display transform or look is never part of it.
 */
export function decidePlateColor(input: PlateColorInput): PlateColorDecision {
  const parsed = parseColorEncoding(...input.handoffText);
  const tagged = parsed.encoding ? null : encodingFromTags(input.probeTags);
  const sourceEncoding = input.operatorEncoding ?? parsed.encoding ?? tagged;
  const sourceEncodingFrom = input.operatorEncoding ? 'operator' : parsed.encoding ? 'handoff' : tagged ? 'probe' : 'unknown';
  const warnings: string[] = [];
  if (!input.operatorEncoding && parsed.note) warnings.push(parsed.note);
  if (sourceEncodingFrom === 'probe') warnings.push(`The handoff names no source encoding; the clip is tagged ${input.probeTags!.transfer}/${input.probeTags!.primaries}, read as ${ENCODINGS[tagged!].label}. Choose another if the tags are wrong.`);
  const isFloat = input.format === 'exr';
  const fmt = formatLabel(input.format, input.bitDepth);
  const srcLabel = sourceEncoding ? ENCODINGS[sourceEncoding].label : 'an unknown encoding';

  const choice: ShotPlateColor = input.shotChoice && input.shotChoice !== 'auto' ? input.shotChoice : isFloat ? input.projectExr : 'as_shot';
  const explicit = Boolean(input.shotChoice && input.shotChoice !== 'auto');

  const asShot = (extra?: string): PlateColorDecision => ({
    policy: { mode: 'as_shot' },
    sourceEncoding,
    sourceEncodingFrom,
    transform: null,
    plateEncoding: sourceEncoding,
    summary: `Writes ${fmt} as shot${sourceEncoding ? ` (${srcLabel} kept)` : ''}${extra ? `, ${extra}` : ''}; no look applied.`,
    warnings,
    blocked: null,
  });

  if (choice === 'as_shot') return asShot();
  const target = choice;
  if (!isFloat) {
    if (explicit) {
      return { ...asShot(), blocked: `Linear ${ENCODINGS[target].label} needs a float format; ${fmt} keeps the camera encoding. Deliver EXR, or choose “As shot”.` };
    }
    return asShot();
  }
  if (!sourceEncoding) {
    if (explicit) {
      return { ...asShot(), blocked: 'The source encoding is unknown, so there is nothing to convert from. Choose the source encoding, or “As shot”.' };
    }
    warnings.push(`Source encoding unknown: EXR written as shot, not converted to ${ENCODINGS[target].label}. Choose the source encoding to convert.`);
    return asShot('source encoding unknown, no conversion');
  }
  if (sourceEncoding === target) return asShot(`already ${ENCODINGS[target].label}`);
  const transform = colorTransform(sourceEncoding, target);
  return {
    policy: { mode: 'convert', from: sourceEncoding, to: target },
    sourceEncoding,
    sourceEncodingFrom,
    transform,
    plateEncoding: target,
    summary: `Writes ${ENCODINGS[target].label.replace(/ \(.*\)$/, '')} linear ${fmt} from ${srcLabel}; no look applied.`,
    warnings,
    blocked: null,
  };
}

/** A transform as words and numbers, for the log and the manifest. */
export function describeTransform(t: ColorTransform): string {
  const m = t.matrix.map((v) => v.toFixed(6));
  return `${TRANSFERS[t.decode].label} → linear; matrix ${GAMUTS[ENCODINGS[t.from].gamut].label} → ${GAMUTS[ENCODINGS[t.to].gamut].label} (${t.adaptation === 'none' ? 'no white adaptation' : `${t.adaptation === 'cat02' ? 'CAT02' : 'Bradford'} white adaptation`}) [${m.slice(0, 3).join(' ')} | ${m.slice(3, 6).join(' ')} | ${m.slice(6).join(' ')}]${t.encode === 'linear' ? '' : `; linear → ${TRANSFERS[t.encode].label}`}`;
}

// ---------------------------------------------------------------------------
// Viewing (never applied to plates)
// ---------------------------------------------------------------------------

export const VIEW_TRANSFORMS = ['rec709', 'raw'] as const;
export type ViewTransformId = (typeof VIEW_TRANSFORMS)[number];

/**
 * A simple, honest display transform for looking at log or linear images on
 * an ordinary monitor: decode to scene-linear, matrix to Rec.709 primaries,
 * a filmic tone curve (Krzysztof Narkowicz's fit of the ACES RRT+ODT, with
 * its customary 0.6 exposure), then the inverse of the BT.1886 2.4 gamma.
 * It is an approximation of the vendors' own Rec.709 LUTs, labelled as such,
 * and is used only to make viewer frames.
 */
export interface ViewPipeline {
  label: string;
  /** Null: nothing to do (raw view, or the image is already display-referred). */
  decode: TransferId | null;
  matrix: Matrix3 | null;
  tone: boolean;
}

export function filmicTone(x: number): number {
  const v = Math.max(0, x) * 0.6;
  const y = (v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14);
  return Math.min(1, Math.max(0, y));
}

/** Tone curve and display encode, scene-linear (Rec.709 primaries) → display code value. */
export function viewDisplayCurve(x: number): number {
  return Math.pow(filmicTone(x), 1 / 2.4);
}

/** The upper end of the viewer's tone-curve LUT domain (scene-linear): the curve has reached white there. */
export const VIEW_LINEAR_MAX = 16;

export function viewTransform(encoding: ColorEncodingId | null, view: ViewTransformId): ViewPipeline {
  if (view === 'raw') return { label: 'Raw values (as encoded)', decode: null, matrix: null, tone: false };
  if (!encoding) return { label: 'Raw values (encoding unknown)', decode: null, matrix: null, tone: false };
  const e = ENCODINGS[encoding];
  if (e.kind === 'display') return { label: `${e.label} (display-referred, shown as is)`, decode: null, matrix: null, tone: false };
  const matrix = colorTransform(encoding, 'linear_rec709').matrix;
  const short = e.kind === 'linear' ? e.label.replace(/ \(.*\)$/, '') : TRANSFERS[e.transfer].label.replace(/ \(EI 800\)$/, '');
  return { label: `${short} → Rec.709 (approx.)`, decode: e.transfer === 'linear' ? null : e.transfer, matrix: isIdentity3(matrix, 1e-7) ? null : matrix, tone: true };
}

/** Apply a view pipeline to one pixel (the browser preview's stand-in and tests). */
export function applyView(p: ViewPipeline, rgb: Vec3): Vec3 {
  let v: Vec3 = rgb;
  if (p.decode) {
    const d = TRANSFERS[p.decode].toLinear;
    v = [d(v[0]), d(v[1]), d(v[2])];
  }
  if (p.matrix) v = apply3(p.matrix, v);
  if (p.tone) v = [viewDisplayCurve(v[0]), viewDisplayCurve(v[1]), viewDisplayCurve(v[2])];
  return v;
}
