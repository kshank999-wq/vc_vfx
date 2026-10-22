import type { TextureCamera } from '@vcvfx/domain';

/**
 * The camera of a still from its EXIF (addendum 12 §2): make and model, lens,
 * focal length, and the 35 mm-equivalent focal length — from which the film
 * back follows (36 mm × focal / equivalent), so the photo's field of view is
 * known and it can be undistorted with a lens profile. Reads JPEG (APP1) and
 * TIFF headers; anything else, or a still without EXIF, gives null. Only the
 * first bytes of the file are needed.
 */

export interface ExifCamera {
  make: string | null;
  model: string | null;
  lens: string | null;
  focalMm: number | null;
  focal35Mm: number | null;
}

const TAGS = { make: 0x010f, model: 0x0110, exifIfd: 0x8769, focal: 0x920a, focal35: 0xa405, lens: 0xa434 } as const;

function readTiff(view: DataView, start: number): ExifCamera | null {
  if (start + 8 > view.byteLength) return null;
  const order = view.getUint16(start);
  const le = order === 0x4949;
  if (!le && order !== 0x4d4d) return null;
  const u16 = (o: number) => view.getUint16(start + o, le);
  const u32 = (o: number) => view.getUint32(start + o, le);
  if (u16(2) !== 42) return null;
  const out: ExifCamera = { make: null, model: null, lens: null, focalMm: null, focal35Mm: null };
  const ascii = (count: number, valueOffset: number) => {
    const at = count <= 4 ? valueOffset : u32(valueOffset);
    let s = '';
    for (let i = 0; i < count && start + at + i < view.byteLength; i += 1) {
      const c = view.getUint8(start + at + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s.trim() || null;
  };
  const walk = (ifd: number, depth: number) => {
    if (depth > 2 || ifd <= 0 || start + ifd + 2 > view.byteLength) return;
    const n = u16(ifd);
    for (let i = 0; i < n; i += 1) {
      const e = ifd + 2 + i * 12;
      if (start + e + 12 > view.byteLength) return;
      const tag = u16(e);
      const type = u16(e + 2);
      const count = u32(e + 4);
      if (tag === TAGS.make && type === 2) out.make = ascii(count, e + 8);
      else if (tag === TAGS.model && type === 2) out.model = ascii(count, e + 8);
      else if (tag === TAGS.lens && type === 2) out.lens = ascii(count, e + 8);
      else if (tag === TAGS.focal && type === 5) {
        const at = u32(e + 8);
        const den = u32(at + 4);
        if (den) out.focalMm = u32(at) / den;
      } else if (tag === TAGS.focal35 && type === 3) out.focal35Mm = u16(e + 8) || null;
      else if (tag === TAGS.exifIfd) walk(u32(e + 8), depth + 1);
    }
  };
  try {
    walk(u32(4), 0);
  } catch {
    return out;
  }
  return out;
}

export function parseExif(bytes: Uint8Array): ExifCamera | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12) return null;
  // TIFF: the file is the header.
  if ((bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4d && bytes[1] === 0x4d)) return readTiff(view, 0);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let o = 2;
  while (o + 4 < bytes.length) {
    if (bytes[o] !== 0xff) return null;
    const marker = bytes[o + 1]!;
    const size = view.getUint16(o + 2);
    if (marker === 0xe1 && bytes[o + 4] === 0x45 && bytes[o + 5] === 0x78 && bytes[o + 6] === 0x69 && bytes[o + 7] === 0x66) return readTiff(view, o + 10);
    if (marker === 0xda || marker === 0xd9) return null;
    o += 2 + size;
  }
  return null;
}

/** A texture camera record from EXIF (null when it says nothing useful). */
export function cameraFromExif(e: ExifCamera | null): Partial<TextureCamera> | null {
  if (!e || (!e.focalMm && !e.make && !e.model)) return null;
  const body = [e.make, e.model && e.make && e.model.startsWith(e.make) ? e.model.slice(e.make.length).trim() : e.model].filter(Boolean).join(' ');
  return {
    body,
    lens: e.lens ?? '',
    focalMm: e.focalMm ? Math.round(e.focalMm * 100) / 100 : null,
    filmBackWidthMm: e.focalMm && e.focal35Mm ? Math.round(((36 * e.focalMm) / e.focal35Mm) * 100) / 100 : null,
  };
}
