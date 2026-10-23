import { distort, undistort, type Intrinsics } from './geometry';

/**
 * Lens STMaps (addendum 06 §6): images whose red and green channels say, for
 * every output pixel, where to sample the input (u, v in 0 … 1, v = 0 at the
 * bottom — Nuke's STMap convention, pixel centres at (x + 0.5)/W).
 *
 *  - undistort map: output = the undistorted (pinhole) image; it samples the
 *    distorted plate. Apply to the plate to match the exported camera.
 *  - redistort map: output = the distorted image; it samples the undistorted
 *    render. Apply to CG to put the lens back.
 *
 * In the plate's own (squeezed) pixel space: same stored resolution, u
 * across the stored width. For a non-square plate the distortion is computed
 * on de-squeezed (physical) coordinates and mapped back, so the map applies
 * to the squeezed plate as delivered (addendum 17).
 *
 * Same resolution as the plate (no overscan): undistorting a barrel-distorted
 * plate pushes its corners out of frame. Written as uncompressed 32-bit float
 * scanline OpenEXR by our own writer (R, G, B channels; B = 0).
 */

export interface STMap {
  width: number;
  height: number;
  /** u, v per pixel. */
  uv: Float32Array;
}

export function undistortMap(k: Intrinsics, width: number, height: number): STMap {
  const a = k.a ?? 1;
  const uv = new Float32Array(width * height * 2);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      // This output pixel is undistorted; find where it lies on the distorted plate.
      const [xd, yd] = distort(k, ((x - k.cx) * a) / k.f, (y - k.cy) / k.f);
      const px = (k.f * xd) / a + k.cx;
      const py = k.f * yd + k.cy;
      const i = 2 * (y * width + x);
      uv[i] = (px + 0.5) / width;
      uv[i + 1] = 1 - (py + 0.5) / height;
    }
  return { width, height, uv };
}

export function redistortMap(k: Intrinsics, width: number, height: number): STMap {
  const a = k.a ?? 1;
  const uv = new Float32Array(width * height * 2);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const [xu, yu] = undistort(k, ((x - k.cx) * a) / k.f, (y - k.cy) / k.f);
      const px = (k.f * xu) / a + k.cx;
      const py = k.f * yu + k.cy;
      const i = 2 * (y * width + x);
      uv[i] = (px + 0.5) / width;
      uv[i + 1] = 1 - (py + 0.5) / height;
    }
  return { width, height, uv };
}

/** Where an STMap sends output pixel (x, y): the input pixel position it samples. */
export function sampleSTMap(m: STMap, x: number, y: number): [number, number] {
  const i = 2 * (y * m.width + x);
  return [m.uv[i]! * m.width - 0.5, (1 - m.uv[i + 1]!) * m.height - 0.5];
}

/**
 * An uncompressed scanline OpenEXR with float channels (written in the file's
 * alphabetical channel order). Header attributes per the OpenEXR file layout:
 * channels, compression, dataWindow, displayWindow, lineOrder,
 * pixelAspectRatio, screenWindowCenter, screenWindowWidth.
 */
/** IEEE half from a float (round to nearest even; overflow to infinity). */
export function toHalf(v: number): number {
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  f32[0] = v;
  const x = u32[0]!;
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  let e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mant = (mant | 0x800000) >> (1 - e);
    const half = mant >> 13;
    const rest = mant & 0x1fff;
    return sign | (half + (rest > 0x1000 || (rest === 0x1000 && half & 1) ? 1 : 0));
  }
  let half = (e << 10) | (mant >> 13);
  const rest = mant & 0x1fff;
  if (rest > 0x1000 || (rest === 0x1000 && half & 1)) half += 1;
  return sign | half;
}

export function encodeExrFloat(width: number, height: number, channels: Record<string, Float32Array>, type: 'float' | 'half' = 'float'): Uint8Array {
  const half = type === 'half';
  const bytesPer = half ? 2 : 4;
  const names = Object.keys(channels).sort();
  const parts: number[] = [];
  const bytes: Uint8Array[] = [];
  const u8 = (...v: number[]) => bytes.push(Uint8Array.from(v));
  const str = (s: string) => bytes.push(new TextEncoder().encode(`${s}\0`));
  const i32 = (v: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, v, true);
    bytes.push(b);
  };
  const f32 = (v: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v, true);
    bytes.push(b);
  };
  const attr = (name: string, type: string, size: number, body: () => void) => {
    str(name);
    str(type);
    i32(size);
    body();
  };
  void parts;
  // Magic and version (2, single-part scanline).
  u8(0x76, 0x2f, 0x31, 0x01);
  u8(2, 0, 0, 0);
  const chlistSize = names.reduce((n, c) => n + c.length + 1 + 16, 0) + 1;
  attr('channels', 'chlist', chlistSize, () => {
    for (const c of names) {
      str(c);
      i32(half ? 1 : 2); // HALF or FLOAT
      u8(0, 0, 0, 0); // pLinear + reserved
      i32(1); // xSampling
      i32(1); // ySampling
    }
    u8(0);
  });
  attr('compression', 'compression', 1, () => u8(0)); // NO_COMPRESSION
  attr('dataWindow', 'box2i', 16, () => {
    i32(0);
    i32(0);
    i32(width - 1);
    i32(height - 1);
  });
  attr('displayWindow', 'box2i', 16, () => {
    i32(0);
    i32(0);
    i32(width - 1);
    i32(height - 1);
  });
  attr('lineOrder', 'lineOrder', 1, () => u8(0)); // INCREASING_Y
  attr('pixelAspectRatio', 'float', 4, () => f32(1));
  attr('screenWindowCenter', 'v2f', 8, () => {
    f32(0);
    f32(0);
  });
  attr('screenWindowWidth', 'float', 4, () => f32(1));
  u8(0); // end of header
  const headerLen = bytes.reduce((n, b) => n + b.length, 0);
  const lineBytes = names.length * width * bytesPer;
  const chunk = 8 + lineBytes;
  const tableLen = 8 * height;
  const total = headerLen + tableLen + chunk * height;
  const out = new Uint8Array(total);
  let o = 0;
  for (const b of bytes) {
    out.set(b, o);
    o += b.length;
  }
  const dv = new DataView(out.buffer);
  for (let y = 0; y < height; y += 1) {
    dv.setBigUint64(o, BigInt(headerLen + tableLen + y * chunk), true);
    o += 8;
  }
  for (let y = 0; y < height; y += 1) {
    dv.setInt32(o, y, true);
    dv.setInt32(o + 4, lineBytes, true);
    o += 8;
    for (const c of names) {
      const src = channels[c]!;
      for (let x = 0; x < width; x += 1) {
        if (half) dv.setUint16(o, toHalf(src[y * width + x]!), true);
        else dv.setFloat32(o, src[y * width + x]!, true);
        o += bytesPer;
      }
    }
  }
  return out;
}

/** An STMap as EXR bytes: R = u, G = v, B = 0. */
export function stmapExr(m: STMap): Uint8Array {
  const n = m.width * m.height;
  const R = new Float32Array(n);
  const G = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    R[i] = m.uv[2 * i]!;
    G[i] = m.uv[2 * i + 1]!;
  }
  return encodeExrFloat(m.width, m.height, { R, G, B: new Float32Array(n) });
}
