import { stat, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import {
  COMP_NODES,
  COMP_SOURCE_LABELS,
  COMP_TASK,
  compContext,
  compDoc,
  compErrors,
  compGraphData,
  compNames,
  compNodeParams,
  compRenderRange,
  compSourceOf,
  compSourceProblems,
  compUpstream,
  compWriteNode,
  handoffShot,
  resolveCompSource,
  shotState,
  validateCompGraph,
  versionTag,
  type ColorEncodingId,
  type CompDocument,
  type CompExportInput,
  type CompNode,
  type CompReference,
  type CompRenderInput,
  type Project,
  type ShotState,
} from '@vcvfx/domain';
import type { CompExportOutcome, CompFrameRequest, CompFrameView, CompRenderOutcome, CompSessionInfo } from '../../shared/comp/bridge-types';
import { CompEvaluator } from '../../shared/comp/evaluate';
import { compGraphManifest, type CompAsset } from '../../shared/comp/manifest';
import { OCIO_NAMES, writeCompNuke, type NukeSource } from '../../shared/comp/nuke';
import { compPicture } from '../../shared/comp/view';
import type { FfmpegCaps } from '../../shared/ffmpeg-args';
import { sha256File } from '../hash';
import { keyFrameSource, type KeySourceResult } from '../key/frames';
import { shotFolder, sourceFiles } from '../package-shot';
import { isSampleHandoff, outputRootProblem, resolveFromHandoff } from '../paths';
import { createCompIO, sourceKey, type CompFileSource, type CompIOJob } from './io';
import { runCompJob } from './service';

/**
 * The main-process side of the compositor (addendum 13 §4–6), called by
 * ipc-comp.ts. No Electron here: where things live is passed in, so it is
 * tested against a temporary folder with the real ffmpeg.
 *
 * The plate is read as the other modules read it; every module node reads the
 * module's export in the shot package (the files a vendor receives), and a
 * module that has not been exported says which tab to export from. Preview
 * frames are evaluated here at a proxy scale with one evaluator per shot,
 * kept between requests so a parameter change recomputes only downstream;
 * renders and bakes run in the comp worker at plate resolution.
 */

export interface CompEnv {
  ffmpeg: string | null;
  caps: FfmpegCaps;
  /** The built worker (out/main/comp-worker.js). */
  workerFile: string;
  generator: string;
}

const noFfmpeg = 'The comp reads frames with ffmpeg, and none was found. Reinstall VC VFX or set ffmpeg in Settings.';
const slash = (p: string) => p.split(sep).join('/');

async function plateSource(project: Project, shotId: string, outputRoot: string | null, env: CompEnv): Promise<KeySourceResult> {
  if (isSampleHandoff(project.handoffPath)) return { ok: false, reason: 'The sample project has no media on disk. Open a real handoff to composite its frames.' };
  if (!env.ffmpeg) return { ok: false, reason: noFfmpeg };
  return keyFrameSource(project, shotId, outputRoot, { ffmpeg: env.ffmpeg, caps: env.caps });
}

interface Resolved {
  job: CompIOJob;
  src: Extract<KeySourceResult, { ok: true }>;
  /** Per node id: why its source cannot be read. */
  missing: Map<string, string>;
  /** Per node id: what it reads, for the render record and the script. */
  refs: Map<string, CompReference & { abs: string; still: boolean; first: number | null; last: number | null; format: string; encoding: ColorEncodingId | null; kind: CompFileSource['kind'] }>;
  shotDir: string | null;
}

async function resolve(project: Project, shotId: string, outputRoot: string | null, env: CompEnv, doc: Pick<CompDocument, 'nodes'>): Promise<Resolved> {
  const src = await plateSource(project, shotId, outputRoot, env);
  if (!src.ok) throw new Error(src.reason);
  const state = shotState(project, shotId)!;
  const shotDir = outputRoot ? shotFolder(project, shotId, outputRoot) : null;
  const sources: Record<string, CompFileSource> = {};
  const missing = new Map<string, string>();
  const refs: Resolved['refs'] = new Map();
  const platePattern = src.spec.source.kind === 'sequence' ? src.spec.source.pattern : src.spec.source.path;
  for (const n of doc.nodes) {
    const source = compSourceOf(n);
    if (!source) continue;
    const part = String(compNodeParams(n)['part'] ?? '');
    if (source === 'plate') {
      const inPackage = shotDir && src.plates !== null;
      refs.set(n.id, { node: n.name, source, version: src.plates, path: inPackage ? slash(relative(shotDir, platePattern)) : platePattern, label: src.spec.label, abs: platePattern, still: false, first: src.spec.first, last: src.spec.last, format: inPackage ? 'exr' : 'other', encoding: src.spec.encoding, kind: 'rgb' });
      continue;
    }
    const r = resolveCompSource(project, shotId, source, part);
    if (!r.ok) {
      missing.set(n.id, r.reason);
      continue;
    }
    let abs: string;
    if (r.folder === null) {
      const found = resolveFromHandoff(project.handoffPath, r.file);
      if (!found) {
        missing.set(n.id, `${r.file} is not on the drive`);
        continue;
      }
      abs = found;
    } else {
      if (!shotDir) {
        missing.set(n.id, 'Choose the output root (Deliver) so the comp can find the module’s export in the shot package.');
        continue;
      }
      abs = join(shotDir, ...r.folder.split('/'), r.file);
    }
    const probe = r.still ? abs : abs.replace(/%0(\d+)d/, (_m, d: string) => String(r.first ?? src.spec.first).padStart(Number(d), '0'));
    const st = await stat(probe).catch(() => null);
    if (!st) {
      missing.set(n.id, `${r.label}: ${probe.split(/[\\/]/).pop()} is not in the shot package (was it moved or deleted?). Export it again from its tab.`);
      continue;
    }
    sources[sourceKey(source, part)] = { file: abs, still: r.still, kind: r.kind, first: r.first, last: r.last, format: r.format, version: `${r.version ?? ''}|${st.mtimeMs}` };
    refs.set(n.id, { node: n.name, source, version: r.version, path: r.folder === null ? r.file : `${r.folder}/${r.file}`, label: r.label, abs, still: r.still, first: r.first, last: r.last, format: r.format, encoding: r.kind === 'alpha' || r.format === 'png' ? null : src.space.encoding, kind: r.kind });
  }
  return { job: { ffmpeg: env.ffmpeg!, caps: env.caps, plate: src.spec, space: src.space, sources, tracks: state.track2d?.tracks ?? [] }, src, missing, refs, shotDir };
}

export async function compSession(project: Project, shotId: string, outputRoot: string | null, env: CompEnv): Promise<CompSessionInfo> {
  const state = shotState(project, shotId);
  if (!state) throw new Error(`No shot ${shotId}`);
  const empty: CompSessionInfo = { available: false, reason: null, frames: '', plate: null, first: 0, last: 0, fps: 24, previewWidth: 960, encoding: { label: '', linear: false, note: null }, exportable: false, sources: [] };
  if (!state.tasks.some((t) => t.kind === COMP_TASK)) return { ...empty, reason: 'This shot has no Prep composite task. Add it to work on it here.' };
  const src = await plateSource(project, shotId, outputRoot, env);
  if (!src.ok) return { ...empty, reason: src.reason };
  const doc = compDoc(state);
  const r = doc ? await resolve(project, shotId, outputRoot, env, doc) : null;
  return {
    available: true,
    reason: null,
    frames: src.spec.label,
    plate: src.spec.plate,
    first: src.spec.first,
    last: src.spec.last,
    fps: src.spec.frameRate,
    previewWidth: 960,
    encoding: { label: src.space.label, linear: src.space.linear, note: src.space.linear ? null : 'The source encoding is unknown: the comp works on code values, not linear light. Set the source encoding in Plates.' },
    exportable: true,
    sources: (doc?.nodes ?? [])
      .filter((n) => compSourceOf(n))
      .map((n) => ({ node: n.id, source: compSourceOf(n)!, ok: !r?.missing.has(n.id), label: r?.refs.get(n.id)?.label ?? COMP_SOURCE_LABELS[compSourceOf(n)!], reason: r?.missing.get(n.id) ?? null })),
  };
}

/** Evaluators kept warm between preview requests, per project and shot (a parameter change then recomputes only downstream). */
const evaluators = new Map<string, { signature: string; ev: CompEvaluator }>();

export async function compFrameView(project: Project, req: CompFrameRequest, outputRoot: string | null, env: CompEnv): Promise<CompFrameView> {
  const started = Date.now();
  const state = shotState(project, req.shotId);
  const doc = compDoc(state);
  if (!state || !doc) throw new Error('Start the comp first (step 1).');
  const r = await resolve(project, req.shotId, outputRoot, env, doc);
  const key = JSON.stringify([req.projectKey, req.shotId]);
  const signature = JSON.stringify([r.job.plate.label, r.job.plate.plate, r.job.sources]);
  let entry = evaluators.get(key);
  if (!entry || entry.signature !== signature) {
    const io = createCompIO(r.job);
    entry = entry ? (entry.ev.setIO(io), { signature, ev: entry.ev }) : { signature, ev: new CompEvaluator(io, 512 * 1024 * 1024) };
    evaluators.set(key, entry);
    while (evaluators.size > 3) evaluators.delete(evaluators.keys().next().value!);
  }
  const ev = entry.ev;
  const hits = ev.stats.hits;
  const misses = ev.stats.misses;
  const scale = Math.max(0.05, Math.min(1, req.scale));
  const frame = Math.max(r.src.spec.first, Math.min(r.src.spec.last, Math.round(req.frame)));
  const size = ev.size(scale);
  const one = async (id: string | null) => {
    if (!id) return { pic: null, error: null };
    const blocked = [id, ...compUpstream(doc, id)].find((x) => r.missing.has(x));
    if (blocked) return { pic: null, error: `${doc.nodes.find((n) => n.id === blocked)?.name ?? blocked}: ${r.missing.get(blocked)}` };
    try {
      return { pic: compPicture(await ev.evaluate(doc, id, frame, { scale }), r.job.space), error: null };
    } catch (error) {
      return { pic: null, error: (error as Error).message };
    }
  };
  const a = await one(req.a);
  const b = await one(req.b);
  return { frame, width: size.width, height: size.height, a: a.pic, b: b.pic, errors: { a: a.error, b: b.error }, ms: Date.now() - started, computed: ev.stats.misses - misses, cached: ev.stats.hits - hits, viewLabel: `${r.job.space.label} → Rec.709 (approx.), for viewing` };
}

function prepare(project: Project, shotId: string) {
  const state = shotState(project, shotId);
  const shot = handoffShot(project, shotId);
  const doc = compDoc(state);
  if (!state || !shot || !doc || !doc.nodes.length) throw new Error('Start the comp first (step 1).');
  const task = state.tasks.find((t) => t.kind === COMP_TASK);
  if (!task) throw new Error('This shot has no Prep composite task.');
  const write = compWriteNode(doc);
  const problems = compErrors([...validateCompGraph(doc, compContext(state)), ...(write ? compSourceProblems(project, shotId, doc, new Set([write.id, ...compUpstream(doc, write.id)])) : [])]);
  if (problems.length) throw new Error(`Fix the graph first: ${problems[0]!.message}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}`);
  return { state, shot, doc, task, write: write!, name: state.vfxShotId ?? shot.shotId };
}

export async function compRender(
  project: Project,
  req: { shotId: string; projectKey: string; operator: string },
  outputRoot: string,
  env: CompEnv,
  o: { signal?: AbortSignal; onProgress?: (done: number, total: number, frame?: number) => void } = {},
): Promise<CompRenderOutcome> {
  // Never under the source paths (§19).
  const problem = outputRootProblem(outputRoot, sourceFiles(project));
  if (problem) throw new Error(problem);
  const { doc, task, write, name } = prepare(project, req.shotId);
  const r = await resolve(project, req.shotId, outputRoot, env, doc);
  const used = new Set([write.id, ...compUpstream(doc, write.id)]);
  const blocked = [...used].find((id) => r.missing.has(id));
  if (blocked) throw new Error(`${doc.nodes.find((n) => n.id === blocked)?.name}: ${r.missing.get(blocked)}`);
  const range = compRenderRange(doc, r.src.spec.first, r.src.spec.last);
  const folderName = compNames.folder(name, task.version);
  const folder = join(shotFolder(project, req.shotId, outputRoot), '08_PREVIEWS', folderName);
  const out = await runCompJob(
    {
      type: 'render',
      job: { io: r.job, nodes: doc.nodes, edges: doc.edges, write: write.id, first: range.first, last: range.last, folder, shot: name, version: task.version, approved: task.state === 'approved', review: doc.render.review, channels: compNodeParams(write)['channels'] === 'rgb' ? 'rgb' : 'rgba', fps: r.src.spec.frameRate },
    },
    { workerFile: env.workerFile, ...(o.signal ? { signal: o.signal } : {}), ...(o.onProgress ? { onProgress: o.onProgress } : {}) },
  );
  const rendered = out.rendered;
  if (!rendered) throw new Error('The render produced nothing');
  const record: CompRenderInput = {
    version: task.version,
    revision: doc.revision,
    folder: `08_PREVIEWS/${folderName}`,
    pattern: compNames.renderPattern(name, task.version),
    review: doc.render.review === 'none' ? null : compNames.reviewPattern(name, task.version, doc.render.review),
    first: range.first,
    last: range.last,
    frames: range.last - range.first + 1,
    width: rendered.width,
    height: rendered.height,
    encoding: r.src.space.label,
    write: write.name,
    references: [...r.refs.entries()].filter(([id]) => used.has(id)).map(([, x]) => ({ node: x.node, source: x.source, version: x.version, path: x.path, label: x.label })),
    seconds: Math.round(rendered.seconds * 100) / 100,
    files: rendered.files.length,
    algorithm: `${doc.algorithm.id}@${doc.algorithm.version}`,
  };
  return { record, folder, files: rendered.files.length };
}

/** A line about a module node's settings, for its sticky note in the script. */
function moduleNote(state: ShotState, n: CompNode): string {
  const p = compNodeParams(n);
  switch (n.type) {
    case 'keyer': {
      const k = state.key;
      return k ? `screen ${k.screen?.kind ?? '?'}, despill ${k.despill.enabled ? `${k.despill.limit} ${k.despill.strength}` : 'off'}, settings r${k.revision}` : '';
    }
    case 'roto':
      return p['part'] ? `part ${state.roto?.parts.find((x) => x.id === p['part'])?.name ?? String(p['part'])}` : `all parts (${state.roto?.parts.map((x) => x.name).join(', ') ?? ''})`;
    case 'cleanplate':
      return state.cleanPlate ? `mode ${state.cleanPlate.mode}, settings r${state.cleanPlate.revision}` : '';
    case 'isolate': {
      const d = state.isolate?.[p['target'] === 'background' ? 'background' : 'sky'];
      return d ? `${d.target}, seed ${d.seed.mode}, settings r${d.revision}` : '';
    }
    default:
      return '';
  }
}

const frameName = (pattern: string, f: number) => pattern.replace(/%0(\d+)d/, (_m, n: string) => String(f).padStart(Number(n), '0'));

async function hashAll(paths: { abs: string; path: string }[], signal?: AbortSignal): Promise<CompAsset['files']> {
  const out: CompAsset['files'] = [];
  for (const p of paths) {
    const h = await sha256File(p.abs, signal ? { signal } : {}).catch(() => null);
    if (h) out.push({ path: p.path, bytes: h.bytes, sha256: h.sha256 });
  }
  return out;
}

export async function compExport(
  project: Project,
  req: { shotId: string; projectKey: string; operator: string },
  outputRoot: string,
  env: CompEnv,
  o: { signal?: AbortSignal; onProgress?: (done: number, total: number, frame?: number) => void; now?: Date } = {},
): Promise<CompExportOutcome> {
  const problem = outputRootProblem(outputRoot, sourceFiles(project));
  if (problem) throw new Error(problem);
  const { state, doc, task, write, name } = prepare(project, req.shotId);
  const render = doc.renders.find((x) => x.version === task.version && x.revision === doc.revision);
  if (!render) throw new Error(`Render comp ${versionTag(task.version)} with the current graph first (step 4); the export goes with it.`);
  const r = await resolve(project, req.shotId, outputRoot, env, doc);
  const shotDir = shotFolder(project, req.shotId, outputRoot);
  const folderName = compNames.folder(name, task.version);
  const folder = join(shotDir, '09_PROJECT_DATA', folderName);
  const used = new Set([write.id, ...compUpstream(doc, write.id)]);
  const bake = doc.nodes.filter((n) => used.has(n.id) && !n.disabled && (n.type === 'despill' || n.type === 'lightwrap')).map((n) => ({ id: n.id, name: n.name }));
  const approved = task.state === 'approved';
  const baked = await runCompJob(
    { type: 'bake', job: { io: r.job, nodes: doc.nodes, edges: doc.edges, bake, first: render.first, last: render.last, folder, shot: name, version: task.version, approved, fps: r.src.spec.frameRate } },
    { workerFile: env.workerFile, ...(o.signal ? { signal: o.signal } : {}), ...(o.onProgress ? { onProgress: o.onProgress } : {}) },
  );
  const at = (o.now ?? new Date()).toISOString();
  const toNk = (pkgPath: string) => `../../${pkgPath}`;
  const sources = new Map<string, NukeSource>();
  for (const [id, x] of r.refs) {
    const inPackage = !(x.source === 'plate' && x.format === 'other') && x.source !== 'background';
    sources.set(id, { path: inPackage ? toNk(x.path) : x.abs, relative: inPackage, first: x.first ?? render.first, last: x.last ?? render.last, still: x.still, kind: x.kind, encoding: x.source === 'plate' ? x.encoding : x.encoding, label: x.label });
  }
  const bakedSources = new Map<string, NukeSource>(bake.map((b) => [b.id, { path: compNames.bakedPattern(name, task.version, b.name), relative: true, first: render.first, last: render.last, still: false, kind: 'rgba', encoding: r.src.space.encoding, label: `${b.name} (baked by VC VFX)` }]));
  const nuke = writeCompNuke(doc, {
    shot: name,
    version: task.version,
    generator: env.generator,
    writtenAt: at,
    fps: r.src.spec.frameRate,
    first: render.first,
    last: render.last,
    width: render.width,
    height: render.height,
    working: r.src.space.encoding,
    sources,
    baked: bakedSources,
    writePath: `nuke_render/${name}_comp_nk_${versionTag(task.version)}.%04d.exr`,
    tracks: new Map((state.track2d?.tracks ?? []).map((t) => [t.id, t])),
    moduleNotes: new Map(doc.nodes.filter((n) => COMP_NODES[n.type].module).map((n) => [n.id, moduleNote(state, n)])),
  });
  if (r.src.plates === null) nuke.untranslated.push('Read_plate reads the camera file on the drive (no plates were in the package): set its colourspace in Nuke, or generate plates and export again.');
  const graphName = compNames.graph(name, task.version);
  const nkName = compNames.nuke(name, task.version);
  const manifestName = compNames.manifest(name, task.version);
  await writeFile(join(folder, graphName), `${JSON.stringify(compGraphData(doc), null, 2)}\n`);
  await writeFile(join(folder, nkName), nuke.text);
  // Assets with checksums: what the comp read (in the render's range), what it baked, what it rendered.
  const pkg = (p: string) => ({ abs: join(shotDir, ...p.split('/')), path: p });
  const assets: CompAsset[] = [];
  for (const [id, x] of r.refs) {
    if (!used.has(id)) continue;
    const frames: { abs: string; path: string }[] = [];
    const inPackage = x.source !== 'background' && !(x.source === 'plate' && x.format === 'other');
    if (!inPackage) {
      // A camera file or a reference on the drive: listed by path; the handoff's checksums cover camera originals.
      assets.push({ role: 'source', node: x.node, path: x.path, label: x.label, files: x.source === 'background' ? await hashAll([{ abs: x.abs, path: x.path }], o.signal) : [] });
      continue;
    }
    if (x.still) frames.push(pkg(x.path));
    else for (let f = Math.max(render.first, x.first ?? render.first); f <= Math.min(render.last, x.last ?? render.last); f += 1) frames.push(pkg(frameName(x.path, f)));
    assets.push({ role: 'source', node: x.node, path: x.path, label: x.label, files: await hashAll(frames, o.signal) });
  }
  for (const b of bake) {
    const pattern = compNames.bakedPattern(name, task.version, b.name);
    const files = [];
    for (let f = render.first; f <= render.last; f += 1) files.push({ abs: join(folder, ...frameName(pattern, f).split('/')), path: `09_PROJECT_DATA/${folderName}/${frameName(pattern, f)}` });
    assets.push({ role: 'baked', node: b.name, path: `09_PROJECT_DATA/${folderName}/${pattern}`, label: `${b.name} rendered by VC VFX for the script`, files: await hashAll(files, o.signal) });
  }
  const renderFiles = (pattern: string) => {
    const files = [];
    for (let f = render.first; f <= render.last; f += 1) files.push(pkg(`${render.folder}/${frameName(pattern, f)}`));
    return files;
  };
  assets.push({ role: 'render', node: write.name, path: `${render.folder}/${render.pattern}`, label: `comp ${versionTag(task.version)} (EXR half, linear, premultiplied)`, files: await hashAll(renderFiles(render.pattern), o.signal) });
  if (render.review) assets.push({ role: 'review', node: write.name, path: `${render.folder}/${render.review}`, label: 'review encode (Rec.709 approx. view; not for finishing)', files: await hashAll(renderFiles(render.review), o.signal) });
  assets.push({ role: 'graph', node: null, path: `09_PROJECT_DATA/${folderName}/${graphName}`, label: 'the VC VFX graph', files: await hashAll([{ abs: join(folder, graphName), path: `09_PROJECT_DATA/${folderName}/${graphName}` }]) });
  assets.push({ role: 'nuke', node: null, path: `09_PROJECT_DATA/${folderName}/${nkName}`, label: 'the Nuke script', files: await hashAll([{ abs: join(folder, nkName), path: `09_PROJECT_DATA/${folderName}/${nkName}` }]) });
  const manifest = compGraphManifest(doc, nuke, {
    generator: env.generator,
    shot: name,
    version: task.version,
    writtenAt: at,
    by: req.operator,
    frames: { first: render.first, last: render.last },
    resolution: { width: render.width, height: render.height },
    fps: r.src.spec.frameRate,
    encoding: { label: r.src.space.label, linear: r.src.space.linear, ocio: (r.src.space.encoding && OCIO_NAMES[r.src.space.encoding]) || null },
    references: render.references,
    assets,
    tracks: (state.track2d?.tracks ?? []).filter((t) => doc.nodes.some((n) => (n.type === 'cornerpin' || n.type === 'track') && compNodeParams(n)['track'] === t.id)).map((t) => ({ id: t.id, name: t.name, kind: t.kind, frames: t.frames.length })),
    render: { folder: render.folder, pattern: render.pattern, review: render.review, seconds: render.seconds },
    nukeFile: nkName,
    approval: task.approval,
  });
  await writeFile(join(folder, manifestName), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(folder, compNames.readme()), readme(name, task.version, render, nkName, graphName, manifestName, bake.map((b) => b.name), nuke.untranslated, r.src.space.label, approved));
  const record: CompExportInput = {
    version: task.version,
    revision: doc.revision,
    folder: `09_PROJECT_DATA/${folderName}`,
    graph: graphName,
    nuke: nkName,
    manifest: manifestName,
    readme: compNames.readme(),
    baked: bake.map((b) => ({ node: b.id, name: b.name, pattern: compNames.bakedPattern(name, task.version, b.name) })),
    untranslated: nuke.untranslated,
    render: render.folder,
    files: (baked.baked?.files.length ?? 0) + 4,
  };
  return { record, folder, files: record.files };
}

function readme(shot: string, version: number, render: { folder: string; pattern: string; review: string | null; first: number; last: number }, nk: string, graph: string, manifest: string, baked: string[], untranslated: string[], encoding: string, approved: boolean): string {
  const v = versionTag(version);
  return [
    `${shot} prep comp ${v} — VC VFX`,
    '',
    'What is here',
    `  ${nk}   the comp as a Nuke script (Nuke 13 or later). Open it from this folder: every path is relative to the script.`,
    `  ${graph}   the VC VFX graph: every node, parameter and connection — what the comp is reproduced from.`,
    `  ${manifest}   the machine-readable graph manifest: nodes, parameters, connections in Nuke's input order, how each node was`,
    '                translated, every asset read or written with its SHA-256, the tracks used, and what the script does not carry exactly.',
    baked.length ? `  baked/   ${baked.join(', ')}: nodes Nuke has no class for, as VC VFX rendered them; the script reads them back.` : null,
    `  The render: ${render.folder}/${render.pattern} (frames ${render.first}–${render.last}), half-float EXR, ${encoding}, premultiplied,`,
    `  no look.${render.review ? ` ${render.folder}/${render.review} is a review encode through the viewer's Rec.709 (approx.) view: not for finishing.` : ''}`,
    '',
    'In Nuke',
    '  The project is set to OCIO with the aces_1.2 config; Reads and the Write carry their colourspace (mattes are read raw and',
    '  shuffled to alpha). Roto, Keyer, Clean Plate and Isolate nodes read the modules’ own exported, versioned files, each with a',
    '  sticky note naming the VC VFX node and its settings — they are not re-created. The Write renders to nuke_render/ beside the',
    '  script, never over VC VFX’s render. Image y is down in VC VFX and up in Nuke: transforms and corner pins are converted.',
    '',
    untranslated.length ? 'Not carried exactly by the script' : 'Everything in the graph is carried by the script.',
    ...untranslated.map((u) => `  - ${u}`),
    '',
    approved ? `This comp version is approved.` : `This comp version is not approved yet: it is a prep deliverable for review.`,
    '',
  ]
    .filter((l) => l !== null)
    .join('\n');
}
