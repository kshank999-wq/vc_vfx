import { handoffShot, shotState, type LogEntry, type Project, type Result, type ShotState } from './project.js';
import { versionTag } from './frames.js';
import type { SceneUnit } from './camtrack-schema.js';
import {
  DEFAULT_TEXTURE_SETTINGS,
  TEXTURE_ALGORITHM,
  TEXTURE_FORMAT_VERSION,
  TextureCameraSchema,
  TextureDirectionSchema,
  TextureExportSchema,
  TexturePanoramaInfoSchema,
  TexturePlaneSchema,
  TextureReferenceSchema,
  TextureRegionSettingsSchema,
  TextureScanInfoSchema,
  TextureSizeSchema,
  type TextureCamera,
  type TextureDirection,
  type TextureDocument,
  type TextureExportInput,
  type TextureMetrics,
  type TexturePanoramaInfo,
  type TexturePanoramaPose,
  type TexturePlacement,
  type TexturePlane,
  type TextureReference,
  type TextureReferenceKind,
  type TextureRegion,
  type TextureRegionRecord,
  type TextureRegionSettings,
  type TextureScanInfo,
  type TextureSize,
} from './texture-schema.js';

export * from './texture-schema.js';

/**
 * Texture extraction and set-reconstruction prep as a model (master spec §12,
 * §15, §19; addendum 12).
 *
 * Every mutation is pure, returns a new project and is logged with who and
 * when. The rules are the clean plate's and the isolation's:
 *  - the work is the shot's `texture_extraction` task: changing anything
 *    starts it or reopens a review for correction, a finished build or an
 *    export puts it up for review, and nothing here approves it — approval is
 *    `approveTask`, a named human act, and needs an export of the version;
 *  - approved textures are never changed in place: every edit is refused
 *    until the task is reopened, which bumps its version, so the next export
 *    writes `v002` beside the approved `v001`;
 *  - the references, regions, settings and placement decisions are what the
 *    outputs are reproduced from (§19): every change bumps `revision`, and
 *    each build and export records the revision;
 *  - the references are only ever read: their paths and checksums are
 *    recorded so a build can say when a file changed under it.
 */

const MAX_RUNS = 200;
export const TEXTURE_TASK = 'texture_extraction' as const;
/** Confidence below which a region is a problem. */
export const TEXTURE_LOW_CONFIDENCE = 0.6;
/** Stops of large-scale light variation left after delighting above which a region is a problem. */
export const TEXTURE_MAX_RESIDUAL = 0.25;
/** Seam visibility (step across the seam / typical step) above which a tile's seams show. */
export const TEXTURE_MAX_SEAM = 1.6;
/** Sharpness below which the photo is blurred where the region is. */
export const TEXTURE_MIN_SHARPNESS = 0.3;
/** Shares of clipped and specular pixels above which a region is a problem. */
export const TEXTURE_MAX_CLIPPED = 0.005;
export const TEXTURE_MAX_SPECULAR = 0.01;
/** Output texels per photo pixel above which the texture is mostly upsampled (too low a texel density in the photo). */
export const TEXTURE_MAX_UPSAMPLE = 1.25;
/** Share of the texture that must come from inside the photo. */
export const TEXTURE_MIN_COVERAGE = 0.98;

export const TEXTURE_UNIT_METRES: Record<SceneUnit, number> = { m: 1, cm: 0.01, mm: 0.001, ft: 0.3048, in: 0.0254 };

export const TEXTURE_KIND_LABELS: Record<TextureReferenceKind, string> = { photo: 'Photo', panorama: 'Panorama', scan: 'Scan' };

function logged(p: Project, entry: Omit<LogEntry, 'detail'> & { detail?: string }): Project {
  return { ...p, updatedAt: entry.at, log: [...p.log, { detail: '', ...entry }] };
}

function withShot(p: Project, shotId: string, fn: (s: ShotState) => ShotState | string): Result {
  const current = shotState(p, shotId);
  if (!current) return { ok: false, reason: `No shot ${shotId}` };
  const next = fn(current);
  if (typeof next === 'string') return { ok: false, reason: next };
  return { ok: true, project: { ...p, shots: p.shots.map((s) => (s.shotId === shotId ? next : s)) } };
}

export function newTextureDocument(): TextureDocument {
  return {
    formatVersion: TEXTURE_FORMAT_VERSION,
    algorithm: { ...TEXTURE_ALGORITHM },
    references: [],
    regions: [],
    planes: [],
    placements: [],
    panoramaPose: null,
    records: [],
    runs: [],
    exports: [],
    workingWidth: 1024,
    revision: 0,
    seq: 0,
  };
}

const shotName = (s: ShotState) => s.vfxShotId ?? s.shotId;

export function textureDoc(s: ShotState | null | undefined): TextureDocument | null {
  return s?.texture ?? null;
}

/** Why the textures of this shot cannot be changed right now, or null. */
export function textureLocked(s: ShotState): string | null {
  if (s.stage !== 'prep') return `${shotName(s)} is ${s.stage}; reopen it before changing its textures`;
  const task = s.tasks.find((t) => t.kind === TEXTURE_TASK);
  if (!task) return `${shotName(s)} has no Texture extraction task. Add it first.`;
  if (task.state === 'approved') return `Textures ${versionTag(task.version)} are approved. Reopen them (Needs correction) to make ${versionTag(task.version + 1)}; the approved files are kept.`;
  return null;
}

export function textureTaskVersion(s: ShotState): number {
  return s.tasks.find((t) => t.kind === TEXTURE_TASK)?.version ?? 1;
}

type TaskMove = 'edited' | 'review';

function editTexture(
  p: Project,
  shotId: string,
  actor: string,
  now: Date,
  action: string,
  fn: (doc: TextureDocument, s: ShotState) => { doc: TextureDocument; detail: string; task?: TaskMove; settings?: boolean } | string,
): Result {
  const at = now.toISOString();
  let detail = '';
  let started = false;
  const moves: string[] = [];
  const r = withShot(p, shotId, (s) => {
    const locked = textureLocked(s);
    if (locked) return locked;
    const current = textureDoc(s);
    started = current === null;
    const out = fn(current ?? newTextureDocument(), s);
    if (typeof out === 'string') return out;
    detail = out.detail;
    const doc = out.settings ? { ...out.doc, revision: out.doc.revision + 1 } : out.doc;
    const tasks = s.tasks.map((t) => {
      if (t.kind !== TEXTURE_TASK || !out.task || t.state === 'approved') return t;
      // A change starts the work or reopens a review for correction; a finished build goes to review (§15.6).
      const next: typeof t.state = out.task === 'review' ? 'needs_review' : t.state === 'pending' ? 'processing' : t.state === 'needs_review' ? 'needs_correction' : t.state;
      if (next === t.state) return t;
      moves.push(`${TEXTURE_TASK} → ${next}`);
      return { ...t, state: next };
    });
    return { ...s, tasks, texture: doc };
  });
  if (!r.ok) return r;
  let out = r.project;
  if (started) out = logged(out, { at, actor, shotId, action: 'texture.started', detail: `${TEXTURE_ALGORITHM.id}@${TEXTURE_ALGORITHM.version}` });
  out = logged(out, { at, actor, shotId, action, detail });
  for (const m of moves) out = logged(out, { at, actor, shotId, action: 'task.state', detail: m });
  return { ok: true, project: out };
}

const issue = (e: { issues: { path: PropertyKey[]; message: string }[] }) => `${e.issues[0]?.path.map(String).join('.') || 'value'}: ${e.issues[0]?.message ?? 'not usable'}`;
const pt = (c: readonly [number, number]) => `${Math.round(c[0])},${Math.round(c[1])}`;
export const textureSizeText = (s: TextureSize) => `${+s.width.toFixed(3)} × ${+s.height.toFixed(3)} ${s.units}`;

// ---------------------------------------------------------------------------
// References (§12 "ingest high-resolution reference photos plus optional panorama and LiDAR mesh/point cloud")
// ---------------------------------------------------------------------------

export type TextureReferenceInput = Omit<TextureReference, 'id' | 'addedBy' | 'addedAt' | 'camera' | 'scan' | 'panorama'> & {
  camera?: Partial<TextureCamera> | null;
  scan?: Partial<TextureScanInfo> | null;
  panorama?: Partial<TexturePanoramaInfo> | null;
};

const PREFIX: Record<TextureReferenceKind, string> = { photo: 'ph', panorama: 'pano', scan: 'scan' };

/** Record a reference that was read (path, checksum, size): photos, a panorama, a scan. The file itself is never touched. */
export function addTextureReference(p: Project, shotId: string, input: TextureReferenceInput, actor: string, now: Date): Result {
  const at = now.toISOString();
  return editTexture(p, shotId, actor, now, 'texture.reference_added', (doc) => {
    if (doc.references.length >= 200) return 'At most 200 references on a shot';
    if (doc.references.some((r) => r.path === input.path && r.from === input.from)) return `${input.name} is already here`;
    const seq = doc.seq + 1;
    const parsed = TextureReferenceSchema.safeParse({
      ...input,
      id: `${PREFIX[input.kind]}${seq}`,
      camera: input.kind === 'scan' || !input.camera ? null : TextureCameraSchema.parse(input.camera),
      scan: input.kind === 'scan' ? TextureScanInfoSchema.parse(input.scan ?? {}) : null,
      panorama: input.kind === 'panorama' ? TexturePanoramaInfoSchema.parse(input.panorama ?? {}) : null,
      addedBy: actor,
      addedAt: at,
    });
    if (!parsed.success) return `That reference is not usable: ${issue(parsed.error)}`;
    const r = parsed.data;
    if (r.kind !== 'scan' && (!r.width || !r.height)) return `${r.name}: its picture size could not be read`;
    const what =
      r.kind === 'scan'
        ? `${r.points?.toLocaleString('en') ?? '?'} points, ${r.scan!.units}, ${r.scan!.up.toUpperCase()}-up`
        : `${r.width}×${r.height}${r.encoding ? `, read as ${r.encoding}` : ''}${r.camera?.focalMm ? `, ${r.camera.focalMm} mm` : ''}${r.camera?.distortion ? ', lens distortion known' : ''}`;
    return {
      doc: { ...doc, references: [...doc.references, r], seq },
      detail: `${r.id} ${r.kind} ${r.name} (${r.from}: ${r.path}; ${what}${r.checksum ? `; sha256 ${r.checksum.value.slice(0, 12)}…` : ''})`,
      task: 'edited',
      settings: true,
    };
  });
}

export interface TextureReferenceChange {
  name?: string;
  encoding?: TextureReference['encoding'];
  camera?: Partial<TextureCamera> | null;
  scan?: Partial<TextureScanInfo>;
  panorama?: Partial<TexturePanoramaInfo>;
}

/** The camera and lens of a photo, how a picture is read, a scan's units and up axis, a panorama's heading and position. */
export function setTextureReference(p: Project, shotId: string, id: string, change: TextureReferenceChange, actor: string, now: Date): Result {
  return editTexture(p, shotId, actor, now, 'texture.reference', (doc) => {
    const ref = doc.references.find((r) => r.id === id);
    if (!ref) return `No reference ${id}`;
    const next: TextureReference = { ...ref };
    const details: string[] = [];
    if (change.name !== undefined && change.name.trim() && change.name.trim() !== ref.name) {
      next.name = change.name.trim().slice(0, 200);
      details.push(`renamed ${next.name}`);
    }
    if (change.encoding !== undefined && change.encoding !== ref.encoding) {
      if (ref.kind === 'scan') return 'A scan has no colour encoding';
      next.encoding = change.encoding;
      details.push(`read as ${change.encoding ?? 'unknown'}`);
    }
    if (change.camera !== undefined) {
      if (ref.kind === 'scan') return 'A scan has no camera';
      if (change.camera === null) next.camera = null;
      else {
        const parsed = TextureCameraSchema.safeParse({ ...(ref.camera ?? {}), ...change.camera });
        if (!parsed.success) return `camera.${issue(parsed.error)}`;
        next.camera = parsed.data;
      }
      if (JSON.stringify(next.camera) !== JSON.stringify(ref.camera)) {
        const c = next.camera;
        details.push(c ? `camera ${[c.body, c.lens, c.focalMm ? `${c.focalMm} mm` : null, c.filmBackWidthMm ? `film back ${c.filmBackWidthMm} mm` : null, c.distortion ? `k1 ${c.distortion.k1}` : null].filter(Boolean).join(', ') || 'unknown'}` : 'camera cleared');
      }
    }
    if (change.scan) {
      if (ref.kind !== 'scan') return 'Units and up axis are a scan’s';
      const parsed = TextureScanInfoSchema.safeParse({ ...ref.scan, ...change.scan });
      if (!parsed.success) return `scan.${issue(parsed.error)}`;
      next.scan = parsed.data;
      if (JSON.stringify(next.scan) !== JSON.stringify(ref.scan)) details.push(`scan ${next.scan.units}, ${next.scan.up.toUpperCase()}-up`);
    }
    if (change.panorama) {
      if (ref.kind !== 'panorama') return 'Heading and position are a panorama’s';
      const parsed = TexturePanoramaInfoSchema.safeParse({ ...ref.panorama, ...change.panorama });
      if (!parsed.success) return `panorama.${issue(parsed.error)}`;
      next.panorama = parsed.data;
      if (JSON.stringify(next.panorama) !== JSON.stringify(ref.panorama))
        details.push(`panorama heading ${next.panorama.headingDeg === null ? 'estimated' : `${next.panorama.headingDeg.toFixed(1)}°`}, at ${next.panorama.position ? next.panorama.position.map((v) => v.toFixed(2)).join(', ') : 'the scan’s middle'}`);
    }
    if (!details.length) return { doc, detail: `${id} unchanged` };
    return { doc: { ...doc, references: doc.references.map((r) => (r.id === id ? next : r)) }, detail: `${id}: ${details.join(', ')}`, task: 'edited', settings: true };
  });
}

/** Stop using a reference: its regions and its placement go with it (the file is untouched). */
export function removeTextureReference(p: Project, shotId: string, id: string, actor: string, now: Date): Result {
  return editTexture(p, shotId, actor, now, 'texture.reference_removed', (doc) => {
    const ref = doc.references.find((r) => r.id === id);
    if (!ref) return `No reference ${id}`;
    const gone = doc.regions.filter((r) => r.photoId === id).map((r) => r.id);
    return {
      doc: {
        ...doc,
        references: doc.references.filter((r) => r.id !== id),
        regions: doc.regions.filter((r) => r.photoId !== id),
        placements: doc.placements.filter((x) => x.photoId !== id),
        records: doc.records.filter((x) => !gone.includes(x.regionId)),
        planes: ref.kind === 'scan' ? [] : doc.planes,
      },
      detail: `${id} ${ref.name}${gone.length ? `, with its region${gone.length === 1 ? '' : 's'} ${gone.join(', ')}` : ''}`,
      task: 'edited',
      settings: true,
    };
  });
}

export const texturePhotos = (doc: TextureDocument | null | undefined) => (doc?.references ?? []).filter((r) => r.kind === 'photo');
export const texturePanorama = (doc: TextureDocument | null | undefined) => (doc?.references ?? []).find((r) => r.kind === 'panorama') ?? null;
export const textureScan = (doc: TextureDocument | null | undefined) => (doc?.references ?? []).find((r) => r.kind === 'scan') ?? null;

// ---------------------------------------------------------------------------
// Regions (§12 "generate seamless/tileable texture regions from photographed surfaces")
// ---------------------------------------------------------------------------

type Corners = TextureRegion['corners'];

function cornersProblem(c: Corners, ref: TextureReference): string | null {
  if (c.some((q) => !Number.isFinite(q[0]) || !Number.isFinite(q[1]))) return 'A corner is not a number';
  const w = ref.width ?? Infinity;
  const h = ref.height ?? Infinity;
  const margin = 0.25 * Math.max(w === Infinity ? 0 : w, h === Infinity ? 0 : h);
  if (c.some((q) => q[0] < -margin || q[1] < -margin || q[0] > w + margin || q[1] > h + margin)) return 'A corner is far outside the photo';
  // A simple convex quadrilateral, in order: every turn the same way, and some area.
  let sign = 0;
  for (let i = 0; i < 4; i += 1) {
    const a = c[i]!;
    const b = c[(i + 1) % 4]!;
    const d = c[(i + 2) % 4]!;
    const z = (b[0] - a[0]) * (d[1] - b[1]) - (b[1] - a[1]) * (d[0] - b[0]);
    if (Math.abs(z) < 1e-9) return 'Three corners are in a line';
    const s = Math.sign(z);
    if (sign && s !== sign) return 'The corners cross over: drag them round the surface in order (top-left, top-right, bottom-right, bottom-left)';
    sign = s;
  }
  let area = 0;
  for (let i = 0; i < 4; i += 1) area += c[i]![0] * c[(i + 1) % 4]![1] - c[(i + 1) % 4]![0] * c[i]![1];
  if (Math.abs(area) / 2 < 64) return 'That region is too small (under 8×8 photo pixels)';
  return null;
}

export interface TextureRegionInput {
  photoId: string;
  corners: Corners;
  name?: string;
  size?: TextureSize | null;
  settings?: Partial<Omit<TextureRegionSettings, 'output'>> & { output?: Partial<TextureRegionSettings['output']> };
}

/** Mark a surface on a photograph by its four corners. */
export function addTextureRegion(p: Project, shotId: string, input: TextureRegionInput, actor: string, now: Date): Result {
  const at = now.toISOString();
  return editTexture(p, shotId, actor, now, 'texture.region_added', (doc) => {
    const ref = doc.references.find((r) => r.id === input.photoId);
    if (!ref) return `No photo ${input.photoId}`;
    if (ref.kind !== 'photo') return 'Regions are marked on photographs (the panorama and the scan place them)';
    if (doc.regions.length >= 200) return 'At most 200 regions on a shot';
    const bad = cornersProblem(input.corners, ref);
    if (bad) return bad;
    let size: TextureSize | null = null;
    if (input.size) {
      const parsed = TextureSizeSchema.safeParse(input.size);
      if (!parsed.success) return `size.${issue(parsed.error)}`;
      size = parsed.data;
    }
    const settings = TextureRegionSettingsSchema.safeParse({ ...DEFAULT_TEXTURE_SETTINGS, ...(input.settings ?? {}), output: { ...DEFAULT_TEXTURE_SETTINGS.output, ...(input.settings?.output ?? {}) } });
    if (!settings.success) return `settings.${issue(settings.error)}`;
    const seq = doc.seq + 1;
    // Named by the regions there are, not the id sequence (which the references share).
    let n = doc.regions.length + 1;
    while (doc.regions.some((r) => r.name === `Region ${n}`)) n += 1;
    const region: TextureRegion = {
      id: `r${seq}`,
      name: (input.name?.trim() || `Region ${n}`).slice(0, 120),
      photoId: ref.id,
      corners: input.corners.map((c) => [Math.round(c[0] * 100) / 100, Math.round(c[1] * 100) / 100]) as unknown as Corners,
      size,
      target: { planeId: null, label: '' },
      settings: settings.data,
      enabled: true,
      by: actor,
      at,
    };
    return { doc: { ...doc, regions: [...doc.regions, region], seq }, detail: `${region.id} “${region.name}” on ${ref.id} at ${region.corners.map(pt).join(' ')}${size ? `, ${textureSizeText(size)}` : ''}`, task: 'edited', settings: true };
  });
}

export interface TextureRegionChange {
  name?: string;
  corners?: Corners;
  size?: TextureSize | null;
  /** The scan plane to put it on; null: the suggestion. */
  planeId?: string | null;
  enabled?: boolean;
  settings?: Partial<Omit<TextureRegionSettings, 'output'>> & { output?: Partial<TextureRegionSettings['output']> };
}

export function updateTextureRegion(p: Project, shotId: string, id: string, change: TextureRegionChange, actor: string, now: Date): Result {
  return editTexture(p, shotId, actor, now, 'texture.region', (doc) => {
    const region = doc.regions.find((r) => r.id === id);
    if (!region) return `No region ${id}`;
    const ref = doc.references.find((r) => r.id === region.photoId);
    const next: TextureRegion = { ...region };
    const details: string[] = [];
    if (change.name !== undefined && change.name.trim() && change.name.trim() !== region.name) {
      next.name = change.name.trim().slice(0, 120);
      details.push(`renamed “${next.name}”`);
    }
    if (change.corners) {
      if (ref) {
        const bad = cornersProblem(change.corners, ref);
        if (bad) return bad;
      }
      next.corners = change.corners.map((c) => [Math.round(c[0] * 100) / 100, Math.round(c[1] * 100) / 100]) as unknown as Corners;
      if (JSON.stringify(next.corners) !== JSON.stringify(region.corners)) details.push(`corners ${next.corners.map(pt).join(' ')}`);
    }
    if (change.size !== undefined) {
      if (change.size === null) next.size = null;
      else {
        const parsed = TextureSizeSchema.safeParse(change.size);
        if (!parsed.success) return `size.${issue(parsed.error)}`;
        next.size = parsed.data;
      }
      if (JSON.stringify(next.size) !== JSON.stringify(region.size)) details.push(next.size ? `real size ${textureSizeText(next.size)}` : 'real size cleared');
    }
    if (change.planeId !== undefined && change.planeId !== region.target.planeId) {
      if (change.planeId !== null && !doc.planes.some((x) => x.id === change.planeId)) return `No scan plane ${change.planeId}`;
      const plane = doc.planes.find((x) => x.id === change.planeId);
      next.target = { planeId: change.planeId, label: plane?.label ?? '' };
      details.push(change.planeId ? `put on ${change.planeId} (${plane?.label ?? ''})` : 'back to the suggested surface');
    }
    if (change.enabled !== undefined && change.enabled !== region.enabled) {
      next.enabled = change.enabled;
      details.push(change.enabled ? 'on' : 'off');
    }
    if (change.settings) {
      const parsed = TextureRegionSettingsSchema.safeParse({ ...region.settings, ...change.settings, output: { ...region.settings.output, ...(change.settings.output ?? {}) } });
      if (!parsed.success) return `settings.${issue(parsed.error)}`;
      next.settings = parsed.data;
      for (const k of Object.keys(change.settings) as (keyof TextureRegionSettings)[]) {
        const a = JSON.stringify(region.settings[k]);
        const b = JSON.stringify(next.settings[k]);
        if (a !== b) details.push(`${k} ${a} → ${b}`);
      }
    }
    if (next.settings.output.mode === 'density' && !next.size) return 'A texel density needs the surface’s real size: enter it first (step 2).';
    if (!details.length) return { doc, detail: `${id} unchanged` };
    return { doc: { ...doc, regions: doc.regions.map((r) => (r.id === id ? next : r)) }, detail: `${id}: ${details.join(', ')}`, task: 'edited', settings: true };
  });
}

export function removeTextureRegion(p: Project, shotId: string, id: string, actor: string, now: Date): Result {
  return editTexture(p, shotId, actor, now, 'texture.region_removed', (doc) => {
    const region = doc.regions.find((r) => r.id === id);
    if (!region) return `No region ${id}`;
    return { doc: { ...doc, regions: doc.regions.filter((r) => r.id !== id), records: doc.records.filter((x) => x.regionId !== id) }, detail: `${id} “${region.name}”`, task: 'edited', settings: true };
  });
}

export function setTextureWorkingWidth(p: Project, shotId: string, width: number, actor: string, now: Date): Result {
  if (!Number.isInteger(width) || width < 256 || width > 4096) return { ok: false, reason: 'Working width is 256 to 4096 px' };
  return editTexture(p, shotId, actor, now, 'texture.working_width', (doc) => (doc.workingWidth === width ? { doc, detail: `unchanged (${width})` } : { doc: { ...doc, workingWidth: width }, detail: `${doc.workingWidth} → ${width} px` }));
}

/** The real size in metres (width, height), or null. */
export function textureSizeMetres(size: TextureSize | null | undefined): { width: number; height: number } | null {
  if (!size) return null;
  const k = TEXTURE_UNIT_METRES[size.units];
  return { width: size.width * k, height: size.height * k };
}

// ---------------------------------------------------------------------------
// Placement (§12 "use panorama/spatial context to suggest where source photographs belong on scanned geometry")
// ---------------------------------------------------------------------------

/** The placement that holds for a photo: the artist's edit, the accepted suggestion, or the pending suggestion; null when rejected or none. */
export function texturePlacementOf(doc: TextureDocument | null | undefined, photoId: string): { direction: TextureDirection; planeId: string | null; confidence: number; decided: boolean } | null {
  const x = doc?.placements.find((q) => q.photoId === photoId);
  if (!x || x.decision === 'rejected') return null;
  if (x.decision === 'edited' && x.edited) return { direction: x.edited.direction, planeId: x.edited.planeId, confidence: 1, decided: true };
  if (!x.suggested || x.suggested.method === 'none') return null;
  return { direction: x.suggested.direction, planeId: x.suggested.planeId, confidence: x.suggested.confidence, decided: x.decision === 'accepted' };
}

/** The plane a region goes on: the artist's choice, else the build's suggestion under it (unless its photo's placement was rejected). */
export function textureRegionPlane(doc: TextureDocument | null | undefined, region: TextureRegion): TexturePlane | null {
  if (!doc) return null;
  if (region.target.planeId) return doc.planes.find((x) => x.id === region.target.planeId) ?? null;
  const placement = doc.placements.find((q) => q.photoId === region.photoId);
  if (placement?.decision === 'rejected') return null;
  const rec = doc.records.find((r) => r.regionId === region.id);
  const id = placement?.decision === 'edited' && placement.edited?.planeId ? placement.edited.planeId : (rec?.metrics.planeId ?? null);
  return id ? (doc.planes.find((x) => x.id === id) ?? null) : null;
}

export type TexturePlacementChoice = { decision: 'accepted' | 'rejected' | 'pending' } | { decision: 'edited'; direction: TextureDirection; planeId: string | null };

/** Accept, reject or edit where the build suggests a photo belongs. */
export function decideTexturePlacement(p: Project, shotId: string, photoId: string, choice: TexturePlacementChoice, actor: string, now: Date): Result {
  const at = now.toISOString();
  return editTexture(p, shotId, actor, now, 'texture.placement', (doc) => {
    const ref = doc.references.find((r) => r.id === photoId && r.kind === 'photo');
    if (!ref) return `No photo ${photoId}`;
    const current: TexturePlacement = doc.placements.find((x) => x.photoId === photoId) ?? { photoId, suggested: null, decision: 'pending', edited: null, by: null, at: null };
    let next: TexturePlacement;
    let detail: string;
    if (choice.decision === 'edited') {
      const dir = TextureDirectionSchema.safeParse(choice.direction);
      if (!dir.success) return `direction.${issue(dir.error)}`;
      if (choice.planeId !== null && !doc.planes.some((x) => x.id === choice.planeId)) return `No scan plane ${choice.planeId}`;
      next = { ...current, decision: 'edited', edited: { direction: dir.data, planeId: choice.planeId }, by: actor, at };
      detail = `${photoId}: placed by hand, yaw ${dir.data.yawDeg.toFixed(1)}°, pitch ${dir.data.pitchDeg.toFixed(1)}°${choice.planeId ? `, on ${choice.planeId}` : ''}`;
    } else {
      if (choice.decision !== 'pending' && !current.suggested) return `There is no suggestion for ${ref.name} to ${choice.decision === 'accepted' ? 'accept' : 'reject'} yet: build first (step 3).`;
      if (choice.decision === current.decision) return { doc, detail: `${photoId} unchanged (${choice.decision})` };
      next = { ...current, decision: choice.decision, edited: null, by: choice.decision === 'pending' ? null : actor, at: choice.decision === 'pending' ? null : at };
      const s = current.suggested;
      detail = `${photoId}: suggestion ${choice.decision === 'pending' ? 'back to pending' : choice.decision}${s ? ` (yaw ${s.direction.yawDeg.toFixed(1)}°, pitch ${s.direction.pitchDeg.toFixed(1)}°${s.planeId ? `, ${s.planeId}` : ''}, confidence ${s.confidence.toFixed(2)})` : ''}`;
    }
    const placements = doc.placements.some((x) => x.photoId === photoId) ? doc.placements.map((x) => (x.photoId === photoId ? next : x)) : [...doc.placements, next];
    return { doc: { ...doc, placements }, detail, task: 'edited', settings: true };
  });
}

// ---------------------------------------------------------------------------
// Builds, confidence and problems (§19 "show confidence/problem areas")
// ---------------------------------------------------------------------------

const clamp01 = (v: number) => (v <= 0 ? 0 : v >= 1 ? 1 : v);

/** Output texels per photo pixel (above 1: upsampled), or null without a real size. */
export function textureUpsample(m: Pick<TextureMetrics, 'texelDensity' | 'nativeDensity'>): number | null {
  if (m.texelDensity === null || m.nativeDensity === null || !(m.nativeDensity > 0)) return null;
  return m.texelDensity / m.nativeDensity;
}

/** A region's confidence from its measurements (addendum 12 §5). */
export function textureConfidence(m: TextureMetrics, tiled: boolean): number {
  let c = 1;
  c *= 0.4 + 0.6 * clamp01(m.sharpness / 0.5);
  c *= 1 - 0.5 * clamp01((m.clipped - 0.001) / 0.02);
  c *= 1 - 0.35 * clamp01((m.specular - 0.002) / 0.03);
  c *= 1 - 0.4 * clamp01((m.residualAfter - 0.1) / 0.4);
  if (tiled && m.seamScore !== null) c *= 1 - 0.4 * clamp01((m.seamScore - 1.2) / 1.2);
  const up = textureUpsample(m);
  if (up !== null) c *= 1 - 0.35 * clamp01((up - 1) / 2);
  c *= 0.5 + 0.5 * clamp01((m.coverage - 0.9) / 0.1);
  return Math.round(clamp01(c) * 1000) / 1000;
}

/** Why a region is a problem ('' when it is not). */
export function textureProblemReason(r: Pick<TextureRegionRecord, 'confidence' | 'metrics'>, region: Pick<TextureRegion, 'settings'> | null, hasPanorama: boolean): string {
  const m = r.metrics;
  const reasons: string[] = [];
  if (r.confidence < TEXTURE_LOW_CONFIDENCE) reasons.push(`confidence ${r.confidence.toFixed(2)}`);
  if (m.sharpness < TEXTURE_MIN_SHARPNESS) reasons.push(`the photo is soft or blurred here (sharpness ${m.sharpness.toFixed(2)})`);
  if (m.clipped > TEXTURE_MAX_CLIPPED) reasons.push(`${(m.clipped * 100).toFixed(1)} % clipped highlights (no detail to recover)`);
  if (m.specular > TEXTURE_MAX_SPECULAR) reasons.push(`${(m.specular * 100).toFixed(1)} % specular glints (baked into the albedo)`);
  const up = textureUpsample(m);
  if (up !== null && up > TEXTURE_MAX_UPSAMPLE) reasons.push(`too low a texel density in the photo: ${Math.round(m.nativeDensity!)} px/m for ${Math.round(m.texelDensity!)} px/m (upsampled ×${up.toFixed(1)})`);
  if (m.residualAfter > TEXTURE_MAX_RESIDUAL) reasons.push(`light still varies ${m.residualAfter.toFixed(2)} stops across it`);
  if (region && region.settings.tile !== 'none' && m.seamScore !== null && m.seamScore > TEXTURE_MAX_SEAM) reasons.push(`the tile’s seams show (${m.seamScore.toFixed(2)}× the texture’s own steps)`);
  if (m.coverage < TEXTURE_MIN_COVERAGE) reasons.push(`${((1 - m.coverage) * 100).toFixed(0)} % of it is outside the photo`);
  if (hasPanorama && m.planeId === null) reasons.push('no surface found for it in the scan');
  else if (hasPanorama && m.planeConfidence < 0.4) reasons.push(`its place on the scan is uncertain (${m.planeConfidence.toFixed(2)})`);
  return reasons.join('; ');
}

export interface TextureRunResult {
  /** The settings revision the build used. */
  revision: number;
  algorithm?: string;
  regions: { regionId: string; confidence: number; metrics: TextureMetrics }[];
  planes: TexturePlane[];
  placements: { photoId: string; suggested: NonNullable<TexturePlacement['suggested']> }[];
  /** Where the panorama was put in the scan (null without a panorama). */
  panoramaPose?: TexturePanoramaPose | null;
}

/**
 * Record what a build produced: per-region confidence and measurements, the
 * scan's planes and the placement suggestions. The artist's placement
 * decisions are kept (an accepted suggestion stays accepted only while the
 * build still suggests the same surface). A finished build puts the textures
 * up for review — never approves them. A build made with an older revision of
 * the settings is refused.
 */
export function recordTextureRun(p: Project, shotId: string, result: TextureRunResult, actor: string, now: Date): Result {
  if (!result.regions.length) return { ok: false, reason: 'The build produced no textures' };
  if (result.regions.some((r) => !(r.confidence >= 0 && r.confidence <= 1))) return { ok: false, reason: 'The build result is not usable' };
  const planes: TexturePlane[] = [];
  for (const x of result.planes) {
    const parsed = TexturePlaneSchema.safeParse(x);
    if (!parsed.success) return { ok: false, reason: `A scan plane is not usable: ${issue(parsed.error)}` };
    planes.push(parsed.data);
  }
  const at = now.toISOString();
  return editTexture(p, shotId, actor, now, 'texture.built', (doc, s) => {
    if (result.revision !== doc.revision) return `Those textures were built with settings revision ${result.revision}; the settings are now revision ${doc.revision}. Build again.`;
    const regions = new Map(doc.regions.map((r) => [r.id, r]));
    if (result.regions.some((r) => !regions.has(r.regionId))) return 'The build names a region that is not here';
    const previous = new Map(doc.records.map((r) => [r.regionId, r]));
    const hasPano = doc.references.some((r) => r.kind === 'panorama');
    const records = result.regions.map((r) => {
      const prev = previous.get(r.regionId);
      const rec = { regionId: r.regionId, confidence: Math.round(r.confidence * 1000) / 1000, metrics: r.metrics, status: prev?.status === 'flagged' ? ('flagged' as const) : ('processed' as const), reason: '', reviewed: null, note: prev?.note ?? '' };
      return { ...rec, reason: textureProblemReason(rec, regions.get(r.regionId) ?? null, hasPano) };
    });
    const placements = [
      ...result.placements.map((x): TexturePlacement => {
        const prev = doc.placements.find((q) => q.photoId === x.photoId);
        const keep = prev && (prev.decision === 'edited' || prev.decision === 'rejected' || (prev.decision === 'accepted' && prev.suggested?.planeId === x.suggested.planeId));
        return keep ? { ...prev, suggested: x.suggested } : { photoId: x.photoId, suggested: x.suggested, decision: 'pending', edited: null, by: null, at: null };
      }),
      ...doc.placements.filter((q) => !result.placements.some((x) => x.photoId === q.photoId) && q.decision === 'edited'),
    ];
    const values = records.map((r) => r.confidence);
    const mean = Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1000) / 1000;
    const min = Math.round(Math.min(...values) * 1000) / 1000;
    const problems = records.filter((r) => r.reason).map((r) => r.regionId);
    const algorithm = result.algorithm ?? `${TEXTURE_ALGORITHM.id}@${TEXTURE_ALGORITHM.version}`;
    const run = { algorithm, revision: result.revision, regions: records.length, meanConfidence: mean, minConfidence: min, planes: planes.length, placements: result.placements.filter((x) => x.suggested.method !== 'none').length, problems, taskVersion: textureTaskVersion(s), at, by: actor };
    return {
      doc: { ...doc, records, planes, placements, panoramaPose: result.panoramaPose ?? null, runs: [...doc.runs, run].slice(-MAX_RUNS) },
      detail: `${records.length} region${records.length === 1 ? '' : 's'} with ${algorithm} (settings r${result.revision}): confidence mean ${mean.toFixed(2)} min ${min.toFixed(2)}; ${planes.length} scan plane${planes.length === 1 ? '' : 's'}; ${run.placements} placement suggestion${run.placements === 1 ? '' : 's'}${problems.length ? `; problems in ${problems.join(', ')}` : ''}`,
      task: 'review',
    };
  });
}

/** Flag a region as needing correction, or clear the flag. */
export function flagTextureRegion(p: Project, shotId: string, regionId: string, note: string, actor: string, now: Date): Result {
  return editTexture(p, shotId, actor, now, 'texture.flagged', (doc) => {
    const rec = doc.records.find((r) => r.regionId === regionId);
    if (!rec) return `Region ${regionId} has not been built yet`;
    const cleared = rec.status === 'flagged';
    const records = doc.records.map((r) => (r.regionId === regionId ? { ...r, status: cleared ? ('processed' as const) : ('flagged' as const), note: cleared ? r.note : note.trim(), reviewed: null } : r));
    return { doc: { ...doc, records }, detail: `${regionId} ${cleared ? 'flag cleared' : `flagged${note.trim() ? `: ${note.trim()}` : ''}`}` };
  });
}

/** Record that someone looked at a built texture and accepts it. */
export function markTextureRegionReviewed(p: Project, shotId: string, regionId: string, actor: string, now: Date): Result {
  const at = now.toISOString();
  return editTexture(p, shotId, actor, now, 'texture.reviewed', (doc) => {
    if (!doc.records.some((r) => r.regionId === regionId)) return `Region ${regionId} has not been built yet`;
    return { doc: { ...doc, records: doc.records.map((r) => (r.regionId === regionId ? { ...r, reviewed: { by: actor, at }, status: 'processed' as const } : r)) }, detail: regionId };
  });
}

export interface TextureReview {
  /** Regions to look at, worst first: flagged, then problems not yet reviewed. */
  problems: { regionId: string; confidence: number; reason: string }[];
  /** Placement suggestions still waiting for the artist. */
  pendingPlacements: string[];
}

export function textureReview(doc: TextureDocument | null | undefined): TextureReview {
  if (!doc) return { problems: [], pendingPlacements: [] };
  const live = new Set(doc.regions.filter((r) => r.enabled).map((r) => r.id));
  const problems = doc.records
    .filter((r) => live.has(r.regionId))
    .filter((r) => r.status === 'flagged' || (r.reason && !r.reviewed))
    .map((r) => ({ regionId: r.regionId, confidence: r.confidence, reason: r.status === 'flagged' ? `flagged${r.note ? `: ${r.note}` : ''}` : r.reason }))
    .sort((a, b) => Number(b.reason.startsWith('flagged')) - Number(a.reason.startsWith('flagged')) || a.confidence - b.confidence || a.regionId.localeCompare(b.regionId));
  const pendingPlacements = doc.placements.filter((x) => x.decision === 'pending' && x.suggested && x.suggested.method !== 'none').map((x) => x.photoId);
  return { problems, pendingPlacements };
}

export function nextTextureProblem(review: TextureReview, doc: TextureDocument | null | undefined, current: string | null): string | null {
  const order = (doc?.regions ?? []).map((r) => r.id).filter((id) => review.problems.some((x) => x.regionId === id));
  if (!order.length) return null;
  const i = current ? order.indexOf(current) : -1;
  return order[(i + 1) % order.length]!;
}

export interface TextureSummary {
  regions: number;
  built: number;
  mean: number;
  min: number;
  /** Median output texel density over regions with a real size (px/m), or null. */
  texelDensity: number | null;
  /** Worst seam score over tiled regions, or null. */
  seamScore: number | null;
  /** Worst residual light variation after delighting, stops. */
  residual: number;
  /** Mean confidence of the placements that hold, or null without any. */
  placement: number | null;
  low: string[];
  problems: string[];
  flagged: string[];
  reviewed: number;
}

export function textureSummary(doc: TextureDocument | null | undefined): TextureSummary {
  const empty: TextureSummary = { regions: doc?.regions.length ?? 0, built: 0, mean: 0, min: 0, texelDensity: null, seamScore: null, residual: 0, placement: null, low: [], problems: [], flagged: [], reviewed: 0 };
  if (!doc || !doc.records.length) return empty;
  const recs = doc.records;
  const values = recs.map((r) => r.confidence);
  const densities = recs.map((r) => r.metrics.texelDensity).filter((v): v is number => v !== null).sort((a, b) => a - b);
  const seams = recs.filter((r) => doc.regions.find((x) => x.id === r.regionId)?.settings.tile !== 'none').map((r) => r.metrics.seamScore).filter((v): v is number => v !== null);
  const placements = doc.references.filter((r) => r.kind === 'photo').map((r) => texturePlacementOf(doc, r.id)).filter((x): x is NonNullable<typeof x> => x !== null);
  return {
    regions: doc.regions.length,
    built: recs.length,
    mean: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1000) / 1000,
    min: Math.min(...values),
    texelDensity: densities.length ? densities[Math.floor(densities.length / 2)]! : null,
    seamScore: seams.length ? Math.max(...seams) : null,
    residual: Math.max(...recs.map((r) => r.metrics.residualAfter)),
    placement: placements.length ? Math.round((placements.reduce((a, x) => a + x.confidence, 0) / placements.length) * 1000) / 1000 : null,
    low: recs.filter((r) => r.confidence < TEXTURE_LOW_CONFIDENCE).map((r) => r.regionId),
    problems: recs.filter((r) => r.reason && !r.reviewed).map((r) => r.regionId),
    flagged: recs.filter((r) => r.status === 'flagged').map((r) => r.regionId),
    reviewed: recs.filter((r) => r.reviewed).length,
  };
}

/** Is there enough to build? (null when there is, else what is missing.) */
export function textureBuildProblem(doc: TextureDocument | null | undefined): string | null {
  if (!texturePhotos(doc).length) return 'Add the reference photos first (step 1).';
  if (!(doc?.regions ?? []).some((r) => r.enabled)) return 'Mark a region on a photo first (step 2).';
  return null;
}

// ---------------------------------------------------------------------------
// Export (§12 "export texture maps and mapping/reference information for downstream 3D work", §17)
// ---------------------------------------------------------------------------

/** Record a written export and submit the textures for review (never approval). */
export function recordTextureExport(p: Project, shotId: string, record: TextureExportInput, actor: string, now: Date): Result {
  const at = now.toISOString();
  const parsed = TextureExportSchema.safeParse({ ...record, writtenAt: at, by: actor });
  if (!parsed.success) return { ok: false, reason: `The export record is not usable: ${parsed.error.issues[0]?.message ?? 'bad data'}` };
  const rec = parsed.data;
  return editTexture(p, shotId, actor, now, 'texture.exported', (doc, s) => {
    const v = textureTaskVersion(s);
    if (rec.version !== v) return `That export is ${versionTag(rec.version)}; the task is ${versionTag(v)}`;
    return {
      doc: { ...doc, exports: [...doc.exports.filter((e) => e.version !== rec.version), rec].sort((a, b) => a.version - b.version) },
      detail: `${versionTag(rec.version)}: ${rec.folder}, ${rec.regions.length} texture${rec.regions.length === 1 ? '' : 's'} (${rec.regions.map((r) => `${r.id} ${r.width}×${r.height}`).join(', ')}), ${rec.format.toUpperCase()} + 16-bit PNG, ${rec.encoding}; mapping ${rec.mapping}${rec.obj ? `, ${rec.obj}` : ''}; ${rec.files} files; settings r${rec.revision}`,
      task: 'review',
    };
  });
}

const safePart = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'region';

/** File names (§17): `<shot>_tex_v001/` with `<shot>_tex_<region>_v001.png` … */
export const textureNames = {
  folder: (shot: string, version: number) => `${shot}_tex_${versionTag(version)}`,
  stem: (shot: string, region: Pick<TextureRegion, 'id' | 'name'>, version: number) => `${shot}_tex_${region.id}_${safePart(region.name)}_${versionTag(version)}`,
  map: (stem: string) => `${stem}.png`,
  mapExr: (stem: string) => `${stem}.exr`,
  original: (stem: string) => `${stem}_orig.png`,
  tilePreview: (stem: string) => `${stem}_tile3x3.png`,
  mask: (stem: string) => `${stem}_mask.png`,
  mapping: (shot: string, version: number) => `${shot}_tex_${versionTag(version)}.json`,
  obj: (shot: string, version: number) => `${shot}_tex_${versionTag(version)}.obj`,
  mtl: (shot: string, version: number) => `${shot}_tex_${versionTag(version)}.mtl`,
  readme: () => 'README.txt',
  /** Every file of a version starts with this. */
  prefix: (shot: string) => `${shot}_tex_`,
};

/** Everything that decides the pixels and the mapping, for the metadata and for reproducing it (§19). */
export function textureSettings(doc: TextureDocument) {
  return {
    algorithm: doc.algorithm,
    revision: doc.revision,
    references: doc.references.map((r) => ({ id: r.id, kind: r.kind, name: r.name, path: r.path, from: r.from, checksum: r.checksum, width: r.width, height: r.height, points: r.points, encoding: r.encoding, camera: r.camera, scan: r.scan, panorama: r.panorama })),
    regions: doc.regions.map((r) => ({ id: r.id, name: r.name, photoId: r.photoId, corners: r.corners, size: r.size, target: r.target, settings: r.settings, enabled: r.enabled })),
    placements: doc.placements.map((x) => ({ photoId: x.photoId, decision: x.decision, edited: x.edited })),
  };
}

export interface TextureMappingRegion {
  id: string;
  /** Photo pixel → texture pixel homography (row-major 3×3), after undistortion when `undistorted`. */
  homography: number[];
  undistorted: boolean;
  /** Texture size, pixels, and texels per metre. */
  width: number;
  height: number;
  texelDensity: number | null;
  /** The planar patch the texture maps onto, scan coordinates (corners in texture order TL, TR, BR, BL), or null. */
  patch: [number, number, number][] | null;
  files: Record<string, string | null>;
  metrics: TextureMetrics;
  confidence: number;
}

/** The mapping/reference file written beside the textures (`<shot>_tex_vNNN.json`). */
export function textureMetadata(
  p: Project,
  shotId: string,
  info: {
    version: number;
    encoding: string;
    linear: boolean;
    format: 'exr' | 'png';
    generator: string;
    writtenAt: string;
    by: string;
    regions: TextureMappingRegion[];
    obj: string | null;
    mtl: string | null;
    scanFrame: { units: string; up: string } | null;
  },
) {
  const shot = handoffShot(p, shotId);
  const s = shotState(p, shotId);
  const doc = textureDoc(s);
  if (!shot || !s || !doc) throw new Error(`No textures for ${shotId}`);
  const refs = new Map(doc.references.map((r) => [r.id, r]));
  return {
    format: 'vcvfx.texture/1',
    generator: info.generator,
    shot: shotName(s),
    handoffShotId: shot.shotId,
    task: TEXTURE_TASK,
    version: versionTag(info.version),
    writtenAt: info.writtenAt,
    by: info.by,
    colour: {
      encoding: info.encoding,
      linear: info.linear,
      note: info.linear ? 'Albedo-like texture maps, scene-linear in this encoding (EXR) and the same values sRGB-encoded in the 16-bit PNG; no display look is applied.' : 'A photo of unknown encoding: values written as read.',
    },
    conventions: {
      corners: 'Region corners are photo pixels, pixel centres at integers, in the order top-left, top-right, bottom-right, bottom-left.',
      homography: 'H maps photo pixels (undistorted when `undistorted`) to texture pixels; row-major 3×3.',
      scan: info.scanFrame ? `Planes and patches are in the scan’s coordinates (${info.scanFrame.units}, ${info.scanFrame.up.toUpperCase()}-up); the OBJ is the same.` : 'No scan: no planes or patches.',
      direction: 'Panorama directions: yaw about the up axis from the panorama’s centre column (positive to the right), pitch above the horizon, degrees.',
    },
    references: [...refs.values()].map((r) => ({ id: r.id, kind: r.kind, name: r.name, path: r.path, from: r.from, checksum: r.checksum, width: r.width, height: r.height, points: r.points, encoding: r.encoding, camera: r.camera, scan: r.scan, panorama: r.panorama })),
    planes: doc.planes,
    panorama: doc.panoramaPose,
    placements: doc.placements.map((x) => ({ photoId: x.photoId, photo: refs.get(x.photoId)?.name ?? x.photoId, decision: x.decision, suggested: x.suggested, edited: x.edited, holds: texturePlacementOf(doc, x.photoId) })),
    regions: info.regions.map((m) => {
      const r = doc.regions.find((x) => x.id === m.id)!;
      const rec = doc.records.find((x) => x.regionId === m.id);
      const plane = textureRegionPlane(doc, r);
      return {
        id: r.id,
        name: r.name,
        sourcePhoto: { id: r.photoId, name: refs.get(r.photoId)?.name ?? r.photoId, path: refs.get(r.photoId)?.path ?? null },
        corners: r.corners,
        realSize: r.size,
        settings: r.settings,
        homography: m.homography,
        undistorted: m.undistorted,
        lens: refs.get(r.photoId)?.camera ?? null,
        texture: { width: m.width, height: m.height, texelDensity: m.texelDensity },
        surface: plane ? { planeId: plane.id, label: plane.label, normal: plane.normal, d: plane.d, chosenBy: r.target.planeId ? 'artist' : 'suggestion' } : null,
        panoramaDirection: texturePlacementOf(doc, r.photoId)?.direction ?? null,
        patch: m.patch,
        files: m.files,
        confidence: m.confidence,
        metrics: m.metrics,
        status: rec?.status ?? 'processed',
        problem: rec?.reason || null,
        reviewed: rec?.reviewed ?? null,
      };
    }),
    mesh: info.obj ? { obj: info.obj, mtl: info.mtl, note: 'Planar patches with UVs (0–1 across each texture), one object and material per region, in scan coordinates.' } : null,
    settings: textureSettings(doc),
    summary: textureSummary(doc),
    runs: doc.runs.filter((r) => r.taskVersion === info.version),
    approval: s.tasks.find((t) => t.kind === TEXTURE_TASK)?.approval ?? null,
  };
}
export type TextureMetadata = ReturnType<typeof textureMetadata>;

/** The texture section of the package manifest (§18), or null when not started. */
export function textureManifest(s: ShotState) {
  const doc = textureDoc(s);
  if (!doc) return null;
  const task = s.tasks.find((t) => t.kind === TEXTURE_TASK);
  const version = task?.version ?? 1;
  const exported = doc.exports.find((e) => e.version === version) ?? null;
  const summary = textureSummary(doc);
  return {
    task: TEXTURE_TASK,
    version: versionTag(version),
    state: task?.state ?? null,
    approval: task?.approval ?? null,
    exported: exported !== null,
    folder: exported?.folder ?? null,
    mapping: exported ? `${exported.folder}/${exported.mapping}` : null,
    obj: exported?.obj ? `${exported.folder}/${exported.obj}` : null,
    textures: exported ? exported.regions.map((r) => ({ id: r.id, name: r.name, map: `${exported.folder}/${r.map}`, exr: r.mapExr ? `${exported.folder}/${r.mapExr}` : null, width: r.width, height: r.height, planeId: r.planeId })) : [],
    format: exported?.format ?? null,
    encoding: exported?.encoding ?? null,
    algorithm: `${doc.algorithm.id}@${doc.algorithm.version}`,
    revision: exported?.revision ?? doc.revision,
    references: doc.references.map((r) => ({ id: r.id, kind: r.kind, name: r.name, path: r.path, checksum: r.checksum?.value ?? null })),
    regions: doc.regions.map((r) => ({ id: r.id, name: r.name, photoId: r.photoId, size: r.size, tile: r.settings.tile, enabled: r.enabled })),
    planes: doc.planes.length,
    placements: doc.placements.map((x) => ({ photoId: x.photoId, decision: x.decision, confidence: x.suggested?.confidence ?? null })),
    confidence: { regions: summary.built, mean: summary.mean, min: summary.min, low: summary.low, problems: summary.problems, flagged: summary.flagged, reviewed: summary.reviewed },
  };
}
