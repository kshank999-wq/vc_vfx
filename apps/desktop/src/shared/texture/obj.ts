/**
 * The planar patches of a texture export as Wavefront OBJ + MTL (addendum 12
 * §6): one object and one material per region, a quad with UVs 0–1 across the
 * texture (v up, as OBJ has it), in the scan's coordinates and units — for a
 * quick drop into Maya, Blender, Houdini or Unreal. A small reader is here too,
 * so what is written is read back by the tests.
 */

export interface ObjPatch {
  /** Object and material name (letters, digits, _). */
  name: string;
  /** Corners in texture order: top-left, top-right, bottom-right, bottom-left. */
  corners: [number, number, number][];
  /** The texture file the material maps (relative to the MTL). */
  texture: string;
}

const clean = (s: string) => s.replace(/[^A-Za-z0-9_.-]+/g, '_');
const num = (v: number) => (Math.abs(v) < 1e-9 ? '0' : (+v.toFixed(6)).toString());

export function writeObj(patches: readonly ObjPatch[], mtlFile: string, header: string[] = []): string {
  const lines = [...header.map((h) => `# ${h}`), `mtllib ${mtlFile}`];
  let v = 0;
  for (const p of patches) {
    const n = cornerNormal(p.corners);
    lines.push(`o ${clean(p.name)}`, `usemtl ${clean(p.name)}`);
    for (const c of p.corners) lines.push(`v ${num(c[0])} ${num(c[1])} ${num(c[2])}`);
    // Texture order TL, TR, BR, BL → UV (0,1), (1,1), (1,0), (0,0).
    lines.push('vt 0 1', 'vt 1 1', 'vt 1 0', 'vt 0 0');
    lines.push(`vn ${num(n[0])} ${num(n[1])} ${num(n[2])}`);
    const a = v + 1;
    // Counter-clockwise as seen from the front (the normal's side): BL, BR, TR, TL.
    const ni = v / 4 + 1;
    lines.push(`f ${a + 3}/${a + 3}/${ni} ${a + 2}/${a + 2}/${ni} ${a + 1}/${a + 1}/${ni} ${a}/${a}/${ni}`);
    v += 4;
  }
  return `${lines.join('\n')}\n`;
}

export function writeMtl(patches: readonly ObjPatch[], header: string[] = []): string {
  const lines = header.map((h) => `# ${h}`);
  for (const p of patches) lines.push('', `newmtl ${clean(p.name)}`, 'Ka 0 0 0', 'Kd 1 1 1', 'Ks 0 0 0', 'Ns 1', 'd 1', 'illum 1', `map_Kd ${p.texture}`);
  return `${lines.join('\n')}\n`;
}

/** The front-facing normal of a patch: the side its corners run counter-clockwise from (TL → BL → BR is the front). */
export function cornerNormal(c: readonly (readonly [number, number, number])[]): [number, number, number] {
  const u = [c[1]![0] - c[0]![0], c[1]![1] - c[0]![1], c[1]![2] - c[0]![2]];
  const v = [c[3]![0] - c[0]![0], c[3]![1] - c[0]![1], c[3]![2] - c[0]![2]];
  // Texture u to the right, v down: the front is v × u.
  const n = [v[1]! * u[2]! - v[2]! * u[1]!, v[2]! * u[0]! - v[0]! * u[2]!, v[0]! * u[1]! - v[1]! * u[0]!];
  const l = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
  return [n[0]! / l, n[1]! / l, n[2]! / l];
}

export interface ParsedObj {
  mtllib: string[];
  vertices: [number, number, number][];
  uvs: [number, number][];
  normals: [number, number, number][];
  objects: { name: string; material: string | null; faces: { v: number[]; vt: number[]; vn: number[] }[] }[];
}

/** Read an OBJ (v, vt, vn, f with v/vt/vn, o, usemtl, mtllib). Indices are 0-based in the result. */
export function parseObjText(text: string): ParsedObj {
  const out: ParsedObj = { mtllib: [], vertices: [], uvs: [], normals: [], objects: [] };
  let current: ParsedObj['objects'][number] | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [kw, ...rest] = line.split(/\s+/);
    if (kw === 'mtllib') out.mtllib.push(rest.join(' '));
    else if (kw === 'v') out.vertices.push(rest.slice(0, 3).map(Number) as [number, number, number]);
    else if (kw === 'vt') out.uvs.push(rest.slice(0, 2).map(Number) as [number, number]);
    else if (kw === 'vn') out.normals.push(rest.slice(0, 3).map(Number) as [number, number, number]);
    else if (kw === 'o') {
      current = { name: rest.join(' '), material: null, faces: [] };
      out.objects.push(current);
    } else if (kw === 'usemtl') {
      if (!current) {
        current = { name: 'default', material: null, faces: [] };
        out.objects.push(current);
      }
      current.material = rest.join(' ');
    } else if (kw === 'f') {
      if (!current) {
        current = { name: 'default', material: null, faces: [] };
        out.objects.push(current);
      }
      const face = { v: [] as number[], vt: [] as number[], vn: [] as number[] };
      for (const t of rest) {
        const [a, b, c] = t.split('/');
        const idx = (s: string | undefined, n: number) => {
          const k = Number(s);
          return k < 0 ? n + k : k - 1;
        };
        face.v.push(idx(a, out.vertices.length));
        if (b) face.vt.push(idx(b, out.uvs.length));
        if (c) face.vn.push(idx(c, out.normals.length));
      }
      current.faces.push(face);
    }
  }
  return out;
}

/** Read an MTL: material → its diffuse map. */
export function parseMtlText(text: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  let current: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const [kw, ...rest] = line.split(/\s+/);
    if (kw === 'newmtl') {
      current = rest.join(' ');
      out.set(current, null);
    } else if (kw === 'map_Kd' && current) out.set(current, rest.join(' '));
  }
  return out;
}
