import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lightingDoc, lightingNames, lightingRig, lightingRigData, parseProject, shotState, versionTag, type GamutId, type LightingExportFormat } from '@vcvfx/domain';
import { toDisplay, workingSpace } from '../../shared/key/linear';
import { writeLightingBlender, writeLightingReadme, writeLightingReport, writeLightingUnreal, writeLightingUsda, unrealSection, type ExportNames } from '../../shared/lighting/exports';
import { placeRig, type SceneCameraInput } from '../../shared/lighting/place';
import { encodePngRgb } from '../roto/png';
import { createLightingIO, type LightingIOJob } from './io';

/**
 * Writing the light rig into the shot package (master spec §13, §17;
 * addendum 14 §5):
 *
 *   09_PROJECT_DATA/<shot>_light_vNNN/
 *     <shot>_light_vNNN_unreal.py     Unreal 5 editor script (reads the rig file beside it)
 *     <shot>_light_vNNN_rig.json      the rig: estimates, ranges, evidence, edits, placement, units, lens
 *     <shot>_light_vNNN.usda          UsdLux lights + the camera
 *     <shot>_light_vNNN_blender.py    Blender lights + camera
 *     <shot>_light_vNNN_report.html   the printable report
 *     <shot>_light_vNNN_frame.png     the analysed frame (sRGB, for viewing)
 *     README.txt
 *
 * Versioned, never overwritten: an approved version on disk is refused; an
 * unapproved one has only its own files cleared and written again. The
 * caller checks that the output root is not among the source media.
 */

export interface LightingExportJob {
  /** The project (text) and shot: the rig file is the domain's own record. */
  projectText: string;
  shotId: string;
  /** Null when no frame can be read (a rig placed by hand on a shot without media): the report then has no picture. */
  io: LightingIOJob | null;
  frame: number | null;
  frameSize: { width: number; height: number };
  scene: SceneCameraInput;
  folder: string;
  shot: string;
  version: number;
  approved: boolean;
  formats: LightingExportFormat[];
  generator: string;
  writtenAt: string;
  operator: string;
  gamut: GamutId;
  /** The HDRI, relative to the export folder (for the scripts), when one was used. */
  hdri: string | null;
}

export interface LightingExportResult {
  files: string[];
  lights: number;
  camera: 'solve' | 'estimate';
}

/** Clear an unapproved version's own files; refuse an approved one that is on disk. */
export async function clearLightingVersion(folder: string, shot: string, version: number, approved: boolean): Promise<void> {
  const names = await readdir(folder).catch(() => null);
  if (!names) return;
  const tag = versionTag(version);
  const ours = names.filter((x) => (x.startsWith(lightingNames.prefix(shot)) && x.includes(`_${tag}`)) || x === lightingNames.readme());
  if (!ours.length) return;
  if (approved) throw new Error(`${folder} already holds the approved light rig ${tag}; it is never rewritten. Reopen it to make a new version.`);
  for (const x of ours) await rm(join(folder, x), { force: true });
}

export async function exportLighting(job: LightingExportJob, o: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}): Promise<LightingExportResult> {
  const parsed = parseProject(job.projectText);
  if (!parsed.ok) throw new Error(parsed.reason);
  const project = parsed.project;
  const state = shotState(project, job.shotId);
  const doc = lightingDoc(state);
  if (!state || !doc) throw new Error('Analyse the frame first (step 2).');
  await clearLightingVersion(job.folder, job.shot, job.version, job.approved);
  await mkdir(job.folder, { recursive: true });
  const total = 4 + job.formats.length;
  let done = 0;
  const step = () => o.onProgress?.(++done, total);
  const stem = lightingNames.stem(job.shot, job.version);
  const names: ExportNames = { shot: job.shot, version: job.version, generator: job.generator, writtenAt: job.writtenAt, rigFile: lightingNames.rig(stem), hdriFile: job.hdri, frameFile: null };
  const rig = placeRig(doc, job.scene);
  const files: string[] = [];
  // The frame, for the report (and beside it).
  let frame: { dataUrl: string; width: number; height: number } | null = null;
  if (job.io && job.frame !== null) {
    const io = createLightingIO(job.io, o.signal);
    const img = await io.frame(job.frame, job.frameSize.width, job.frameSize.height);
    const rgb = toDisplay(img.data, img.width * img.height, workingSpace(job.io.comp.space.encoding));
    const png = encodePngRgb(img.width, img.height, rgb);
    await writeFile(join(job.folder, lightingNames.frame(stem)), png);
    files.push(lightingNames.frame(stem));
    names.frameFile = lightingNames.frame(stem);
    frame = { dataUrl: `data:image/png;base64,${png.toString('base64')}`, width: img.width, height: img.height };
  }
  step();
  if (o.signal?.aborted) throw new Error('Cancelled');
  const lights = lightingRig(doc);
  const intensities = Object.fromEntries(
    rig.lights.map((p) => {
      const u = unrealSection(rig, names).lights.find((x) => x.id === p.id)!;
      return [p.id, { lux: p.lux, candela: p.candela, unreal: u.intensity, unrealUnit: u.unit }];
    }),
  );
  const plannedFiles: Record<string, string> = { rig: lightingNames.rig(stem), readme: lightingNames.readme() };
  if (job.formats.includes('unreal')) plannedFiles.unreal = lightingNames.unreal(stem);
  if (job.formats.includes('usd')) plannedFiles.usd = lightingNames.usd(stem);
  if (job.formats.includes('blender')) plannedFiles.blender = lightingNames.blender(stem);
  if (job.formats.includes('report')) plannedFiles.report = lightingNames.report(stem);
  if (names.frameFile) plannedFiles.frame = names.frameFile;
  const data = lightingRigData(project, job.shotId, {
    version: job.version,
    generator: job.generator,
    writtenAt: job.writtenAt,
    by: job.operator,
    units: rig.units,
    camera: { source: rig.camera.source, position: rig.camera.position, rotation: rig.camera.rotation, focalMm: rig.camera.focalMm, filmBackMm: rig.camera.filmBackMm, frame: rig.camera.frame, width: rig.camera.width, height: rig.camera.height },
    subject: rig.subject,
    placements: rig.lights.map((p) => ({ id: p.id, position: p.position, direction: p.direction })),
    intensities,
    files: plannedFiles,
  });
  await writeFile(join(job.folder, lightingNames.rig(stem)), `${JSON.stringify({ ...data, hdri: job.hdri, unreal: unrealSection(rig, names) }, null, 2)}\n`);
  files.push(lightingNames.rig(stem));
  step();
  if (job.formats.includes('unreal')) {
    await writeFile(join(job.folder, lightingNames.unreal(stem)), writeLightingUnreal(rig, names));
    files.push(lightingNames.unreal(stem));
    step();
  }
  if (job.formats.includes('usd')) {
    await writeFile(join(job.folder, lightingNames.usd(stem)), writeLightingUsda(rig, names));
    files.push(lightingNames.usd(stem));
    step();
  }
  if (job.formats.includes('blender')) {
    await writeFile(join(job.folder, lightingNames.blender(stem)), writeLightingBlender(rig, names, job.gamut));
    files.push(lightingNames.blender(stem));
    step();
  }
  if (job.formats.includes('report')) {
    const task = state.tasks.find((t) => t.kind === 'lighting_analysis');
    await writeFile(join(job.folder, lightingNames.report(stem)), writeLightingReport({ doc, rig, lights, names, approval: task?.approval ?? null, state: task?.state ?? 'pending', frame, tilt: { pitchDeg: doc.analysis?.ground?.pitchDeg ?? 0, rollDeg: 0 } }));
    files.push(lightingNames.report(stem));
    step();
  }
  files.push(lightingNames.readme());
  await writeFile(join(job.folder, lightingNames.readme()), writeLightingReadme({ names, files, rig, approved: job.approved, lights: lights.length }));
  step();
  return { files, lights: lights.length, camera: rig.camera.source };
}
