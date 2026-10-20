import { describe, expect, it } from 'vitest';
import {
  COLOR_ENCODINGS,
  ENCODINGS,
  TRANSFERS,
  applyTransform,
  applyView,
  colorTransform,
  cube1D,
  decidePlateColor,
  decodeCube,
  describeTransform,
  gamutMatrix,
  invert3,
  isIdentityTransform,
  mul3,
  parseColorEncoding,
  rgbToXyz,
  viewTransform,
  type Matrix3,
  type PlateColorInput,
  type TransferId,
} from '../color';

const close = (a: readonly number[], b: readonly number[], tol: number) => a.forEach((v, i) => expect(Math.abs(v - b[i]!)).toBeLessThanOrEqual(tol));

describe('transfer functions', () => {
  it('put 18% grey where the manufacturers say', () => {
    // Published reference code values for 18% grey (normalised full range).
    expect(TRANSFERS.logc3.fromLinear(0.18)).toBeCloseTo(0.391007, 5); // ARRI: 0.391
    expect(TRANSFERS.logc4.fromLinear(0.18)).toBeCloseTo(0.2784, 3); // ARRI LogC4 spec: ≈ 0.278
    expect(TRANSFERS.slog3.fromLinear(0.18)).toBeCloseTo(420 / 1023, 6); // Sony: code 420, 41 %
    expect(TRANSFERS.log3g10.fromLinear(0.18)).toBeCloseTo(1 / 3, 4); // RED: one third
    expect(TRANSFERS.vlog.fromLinear(0.18)).toBeCloseTo(0.4233, 3); // Panasonic: 42.3 %
    expect(TRANSFERS.bmdFilm5.fromLinear(0.18)).toBeCloseTo(0.3836, 3); // Blackmagic Gen 5: 38.4 %
    // Canon Log 3: 34.3 % IRE → (0.343 · 876 + 64) / 1023.
    expect(((TRANSFERS.clog3.fromLinear(0.18) * 1023 - 64) / 876)).toBeCloseTo(0.3434, 3);
    expect(TRANSFERS.bt709.fromLinear(0.18)).toBeCloseTo(0.409, 3);
    expect(TRANSFERS.srgb.fromLinear(0.18)).toBeCloseTo(0.4614, 3);
  });

  it('put black where the manufacturers say', () => {
    expect(TRANSFERS.logc3.fromLinear(0)).toBeCloseTo(0.092809, 6);
    expect(TRANSFERS.slog3.fromLinear(0) * 1023).toBeCloseTo(95, 6);
    expect(TRANSFERS.vlog.fromLinear(0)).toBeCloseTo(0.125, 6);
    expect(TRANSFERS.logc4.fromLinear(0)).toBeCloseTo(95 / 1023, 6);
  });

  it.each(Object.keys(TRANSFERS) as TransferId[])('%s round-trips across its range', (id) => {
    const t = TRANSFERS[id];
    for (const x of [-0.005, 0, 0.001, 0.01, 0.0114, 0.05, 0.18, 0.9, 1, 4, 16, 40]) {
      if ((id === 'bt709' || id === 'srgb') && (x < 0 || x > 1)) continue;
      // V-Log as published is discontinuous by ~1e-7 at its cut.
      expect(t.toLinear(t.fromLinear(x))).toBeCloseTo(x, id === 'vlog' ? 6 : 9);
    }
    for (let v = 0; v <= 1; v += 1 / 64) expect(t.fromLinear(t.toLinear(v))).toBeCloseTo(v, 9);
  });

  it('are continuous at their cuts and increasing', () => {
    for (const id of Object.keys(TRANSFERS) as TransferId[]) {
      let previous = -Infinity;
      for (let i = 0; i <= 4096; i += 1) {
        const y = TRANSFERS[id].toLinear(i / 4096);
        expect(y).toBeGreaterThan(previous);
        if (i > 0) expect(y - previous).toBeLessThan(Math.max(1, Math.abs(y) * 0.02));
        previous = y;
      }
    }
  });
});

describe('gamut matrices', () => {
  const row = (m: Matrix3) => [...m];
  it('reproduce the vendors’ published ACES input matrices', () => {
    // ARRI AWG3 → AP0 (ARRI IDT, CAT02).
    close(row(gamutMatrix('awg3', 'ap0', 'cat02')), [0.680206, 0.236137, 0.083658, 0.085415, 1.017471, -0.102886, 0.002057, -0.062563, 1.060506], 2e-6);
    // Sony S-Gamut3.Cine → AP0 (Sony IDT, CAT02).
    close(row(gamutMatrix('sgamut3cine', 'ap0', 'cat02')), [0.6387886672, 0.2723514337, 0.0888598991, -0.003915906, 1.0880732309, -0.0841573249, -0.0299072021, -0.0264325799, 1.056339782], 2e-6);
    // Canon Cinema Gamut → AP0 (Canon IDT).
    close(row(gamutMatrix('cinemagamut', 'ap0', 'cat02')), [0.763064, 0.149021, 0.087916, 0.003657, 1.10696, -0.110617, -0.009407, -0.218383, 1.22779], 3e-6);
    // RED RWG → AP0 (RED IPP2 IDT, Bradford).
    close(row(gamutMatrix('rwg', 'ap0', 'bradford')), [0.785043, 0.083844, 0.131118, 0.023172, 1.087892, -0.111055, -0.073769, -0.314639, 1.388537], 2e-4);
    // ACES: Rec.709 → AP1 and AP0 → AP1 (Academy TB-2014-004 / aces-dev).
    close(row(gamutMatrix('rec709', 'ap1')), [0.6130974024, 0.3395231462, 0.0473794514, 0.0701937225, 0.9163538791, 0.0134523985, 0.0206155929, 0.1095697729, 0.8698146342], 1e-6);
    close(row(gamutMatrix('ap0', 'ap1')), [1.4514393161, -0.2365107469, -0.2149285693, -0.0765537734, 1.1762296998, -0.0996759264, 0.0083161484, -0.0060324498, 0.9977163014], 1e-6);
  });

  it('map white to white and invert', () => {
    for (const id of COLOR_ENCODINGS) {
      const m = colorTransform(id, 'acescg').matrix;
      const white = [m[0] + m[1] + m[2], m[3] + m[4] + m[5], m[6] + m[7] + m[8]];
      close(white, [1, 1, 1], 1e-6);
      close([...mul3(m, invert3(m))], [1, 0, 0, 0, 1, 0, 0, 0, 1], 1e-9);
    }
  });

  it('give Rec.709 its textbook XYZ matrix', () => {
    close([...rgbToXyz({ label: '', red: [0.64, 0.33], green: [0.3, 0.6], blue: [0.15, 0.06], white: [0.3127, 0.329] })], [0.4124, 0.3576, 0.1805, 0.2126, 0.7152, 0.0722, 0.0193, 0.1192, 0.9505], 1e-4);
  });
});

describe('parseColorEncoding', () => {
  it.each([
    ['ARRI LogC4 / AWG4', 'arri_logc4_awg4', 'exact'],
    ['LogC3', 'arri_logc3_awg3', 'exact'],
    ['Log C EI800 / ALEXA Wide Gamut', 'arri_logc3_awg3', 'assumed'],
    ['S-Log3 / S-Gamut3.Cine', 'sony_slog3_sgamut3cine', 'exact'],
    ['SLog3 SGamut3', 'sony_slog3_sgamut3', 'exact'],
    ['S-Log3', 'sony_slog3_sgamut3cine', 'assumed'],
    ['Log3G10 / REDWideGamutRGB', 'red_log3g10_rwg', 'exact'],
    ['RED IPP2 Log3G10', 'red_log3g10_rwg', 'assumed'],
    ['Canon Log 3 / Cinema Gamut', 'canon_clog3_cinemagamut', 'exact'],
    ['C-Log3', 'canon_clog3_cinemagamut', 'assumed'],
    ['V-Log / V-Gamut', 'panasonic_vlog_vgamut', 'exact'],
    ['Blackmagic Film Gen 5', 'bmd_film5_bmdwg', 'exact'],
    ['ACEScg', 'acescg', 'exact'],
    ['ACES2065-1 (AP0)', 'aces2065_1', 'exact'],
    ['Linear Rec.709', 'linear_rec709', 'exact'],
    ['Rec.709', 'rec709', 'exact'],
    ['BT.709', 'rec709', 'exact'],
    ['sRGB', 'srgb', 'exact'],
  ] as const)('reads “%s”', (text, encoding, confidence) => {
    expect(parseColorEncoding(text)).toMatchObject({ encoding, confidence });
  });

  it.each(['', 'ACEScct', 'S-Log2 / S-Gamut', 'Canon Log 2', 'REDlogFilm', 'Cineon', 'P3-D65'])('does not guess at “%s”', (text) => {
    expect(parseColorEncoding(text).encoding).toBeNull();
  });

  it('reads the gamma field alongside', () => {
    expect(parseColorEncoding('S-Gamut3.Cine', 'S-Log3').encoding).toBe('sony_slog3_sgamut3cine');
  });
});

describe('colorTransform', () => {
  it('converts LogC3 18% grey to 0.18 in ACEScg and back', () => {
    const t = colorTransform('arri_logc3_awg3', 'acescg');
    close([...applyTransform(t, [0.391007, 0.391007, 0.391007])], [0.18, 0.18, 0.18], 1e-5);
    close([...applyTransform(colorTransform('acescg', 'arri_logc3_awg3'), [0.18, 0.18, 0.18])], [0.391007, 0.391007, 0.391007], 1e-5);
  });

  it('keeps linear values above 1.0', () => {
    const out = applyTransform(colorTransform('arri_logc4_awg4', 'acescg'), [1, 1, 1]);
    expect(out[1]).toBeGreaterThan(400);
  });

  it('round-trips every encoding through ACEScg', () => {
    for (const id of COLOR_ENCODINGS) {
      const there = colorTransform(id, 'acescg');
      const back = colorTransform('acescg', id);
      const rgb = [0.3, 0.45, 0.6] as const;
      close([...applyTransform(back, applyTransform(there, rgb))], rgb, 1e-7);
    }
  });

  it('is the identity for an encoding to itself', () => {
    expect(isIdentityTransform(colorTransform('acescg', 'acescg'))).toBe(true);
    expect(isIdentityTransform(colorTransform('arri_logc3_awg3', 'acescg'))).toBe(false);
  });

  it('describes itself with its numbers', () => {
    const d = describeTransform(colorTransform('sony_slog3_sgamut3cine', 'acescg'));
    expect(d).toMatch(/Sony S-Log3 → linear; matrix S-Gamut3.Cine → ACES AP1 \(CAT02 white adaptation\) \[/);
  });
});

describe('cube1D', () => {
  it('writes a lut1d ffmpeg reads, sampling the curve exactly at its points', () => {
    const text = decodeCube(colorTransform('arri_logc3_awg3', 'acescg'), 1024);
    const lines = text.trim().split('\n');
    expect(lines[1]).toBe('LUT_1D_SIZE 1024');
    expect(lines[2]).toBe('DOMAIN_MIN 0 0 0');
    expect(lines[3]).toBe('DOMAIN_MAX 1 1 1');
    expect(lines).toHaveLength(4 + 1024);
    expect(Number(lines[4]!.split(' ')[0])).toBeCloseTo(TRANSFERS.logc3.toLinear(0), 7);
    expect(Number(lines[lines.length - 1]!.split(' ')[0])).toBeCloseTo(TRANSFERS.logc3.toLinear(1), 4);
  });

  it('stays within 5e-5 of the curve between points at 4096', () => {
    const N = 4096;
    for (const id of ['logc3', 'logc4', 'slog3', 'log3g10'] as const) {
      const f = TRANSFERS[id].toLinear;
      for (let k = 100; k < N - 1; k += 97) {
        const v = (k + 0.5) / (N - 1);
        const lerp = (f(k / (N - 1)) + f((k + 1) / (N - 1))) / 2;
        expect(Math.abs(lerp - f(v)) / Math.max(Math.abs(f(v)), 1e-3)).toBeLessThan(5e-5);
      }
    }
  });

  it('supports a custom domain', () => {
    expect(cube1D((v) => v * 2, { size: 3, domainMin: 0, domainMax: 64, title: 'x' })).toContain('DOMAIN_MAX 64 64 64\n0 0 0\n64 64 64\n128 128 128');
  });
});

describe('decidePlateColor', () => {
  const base: PlateColorInput = { format: 'exr', bitDepth: 16, shotChoice: null, projectExr: 'acescg', operatorEncoding: null, handoffText: ['ARRI LogC4 / AWG4'] };

  it('converts EXR to ACEScg by default when the encoding is known', () => {
    const d = decidePlateColor(base);
    expect(d.policy).toEqual({ mode: 'convert', from: 'arri_logc4_awg4', to: 'acescg' });
    expect(d.summary).toBe('Writes ACEScg linear EXR half from ARRI LogC4 / AWG4; no look applied.');
    expect(d.transform?.decode).toBe('logc4');
    expect(d.plateEncoding).toBe('acescg');
    expect(d.blocked).toBeNull();
  });

  it('writes EXR as shot, with a warning, when the encoding is unknown', () => {
    const d = decidePlateColor({ ...base, handoffText: [] });
    expect(d.policy).toEqual({ mode: 'as_shot' });
    expect(d.warnings.join(' ')).toMatch(/Source encoding unknown/);
    expect(d.summary).toMatch(/as shot, source encoding unknown/);
  });

  it('keeps DPX in the camera encoding', () => {
    const d = decidePlateColor({ ...base, format: 'dpx', bitDepth: 10 });
    expect(d.policy).toEqual({ mode: 'as_shot' });
    expect(d.summary).toBe('Writes DPX 10-bit as shot (ARRI LogC4 / AWG4 kept); no look applied.');
  });

  it('refuses linear into an integer format when asked explicitly', () => {
    expect(decidePlateColor({ ...base, format: 'dpx', bitDepth: 10, shotChoice: 'acescg' }).blocked).toMatch(/float format/);
  });

  it('refuses a conversion with nothing to convert from', () => {
    expect(decidePlateColor({ ...base, handoffText: ['Cineon'], shotChoice: 'aces2065_1' }).blocked).toMatch(/unknown/);
  });

  it('lets the operator override the encoding and the policy', () => {
    const d = decidePlateColor({ ...base, operatorEncoding: 'sony_slog3_sgamut3', shotChoice: 'aces2065_1' });
    expect(d.policy).toEqual({ mode: 'convert', from: 'sony_slog3_sgamut3', to: 'aces2065_1' });
    expect(d.sourceEncodingFrom).toBe('operator');
    expect(decidePlateColor({ ...base, shotChoice: 'as_shot' }).policy).toEqual({ mode: 'as_shot' });
    expect(decidePlateColor({ ...base, projectExr: 'as_shot' }).policy).toEqual({ mode: 'as_shot' });
  });

  it('does not convert an ACEScg source to itself', () => {
    const d = decidePlateColor({ ...base, handoffText: ['ACEScg'] });
    expect(d.policy.mode).toBe('as_shot');
    expect(d.summary).toMatch(/already ACEScg/);
  });

  it('never mentions a look being applied', () => {
    for (const id of COLOR_ENCODINGS) expect(decidePlateColor({ ...base, operatorEncoding: id }).summary).toMatch(/no look applied\.$/);
  });
});

describe('viewTransform', () => {
  it('maps LogC3 18% grey to a sensible display value and is labelled as approximate', () => {
    const v = viewTransform('arri_logc3_awg3', 'rec709');
    expect(v.label).toBe('ARRI LogC3 → Rec.709 (approx.)');
    const [r, g, b] = applyView(v, [0.391007, 0.391007, 0.391007]);
    expect(g).toBeGreaterThan(0.38);
    expect(g).toBeLessThan(0.5);
    close([r, b], [g, g], 1e-6);
  });

  it('rolls highlights off below 1 and keeps black at 0', () => {
    const v = viewTransform('acescg', 'rec709');
    expect(applyView(v, [50, 50, 50])[0]).toBeLessThanOrEqual(1);
    expect(applyView(v, [0, 0, 0])[0]).toBe(0);
  });

  it('leaves raw, display-referred and unknown images alone', () => {
    expect(viewTransform('arri_logc4_awg4', 'raw')).toMatchObject({ decode: null, matrix: null, tone: false });
    expect(viewTransform('rec709', 'rec709')).toMatchObject({ decode: null, tone: false });
    expect(viewTransform(null, 'rec709').label).toMatch(/unknown/);
  });

  it('labels every encoding', () => {
    for (const id of COLOR_ENCODINGS) expect(ENCODINGS[id].label.length).toBeGreaterThan(3);
  });
});
