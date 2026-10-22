import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import {
  COLOR_ENCODINGS,
  DEFAULT_TEXTURE_SETTINGS,
  ENCODINGS,
  SCENE_UNITS,
  TASK_STATE_LABELS,
  TEXTURE_KIND_LABELS,
  TEXTURE_LOW_CONFIDENCE,
  TEXTURE_MAX_RESIDUAL,
  TEXTURE_MAX_SEAM,
  addTask,
  addTextureReference,
  addTextureRegion,
  decideTexturePlacement,
  flagTextureRegion,
  markTextureRegionReviewed,
  nextTextureProblem,
  recordTextureExport,
  recordTextureRun,
  removeTextureReference,
  removeTextureRegion,
  serializeProject,
  setTextureReference,
  shotState,
  textureBuildProblem,
  textureDoc,
  textureLocked,
  texturePlacementOf,
  textureRegionPlane,
  textureReview,
  textureSizeText,
  textureSummary,
  textureTaskVersion,
  textureUpsample,
  updateTextureRegion,
  versionTag,
  type ColorEncodingId,
  type Project,
  type Result,
  type SceneUnit,
  type TextureDocument,
  type TextureReference,
  type TextureReferenceChange,
  type TextureReferenceKind,
  type TextureRegion,
  type TextureRegionChange,
  type TextureSize,
} from '@vcvfx/domain';
import type { VcvfxApi } from '../../../shared/bridge';
import type { TextureImageView, TextureScanView, TextureSessionInfo } from '../../../shared/texture/bridge-types';
import { Big, Check, Seg, Slider, confidenceColour } from '../cleanplate/CleanPlateWorkspace';
import { PointCloudView, type CloudLayer } from '../PointCloudView';
import '../key/key.css';
import '../cleanplate/cleanplate.css';
import './texture.css';

/**
 * The Textures workspace (master spec §12; addendum 12): add the reference
 * photos, the 360° panorama and the LiDAR scan; mark a surface on a photo by
 * dragging its four corners and give its real size; correct it (undistort,
 * rectify, delight, one exposure across the surface); make it seamless;
 * review where the build suggests each photo belongs on the scan and accept,
 * reject or change it; export versioned texture maps with the mapping file
 * and a mesh of planar patches.
 *
 * Built for the three-zone module screen (addendum 08), as the Clean Plate
 * and Sky & BG are: `useTextureController` holds the state and actions;
 * `textureStepDefs` (left), `TextureViewer` (centre) and `TextureInfo`
 * (right) draw from it. Every change is a logged domain mutation applied
 * through `onTexture`. A build puts the task up for review; nothing here
 * approves.
 */

export type TextureMutation = (p: Project, actor: string, now: Date) => Result;

export interface TextureWorkspaceProps {
  api: VcvfxApi;
  project: Project;
  shotId: string;
  projectKey: string;
  canEdit: boolean;
  busy: boolean;
  actor: string;
  /** Apply a domain mutation; false when it was refused (the shell shows why). */
  onTexture(fn: TextureMutation): boolean;
  runJob<T>(label: string, fn: (jobId: string) => Promise<T>): Promise<T>;
  notify(kind: 'ok' | 'error' | 'info', text: string): void;
}

export const TEXTURE_VIEWS = ['photo', 'rectified', 'delit', 'tiled', 'panorama', 'scan'] as const;
export type TextureViewMode = (typeof TEXTURE_VIEWS)[number];
export const TEXTURE_VIEW_LABELS: Record<TextureViewMode, string> = {
  photo: 'Photo',
  rectified: 'Rectified',
  delit: 'Delit',
  tiled: 'Tiled 3×3',
  panorama: 'Panorama',
  scan: 'Scan',
};
export type TextureTool = 'region' | null;
type Corners = TextureRegion['corners'];

const unwrap = <T,>(r: { ok: true; data: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(r.error);
  return r.data;
};
const PHOTO_WIDTH = 1280;
const kindPlural = (k: TextureReferenceKind) => (k === 'photo' ? 'photos' : k === 'panorama' ? 'the panorama' : 'the scan');

// ---------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------

export function useTextureController(props: TextureWorkspaceProps) {
  const { api, project, shotId, projectKey, canEdit, actor, onTexture, runJob, notify } = props;
  const state = shotState(project, shotId);
  const doc: TextureDocument | null = textureDoc(state);
  const hasTask = Boolean(state?.tasks.some((t) => t.kind === 'texture_extraction'));
  const task = state?.tasks.find((t) => t.kind === 'texture_extraction') ?? null;
  const locked = state ? textureLocked(state) : 'No shot';
  const version = state ? textureTaskVersion(state) : 1;
  const text = useMemo(() => serializeProject(project), [project]);
  const textRef = useRef(text);
  textRef.current = text;
  const supported = Boolean(api.textureSession && api.textureImage);

  const [session, setSession] = useState<TextureSessionInfo | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [photoPick, setPhotoId] = useState<string | null>(null);
  const [regionPick, setRegionId] = useState<string | null>(null);
  const [mode, setMode] = useState<TextureViewMode>('photo');
  const [wipe, setWipe] = useState<{ on: boolean; x: number }>({ on: false, x: 0.5 });
  const [tool, setTool] = useState<TextureTool>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [photoView, setPhotoView] = useState<TextureImageView | null>(null);
  const [textureView, setTextureView] = useState<TextureImageView | null>(null);
  const [wipeView, setWipeView] = useState<TextureImageView | null>(null);
  const [panoView, setPanoView] = useState<TextureImageView | null>(null);
  const [scan, setScan] = useState<TextureScanView | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const references = doc?.references ?? [];
  const photos = references.filter((r) => r.kind === 'photo');
  const panorama = references.find((r) => r.kind === 'panorama') ?? null;
  const scanRef = references.find((r) => r.kind === 'scan') ?? null;
  const regions = doc?.regions ?? [];
  const photoId = photoPick && photos.some((p) => p.id === photoPick) ? photoPick : (photos[0]?.id ?? null);
  const photo = photos.find((p) => p.id === photoId) ?? null;
  const regionId = regionPick && regions.some((r) => r.id === regionPick) ? regionPick : (regions.find((r) => r.photoId === photoId)?.id ?? regions[0]?.id ?? null);
  const region = regions.find((r) => r.id === regionId) ?? null;
  const canChange = canEdit && !locked && Boolean(session?.available);

  const refsKey = JSON.stringify(references.map((r) => [r.id, r.path, r.encoding]));
  useEffect(() => {
    if (!api.textureSession) return;
    let live = true;
    setSessionError(null);
    void api.textureSession({ text: textRef.current, shotId, projectKey }).then((r) => {
      if (!live) return;
      if (r.ok) setSession(r.data);
      else setSessionError(r.error);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, shotId, projectKey, hasTask, refsKey]);

  const lastRun = doc?.runs.filter((r) => r.taskVersion === version).at(-1) ?? null;
  const built = Boolean(lastRun && lastRun.revision === doc?.revision);
  const buildKey = `${lastRun?.at ?? ''}|${lastRun?.revision ?? ''}|${doc?.revision ?? 0}`;

  // The photo.
  useEffect(() => {
    if (!api.textureImage || !session?.available || !photo) {
      setPhotoView(null);
      return;
    }
    let live = true;
    setLoading(true);
    void api.textureImage({ text: textRef.current, shotId, projectKey, request: { kind: 'reference', id: photo.id, maxWidth: PHOTO_WIDTH } }).then((r) => {
      if (!live) return;
      setLoading(false);
      if (r.ok) {
        setPhotoView(r.data);
        setViewError(null);
      } else setViewError(r.error);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, session?.available, photo?.id, photo?.encoding, refsKey, shotId]);

  // The texture of the region, at the stage the view shows (and the original for the A/B wipe).
  const stage = mode === 'rectified' ? 'original' : mode === 'tiled' ? 'tiled' : 'delit';
  useEffect(() => {
    if (!api.textureImage || !session?.available || !region || !lastRun || !(mode === 'rectified' || mode === 'delit' || mode === 'tiled')) {
      setTextureView(null);
      setWipeView(null);
      return;
    }
    let live = true;
    setLoading(true);
    const ask = (s: 'original' | 'delit' | 'tiled') => api.textureImage!({ text: textRef.current, shotId, projectKey, request: { kind: 'texture', regionId: region.id, stage: s, maxWidth: s === 'tiled' ? 512 : 1024 } });
    void Promise.all([ask(stage), mode === 'delit' ? ask('original') : Promise.resolve(null)]).then(([a, b]) => {
      if (!live) return;
      setLoading(false);
      if (a.ok) {
        setTextureView(a.data);
        setViewError(null);
      } else {
        setTextureView(null);
        setViewError(a.error);
      }
      setWipeView(b && b.ok ? b.data : null);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, session?.available, region?.id, mode, buildKey, shotId]);

  // The panorama.
  useEffect(() => {
    if (!api.textureImage || !session?.available || !panorama || mode !== 'panorama') return;
    let live = true;
    setLoading(true);
    void api.textureImage({ text: textRef.current, shotId, projectKey, request: { kind: 'reference', id: panorama.id, maxWidth: 2048 } }).then((r) => {
      if (!live) return;
      setLoading(false);
      if (r.ok) setPanoView(r.data);
      else setViewError(r.error);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, session?.available, panorama?.id, panorama?.encoding, mode, shotId]);

  // The scan.
  useEffect(() => {
    if (!api.textureScan || !session?.available || !scanRef || mode !== 'scan') return;
    let live = true;
    setLoading(true);
    void api.textureScan({ text: textRef.current, shotId, projectKey }).then((r) => {
      if (!live) return;
      setLoading(false);
      if (r.ok) setScan(r.data);
      else setViewError(r.error);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, session?.available, scanRef?.id, scanRef?.scan?.up, mode, buildKey, shotId]);

  const apply = useCallback((fn: TextureMutation) => onTexture(fn), [onTexture]);
  const guard = async (label: string, fn: () => Promise<void>) => {
    setWorking(label);
    try {
      await fn();
    } catch (error) {
      notify('error', (error as Error).message);
    } finally {
      setWorking(null);
    }
  };

  const review = useMemo(() => textureReview(doc), [doc]);
  const summary = useMemo(() => textureSummary(doc), [doc]);
  const record = region ? (doc?.records.find((r) => r.regionId === region.id) ?? null) : null;
  const exported = doc?.exports.find((e) => e.version === version) ?? null;
  const exportCurrent = Boolean(exported && exported.revision === doc?.revision);
  const placement = photo ? (doc?.placements.find((x) => x.photoId === photo.id) ?? null) : null;
  const planeOfRegion = region ? textureRegionPlane(doc, region) : null;

  /** Ingest a kind of reference and record each one; returns the ids added. */
  const ingest = async (kind: TextureReferenceKind, sources: { path: string; from: 'disk' | 'handoff' | 'sample' }[]) => {
    if (!api.textureIngest) throw new Error('Adding references is not available here.');
    const refs = await runJob(`Reading ${kindPlural(kind)} for ${state?.vfxShotId ?? shotId}`, async (jobId) => unwrap(await api.textureIngest!({ jobId, text: textRef.current, shotId, projectKey, kind, sources })));
    let added = 0;
    for (const r of refs) {
      if (references.some((x) => x.path === r.path && x.from === r.from)) continue;
      if (apply((p, a, t) => addTextureReference(p, shotId, r, a, t))) added += 1;
    }
    return added;
  };

  const actions = {
    addFromDisk: (kind: TextureReferenceKind) =>
      guard('Adding…', async () => {
        if (!api.textureChoose) throw new Error('Choosing files is the desktop app’s.');
        const paths = unwrap(await api.textureChoose({ kind }));
        if (!paths?.length) return;
        const n = await ingest(kind, paths.map((path) => ({ path, from: 'disk' as const })));
        if (n) notify('ok', `${n} ${kind === 'photo' ? `photo${n === 1 ? '' : 's'}` : kind} added: read, checksummed, never changed.`);
      }),
    addFromHandoff: (kind: TextureReferenceKind) =>
      guard('Adding…', async () => {
        const items = (session?.handoff ?? []).filter((h) => h.kind === kind && h.onDisk && !references.some((r) => r.from === 'handoff' && r.path === h.path));
        if (!items.length) throw new Error('Nothing from the handoff is on the drive to add.');
        const n = await ingest(kind, items.map((h) => ({ path: h.path, from: 'handoff' as const })));
        if (n) notify('ok', `${n} reference${n === 1 ? '' : 's'} from the handoff added.`);
      }),
    useSample: () =>
      guard('Adding…', async () => {
        let n = 0;
        for (const kind of ['photo', 'panorama', 'scan'] as const) if (!references.some((r) => r.kind === kind)) n += await ingest(kind, [{ path: 'sample', from: 'sample' }]);
        if (n) notify('ok', 'The sample set is in: three stills, a 360° panorama and a scan of the storeroom. Mark the regions next (step 2).');
      }),
    markSampleRegions: () => {
      const doc0 = textureDoc(shotState(project, shotId));
      let n = 0;
      for (const s of session?.sampleRegions ?? []) {
        const ph = doc0?.references.find((r) => r.kind === 'photo' && r.path === s.photo);
        if (!ph || doc0?.regions.some((r) => r.photoId === ph.id && r.name === s.name)) continue;
        if (apply((p, a, t) => addTextureRegion(p, shotId, { photoId: ph.id, corners: s.corners, name: s.name, size: s.size, settings: { output: { mode: 'density', density: 200 } } }, a, t))) n += 1;
      }
      if (n) notify('ok', `${n} region${n === 1 ? '' : 's'} marked with their measured sizes. Build next (step 3).`);
    },
    removeReference: (id: string) => apply((p, a, t) => removeTextureReference(p, shotId, id, a, t)),
    setReference: (id: string, change: TextureReferenceChange) => apply((p, a, t) => setTextureReference(p, shotId, id, change, a, t)),
    addRegion: (corners: Corners) => {
      if (!photo) return;
      const before = new Set(regions.map((r) => r.id));
      let created: string | null = null;
      if (
        apply((p, a, t) => {
          const r = addTextureRegion(p, shotId, { photoId: photo.id, corners }, a, t);
          if (r.ok) created = textureDoc(shotState(r.project, shotId))?.regions.find((x) => !before.has(x.id))?.id ?? null;
          return r;
        })
      ) {
        if (created) setRegionId(created);
        notify('info', 'Drag the corners onto the surface’s corners, and give its real size if you know it.');
      }
    },
    updateRegion: (id: string, change: TextureRegionChange) => apply((p, a, t) => updateTextureRegion(p, shotId, id, change, a, t)),
    removeRegion: (id: string) => apply((p, a, t) => removeTextureRegion(p, shotId, id, a, t)),
    build: () =>
      guard('Building…', async () => {
        if (!api.textureBuild) throw new Error('Building is not available here.');
        const { result } = await runJob(`Building the textures of ${state?.vfxShotId ?? shotId}`, async (jobId) => unwrap(await api.textureBuild!({ jobId, text: textRef.current, shotId, projectKey })));
        if (apply((p, a, t) => recordTextureRun(p, shotId, result, a, t))) {
          const placed = result.placements.length;
          notify('ok', `${result.regions.length} texture${result.regions.length === 1 ? '' : 's'} built${result.planes.length ? `; ${result.planes.length} planes in the scan` : ''}${placed ? `; ${placed} placement${placed === 1 ? '' : 's'} suggested — review them (step 5)` : ''}.`);
          if (mode === 'photo') setMode('delit');
        }
      }),
    decide: (choice: Parameters<typeof decideTexturePlacement>[3]) => {
      if (!photo) return;
      apply((p, a, t) => decideTexturePlacement(p, shotId, photo.id, choice, a, t));
    },
    nextProblem: () => {
      const next = nextTextureProblem(review, doc, regionId);
      if (!next) return;
      setRegionId(next);
      const r = regions.find((x) => x.id === next);
      if (r) setPhotoId(r.photoId);
    },
    flag: (note: string) => region && apply((p, a, t) => flagTextureRegion(p, shotId, region.id, note, a, t)),
    markReviewed: () => region && apply((p, a, t) => markTextureRegionReviewed(p, shotId, region.id, a, t)),
    exportTextures: () =>
      guard('Exporting…', async () => {
        if (!api.textureExport) throw new Error('Exporting is not available here.');
        const out = await runJob(`Exporting the textures of ${state?.vfxShotId ?? shotId}`, async (jobId) => unwrap(await api.textureExport!({ jobId, text: textRef.current, shotId, projectKey, operator: actor })));
        if (apply((p, a, t) => recordTextureExport(p, shotId, out.record, a, t))) notify('ok', `Textures ${versionTag(out.record.version)} written: ${out.files} files in ${out.folder}`);
      }),
    addTask: () => apply((p, a, t) => addTask(p, shotId, 'texture_extraction', a, t)),
  };

  return {
    props,
    state,
    doc,
    hasTask,
    task,
    locked,
    version,
    supported,
    session,
    sessionError,
    photos,
    photo,
    photoId,
    setPhotoId,
    panorama,
    scanRef,
    regions,
    region,
    regionId,
    setRegionId,
    mode,
    setMode,
    wipe,
    setWipe,
    tool,
    setTool,
    working,
    photoView,
    textureView,
    wipeView,
    panoView,
    scan,
    viewError,
    loading,
    canChange,
    canEdit,
    busy: props.busy || working !== null,
    review,
    summary,
    record,
    lastRun,
    built,
    exported,
    exportCurrent,
    placement,
    planeOfRegion,
    actions,
  };
}
export type TextureController = ReturnType<typeof useTextureController>;

// ---------------------------------------------------------------------------
// Steps (left)
// ---------------------------------------------------------------------------

export interface TextureStepDef {
  id: string;
  title: string;
  hint?: string;
  done: boolean;
  optional?: boolean;
  waiting?: string | null;
  content: ReactNode;
}

const fmt = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const lensText = (r: TextureReference) => {
  const c = r.camera;
  if (!c || (!c.focalMm && !c.distortion)) return 'lens unknown';
  return [c.focalMm ? `${+c.focalMm.toFixed(1)} mm` : null, c.filmBackWidthMm ? `on ${+c.filmBackWidthMm.toFixed(1)} mm` : null, c.distortion ? `k1 ${c.distortion.k1}` : 'no distortion profile'].filter(Boolean).join(' · ');
};

function ReferenceList({ ctl }: { ctl: TextureController }) {
  const refs = ctl.doc?.references ?? [];
  const status = new Map((ctl.session?.references ?? []).map((s) => [s.id, s]));
  if (!refs.length) return <p className="muted key-note">Nothing added yet.</p>;
  return (
    <ul className="key-links tex-refs">
      {refs.map((r) => {
        const st = status.get(r.id);
        const what = r.kind === 'scan' ? `${r.points?.toLocaleString('en') ?? '?'} points · ${r.scan?.units ?? 'm'}, ${(r.scan?.up ?? 'z').toUpperCase()}-up` : `${r.width}×${r.height}${r.kind === 'photo' ? ` · ${lensText(r)}` : ''}`;
        return (
          <li key={r.id} className="key-link tex-ref">
            <span className={`key-link-dot tex-kind-${r.kind}`} aria-hidden="true" />
            <span className="key-link-name" title={`${r.path}${r.checksum ? `\nsha256 ${r.checksum.value}` : ''}`}>
              <strong>{TEXTURE_KIND_LABELS[r.kind]}</strong> {r.name}
              <span className="tex-ref-meta">
                {what}
                {st && !st.onDisk ? <span className="warn-text"> · not on the drive</span> : st?.changed ? <span className="warn-text"> · changed since added</span> : null}
              </span>
            </span>
            <button type="button" className="small danger" aria-label={`Remove ${r.name}`} disabled={!ctl.canChange} onClick={() => ctl.actions.removeReference(r.id)}>
              ✕
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function ReferenceSettings({ ctl }: { ctl: TextureController }) {
  const { photo, panorama, scanRef, canChange, actions } = ctl;
  const [focal, setFocal] = useState('');
  const [back, setBack] = useState('');
  const [k1, setK1] = useState('');
  useEffect(() => {
    setFocal(photo?.camera?.focalMm ? String(photo.camera.focalMm) : '');
    setBack(photo?.camera?.filmBackWidthMm ? String(photo.camera.filmBackWidthMm) : '');
    setK1(photo?.camera?.distortion ? String(photo.camera.distortion.k1) : '');
  }, [photo?.id, photo?.camera]);
  const commitLens = () => {
    if (!photo) return;
    const f = Number(focal);
    const b = Number(back);
    const k = Number(k1);
    actions.setReference(photo.id, { camera: { focalMm: focal && f > 0 ? f : null, filmBackWidthMm: back && b > 0 ? b : null, distortion: k1 !== '' && Number.isFinite(k) ? { k1: k, k2: photo.camera?.distortion?.k2 ?? 0, k3: 0, p1: 0, p2: 0 } : null } });
  };
  return (
    <details className="sub">
      <summary>Lens, colour, scan and panorama</summary>
      {photo ? (
        <div className="tex-form">
          <span className="key-slider-label">{photo.name}</span>
          <div className="key-row tex-fields">
            <label className="key-field">
              <span>Focal (mm)</span>
              <input type="number" aria-label="Focal length (mm)" value={focal} min={1} step={0.1} disabled={!canChange} onChange={(e) => setFocal(e.target.value)} onBlur={commitLens} />
            </label>
            <label className="key-field">
              <span>Film back (mm)</span>
              <input type="number" aria-label="Film back width (mm)" value={back} min={1} step={0.1} disabled={!canChange} onChange={(e) => setBack(e.target.value)} onBlur={commitLens} />
            </label>
            <label className="key-field">
              <span>k1</span>
              <input type="number" aria-label="Lens distortion k1" value={k1} step={0.01} disabled={!canChange} onChange={(e) => setK1(e.target.value)} onBlur={commitLens} />
            </label>
          </div>
          <label className="key-field">
            <span>Read as</span>
            <select className="tex-select" aria-label="Photo colour encoding" value={photo.encoding ?? 'srgb'} disabled={!canChange} onChange={(e) => actions.setReference(photo.id, { encoding: e.target.value as ColorEncodingId })}>
              {COLOR_ENCODINGS.map((c) => (
                <option key={c} value={c}>
                  {ENCODINGS[c].label}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
      {panorama ? (
        <div className="tex-form">
          <span className="key-slider-label">{panorama.name}</span>
          <div className="key-row tex-fields">
            <label className="key-field">
              <span>Heading (°)</span>
              <input
                type="number"
                aria-label="Panorama heading"
                placeholder="auto"
                defaultValue={panorama.panorama?.headingDeg ?? ''}
                key={`${panorama.id}|${panorama.panorama?.headingDeg ?? ''}`}
                disabled={!canChange}
                onBlur={(e) => actions.setReference(panorama.id, { panorama: { headingDeg: e.target.value === '' ? null : Number(e.target.value) } })}
              />
            </label>
            <label className="key-field">
              <span>Read as</span>
              <select className="tex-select" aria-label="Panorama colour encoding" value={panorama.encoding ?? 'linear_rec709'} disabled={!canChange} onChange={(e) => actions.setReference(panorama.id, { encoding: e.target.value as ColorEncodingId })}>
                {COLOR_ENCODINGS.map((c) => (
                  <option key={c} value={c}>
                    {ENCODINGS[c].label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="muted key-note">Heading: which way the panorama’s centre faces in the scan. Empty: worked out from a coloured scan.</p>
        </div>
      ) : null}
      {scanRef?.scan ? (
        <div className="tex-form">
          <span className="key-slider-label">{scanRef.name}</span>
          <div className="key-row tex-fields">
            <label className="key-field">
              <span>Units</span>
              <select className="tex-select" aria-label="Scan units" value={scanRef.scan.units} disabled={!canChange} onChange={(e) => actions.setReference(scanRef.id, { scan: { units: e.target.value as SceneUnit } })}>
                {SCENE_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </label>
            <label className="key-field">
              <span>Up</span>
              <select className="tex-select" aria-label="Scan up axis" value={scanRef.scan.up} disabled={!canChange} onChange={(e) => actions.setReference(scanRef.id, { scan: { up: e.target.value as 'y' | 'z' } })}>
                <option value="z">Z up</option>
                <option value="y">Y up</option>
              </select>
            </label>
          </div>
        </div>
      ) : null}
    </details>
  );
}

function SizeFields({ ctl, region }: { ctl: TextureController; region: TextureRegion }) {
  const [w, setW] = useState(region.size ? String(region.size.width) : '');
  const [h, setH] = useState(region.size ? String(region.size.height) : '');
  const [u, setU] = useState<SceneUnit>(region.size?.units ?? 'm');
  useEffect(() => {
    setW(region.size ? String(region.size.width) : '');
    setH(region.size ? String(region.size.height) : '');
    setU(region.size?.units ?? 'm');
  }, [region.id, region.size]);
  const commit = (units = u) => {
    const ww = Number(w);
    const hh = Number(h);
    if (w === '' && h === '') {
      if (region.size) ctl.actions.updateRegion(region.id, { size: null });
      return;
    }
    if (!(ww > 0 && hh > 0)) return;
    const next: TextureSize = { width: ww, height: hh, units };
    if (JSON.stringify(next) !== JSON.stringify(region.size)) ctl.actions.updateRegion(region.id, { size: next });
  };
  return (
    <div className="key-row tex-fields tex-size">
      <label className="key-field">
        <span>Width</span>
        <input type="number" aria-label="Real width" min={0} step={0.01} value={w} disabled={!ctl.canChange} onChange={(e) => setW(e.target.value)} onBlur={() => commit()} onKeyDown={(e) => e.key === 'Enter' && commit()} />
      </label>
      <span className="tex-times" aria-hidden="true">
        ×
      </span>
      <label className="key-field">
        <span>Height</span>
        <input type="number" aria-label="Real height" min={0} step={0.01} value={h} disabled={!ctl.canChange} onChange={(e) => setH(e.target.value)} onBlur={() => commit()} onKeyDown={(e) => e.key === 'Enter' && commit()} />
      </label>
      <label className="key-field tex-units">
        <span>Units</span>
        <select className="tex-select"
          aria-label="Size units"
          value={u}
          disabled={!ctl.canChange}
          onChange={(e) => {
            setU(e.target.value as SceneUnit);
            commit(e.target.value as SceneUnit);
          }}
        >
          {SCENE_UNITS.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function RegionList({ ctl }: { ctl: TextureController }) {
  const { regions, regionId, setRegionId, setPhotoId, canChange, actions, doc } = ctl;
  if (!regions.length) return <p className="muted key-note">No regions yet.</p>;
  return (
    <ul className="key-links tex-regions">
      {regions.map((r) => {
        const rec = doc?.records.find((x) => x.regionId === r.id);
        const ph = doc?.references.find((x) => x.id === r.photoId);
        return (
          <li key={r.id} className={`key-link tex-region${r.id === regionId ? ' on' : ''}${r.enabled ? '' : ' off'}`}>
            <span className="key-link-dot" style={{ background: rec ? confidenceColour(rec.confidence) : undefined }} aria-hidden="true" />
            <button
              type="button"
              className="link tex-region-name"
              aria-pressed={r.id === regionId}
              onClick={() => {
                setRegionId(r.id);
                setPhotoId(r.photoId);
              }}
            >
              <strong>{r.name}</strong>
              <span className="tex-ref-meta">
                {ph?.name ?? r.photoId}
                {r.size ? ` · ${textureSizeText(r.size)}` : ' · size unknown'}
                {r.settings.tile !== 'none' ? ` · tiles ${r.settings.tile}` : ''}
              </span>
            </button>
            <Check label="On" checked={r.enabled} disabled={!canChange} onChange={(v) => actions.updateRegion(r.id, { enabled: v })} />
            <button type="button" className="small danger" aria-label={`Remove region ${r.name}`} disabled={!canChange} onClick={() => actions.removeRegion(r.id)}>
              ✕
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function textureStepDefs(ctl: TextureController): TextureStepDef[] {
  const { doc, canChange, actions, region, session, busy, photos } = ctl;
  const s = region?.settings ?? DEFAULT_TEXTURE_SETTINGS;
  const hasPhotos = photos.length > 0;
  const hasRegion = Boolean(doc?.regions.some((r) => r.enabled));
  const buildProblem = textureBuildProblem(doc);
  const handoffKinds = (k: TextureReferenceKind) => (session?.handoff ?? []).filter((h) => h.kind === k && h.onDisk && !(doc?.references ?? []).some((r) => r.from === 'handoff' && r.path === h.path));
  const sample = Boolean(session?.sample);
  const sampleDone = sample && photos.length > 0 && ctl.panorama !== null && ctl.scanRef !== null;
  const sampleRegionsDone = sample && (session?.sampleRegions ?? []).every((x) => doc?.regions.some((r) => r.name === x.name));
  const regionSettings = (change: TextureRegionChange['settings']) => region && actions.updateRegion(region.id, { settings: change });
  const lensKnown = Boolean(ctl.doc?.references.find((r) => r.id === region?.photoId)?.camera?.distortion);
  const planes = doc?.planes ?? [];
  const p = ctl.placement;
  const suggestion = p?.suggested ?? null;
  const holds = ctl.photo ? texturePlacementOf(doc, ctl.photo.id) : null;
  return [
    {
      id: 'refs',
      title: 'Add references',
      hint: 'High-resolution photos of the surfaces; the 360° panorama and the LiDAR scan if you have them. Read only.',
      done: hasPhotos,
      content: (
        <>
          {sample && !sampleDone ? (
            <div className="action">
              <button type="button" className="primary big key-wrap" disabled={!canChange || busy} onClick={() => actions.useSample()} title="The sample shot comes with stills, a panorama and a scan of a synthetic storeroom">
                Use the sample set (3 photos, a 360°, a scan)
              </button>
            </div>
          ) : null}
          {session?.fromDisk ? (
            <div className="key-row tex-add">
              <button type="button" disabled={!canChange || busy} onClick={() => actions.addFromDisk('photo')}>
                Photos…
              </button>
              <button type="button" disabled={!canChange || busy || Boolean(ctl.panorama)} onClick={() => actions.addFromDisk('panorama')}>
                Panorama…
              </button>
              <button type="button" disabled={!canChange || busy || Boolean(ctl.scanRef)} onClick={() => actions.addFromDisk('scan')}>
                Scan…
              </button>
            </div>
          ) : null}
          {(['photo', 'panorama', 'scan'] as const).some((k) => handoffKinds(k).length) ? (
            <div className="key-row tex-add">
              {(['photo', 'panorama', 'scan'] as const)
                .filter((k) => handoffKinds(k).length)
                .map((k) => (
                  <button key={k} type="button" disabled={!canChange || busy} onClick={() => actions.addFromHandoff(k)} title={handoffKinds(k).map((h) => h.path).join('\n')}>
                    {k === 'photo' ? `${handoffKinds(k).length} photo${handoffKinds(k).length === 1 ? '' : 's'}` : TEXTURE_KIND_LABELS[k]} from the handoff
                  </button>
                ))}
            </div>
          ) : null}
          <ReferenceList ctl={ctl} />
          {doc?.references.length ? <ReferenceSettings ctl={ctl} /> : null}
        </>
      ),
    },
    {
      id: 'region',
      title: 'Mark a region',
      hint: 'Drag a box on the photo, then drag its four corners onto the surface’s corners. Give its real size if you know it.',
      done: hasRegion,
      waiting: hasPhotos ? null : 'Add the photos first (step 1).',
      content: (
        <>
          {sample && !sampleRegionsDone ? (
            <div className="action">
              <button type="button" className="primary big key-wrap" disabled={!canChange || busy} onClick={() => actions.markSampleRegions()}>
                Mark the sample’s three regions
              </button>
            </div>
          ) : null}
          <div className="key-row">
            <button type="button" className={ctl.tool === 'region' ? 'on key-tool key-wrap' : 'key-tool key-wrap'} aria-pressed={ctl.tool === 'region'} disabled={!canChange || !ctl.photo} onClick={() => ctl.setTool(ctl.tool === 'region' ? null : 'region')}>
              Drag a new region on {ctl.photo?.name ?? 'the photo'}
            </button>
          </div>
          <RegionList ctl={ctl} />
          {region ? (
            <div className="tex-form">
              <label className="key-field">
                <span>Name</span>
                <input aria-label="Region name" defaultValue={region.name} key={`${region.id}|${region.name}`} disabled={!canChange} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== region.name && actions.updateRegion(region.id, { name: e.target.value })} />
              </label>
              <span className="key-slider-label">Real size (top edge × left edge)</span>
              <SizeFields ctl={ctl} region={region} />
              {!region.size ? <p className="muted key-note">Without a size the aspect comes from the lens or the corners, and the placement on the scan is only rough.</p> : null}
            </div>
          ) : null}
        </>
      ),
    },
    {
      id: 'correct',
      title: 'Correct and build',
      hint: 'Undistort, square it up, flatten the light; regions of one surface get one exposure.',
      done: ctl.built,
      waiting: buildProblem,
      content: (
        <>
          {region ? (
            <>
              <span className="key-slider-label cp-label">{region.name}</span>
              <Check label={lensKnown ? 'Take out the lens distortion' : 'Take out the lens distortion (no profile)'} checked={s.undistort && lensKnown} disabled={!canChange || !lensKnown} onChange={(v) => regionSettings({ undistort: v })} hint="Needs the photo’s lens: from its EXIF and a lens profile, or entered in step 1" />
              <Check label="Square it up (rectify)" checked={s.rectify} disabled={!canChange} onChange={(v) => regionSettings({ rectify: v })} />
              <Slider label="Flatten the light" value={s.delight} min={0} max={1} step={0.05} disabled={!canChange} hint="How much of the light falloff and shading across the surface is divided out" onCommit={(v) => regionSettings({ delight: v })} />
              <Slider label="Shading scale" value={s.delightRadius} min={0.05} max={1} step={0.05} disabled={!canChange} hint="Smaller takes out more local shading (and more of the surface’s own large-scale colour)" onCommit={(v) => regionSettings({ delightRadius: v })} />
              <Check label="One exposure across the surface" checked={s.exposureMatch} disabled={!canChange} onChange={(v) => regionSettings({ exposureMatch: v })} hint="Regions on the same scan plane are brought to one brightness" />
              <Seg
                label="Output size"
                value={s.output.mode}
                options={[['resolution', 'Resolution'], ['density', 'Texel density', !region.size]] as const}
                disabled={!canChange}
                onChange={(m) => regionSettings({ output: { mode: m } })}
              />
              {s.output.mode === 'resolution' ? (
                <Slider label="Long edge" value={s.output.resolution} min={256} max={8192} step={256} unit=" px" disabled={!canChange} onCommit={(v) => regionSettings({ output: { resolution: v } })} />
              ) : (
                <Slider label="Texels per metre" value={s.output.density} min={50} max={4000} step={50} unit=" px/m" disabled={!canChange} onCommit={(v) => regionSettings({ output: { density: v } })} />
              )}
            </>
          ) : null}
          <div className="action">
            <button type="button" className="primary big" disabled={!canChange || busy || !ctl.props.api.textureBuild || Boolean(buildProblem)} onClick={() => void actions.build()}>
              {ctl.built ? 'Build again' : ctl.lastRun ? 'Build again (settings changed)' : 'Build textures'}
            </button>
          </div>
          {ctl.lastRun ? (
            <p className="key-note">
              {ctl.lastRun.regions} texture{ctl.lastRun.regions === 1 ? '' : 's'} · confidence {fmt(ctl.lastRun.meanConfidence)} · {ctl.lastRun.planes} scan planes{ctl.built ? '' : ' · settings changed since: build again'}
            </p>
          ) : (
            <p className="muted key-note">Nothing is written until you export.</p>
          )}
        </>
      ),
    },
    {
      id: 'seamless',
      title: 'Make seamless',
      hint: 'Overlap the ends and cut the join where they agree: a tile that repeats without a seam.',
      done: Boolean(ctl.built && region && region.settings.tile !== 'none'),
      optional: true,
      waiting: hasRegion ? null : 'Mark a region first (step 2).',
      content: region ? (
        <>
          <Seg label="Tile" value={s.tile} options={[['none', 'No'], ['x', 'Across'], ['xy', 'Across and down']] as const} disabled={!canChange} onChange={(t) => regionSettings({ tile: t })} />
          <Slider label="Overlap" value={s.tileOverlap} min={0.05} max={0.45} step={0.05} disabled={!canChange || s.tile === 'none'} hint="How much of the texture overlaps itself: more gives the cut more room" onCommit={(v) => regionSettings({ tileOverlap: v })} />
          {ctl.record?.metrics.seamScore !== null && ctl.record?.metrics.seamScore !== undefined && s.tile !== 'none' ? (
            <p className={ctl.record.metrics.seamScore > TEXTURE_MAX_SEAM ? 'warn-text' : 'key-note'}>
              Seams {fmt(ctl.record.metrics.seamScore)}× the texture’s own steps {ctl.record.metrics.seamScore > TEXTURE_MAX_SEAM ? '— they show: more overlap, or flatten the light more' : '— they do not show'}.
            </p>
          ) : null}
          {s.tile !== 'none' && ctl.lastRun && !ctl.built ? (
            <button type="button" disabled={!canChange || busy} onClick={() => void actions.build()}>
              Build again to see the tile
            </button>
          ) : null}
        </>
      ) : (
        <p className="muted key-note">Choose a region in step 2.</p>
      ),
    },
    {
      id: 'placement',
      title: 'Placement on the scan',
      hint: 'Where each photo belongs, found in the panorama projected onto the scan. Accept it, reject it or put it elsewhere.',
      done: Boolean(ctl.lastRun) && ctl.review.pendingPlacements.length === 0 && ctl.review.problems.length === 0,
      waiting: ctl.lastRun ? null : 'Build first (step 3).',
      content: (
        <>
          {!ctl.panorama || !ctl.scanRef ? <p className="muted key-note">Placement needs the panorama and the scan (step 1); without them, put regions on planes by hand once a scan is in.</p> : null}
          {ctl.photo ? (
            <div className="tex-placement">
              <span className="key-slider-label cp-label">{ctl.photo.name}</span>
              {suggestion ? (
                <p className="key-note">
                  {suggestion.planeId ? `On ${planes.find((x) => x.id === suggestion.planeId)?.label ?? suggestion.planeId}` : 'No surface found'} · yaw {fmt(suggestion.direction.yawDeg, 1)}°, pitch {fmt(suggestion.direction.pitchDeg, 1)}° · confidence {fmt(suggestion.confidence)}
                  <span className="tex-decision"> · {p?.decision === 'pending' ? 'not decided' : p?.decision}</span>
                </p>
              ) : (
                <p className="muted key-note">No suggestion for this photo.</p>
              )}
              <div className="key-row">
                <button type="button" disabled={!canChange || !suggestion || p?.decision === 'accepted'} onClick={() => actions.decide({ decision: 'accepted' })}>
                  Accept
                </button>
                <button type="button" disabled={!canChange || !suggestion || p?.decision === 'rejected'} onClick={() => actions.decide({ decision: 'rejected' })}>
                  Reject
                </button>
                {p && p.decision !== 'pending' ? (
                  <button type="button" disabled={!canChange} onClick={() => actions.decide({ decision: 'pending' })}>
                    Undo
                  </button>
                ) : null}
              </div>
              {planes.length ? (
                <label className="key-field">
                  <span>Put {ctl.photo.name} on</span>
                  <select className="tex-select"
                    aria-label="Put the photo on a plane"
                    value={p?.decision === 'edited' ? (p.edited?.planeId ?? '') : ''}
                    disabled={!canChange}
                    onChange={(e) => {
                      const dir = holds?.direction ?? suggestion?.direction ?? { yawDeg: 0, pitchDeg: 0, rollDeg: 0, fovDeg: 60 };
                      if (e.target.value) actions.decide({ decision: 'edited', direction: dir, planeId: e.target.value });
                      else actions.decide({ decision: 'pending' });
                    }}
                  >
                    <option value="">The suggestion</option>
                    {planes.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
          ) : null}
          {region && planes.length ? (
            <label className="key-field">
              <span>{region.name} goes on</span>
              <select className="tex-select" aria-label="Region plane" value={region.target.planeId ?? ''} disabled={!canChange} onChange={(e) => actions.updateRegion(region.id, { planeId: e.target.value || null })}>
                <option value="">{ctl.planeOfRegion && !region.target.planeId ? `Suggested: ${ctl.planeOfRegion.label}` : 'The suggestion'}</option>
                {planes.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="key-row">
            <button type="button" disabled={!ctl.review.problems.length} onClick={() => actions.nextProblem()}>
              Next problem ▸
            </button>
            <button type="button" disabled={!canChange || !ctl.record} onClick={() => actions.markReviewed()}>
              Looks right
            </button>
            <button type="button" disabled={!canChange || !ctl.record} onClick={() => actions.flag(ctl.record?.status === 'flagged' ? '' : 'needs a better photo')}>
              {ctl.record?.status === 'flagged' ? 'Unflag' : 'Flag'}
            </button>
          </div>
        </>
      ),
    },
    {
      id: 'export',
      title: `Export textures ${versionTag(ctl.version)}`,
      hint: 'Texture maps (16-bit PNG and half-float EXR), masks, the mapping file and an OBJ of the patches into 07_TEXTURES_REFERENCES. Approve in Details.',
      done: ctl.exportCurrent,
      waiting: !ctl.built ? 'Build with the current settings first (step 3).' : null,
      content: (
        <>
          <p className="key-note">
            {doc?.regions.filter((r) => r.enabled).length ?? 0} region{doc?.regions.filter((r) => r.enabled).length === 1 ? '' : 's'}, made again at full size from the photos{ctl.scanRef ? ', with the planar patches as OBJ + MTL' : ''}.
          </p>
          <div className="action">
            <button type="button" className="primary big" disabled={!canChange || busy || !session?.exportable} title={session && !session.exportable ? 'Exporting is the desktop app’s' : undefined} onClick={() => void actions.exportTextures()}>
              Export textures {versionTag(ctl.version)}
            </button>
          </div>
          {session && !session.exportable ? <p className="muted key-note">Exporting writes into the shot package on disk: the desktop app does it.</p> : null}
          {ctl.exported ? (
            <p className="key-note">
              Written {ctl.exported.regions.length} texture{ctl.exported.regions.length === 1 ? '' : 's'} to {ctl.exported.folder}
              {ctl.exportCurrent ? '' : ' — settings changed since; export again'}.
            </p>
          ) : null}
        </>
      ),
    },
  ];
}

// ---------------------------------------------------------------------------
// The viewer (centre)
// ---------------------------------------------------------------------------

/** The RGBA picture of an 8-bit view, a second one wiped in on the left; tiled n × n. */
export function composeTexture(view: TextureImageView, o: { wipe?: { x: number; other: TextureImageView } | null; tile?: number; dimOutside?: boolean } = {}): { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> } {
  const n = Math.max(1, o.tile ?? 1);
  const W = view.width * n;
  const H = view.height * n;
  const out = new Uint8ClampedArray(W * H * 4);
  const split = o.wipe && o.wipe.other.width === view.width && o.wipe.other.height === view.height ? Math.round(o.wipe.x * W) : -1;
  for (let y = 0; y < H; y += 1)
    for (let x = 0; x < W; x += 1) {
      const sx = x % view.width;
      const sy = y % view.height;
      const i = sy * view.width + sx;
      const src = split >= 0 && x < split ? o.wipe!.other.rgb : view.rgb;
      const d = 4 * (y * W + x);
      let k = 1;
      if (o.dimOutside && view.mask && view.mask[i]! < 128) k = 0.35;
      out[d] = src[3 * i]! * k;
      out[d + 1] = src[3 * i + 1]! * k;
      out[d + 2] = src[3 * i + 2]! * k;
      out[d + 3] = 255;
    }
  return { width: W, height: H, data: out };
}

type Drag = { kind: 'new'; x0: number; y0: number; x1: number; y1: number } | { kind: 'corner'; index: number; corners: Corners } | null;

function PhotoStrip({ ctl }: { ctl: TextureController }) {
  const { photos, photoId, setPhotoId, regions, doc } = ctl;
  if (!photos.length) return null;
  return (
    <div className="tex-strip" role="listbox" aria-label="Photos">
      {photos.map((p) => {
        const own = regions.filter((r) => r.photoId === p.id);
        const placement = doc?.placements.find((x) => x.photoId === p.id);
        return (
          <button key={p.id} type="button" role="option" aria-selected={p.id === photoId} className={`tex-chip${p.id === photoId ? ' on' : ''}`} onClick={() => setPhotoId(p.id)} title={p.path}>
            <span className="tex-chip-name">{p.name}</span>
            <span className="tex-chip-meta">
              {own.length} region{own.length === 1 ? '' : 's'}
              {placement?.decision && placement.decision !== 'pending' ? ` · ${placement.decision}` : placement?.suggested ? ' · suggestion' : ''}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function TextureViewer({ ctl }: { ctl: TextureController }) {
  const { mode, setMode, wipe, setWipe, tool, setTool, photoView, textureView, wipeView, panoView, photo, region, regions, doc } = ctl;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const shown: TextureImageView | null = mode === 'photo' ? photoView : mode === 'panorama' ? panoView : mode === 'scan' ? null : textureView;
  const tile = mode === 'tiled' && textureView ? 3 : 1;

  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !shown) return;
    const pic = composeTexture(shown, { tile, wipe: wipe.on && mode === 'delit' && wipeView ? { x: wipe.x, other: wipeView } : null, dimOutside: mode !== 'photo' && mode !== 'panorama' });
    c.width = pic.width;
    c.height = pic.height;
    const g = c.getContext('2d');
    if (!g) return;
    g.putImageData(new ImageData(pic.data, pic.width, pic.height), 0, 0);
  }, [shown, wipe, wipeView, mode, tile]);

  const vw = shown ? shown.width * tile : 1;
  const vh = shown ? shown.height * tile : 1;
  const toView = (e: ReactPointerEvent): { x: number; y: number } | null => {
    const el = stageRef.current;
    if (!el || !shown) return null;
    const rect = el.getBoundingClientRect();
    const s = Math.min(rect.width / vw, rect.height / vh) || 1;
    const ox = (rect.width - vw * s) / 2;
    const oy = (rect.height - vh * s) / 2;
    return { x: (e.clientX - rect.left - ox) / s, y: (e.clientY - rect.top - oy) / s, s } as { x: number; y: number };
  };
  // Photo pixels per view pixel.
  const k = photo && photoView ? photo.width! / photoView.width : 1;
  const own = regions.filter((r) => r.photoId === photo?.id);
  const cornersOf = (r: TextureRegion): Corners => (drag?.kind === 'corner' && r.id === region?.id ? drag.corners : r.corners);

  const onDown = (e: ReactPointerEvent) => {
    const v = toView(e);
    if (!v) return;
    if (mode === 'photo' && photoView) {
      if (tool === 'region') {
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
        setDrag({ kind: 'new', x0: v.x, y0: v.y, x1: v.x, y1: v.y });
        return;
      }
      // A corner of the selected region, within a few screen pixels.
      if (region && region.photoId === photo?.id && ctl.canChange) {
        const el = stageRef.current!.getBoundingClientRect();
        const s = Math.min(el.width / vw, el.height / vh) || 1;
        const hit = region.corners.findIndex(([x, y]) => Math.hypot(x / k - v.x, y / k - v.y) * s < 14);
        if (hit >= 0) {
          (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
          setDrag({ kind: 'corner', index: hit, corners: region.corners.map((c) => [c[0], c[1]]) as unknown as Corners });
          return;
        }
      }
      // Clicking inside another region selects it.
      const inside = own.find((r) => pointIn(r.corners.map(([x, y]) => [x / k, y / k] as [number, number]), v.x, v.y));
      if (inside) ctl.setRegionId(inside.id);
      return;
    }
    if (wipe.on && mode === 'delit') setWipe({ on: true, x: Math.max(0, Math.min(1, v.x / vw)) });
  };
  const onMove = (e: ReactPointerEvent) => {
    const v = toView(e);
    if (!v) return;
    if (drag?.kind === 'new') setDrag({ ...drag, x1: v.x, y1: v.y });
    else if (drag?.kind === 'corner') {
      const next = drag.corners.map((c, i) => (i === drag.index ? [Math.round(v.x * k * 10) / 10, Math.round(v.y * k * 10) / 10] : c)) as unknown as Corners;
      setDrag({ ...drag, corners: next });
    } else if (wipe.on && mode === 'delit' && e.buttons === 1) setWipe({ on: true, x: Math.max(0, Math.min(1, v.x / vw)) });
  };
  const onUp = () => {
    if (!drag) return;
    if (drag.kind === 'new') {
      const x0 = Math.min(drag.x0, drag.x1) * k;
      const x1 = Math.max(drag.x0, drag.x1) * k;
      const y0 = Math.min(drag.y0, drag.y1) * k;
      const y1 = Math.max(drag.y0, drag.y1) * k;
      setDrag(null);
      setTool(null);
      if (x1 - x0 < 8 || y1 - y0 < 8) return;
      ctl.actions.addRegion([
        [Math.round(x0), Math.round(y0)],
        [Math.round(x1), Math.round(y0)],
        [Math.round(x1), Math.round(y1)],
        [Math.round(x0), Math.round(y1)],
      ]);
      return;
    }
    const corners = drag.corners;
    setDrag(null);
    if (region && JSON.stringify(corners) !== JSON.stringify(region.corners)) ctl.actions.updateRegion(region.id, { corners });
  };

  const placements = doc?.placements ?? [];
  const message =
    ctl.sessionError ??
    (ctl.session && !ctl.session.available ? ctl.session.reason : null) ??
    (mode === 'photo' && !photo ? 'Add the reference photos (step 1).' : null) ??
    (mode === 'panorama' && !ctl.panorama ? 'Add the 360° panorama (step 1) to see it here.' : null) ??
    (mode === 'scan' && !ctl.scanRef ? 'Add the LiDAR scan (step 1) to see it here.' : null) ??
    ((mode === 'rectified' || mode === 'delit' || mode === 'tiled') && !region ? 'Mark a region (step 2).' : null) ??
    ((mode === 'rectified' || mode === 'delit' || mode === 'tiled') && !ctl.lastRun ? 'Build the textures (step 3) to see them here.' : null) ??
    (shown || mode === 'scan' ? null : ctl.viewError);
  const cursorClass = tool === 'region' && mode === 'photo' ? 'tool-box' : wipe.on && mode === 'delit' ? 'tool-wipe' : '';
  const stale = textureView?.built === 'stale' && (mode === 'rectified' || mode === 'delit' || mode === 'tiled');

  return (
    <div className="key-viewer tex-viewer" aria-label={`Texture viewer — ${ctl.state?.vfxShotId ?? ctl.props.shotId}`} role="region">
      <div className="key-viewer-bar">
        <div className="seg key-modes" role="tablist" aria-label="View">
          {TEXTURE_VIEWS.map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} className={mode === m ? 'on' : undefined} onClick={() => setMode(m)}>
              {TEXTURE_VIEW_LABELS[m]}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button type="button" className={wipe.on ? 'on' : undefined} aria-pressed={wipe.on} disabled={mode !== 'delit'} onClick={() => setWipe({ ...wipe, on: !wipe.on })} title="A/B wipe: the rectified original on the left, delit on the right; drag to move">
          A/B wipe
        </button>
      </div>
      {mode === 'scan' && ctl.scan ? (
        <div className="key-stage tex-scan">
          <ScanView ctl={ctl} />
          {ctl.scan.built === 'none' ? <div className="key-hint">The scan as read. Build (step 3) to find its planes and place the regions.</div> : null}
        </div>
      ) : (
        <div ref={stageRef} className={`key-stage ${cursorClass}`} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
          {shown ? <canvas ref={canvasRef} className="key-canvas" aria-label={`${TEXTURE_VIEW_LABELS[mode]}${mode === 'photo' ? ` of ${photo?.name ?? ''}` : region ? ` of ${region.name}` : ''}`} /> : null}
          {shown && mode === 'photo' ? (
            <svg className="key-overlay" viewBox={`0 0 ${vw} ${vh}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
              {own.map((r) => {
                const c = cornersOf(r);
                const on = r.id === region?.id;
                return (
                  <g key={r.id} className={`tex-quad${on ? ' on' : ''}${r.enabled ? '' : ' off'}`}>
                    <polygon points={c.map(([x, y]) => `${x / k},${y / k}`).join(' ')} />
                    {on ? c.map(([x, y], i) => <circle key={i} cx={x / k} cy={y / k} r={Math.max(3, vw / 160)} className="tex-handle" />) : null}
                    <text x={c[0][0] / k + 4} y={c[0][1] / k - vw / 160} className="tex-quad-label" style={{ fontSize: Math.max(12, vw / 52) }}>
                      {r.name}
                    </text>
                  </g>
                );
              })}
              {drag?.kind === 'new' ? <rect className="key-box drawing" x={Math.min(drag.x0, drag.x1)} y={Math.min(drag.y0, drag.y1)} width={Math.abs(drag.x1 - drag.x0)} height={Math.abs(drag.y1 - drag.y0)} /> : null}
            </svg>
          ) : null}
          {shown && mode === 'panorama' ? (
            <svg className="key-overlay" viewBox={`0 0 ${vw} ${vh}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
              {placements.map((x) => {
                const dir = x.decision === 'edited' ? x.edited?.direction : x.suggested?.direction;
                if (!dir || x.decision === 'rejected') return null;
                const u = (dir.yawDeg / 360 + 0.5) * vw;
                const v = (0.5 - dir.pitchDeg / 180) * vh;
                const name = doc?.references.find((r) => r.id === x.photoId)?.name ?? x.photoId;
                const on = x.photoId === photo?.id;
                return (
                  <g key={x.photoId} className={`tex-pin${on ? ' on' : ''}${x.decision === 'accepted' || x.decision === 'edited' ? ' decided' : ''}`}>
                    <circle cx={u} cy={v} r={vw / 120} />
                    <text x={u + vw / 90} y={v + vw / 200} style={{ fontSize: Math.max(12, vw / 62) }}>
                      {name}
                    </text>
                  </g>
                );
              })}
            </svg>
          ) : null}
          {wipe.on && mode === 'delit' && shown ? (
            <svg className="key-overlay" viewBox={`0 0 ${vw} ${vh}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
              <line className="key-wipe" x1={wipe.x * vw} x2={wipe.x * vw} y1={0} y2={vh} />
            </svg>
          ) : null}
          {message ? <div className="key-message">{message}</div> : null}
          {ctl.loading && !message ? <div className="key-busy" aria-live="polite">Loading…</div> : null}
          {stale ? <div className="key-hint cp-stale">Settings changed since this was built: build again (step 3).</div> : null}
          {mode === 'tiled' && region?.settings.tile === 'none' && shown ? <div className="key-hint">Not made to tile: this is the texture repeated as it is (step 4 makes it seamless).</div> : null}
          {tool === 'region' && mode === 'photo' ? <div className="key-hint">Drag a box round the surface; then drag its corners onto the surface’s corners.</div> : null}
          {mode === 'photo' && region && region.photoId === photo?.id && !tool && ctl.canChange ? <div className="key-hint tex-hint-corners">Drag a corner to move it.</div> : null}
        </div>
      )}
      <PhotoStrip ctl={ctl} />
      {shown ? (
        <p className="key-view-label muted">
          {shown.label}
          {mode !== 'photo' && mode !== 'panorama' && shown ? ` · ${shown.width}×${shown.height} shown` : ''}
        </p>
      ) : null}
    </div>
  );
}

function pointIn(q: readonly (readonly [number, number])[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const [xi, yi] = q[i]!;
    const [xj, yj] = q[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function ScanView({ ctl }: { ctl: TextureController }) {
  const scan = ctl.scan!;
  const plane = ctl.planeOfRegion;
  const layers = useMemo((): CloudLayer[] => {
    const n = scan.positions.length / 3;
    const idx = plane ? scan.planeIds.indexOf(plane.id) + 1 : 0;
    const dim = new Uint8Array(n * 3);
    const hiPos: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const c = scan.colors;
      for (let j = 0; j < 3; j += 1) dim[3 * i + j] = c ? Math.round(c[3 * i + j]! * 0.75) : 150;
      if (idx && scan.planeOf && scan.planeOf[i] === idx) hiPos.push(scan.positions[3 * i]!, scan.positions[3 * i + 1]!, scan.positions[3 * i + 2]!);
    }
    const out: CloudLayer[] = [{ id: 'scan', positions: scan.positions, colors: dim, pickable: false, size: 2 }];
    if (hiPos.length) out.push({ id: 'plane', positions: Float32Array.from(hiPos), colors: Uint8Array.from({ length: hiPos.length }, (_, i) => [255, 176, 64][i % 3]!), pickable: false, size: 3 });
    return out;
  }, [scan, plane]);
  const marks = useMemo(() => {
    const m: { position: number[]; color: [number, number, number]; label: string }[] = [];
    if (scan.panorama) m.push({ position: scan.panorama, color: [1, 1, 1], label: 'Panorama' });
    for (const p of scan.patches) {
      const r = ctl.regions.find((x) => x.id === p.regionId);
      const on = p.regionId === ctl.regionId;
      const c = [0, 1, 2].map((k) => p.corners.reduce((a, q) => a + q[k]!, 0) / 4);
      m.push({ position: c, color: on ? [1, 0.69, 0.25] : [0.35, 0.67, 1], label: r?.name ?? p.regionId });
      if (on) for (const q of p.corners) m.push({ position: q, color: [1, 0.69, 0.25], label: '' });
    }
    return m;
  }, [scan, ctl.regions, ctl.regionId]);
  const legend = [
    ...(scan.panorama ? [{ color: '#fff', label: 'where the panorama was' }] : []),
    ...(plane ? [{ color: '#ffb040', label: `${plane.label} (${ctl.region?.name ?? 'the region'}’s plane)` }] : []),
    ...(scan.patches.length ? [{ color: '#5aabff', label: `${scan.patches.length} region patch${scan.patches.length === 1 ? '' : 'es'}` }] : []),
  ];
  return <PointCloudView clouds={layers} tracks={null} cameras={[]} currentFrame={0} fovDeg={60} aspect={1.5} marks={marks} legend={legend} frameKey={`${ctl.props.shotId}|${scan.positions.length}`} />;
}

// ---------------------------------------------------------------------------
// The numbers (right)
// ---------------------------------------------------------------------------

export function TextureInfo({ ctl }: { ctl: TextureController }) {
  const { doc, summary, review, task, version, record, region, session, placement } = ctl;
  const has = summary.built > 0;
  const m = record?.metrics ?? null;
  const up = m ? textureUpsample(m) : null;
  const plane = ctl.planeOfRegion;
  return (
    <div className="key-info tex-info">
      <div className="stats">
        <Big label="Regions built" value={has ? `${summary.built}` : '—'} unit={has ? ` / ${summary.regions}` : undefined} tone={has ? (ctl.built ? 'ok' : 'warn') : undefined} title={ctl.built ? undefined : has ? 'Settings changed since the build' : undefined} />
        <Big label="Texel density" value={summary.texelDensity !== null ? Math.round(summary.texelDensity) : '—'} unit={summary.texelDensity !== null ? ' px/m' : undefined} title="Median texels per metre over the regions with a real size" />
        <Big label="Seam score" value={summary.seamScore !== null ? fmt(summary.seamScore) : '—'} tone={summary.seamScore !== null ? (summary.seamScore <= TEXTURE_MAX_SEAM ? 'ok' : 'warn') : undefined} title="Worst tile seam: the step across it against the texture’s own steps (1 = invisible)" />
        <Big label="Light left" value={has ? fmt(summary.residual) : '—'} unit={has ? ' stops' : undefined} tone={has ? (summary.residual <= TEXTURE_MAX_RESIDUAL ? 'ok' : 'warn') : undefined} title="Worst large-scale light variation left after delighting" />
        <Big label="Placement" value={summary.placement !== null ? Math.round(summary.placement * 100) : '—'} unit={summary.placement !== null ? '%' : undefined} tone={summary.placement !== null ? (summary.placement >= 0.6 ? 'ok' : 'warn') : undefined} title="Mean confidence of the placements that hold" />
        <Big label="Problems" value={has ? review.problems.length : '—'} tone={has ? (review.problems.length ? 'warn' : 'ok') : undefined} />
      </div>
      {region ? (
        <section className="info-section">
          <h4>{region.name}</h4>
          {m ? (
            <dl className="key-kv">
              <dt>Texture</dt>
              <dd>
                {m.width}×{m.height}
                {m.texelDensity !== null ? ` · ${Math.round(m.texelDensity)} px/m` : ''}
              </dd>
              <dt>In the photo</dt>
              <dd>{m.nativeDensity !== null ? `${Math.round(m.nativeDensity)} px/m${up !== null && up > 1 ? ` (upsampled ×${up.toFixed(1)})` : ''}` : 'size unknown'}</dd>
              <dt>Light</dt>
              <dd>
                {fmt(m.residualBefore)} → {fmt(m.residualAfter)} stops · detail kept {Math.round(m.detailKept * 100)} %
              </dd>
              <dt>Seams</dt>
              <dd>{m.seamScore !== null ? `${fmt(m.seamScore)}×` : 'not tiled'}</dd>
              <dt>Photo</dt>
              <dd>
                sharpness {fmt(m.sharpness)} · clipped {(m.clipped * 100).toFixed(1)} % · glints {(m.specular * 100).toFixed(1)} %
              </dd>
              <dt>Exposure</dt>
              <dd>×{fmt(m.exposureGain)} · aspect {fmt(m.aspect)} from the {m.aspectFrom}</dd>
              <dt>Surface</dt>
              <dd>{plane ? `${plane.label}${region.target.planeId ? ' (yours)' : ` · ${Math.round(m.planeConfidence * 100)} %`}` : 'none'}</dd>
              <dt>Confidence</dt>
              <dd className={record!.confidence < TEXTURE_LOW_CONFIDENCE ? 'warn-text' : undefined}>{fmt(record!.confidence)}</dd>
            </dl>
          ) : (
            <p className="muted key-note">{region.size ? textureSizeText(region.size) : 'Real size unknown'} · not built yet.</p>
          )}
          {record?.reason ? <p className="warn-text">Problem: {record.reason}</p> : null}
        </section>
      ) : null}
      {placement?.suggested ? (
        <section className="info-section">
          <h4>Placement of {ctl.photo?.name}</h4>
          <p className="info-line">{placement.suggested.note}</p>
          <p className="info-line">
            {placement.decision === 'pending' ? 'Not decided yet.' : `${placement.decision[0]!.toUpperCase()}${placement.decision.slice(1)}${placement.by ? ` by ${placement.by}` : ''}.`}
          </p>
        </section>
      ) : null}
      <section className="info-section">
        <h4>Version</h4>
        <dl className="key-kv">
          <dt>Textures</dt>
          <dd>
            {versionTag(version)} · {task ? TASK_STATE_LABELS[task.state] : 'no task'}
            {task?.approval ? ` · approved by ${task.approval.by}` : ''}
          </dd>
          <dt>Exported</dt>
          <dd>{ctl.exported ? `${ctl.exported.regions.length} textures, ${ctl.exported.format.toUpperCase()} + PNG` : 'not yet'}</dd>
          <dt>Settings</dt>
          <dd>
            revision {doc?.revision ?? 0}
            {ctl.lastRun && !ctl.built ? ' (changed since the build)' : ''}
          </dd>
          <dt>Built in</dt>
          <dd>{session?.working.label || '—'}</dd>
        </dl>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The steps as a list (for tests and a standalone workspace)
// ---------------------------------------------------------------------------

export function TextureWorkspace(props: TextureWorkspaceProps) {
  const ctl = useTextureController(props);
  const steps = textureStepDefs(ctl);
  const current = steps.find((s) => !s.done && !s.optional)?.id ?? null;
  const [open, setOpen] = useState<Set<string>>(() => new Set(steps.map((s) => s.id)));
  if (!ctl.supported) return <div className="key-missing">Texture extraction is not available in this build.</div>;
  return (
    <div className="key-workspace">
      <aside className="key-zone key-zone-steps" aria-label="Steps">
        <ol className="steps key-steps" aria-label="Texture steps">
          {steps.map((s, i) => (
            <li key={s.id} className={`step step-${s.done ? 'done' : s.id === current ? 'current' : 'todo'}${open.has(s.id) ? ' open' : ''}`} data-step={s.id}>
              <button type="button" className="step-head" aria-expanded={open.has(s.id)} onClick={() => setOpen((o) => (o.has(s.id) ? new Set([...o].filter((x) => x !== s.id)) : new Set([...o, s.id])))}>
                <span className="step-num" aria-hidden="true">
                  {s.done ? '✓' : i + 1}
                </span>
                <span className="step-title">
                  <span>{s.title}</span>
                  {s.hint ? <span className="step-hint">{s.hint}</span> : null}
                </span>
              </button>
              {open.has(s.id) ? <div className="step-body">{s.waiting ? <p className="step-waiting">{s.waiting}</p> : s.content}</div> : null}
            </li>
          ))}
        </ol>
      </aside>
      <section className="key-zone key-zone-centre" aria-label="Viewer">
        <TextureViewer ctl={ctl} />
      </section>
      <aside className="key-zone key-zone-info" aria-label="Details">
        <TextureInfo ctl={ctl} />
      </aside>
    </div>
  );
}
