import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { textureNames, versionTag, type TextureMetrics, type TexturePlacement, type TextureReference, type TextureRegion } from '@vcvfx/domain';
import { toPlanar } from '../../shared/key/ffmpeg-key';
import { resizeLinear, type LinearImage } from '../../shared/key/linear';
import { buildTextures } from '../../shared/texture/engine';
import { tileImage } from '../../shared/texture/image';
import { writeMtl, writeObj, type ObjPatch } from '../../shared/texture/obj';
import { srgb16 } from '../../shared/texture/view';
import { ExrStream } from '../key/export';
import { encodePng, encodePngRgb16 } from '../roto/png';
import { createTextureIO, type TextureIOJob } from './io';

/**
 * Writing textures into the shot package (master spec §12 "export texture
 * maps and mapping/reference information for downstream 3D work", §17;
 * addendum 12 §6):
 *
 *   07_TEXTURES_REFERENCES/<shot>_tex_vNNN/
 *     <shot>_tex_<region>_vNNN.png          the texture, 16-bit sRGB (what a 3D package's viewport shows)
 *     <shot>_tex_<region>_vNNN.exr          the same, RGB half-float, scene-linear ACEScg, no look
 *     <shot>_tex_<region>_vNNN_orig.png     before delighting (rectified, exposure matched), when delit
 *     <shot>_tex_<region>_vNNN_tile3x3.png  the tile repeated 3 × 3, when made to tile
 *     <shot>_tex_<region>_vNNN_mask.png     where the texture came from inside the photo
 *     <shot>_tex_vNNN.obj / .mtl            the planar patches with UVs, materials mapping the textures
 *     <shot>_tex_vNNN.json, README.txt      written by the caller
 *
 * Made again from source + settings at each region's own output size, from
 * the photos at their full resolution. Versioned, never overwritten: an
 * approved version on disk is refused; an unapproved one has only its own
 * files cleared and written again. Nothing is written under the source paths
 * (the caller checks the output root).
 */

export interface TextureExportJob {
  io: TextureIOJob;
  references: TextureReference[];
  regions: TextureRegion[];
  placements: TexturePlacement[];
  revision: number;
  shot: string;
  version: number;
  approved: boolean;
  /** Absolute path of `07_TEXTURES_REFERENCES/<shot>_tex_vNNN`. */
  folder: string;
  generator: string;
  luma: [number, number, number];
}

export interface TextureExportedRegion {
  id: string;
  name: string;
  map: string;
  mapExr: string;
  original: string | null;
  tilePreview: string | null;
  mask: string;
  width: number;
  height: number;
  planeId: string | null;
  homography: number[];
  undistorted: boolean;
  texelDensity: number | null;
  patch: [number, number, number][] | null;
  metrics: TextureMetrics;
  confidence: number;
}

export interface TextureExportResult {
  files: string[];
  regions: TextureExportedRegion[];
  obj: string | null;
  mtl: string | null;
  planes: import('@vcvfx/domain').TexturePlane[];
  placements: import('@vcvfx/domain').TextureRunResult['placements'];
  heading: { value: number; from: string; confidence: number } | null;
}

/** Clear an unapproved version's own files; refuse an approved one that is on disk. */
export async function clearTextureVersion(folder: string, shot: string, version: number, approved: boolean): Promise<void> {
  const names = await readdir(folder).catch(() => null);
  if (!names) return;
  const tag = versionTag(version);
  const ours = names.filter((x) => (x.startsWith(textureNames.prefix(shot)) && x.includes(`_${tag}`)) || x === textureNames.readme());
  if (!ours.length) return;
  if (approved) throw new Error(`${folder} already holds the approved textures ${tag}; they are never rewritten. Reopen them to make a new version.`);
  for (const x of ours) await rm(join(folder, x), { force: true });
}

async function writeExr(ffmpeg: string, path: string, img: LinearImage, signal?: AbortSignal): Promise<void> {
  const s = new ExrStream(ffmpeg, 'rgb', img.width, img.height, 1, 0, path, signal);
  try {
    await s.write(toPlanar('rgb', img.width * img.height, img.data, null));
  } catch (error) {
    void s.close().catch(() => undefined);
    throw error;
  }
  await s.close();
}

export async function exportTextures(job: TextureExportJob, o: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}): Promise<TextureExportResult> {
  const { shot, version, folder } = job;
  await clearTextureVersion(folder, shot, version, job.approved);
  await mkdir(folder, { recursive: true });
  const io = createTextureIO(job.io, o.signal);
  const files: string[] = [];
  const regions: TextureExportedRegion[] = [];
  const text = (what: string) => ({ Software: job.generator, Description: `${shot} ${what} ${versionTag(version)}` });
  const out = await buildTextures(
    io,
    { references: job.references, regions: job.regions, placements: job.placements },
    { luma: job.luma, revision: job.revision, maxTexture: null, maxPhoto: null, progress: (done, total) => o.onProgress?.(done, total) },
    async (r) => {
      const region = job.regions.find((x) => x.id === r.regionId)!;
      const stem = textureNames.stem(shot, region, version);
      const final = r.tiled ?? r.delit;
      const at = (name: string) => join(folder, name);
      await writeFile(at(textureNames.map(stem)), encodePngRgb16(final.width, final.height, srgb16(final), { text: text(`texture ${region.name}`) }));
      files.push(textureNames.map(stem));
      await writeExr(job.io.ffmpeg, at(textureNames.mapExr(stem)), final, o.signal);
      files.push(textureNames.mapExr(stem));
      let original: string | null = null;
      if (region.settings.delight > 0) {
        original = textureNames.original(stem);
        await writeFile(at(original), encodePngRgb16(r.original.width, r.original.height, srgb16(r.original), { text: text(`texture ${region.name} before delighting`) }));
        files.push(original);
      }
      let tilePreview: string | null = null;
      if (r.tiled) {
        // Three by three, each tile at most 1024 wide.
        const k = Math.min(1, 1024 / r.tiled.width);
        const small = k < 1 ? resizeLinear(r.tiled, Math.round(r.tiled.width * k), Math.round(r.tiled.height * k)) : r.tiled;
        const t = tileImage(small, 3);
        tilePreview = textureNames.tilePreview(stem);
        await writeFile(at(tilePreview), encodePngRgb16(t.width, t.height, srgb16(t), { text: text(`tile preview ${region.name}`) }));
        files.push(tilePreview);
      }
      await writeFile(at(textureNames.mask(stem)), encodePng({ width: final.width, height: final.height, bitDepth: 8, data: Uint8Array.from(r.mask, (v) => (v ? 255 : 0)) }, { text: text(`mask ${region.name}`) }));
      files.push(textureNames.mask(stem));
      regions.push({
        id: region.id,
        name: region.name,
        map: textureNames.map(stem),
        mapExr: textureNames.mapExr(stem),
        original,
        tilePreview,
        mask: textureNames.mask(stem),
        width: final.width,
        height: final.height,
        planeId: r.metrics.planeId,
        homography: r.H,
        undistorted: r.undistorted,
        texelDensity: r.texelDensity,
        patch: r.patch,
        metrics: r.metrics,
        confidence: r.confidence,
      });
    },
  );
  // The mesh: one planar patch per region that has one.
  const patches: ObjPatch[] = regions.filter((r) => r.patch).map((r) => ({ name: `${r.id}_${r.name}`, corners: r.patch!, texture: r.map }));
  let obj: string | null = null;
  let mtl: string | null = null;
  if (patches.length) {
    obj = textureNames.obj(shot, version);
    mtl = textureNames.mtl(shot, version);
    const scan = job.references.find((r) => r.kind === 'scan');
    const header = [`${shot} textures ${versionTag(version)} — ${job.generator}`, `Planar patches in the scan's coordinates${scan?.scan ? ` (${scan.scan.units}, ${scan.scan.up.toUpperCase()}-up)` : ''}; UVs 0–1 across each texture.`];
    await writeFile(join(folder, obj), writeObj(patches, mtl, header));
    await writeFile(join(folder, mtl), writeMtl(patches, header));
    files.push(obj, mtl);
  }
  const order = new Map(job.regions.map((r, i) => [r.id, i]));
  regions.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return { files, regions, obj, mtl, planes: out.result.planes, placements: out.result.placements, heading: out.heading };
}
