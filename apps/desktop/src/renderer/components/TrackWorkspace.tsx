import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import {
  CAMERA_DB,
  CAMERA_EXPORT_FORMATS,
  SCENE_UNITS,
  TRACK2D_EXPORT_FORMATS,
  activeSolve,
  camtrackLocked,
  camtrackTaskVersion,
  handoffShot,
  newCamTrackDocument,
  serializeProject,
  shotState,
  track2dLocked,
  track2dTaskVersion,
  versionTag,
  type CamTrackDocument,
  type CameraExportFormat,
  type Project,
  type Result,
  type Track2d,
  type Track2dExportFormat,
} from '@vcvfx/domain';
import type { TrackSessionInfo, TrackViewData, VcvfxApi } from '../../shared/bridge';
import { applyOps, type CameraCommand, type ProjectOp } from '../../shared/camera/commands';
import { applySim, invertSim, composeSim, type Similarity } from '../../shared/camera/align';
import { lidarToScene } from '../../shared/camera/coords';
import { CV_TO_GL } from '../../shared/camera/geometry';
import { mul3 } from '../../shared/camera/linalg';
import { homographyFromQuads } from '../../shared/camera/planar';
import { PointCloudView, type CloudLayer } from './PointCloudView';
import { CameraPicker } from './CameraPicker';
import { AiAssistant } from './AiAssistant';
import { Icon } from './Icons';
import { ModuleLayout, Stat, StepList, Stats, TaskMissing, type StepDef } from './Layout';
import { PREF, readPref, writePref } from '../modules';

/**
 * The Track workspace (master spec §9, §10; addendum 06 §9): the Camera
 * Track and 2D Track tabs (addendum 08), one mode each. Camera: detect and track features (with roto parts and drawn
 * rectangles excluded), set the camera and lens, solve, read the error graph
 * and the worst tracks, delete what is bad, look at it in 3D with the LiDAR,
 * tie LiDAR points to features, align, set the coordinate system, export.
 * 2D: draw a surface's four corners (or a point), track it, correct any
 * frame by dragging a corner, preview an insert pinned to it, export.
 *
 * Every button runs a command from shared/camera/commands.ts — the same verbs
 * the AI tracking assistant will use — and the outcome's ops go through the
 * domain (and the log) with `applyOps`.
 */

export type TrackMutation = (p: Project, actor: string, now: Date) => Result;

export interface TrackWorkspaceProps {
  api: VcvfxApi;
  project: Project;
  shotId: string;
  projectKey: string;
  canEdit: boolean;
  busy: boolean;
  actor: string;
  frame: number;
  onFrame(frame: number): void;
  onTrack(fn: TrackMutation): boolean;
  runJob<T>(label: string, fn: (jobId: string) => Promise<T>): Promise<T>;
  notify(kind: 'ok' | 'error' | 'info', text: string): void;
  onAddTask(kind: 'camera_track' | 'track_2d'): void;
  /** Camera Track or 2D Track: each is its own tab (addendum 08). */
  mode: 'camera' | '2d';
  /** The task's state, approval and the shot's log, for the Details panel. */
  taskInfo?: ReactNode;
}

type Sub = 'camera' | '2d';
type Tool = 'select' | 'include' | 'exclude' | 'detect' | 'origin' | 'ground' | 'scale' | 'corr' | 'planar' | 'point';
type Loaded<T> = { data: T } | { error: string };

/** The drop-in element's size before its homography (large enough to rasterise sharply). */
const DROP_SIZE = 1024;

const sizeFor = (px: number) => [320, 640, 960, 1280, 1920].find((s) => s >= px) ?? 1920;

/** Track error as a colour: green under 0.5 px, amber to 1.5, red beyond. */
export function errorColour(e: number): string {
  if (!Number.isFinite(e)) return '#7fa6cc';
  const t = Math.max(0, Math.min(1, (e - 0.3) / 1.5));
  const hue = 130 - 130 * t;
  return `hsl(${hue.toFixed(0)} 75% 55%)`;
}

function rgbOf(css: string): [number, number, number] {
  const m = /hsl\((\d+) (\d+)% (\d+)%\)/.exec(css);
  if (!m) return [127, 166, 204];
  const h = Number(m[1]) / 360;
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const k = (n: number) => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

const fmt = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d));

export function TrackWorkspace(props: TrackWorkspaceProps) {
  const { api, project, shotId, projectKey, canEdit, busy, frame, onFrame, onTrack, runJob, notify, actor } = props;
  const state = shotState(project, shotId);
  const hasCam = Boolean(state?.tasks.some((t) => t.kind === 'camera_track'));
  const has2d = Boolean(state?.tasks.some((t) => t.kind === 'track_2d'));
  const sub: Sub = props.mode;
  const [aiOpen, setAiOpenState] = useState(() => readPref(PREF.aiOpen) === '1');
  const setAiOpen = (open: boolean) => {
    setAiOpenState(open);
    writePref(PREF.aiOpen, open ? '1' : null);
  };
  const doc: CamTrackDocument = useMemo(() => state?.camtrack ?? newCamTrackDocument(project, shotId), [state?.camtrack, project, shotId]);
  const t2d = state?.track2d ?? null;
  const text = useMemo(() => serializeProject(project), [project]);
  const textRef = useRef(text);
  textRef.current = text;
  const workingWidth = doc.trackSettings.workingWidth;

  const [session, setSession] = useState<TrackSessionInfo | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [view, setView] = useState<TrackViewData | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [show3d, setShow3d] = useState(false);
  const [showTrails, setShowTrails] = useState(true);
  const [selectedTrack, setSelectedTrack] = useState<number | null>(null);
  const [marked, setMarked] = useState<Set<number>>(new Set());
  const [picks, setPicks] = useState<number[]>([]);
  const [scaleDistance, setScaleDistance] = useState('1');
  const [corrFeature, setCorrFeature] = useState<{ trackId?: number; frame: number; x: number; y: number } | null>(null);
  const [errorThreshold, setErrorThreshold] = useState('1.5');
  const [formats, setFormats] = useState<Set<CameraExportFormat>>(new Set(CAMERA_EXPORT_FORMATS));
  const [stmaps, setStmaps] = useState(true);
  const [lidarUnits, setLidarUnits] = useState<(typeof SCENE_UNITS)[number]>('m');
  const [lidarUp, setLidarUp] = useState<'y' | 'z'>('z');
  const [t2dSelected, setT2dSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<[number, number][]>([]);
  const [dropIn, setDropIn] = useState<{ url: string; kind: 'image' | 'video'; name: string } | null>(null);
  const [t2dFormats, setT2dFormats] = useState<Set<Track2dExportFormat>>(new Set(TRACK2D_EXPORT_FORMATS));
  const [dragCorner, setDragCorner] = useState<{ index: number; points: [number, number][] } | null>(null);
  const [, setTick] = useState(0);
  const frames = useRef(new Map<string, Loaded<string> | 'pending'>());
  const stageRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const [box, setBox] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const rectDrag = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const camLocked = state ? camtrackLocked(state) : 'No shot';
  const t2dLocked = state ? track2dLocked(state) : 'No shot';
  const plate = session?.plate ?? null;
  const first = session?.first ?? frame;
  const last = session?.last ?? frame;
  // The viewer's frame can be outside what tracks here (the preview's sample shot is shorter than the shot).
  useEffect(() => {
    if (session?.available && (frame < first || frame > last)) onFrame(Math.min(last, Math.max(first, frame)));
  }, [session?.available, first, last, frame, onFrame]);
  const camVersion = state ? camtrackTaskVersion(state) : 1;
  const t2dVersion = state ? track2dTaskVersion(state) : 1;
  const solveRec = activeSolve(doc);
  const canCam = canEdit && !camLocked && Boolean(session?.available);
  const can2d = canEdit && !t2dLocked && Boolean(session?.available);

  // --- session and view data ---------------------------------------------
  useEffect(() => {
    setSession(null);
    setView(null);
    frames.current = new Map();
  }, [shotId, projectKey]);
  useEffect(() => {
    let live = true;
    setSessionError(null);
    void api.trackSession({ text: textRef.current, shotId, projectKey, workingWidth }).then((r) => {
      if (!live) return;
      if (!r.ok) return setSessionError(r.error);
      setSession(r.data);
    });
    return () => {
      live = false;
    };
  }, [api, shotId, projectKey, hasCam, has2d, state?.plates.length, workingWidth]);
  const viewKey = `${doc.trackSet?.file ?? ''}|${doc.activeSolve ?? ''}|${doc.solves.length}|${doc.lidar.map((l) => l.cache).join(',')}`;
  useEffect(() => {
    if (!session?.available || !hasCam) return;
    let live = true;
    void api.trackView({ text: textRef.current, shotId, projectKey, workingWidth, clouds: true }).then((r) => {
      if (live && r.ok) setView(r.data);
      else if (live && !r.ok) notify('error', r.error);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, shotId, projectKey, viewKey, session?.available, hasCam]);

  // --- the stage --------------------------------------------------------------
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !plate) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      const aspect = plate.width / plate.height;
      const width = Math.min(w, h * aspect);
      const height = width / aspect;
      setBox({ left: (w - width) / 2, top: (h - height) / 2, width, height });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [plate?.width, plate?.height, show3d]);
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const mainWidth = sizeFor(box.width * dpr);
  const wantFrame = useCallback(
    (f: number, w: number): Loaded<string> | undefined => {
      const k = `${f}:${w}`;
      const have = frames.current.get(k);
      if (have === 'pending') return undefined;
      if (have || !session?.available) return have;
      frames.current.set(k, 'pending');
      void api.trackFrame({ text: textRef.current, shotId, projectKey, frame: f, maxWidth: w }).then((r) => {
        frames.current.set(k, r.ok ? { data: r.data.url } : { error: r.error });
        setTick((t) => t + 1);
      });
      return undefined;
    },
    [api, projectKey, session?.available, shotId],
  );
  const current = wantFrame(frame, mainWidth);
  useEffect(() => {
    if (!session?.available) return;
    for (const d of [1, -1, 2]) if (frame + d >= first && frame + d <= last) wantFrame(frame + d, mainWidth);
  });

  // Track errors by id from the active solve.
  const errById = useMemo(() => {
    const m = new Map<number, number>();
    const s = view?.solve;
    if (s) s.trackIds.forEach((id, i) => m.set(id, s.trackRms[i]!));
    return m;
  }, [view?.solve]);
  const toScreen = useCallback((x: number, y: number): [number, number] => (plate ? [((x + 0.5) / plate.width) * box.width * dpr, ((y + 0.5) / plate.height) * box.height * dpr] : [0, 0]), [plate, box.width, box.height, dpr]);
  const toPlate = (e: { clientX: number; clientY: number; currentTarget: Element }): [number, number] | null => {
    if (!plate) return null;
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width <= 0) return null;
    return [((e.clientX - r.left) / r.width) * plate.width - 0.5, ((e.clientY - r.top) / r.height) * plate.height - 0.5];
  };

  const t2dTracks = t2d?.tracks ?? [];
  const selT2d: Track2d | undefined = t2dTracks.find((t) => t.id === t2dSelected) ?? t2dTracks[0];
  const pointsOn = (t: Track2d, f: number) => t.frames.find((x) => x.frame === f)?.points ?? null;

  // Draw the overlay.
  useEffect(() => {
    const c = overlayRef.current;
    const g = c?.getContext('2d');
    if (!c || !g || !plate) return;
    c.width = Math.max(1, Math.round(box.width * dpr));
    c.height = Math.max(1, Math.round(box.height * dpr));
    g.clearRect(0, 0, c.width, c.height);
    const tr = view?.tracks;
    if (sub === 'camera' && tr) {
      for (let i = 0; i < tr.ids.length; i += 1) {
        const s = tr.start[i]!;
        const len = tr.length[i]!;
        if (frame < s || frame >= s + len) continue;
        const id = tr.ids[i]!;
        const err = errById.get(id);
        const colour = err !== undefined ? errorColour(err) : `hsl(${200 + Math.min(60, len)} 70% 62%)`;
        const o = (tr.offset[i]! + frame - s) * 2;
        const [x, y] = toScreen(tr.xy[o]!, tr.xy[o + 1]!);
        if (showTrails) {
          g.strokeStyle = colour;
          g.globalAlpha = 0.55;
          g.lineWidth = 1 * dpr;
          g.beginPath();
          const a = Math.max(s, frame - 10);
          for (let f = a; f <= frame; f += 1) {
            const k = (tr.offset[i]! + f - s) * 2;
            const [px, py] = toScreen(tr.xy[k]!, tr.xy[k + 1]!);
            if (f === a) g.moveTo(px, py);
            else g.lineTo(px, py);
          }
          g.stroke();
          g.globalAlpha = 1;
        }
        const sel = id === selectedTrack || marked.has(id) || picks.includes(id) || corrFeature?.trackId === id;
        g.fillStyle = colour;
        g.beginPath();
        g.arc(x, y, (sel ? 4 : 2.2) * dpr, 0, Math.PI * 2);
        g.fill();
        if (sel) {
          g.strokeStyle = '#fff';
          g.lineWidth = 1.5 * dpr;
          g.beginPath();
          g.arc(x, y, 7 * dpr, 0, Math.PI * 2);
          g.stroke();
        }
      }
      // Correspondences on this frame.
      for (const cp of doc.correspondences) {
        let p: [number, number] | null = null;
        if (cp.target.kind === 'pixel' && cp.target.frame === frame) p = [cp.target.x, cp.target.y];
        else if (cp.target.kind === 'track') {
          const id = cp.target.trackId;
          const i = tr.ids.indexOf(id);
          if (i >= 0 && frame >= tr.start[i]! && frame < tr.start[i]! + tr.length[i]!) {
            const o = (tr.offset[i]! + frame - tr.start[i]!) * 2;
            p = [tr.xy[o]!, tr.xy[o + 1]!];
          }
        }
        if (!p) continue;
        const [x, y] = toScreen(p[0], p[1]);
        g.strokeStyle = '#ff5f56';
        g.lineWidth = 2 * dpr;
        g.strokeRect(x - 6 * dpr, y - 6 * dpr, 12 * dpr, 12 * dpr);
        g.fillStyle = '#ff5f56';
        g.font = `${11 * dpr}px system-ui`;
        g.fillText(cp.name, x + 9 * dpr, y - 8 * dpr);
      }
    }
    // Rectangles (masks) and the one being drawn.
    const rect = (r: { x0: number; y0: number; x1: number; y1: number }, colour: string, dash: boolean) => {
      const [x0, y0] = toScreen(Math.min(r.x0, r.x1), Math.min(r.y0, r.y1));
      const [x1, y1] = toScreen(Math.max(r.x0, r.x1), Math.max(r.y0, r.y1));
      g.strokeStyle = colour;
      g.lineWidth = 1.5 * dpr;
      g.setLineDash(dash ? [6 * dpr, 4 * dpr] : []);
      g.strokeRect(x0, y0, x1 - x0, y1 - y0);
      g.setLineDash([]);
    };
    if (sub === 'camera') for (const r of doc.masks.rects) rect(r, r.mode === 'include' ? '#3ad07a' : '#ff5f56', false);
    if (rectDrag.current) rect(rectDrag.current, tool === 'include' ? '#3ad07a' : tool === 'exclude' ? '#ff5f56' : '#f2a33a', true);
    // 2D tracks.
    if (sub === '2d') {
      for (const t of t2dTracks) {
        const pts = t.id === selT2d?.id && dragCorner ? dragCorner.points : pointsOn(t, frame);
        if (!pts) continue;
        const rec = t.frames.find((x) => x.frame === frame);
        const scr = pts.map(([x, y]) => toScreen(x, y));
        g.strokeStyle = t.color;
        g.lineWidth = (t.id === selT2d?.id ? 2 : 1.2) * dpr;
        if (rec?.status === 'lost') g.setLineDash([5 * dpr, 4 * dpr]);
        g.beginPath();
        scr.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y)));
        if (scr.length === 4) g.closePath();
        g.stroke();
        g.setLineDash([]);
        if (t.id === selT2d?.id)
          scr.forEach(([x, y], k) => {
            g.fillStyle = k === 0 ? '#fff' : t.color;
            g.beginPath();
            g.arc(x, y, 5 * dpr, 0, Math.PI * 2);
            g.fill();
            g.strokeStyle = '#000';
            g.lineWidth = 1;
            g.stroke();
          });
        if (scr.length === 1) {
          const [x, y] = scr[0]!;
          g.strokeStyle = t.color;
          g.strokeRect(x - (t.pattern / (plate.width / box.width)) * dpr, y - (t.pattern / (plate.width / box.width)) * dpr, ((2 * t.pattern) / (plate.width / box.width)) * dpr, ((2 * t.pattern) / (plate.width / box.width)) * dpr);
        }
      }
      if (draft.length) {
        g.strokeStyle = '#f2a33a';
        g.lineWidth = 1.5 * dpr;
        g.beginPath();
        draft.forEach(([x, y], k) => {
          const [sx, sy] = toScreen(x, y);
          if (k) g.lineTo(sx, sy);
          else g.moveTo(sx, sy);
        });
        g.stroke();
        for (const [x, y] of draft) {
          const [sx, sy] = toScreen(x, y);
          g.fillStyle = '#f2a33a';
          g.beginPath();
          g.arc(sx, sy, 4 * dpr, 0, Math.PI * 2);
          g.fill();
        }
      }
    }
  });

  // --- running commands -----------------------------------------------------
  const run = useCallback(
    async (label: string, command: CameraCommand): Promise<{ summary: string; data: Record<string, unknown> } | null> => {
      const r = await runJob(label, (jobId) => api.trackCommand({ jobId, text: textRef.current, shotId, projectKey, operator: actor, command: command as unknown as { verb: string } & Record<string, unknown>, workingWidth }));
      if (!r.ok) {
        notify('error', r.error);
        return null;
      }
      const out = r.data;
      if (!out.ok) {
        notify(out.error === 'Cancelled' ? 'info' : 'error', out.error === 'Cancelled' ? 'Stopped.' : out.error);
        return null;
      }
      if (onTrack((p, a, now) => applyOps(p, shotId, out.ops as ProjectOp[], a, now))) notify('ok', out.summary);
      return out;
    },
    [actor, api, notify, onTrack, projectKey, runJob, shotId, workingWidth],
  );

  const trackAtFrame = (id: number): [number, number] | null => {
    const tr = view?.tracks;
    if (!tr) return null;
    const i = tr.ids.indexOf(id);
    if (i < 0 || frame < tr.start[i]! || frame >= tr.start[i]! + tr.length[i]!) return null;
    const o = (tr.offset[i]! + frame - tr.start[i]!) * 2;
    return [tr.xy[o]!, tr.xy[o + 1]!];
  };
  const nearestTrack = (p: [number, number]): number | null => {
    const tr = view?.tracks;
    if (!tr || !plate) return null;
    const maxD = (10 * plate.width) / Math.max(1, box.width);
    let best: number | null = null;
    let bd = maxD;
    for (let i = 0; i < tr.ids.length; i += 1) {
      if (frame < tr.start[i]! || frame >= tr.start[i]! + tr.length[i]!) continue;
      const o = (tr.offset[i]! + frame - tr.start[i]!) * 2;
      const d = Math.hypot(tr.xy[o]! - p[0], tr.xy[o + 1]! - p[1]);
      if (d < bd) {
        bd = d;
        best = tr.ids[i]!;
      }
    }
    return best;
  };

  const pickTrack = async (id: number) => {
    if (tool === 'origin') {
      await run('Setting the origin', { verb: 'set_coordinate_system', origin: { trackId: id } });
      setTool('select');
    } else if (tool === 'ground') {
      const next = [...picks, id].slice(-3);
      setPicks(next);
      if (next.length === 3) {
        await run('Setting the ground plane', { verb: 'set_coordinate_system', ground: next as [number, number, number] });
        setPicks([]);
        setTool('select');
      }
    } else if (tool === 'scale') setPicks((p) => [...p, id].slice(-2));
    else if (tool === 'corr') {
      const at = trackAtFrame(id);
      setCorrFeature({ trackId: id, frame, x: at?.[0] ?? 0, y: at?.[1] ?? 0 });
    } else setSelectedTrack(id);
  };

  // Stage pointer handling: rectangles, picks, 2D corners.
  const onDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const p = toPlate(e);
    if (!p || e.button !== 0) return;
    if (sub === 'camera') {
      if (tool === 'include' || tool === 'exclude' || tool === 'detect') {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        rectDrag.current = { x0: p[0], y0: p[1], x1: p[0], y1: p[1] };
        return;
      }
      const id = nearestTrack(p);
      if (id !== null) void pickTrack(id);
      else if (tool === 'corr') setCorrFeature({ frame, x: p[0], y: p[1] });
      return;
    }
    // 2D
    if (tool === 'planar' || tool === 'point') {
      const next = [...draft, p];
      if ((tool === 'point' && next.length === 1) || next.length === 4) {
        setDraft([]);
        setTool('select');
        const n = t2dTracks.length + 1;
        void run('Creating a track', { verb: 'track2d_create', name: tool === 'point' ? `Point ${n}` : `Surface ${n}`, kind: tool === 'point' ? 'point' : 'planar', frame, points: next });
      } else setDraft(next);
      return;
    }
    if (selT2d && can2d) {
      const pts = pointsOn(selT2d, frame);
      if (!pts || !plate) return;
      const maxD = (12 * plate.width) / Math.max(1, box.width);
      const k = pts.findIndex(([x, y]) => Math.hypot(x - p[0], y - p[1]) < maxD);
      if (k >= 0) {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        setDragCorner({ index: k, points: pts.map((q) => [q[0], q[1]] as [number, number]) });
      }
    }
  };
  const onMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const p = toPlate(e);
    if (!p) return;
    if (rectDrag.current) {
      rectDrag.current = { ...rectDrag.current, x1: p[0], y1: p[1] };
      setTick((t) => t + 1);
    } else if (dragCorner) {
      const pts = dragCorner.points.map((q, i) => (i === dragCorner.index ? p : q));
      setDragCorner({ ...dragCorner, points: pts });
    }
  };
  const onUp = () => {
    const r = rectDrag.current;
    rectDrag.current = null;
    if (r && Math.abs(r.x1 - r.x0) > 4 && Math.abs(r.y1 - r.y0) > 4) {
      const norm = { x0: Math.min(r.x0, r.x1), y0: Math.min(r.y0, r.y1), x1: Math.max(r.x0, r.x1), y1: Math.max(r.y0, r.y1) };
      if (tool === 'detect') void run(`Detecting features on ${frame}`, { verb: 'detect_features', frame, region: norm, maxFeatures: 40 });
      else void run('Setting masks', { verb: 'set_masks', rects: [...doc.masks.rects, { ...norm, mode: tool === 'include' ? 'include' : 'exclude' }] });
      setTool('select');
    }
    if (dragCorner && selT2d) {
      const pts = dragCorner.points;
      setDragCorner(null);
      void run(`Correcting ${selT2d.name} on ${frame}`, { verb: 'track2d_set_key', trackId: selT2d.id, frame, points: pts });
    }
    setTick((t) => t + 1);
  };

  // --- 3D view data ---------------------------------------------------------
  const sceneT: Similarity = { s: doc.coords.transform.s, R: [...doc.coords.transform.R], t: [...doc.coords.transform.t] };
  const cams3d = useMemo(() => {
    const s = view?.solve;
    if (!s) return [];
    return s.frames
      .map((f, i) => ({ f, i }))
      .filter(({ f }) => f.solved)
      .map(({ f, i }) => {
        const R = Array.from(s.R.subarray(9 * i, 9 * i + 9));
        const t = Array.from(s.t.subarray(3 * i, 3 * i + 3));
        const C = [-(R[0]! * t[0]! + R[3]! * t[1]! + R[6]! * t[2]!), -(R[1]! * t[0]! + R[4]! * t[1]! + R[7]! * t[2]!), -(R[2]! * t[0]! + R[5]! * t[1]! + R[8]! * t[2]!)];
        const Rt = [R[0]!, R[3]!, R[6]!, R[1]!, R[4]!, R[7]!, R[2]!, R[5]!, R[8]!];
        return { frame: f.frame, position: applySim(sceneT, C), rotation: mul3(mul3(sceneT.R, Rt), CV_TO_GL) };
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.solve, JSON.stringify(doc.coords.transform)]);
  const tracks3d = useMemo(() => {
    const s = view?.solve;
    if (!s) return null;
    const ids: number[] = [];
    const pos: number[] = [];
    const col: number[] = [];
    s.trackIds.forEach((id, i) => {
      if (Number.isNaN(s.X[3 * i])) return;
      ids.push(id);
      pos.push(...applySim(sceneT, [s.X[3 * i]!, s.X[3 * i + 1]!, s.X[3 * i + 2]!]));
      col.push(...rgbOf(errorColour(s.trackRms[i]!)));
    });
    return { ids: Int32Array.from(ids), positions: Float32Array.from(pos), colors: Uint8Array.from(col) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.solve, JSON.stringify(doc.coords.transform)]);
  const lidarToSceneSim = useCallback(
    (lidarId: string): Similarity | null => {
      const ref = doc.lidar.find((l) => l.id === lidarId);
      if (!ref) return null;
      if (doc.alignment && doc.alignment.lidarId === lidarId && doc.alignment.solve === doc.activeSolve) {
        const A: Similarity = { s: doc.alignment.transform.s, R: [...doc.alignment.transform.R], t: [...doc.alignment.transform.t] };
        return composeSim(sceneT, invertSim(A));
      }
      // Not aligned yet: in scene units and the right way up, with its centre put at the middle
      // of the solved points, so both are in view to pick correspondences between.
      const base = lidarToScene({ units: ref.units, up: ref.up }, doc.coords.units);
      const cloud = view?.clouds.find((c) => c.id === lidarId);
      if (!cloud || !tracks3d?.positions.length) return base;
      const mid = [0, 1, 2].map((k) => {
        const v = Array.from({ length: tracks3d.positions.length / 3 }, (_, i) => tracks3d.positions[3 * i + k]!).sort((a, b) => a - b);
        return v[v.length >> 1]!;
      });
      // …and, for looking only, at the size of the solve (its scale is arbitrary until aligned).
      const r80 = (pos: Float32Array, centre: number[], k = 1) => {
        const r: number[] = [];
        for (let i = 0; i < pos.length; i += 3 * Math.max(1, Math.floor(pos.length / 3 / 4000))) r.push(Math.hypot(pos[i]! * k - centre[0]!, pos[i + 1]! * k - centre[1]!, pos[i + 2]! * k - centre[2]!));
        r.sort((a, b) => a - b);
        return r[Math.floor(0.8 * (r.length - 1))] ?? 1;
      };
      const fit = r80(tracks3d.positions, mid) / Math.max(1e-9, r80(cloud.positions, [0, 0, 0], base.s));
      const shown = { ...base, s: base.s * fit };
      const c = applySim(shown, cloud.origin);
      return { ...shown, t: [mid[0]! - c[0]!, mid[1]! - c[1]!, mid[2]! - c[2]!] };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc.alignment, doc.lidar, doc.activeSolve, JSON.stringify(doc.coords.transform), doc.coords.units, view?.clouds, tracks3d],
  );
  const clouds3d: CloudLayer[] = useMemo(() => {
    if (!view) return [];
    return view.clouds.map((c) => {
      const M = lidarToSceneSim(c.id) ?? { s: 1, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
      const out = new Float32Array(c.positions.length);
      const o = c.origin;
      for (let i = 0; i < c.positions.length; i += 3) {
        const p = applySim(M, [c.positions[i]! + o[0], c.positions[i + 1]! + o[1], c.positions[i + 2]! + o[2]]);
        out[i] = p[0]!;
        out[i + 1] = p[1]!;
        out[i + 2] = p[2]!;
      }
      return { id: c.id, positions: out, colors: c.colors, pickable: true, size: 2 };
    });
  }, [view, lidarToSceneSim]);
  const marks3d = useMemo(
    () =>
      doc.correspondences
        .map((cp) => {
          const M = lidarToSceneSim(cp.lidarId);
          return M ? { position: applySim(M, cp.point), color: [1, 0.37, 0.34] as [number, number, number], label: cp.name } : null;
        })
        .filter((m): m is NonNullable<typeof m> => m !== null),
    [doc.correspondences, lidarToSceneSim],
  );
  const onPick3d = async (p: { layer: string; index: number; position: number[] } | { layer: 'tracks'; id: number; position: number[] }) => {
    if (p.layer === 'tracks' && 'id' in p) return void pickTrack(p.id);
    if (tool !== 'corr' || !('index' in p)) return notify('info', 'Choose “Pick correspondence” first: click a feature in the frame, then the same point in the cloud.');
    const c = view?.clouds.find((x) => x.id === p.layer);
    if (!c) return;
    const point: [number, number, number] = [c.positions[3 * p.index]! + c.origin[0], c.positions[3 * p.index + 1]! + c.origin[1], c.positions[3 * p.index + 2]! + c.origin[2]];
    if (!corrFeature) return notify('info', 'Click the feature in the frame first (a track, or any pixel), then the point in the cloud.');
    await run('Adding a correspondence', { verb: 'add_correspondence', lidarId: c.id, point, ...(corrFeature.trackId !== undefined ? { trackId: corrFeature.trackId } : { frame: corrFeature.frame, x: corrFeature.x, y: corrFeature.y }) });
    setCorrFeature(null);
  };

  // --- keyboard -----------------------------------------------------------------
  const keys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keys.current = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (document.querySelector('.modal') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape' && (tool !== 'select' || draft.length)) {
      e.stopPropagation();
      setTool('select');
      setDraft([]);
      setPicks([]);
      setCorrFeature(null);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && sub === 'camera' && canCam && (marked.size || selectedTrack !== null)) {
      const ids = marked.size ? [...marked] : [selectedTrack!];
      void run('Deleting tracks', { verb: 'delete_tracks', ids }).then(() => {
        setMarked(new Set());
        setSelectedTrack(null);
      });
    } else if (e.key === '3' && sub === 'camera') setShow3d((s) => !s);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Drop-in video follows the frame.
  useEffect(() => {
    const v = videoRef.current;
    if (v && dropIn?.kind === 'video' && session) v.currentTime = Math.max(0, (frame - first) / (session.fps || 24));
  }, [frame, dropIn, first, session]);

  if (!state) return null;
  const taskKind = sub === 'camera' ? 'camera_track' : 'track_2d';
  if (sub === 'camera' ? !hasCam : !has2d) {
    return (
      <main className="module module-missing" aria-label={sub === 'camera' ? 'Camera Track' : '2D Track'}>
        <TaskMissing module={sub === 'camera' ? 'camera' : 'track2d'} shotName={state.vfxShotId ?? shotId} canEdit={canEdit} locked={state.stage !== 'prep' ? `The shot is ${state.stage}; reopen it first.` : null} onAdd={() => props.onAddTask(taskKind)} />
      </main>
    );
  }

  const message = sessionError ?? (session && !session.available ? session.reason : null);
  const solveFrames = view?.solve?.frames ?? [];
  const worst = (() => {
    const s = view?.solve;
    if (!s) return [];
    const lengths = new Map<number, number>();
    if (view?.tracks) view.tracks.ids.forEach((id, i) => lengths.set(id, view.tracks!.length[i]!));
    return [...s.trackIds]
      .map((id, i) => ({ id, rms: s.trackRms[i]!, len: lengths.get(id) ?? 0, solved: !Number.isNaN(s.X[3 * i]) }))
      .filter((x) => x.solved)
      .sort((a, b) => b.rms - a.rms)
      .slice(0, 12);
  })();
  const camera = doc.camera;
  const bodies = [...project.customCameras, ...CAMERA_DB];
  const handoffCam = handoffShot(project, shotId)?.camera;
  const handoffCameraText = [handoffCam?.body, handoffCam?.sensorMode].filter(Boolean).join(' · ') || null;
  const exportedCam = doc.exports.find((x) => x.version === camVersion);
  const exported2d = t2d?.exports.find((x) => x.version === t2dVersion);
  const lockedNote = (sub === 'camera' ? camLocked : t2dLocked) && state.stage === 'prep' ? <p className="muted small hint">{sub === 'camera' ? camLocked : t2dLocked}</p> : null;

  // Drop-in transform: image corners → the selected surface's corners on this frame.
  const dropTransform = (() => {
    if (!dropIn || !selT2d || selT2d.kind !== 'planar' || !plate) return null;
    const pts = dragCorner?.points ?? pointsOn(selT2d, frame);
    if (!pts) return null;
    const scr = pts.map(([x, y]) => [((x + 0.5) / plate.width) * box.width, ((y + 0.5) / plate.height) * box.height] as [number, number]);
    const H = homographyFromQuads(
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
      scr,
    );
    if (!H) return null;
    // The element is DROP_SIZE px square (CSS), so H takes its pixels through 1/DROP_SIZE first. matrix3d is column-major.
    const k = 1 / DROP_SIZE;
    return `matrix3d(${H[0]! * k},${H[3]! * k},0,${H[6]! * k},${H[1]! * k},${H[4]! * k},0,${H[7]! * k},0,0,1,0,${H[2]},${H[5]},0,${H[8]})`;
  })();

  const aiButton = (
    <div className="ai-callout-step">
      <button type="button" className={aiOpen ? 'on' : undefined} aria-pressed={aiOpen} onClick={() => setAiOpen(!aiOpen)} title="Say what you want; the assistant runs these same steps and reports back">
        <Icon name="ai" size={18} /> AI assistant
      </button>
      <span className="muted small">Let the assistant run these steps for you, then review its report.</span>
    </div>
  );

  const camSteps: StepDef[] = [
    {
      id: 'camera',
      title: 'Choose camera & lens',
      hint: 'From the handoff when it matches; check the focal length.',
      done: Boolean(camera),
      content: (
        <>
          <CameraPicker
            bodies={bodies}
            camera={camera}
            disabled={!canCam}
            handoffText={handoffCameraText}
            onPick={(cameraId, modeId) => void run('Setting the camera', { verb: 'set_camera', cameraId, modeId })}
            onCustom={(custom) => void run('Adding the camera', { verb: 'set_camera', custom })}
          />
          <div className="track-grid">
            <label>
              <span className="muted small">Focal (mm)</span>
              <input
                aria-label="Focal length"
                type="number"
                step="0.1"
                defaultValue={doc.lens.focalMm ?? ''}
                key={`f-${doc.lens.focalMm}`}
                disabled={!canCam}
                onBlur={(e) => {
                  const v = Number(e.target.value);
                  if ((v || null) !== doc.lens.focalMm) void run('Setting the lens', { verb: 'set_lens', focalMm: v > 0 ? v : null, ...(v > 0 ? {} : { focalMode: 'unknown' as const }) });
                }}
              />
            </label>
            <label>
              <span className="muted small">Focal is</span>
              <select aria-label="Focal mode" value={doc.lens.focalMode} disabled={!canCam} onChange={(e) => void run('Setting the lens', { verb: 'set_lens', focalMode: e.target.value as 'known' | 'approx' | 'unknown' })}>
                <option value="known">known (held)</option>
                <option value="approx">approximate</option>
                <option value="unknown">unknown (solved)</option>
              </select>
            </label>
          </div>
          <details className="sub">
            <summary>Lens distortion and profiles</summary>
            <div className="track-grid">
              <label>
                <span className="muted small">k1</span>
                <input aria-label="k1" type="number" step="0.001" defaultValue={doc.lens.distortion.k1} key={`k1-${doc.lens.distortion.k1}`} disabled={!canCam} onBlur={(e) => Number(e.target.value) !== doc.lens.distortion.k1 && void run('Setting the lens', { verb: 'set_lens', distortion: { k1: Number(e.target.value) } })} />
              </label>
              <label>
                <span className="muted small">k2</span>
                <input aria-label="k2" type="number" step="0.001" defaultValue={doc.lens.distortion.k2} key={`k2-${doc.lens.distortion.k2}`} disabled={!canCam} onBlur={(e) => Number(e.target.value) !== doc.lens.distortion.k2 && void run('Setting the lens', { verb: 'set_lens', distortion: { k2: Number(e.target.value) } })} />
              </label>
            </div>
            <div className="check-row">
              {(
                [
                  ['focal', 'refine focal'],
                  ['k1k2', 'k1 k2'],
                  ['p1p2', 'p1 p2'],
                ] as const
              ).map(([k, label]) => (
                <label key={k} className="check">
                  <input type="checkbox" checked={doc.lens.refine[k]} disabled={!canCam} onChange={(e) => void run('Setting the lens', { verb: 'set_lens', refine: { [k]: e.target.checked } })} /> {label}
                </label>
              ))}
            </div>
            {project.lensProfiles.length ? (
              <label className="field-col">
                <span className="muted small">Lens profile</span>
                <select aria-label="Lens profile" value={doc.lens.profileId ?? ''} disabled={!canCam} onChange={(e) => void run('Setting the lens', { verb: 'set_lens', profileId: e.target.value || null })}>
                  <option value="">None</option>
                  {project.lensProfiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.lens || p.camera} {p.focalMm} mm ({p.source})
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <div className="row">
              <button type="button" className="small-button" disabled={!canCam || !solveRec} onClick={() => void run('Saving the lens profile', { verb: 'save_lens_profile' })} title="Store the active solve's focal length and distortion as a project lens profile">
                Save lens profile
              </button>
              <button
                type="button"
                className="small-button"
                onClick={async () => {
                  const r = await api.saveCalibrationTarget({ cols: 10, rows: 7, squareMm: 30, marginMm: 15 });
                  if (!r.ok) notify('error', r.error);
                  else if (r.data) notify('ok', `Saved ${r.data.path} (and a 300 dpi PNG). Print at 100 % and check a square with a ruler.`);
                }}
                title="A 10 × 7 checkerboard of 30 mm squares as a PDF to print at 100 %"
              >
                Print checkerboard…
              </button>
            </div>
          </details>
        </>
      ),
    },
    {
      id: 'features',
      title: 'Find & track features',
      hint: 'Corners in the picture, followed through the shot.',
      done: Boolean(doc.trackSet),
      content: (
        <>
          <button type="button" className="primary big" disabled={!canCam || busy} onClick={() => void run('Tracking features', { verb: 'auto_track' })}>
            {doc.trackSet ? 'Track again' : 'Auto-track'}
          </button>
          {doc.trackSet ? (
            <p className="step-text">
              {doc.trackSet.tracks} tracks, mean {doc.trackSet.meanLength} frames, at least {doc.trackSet.minPerFrame} per frame{doc.trackSet.deleted ? `; ${doc.trackSet.deleted} deleted` : ''}.
            </p>
          ) : null}
          <p className="muted small hint">Keep features off things that move by themselves (people, cars): drag a rectangle with Exclude, or tick roto parts below.</p>
          <div className="seg" role="group" aria-label="Region tools">
            <button type="button" className={tool === 'detect' ? 'on' : undefined} disabled={!canCam} onClick={() => setTool(tool === 'detect' ? 'select' : 'detect')} title="Drag a rectangle: detect features there and track them both ways">
              Add in region
            </button>
            <button type="button" className={tool === 'exclude' ? 'on tool-exclude' : 'tool-exclude'} disabled={!canCam} onClick={() => setTool(tool === 'exclude' ? 'select' : 'exclude')} title="Drag a rectangle to keep features out of it">
              Exclude
            </button>
            <button type="button" className={tool === 'include' ? 'on tool-include' : 'tool-include'} disabled={!canCam} onClick={() => setTool(tool === 'include' ? 'select' : 'include')} title="Drag a rectangle: features only inside include rectangles">
              Include
            </button>
          </div>
          {doc.masks.rects.length ? (
            <button type="button" className="small-button" disabled={!canCam} onClick={() => void run('Clearing rectangles', { verb: 'set_masks', rects: [] })}>
              Clear {doc.masks.rects.length} rectangle{doc.masks.rects.length === 1 ? '' : 's'}
            </button>
          ) : null}
          {state.roto?.parts.length ? (
            <div className="check-col">
              <span className="muted small">Exclude moving objects (roto parts)</span>
              {state.roto.parts.map((p) => (
                <label key={p.id} className="check">
                  <input
                    type="checkbox"
                    checked={doc.masks.excludeRotoParts.includes(p.id)}
                    disabled={!canCam}
                    onChange={(e) => void run('Setting masks', { verb: 'set_masks', excludeRotoParts: e.target.checked ? [...doc.masks.excludeRotoParts, p.id] : doc.masks.excludeRotoParts.filter((x) => x !== p.id) })}
                  />{' '}
                  <span style={{ color: p.color }}>■</span> {p.name}
                </label>
              ))}
            </div>
          ) : null}
          <details className="sub">
            <summary>Tracker settings</summary>
            <div className="track-grid">
              <label>
                <span className="muted small">Features</span>
                <select aria-label="Features" value={doc.trackSettings.maxFeatures} disabled={!canCam} onChange={(e) => void run('Tracker settings', { verb: 'set_track_settings', maxFeatures: Number(e.target.value) })}>
                  {[150, 300, 500, 800, 1200].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className="muted small">Working size</span>
                <select aria-label="Working size" value={Math.min(workingWidth, plate?.width ?? workingWidth)} disabled={!canCam || session?.sample} onChange={(e) => void run('Tracker settings', { verb: 'set_track_settings', workingWidth: Number(e.target.value) })}>
                  {[...new Set([960, 1280, 1920, 2560, ...(plate ? [plate.width] : [])])]
                    .filter((w) => !plate || w <= plate.width)
                    .map((w) => (
                      <option key={w} value={w}>
                        {w} px
                      </option>
                    ))}
                </select>
              </label>
            </div>
          </details>
        </>
      ),
    },
    {
      id: 'solve',
      title: 'Solve',
      hint: 'Work out the camera’s path and lens from the tracks.',
      done: Boolean(solveRec),
      waiting: doc.trackSet ? null : 'Track features first (step 2).',
      content: (
        <>
          <button type="button" className="primary big" disabled={!canCam || busy || !doc.trackSet} onClick={() => void run('Solving the camera', { verb: 'solve' })}>
            {solveRec ? 'Solve again' : 'Solve camera'}
          </button>
          {solveRec ? (
            <div className="solve-stats">
              <span className={solveRec.stats.rms < 0.8 ? 'ok' : solveRec.stats.rms < 1.5 ? '' : 'error'}>
                RMS <b>{solveRec.stats.rms.toFixed(3)} px</b>
              </span>
              <span>
                {solveRec.stats.framesSolved}/{solveRec.stats.framesTotal} frames · {solveRec.stats.tracksUsed} tracks
              </span>
              {solveRec.stats.nodal ? <span className="tag">nodal</span> : null}
            </div>
          ) : null}
          {doc.solves.length > 1 ? (
            <label className="field-col">
              <span className="muted small">Active solve</span>
              <select aria-label="Active solve" value={doc.activeSolve ?? ''} disabled={!canCam} onChange={(e) => void run('Choosing the solve', { verb: 'select_solve', number: Number(e.target.value) })}>
                {doc.solves.map((s) => (
                  <option key={s.number} value={s.number}>
                    Solve {s.number}: {s.stats.rms.toFixed(3)} px{s.constraint !== 'none' ? ' · LiDAR' : ''}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </>
      ),
    },
    {
      id: 'review',
      title: 'Review errors',
      hint: 'Under 1 px is good. Delete the worst tracks, solve again.',
      done: Boolean(solveRec) && solveRec!.stats.rms <= 1,
      waiting: solveRec ? null : 'Solve first (step 3).',
      content: (
        <>
          <p className="step-text">The graph under the picture shows the error per frame; click it to go there. Dots on the picture are coloured the same way.</p>
          <button type="button" className={show3d ? 'on' : undefined} aria-pressed={show3d} onClick={() => setShow3d((s) => !s)} title="The solved points and the camera path in 3D (3)">
            {show3d ? 'Hide 3D view' : 'Show 3D view'}
          </button>
          <h5 className="step-sub">Worst tracks</h5>
          <ul className="worst-tracks" aria-label="Worst tracks">
            {worst.map((w) => (
              <li key={w.id} className={w.id === selectedTrack ? 'selected' : undefined}>
                <input
                  type="checkbox"
                  aria-label={`Mark track ${w.id}`}
                  checked={marked.has(w.id)}
                  onChange={(e) =>
                    setMarked((m) => {
                      const n = new Set(m);
                      if (e.target.checked) n.add(w.id);
                      else n.delete(w.id);
                      return n;
                    })
                  }
                />
                <button type="button" className="link" onClick={() => setSelectedTrack(w.id)}>
                  #{w.id}
                </button>
                <span className="mono" style={{ color: errorColour(w.rms) }}>
                  {w.rms.toFixed(2)} px
                </span>
                <span className="muted">{w.len} fr</span>
              </li>
            ))}
          </ul>
          <div className="row">
            <button type="button" className="small-button" disabled={!canCam || !marked.size} onClick={() => void run('Deleting tracks', { verb: 'delete_tracks', ids: [...marked] }).then(() => setMarked(new Set()))}>
              Delete {marked.size || ''} marked
            </button>
          </div>
          <div className="row">
            <span className="muted small">Or every track above</span>
            <input className="tiny" aria-label="Error threshold" value={errorThreshold} onChange={(e) => setErrorThreshold(e.target.value)} />
            <span className="muted small">px</span>
            <button type="button" className="small-button" disabled={!canCam || !solveRec} onClick={() => void run('Deleting tracks', { verb: 'delete_tracks', maxErrorPx: Number(errorThreshold) || 1.5 })}>
              Delete
            </button>
          </div>
        </>
      ),
    },
    {
      id: 'lidar',
      title: 'Align to LiDAR',
      hint: 'Put the camera into a scan’s real-world coordinates.',
      optional: true,
      done: Boolean(doc.alignment),
      waiting: solveRec ? null : 'Solve first (step 3).',
      content: (
        <>
          <div className="track-grid">
            <label>
              <span className="muted small">Units</span>
              <select aria-label="LiDAR units" value={lidarUnits} onChange={(e) => setLidarUnits(e.target.value as (typeof SCENE_UNITS)[number])}>
                {SCENE_UNITS.map((u) => (
                  <option key={u}>{u}</option>
                ))}
              </select>
            </label>
            <label>
              <span className="muted small">File up</span>
              <select aria-label="LiDAR up axis" value={lidarUp} onChange={(e) => setLidarUp(e.target.value as 'y' | 'z')}>
                <option value="z">Z-up</option>
                <option value="y">Y-up</option>
              </select>
            </label>
          </div>
          <button
            type="button"
            disabled={!canCam || busy}
            onClick={async () => {
              const r = await api.chooseLidarFile();
              if (!r.ok) return notify('error', r.error);
              if (r.data) await run('Importing the point cloud', { verb: 'import_lidar', path: r.data, units: lidarUnits, up: lidarUp });
            }}
          >
            Import LiDAR / survey…
          </button>
          <ul className="lidar-list">
            {doc.lidar.map((l) => (
              <li key={l.id}>
                <span title={l.path}>{l.name}</span>
                <span className="muted small">
                  {l.points.toLocaleString('en')} pts · {l.units} · {l.up.toUpperCase()}-up
                </span>
                <button type="button" className="icon remove" aria-label={`Remove ${l.name}`} disabled={!canCam} onClick={() => void run('Removing LiDAR', { verb: 'remove_lidar', id: l.id })}>
                  ×
                </button>
              </li>
            ))}
          </ul>
          {doc.lidar.length ? (
            <>
              <button
                type="button"
                className={tool === 'corr' ? 'on' : undefined}
                disabled={!canCam || !solveRec}
                onClick={() => {
                  setTool(tool === 'corr' ? 'select' : 'corr');
                  setShow3d(true);
                  setCorrFeature(null);
                }}
                title="Click a feature in the frame, then the same point in the cloud"
              >
                {tool === 'corr' ? (corrFeature ? 'Now click the point in the cloud…' : 'Click a feature in the frame…') : 'Pick correspondence'}
              </button>
              <ul className="corr-list" aria-label="Correspondences">
                {doc.correspondences.map((c) => (
                  <li key={c.id}>
                    <span>{c.name}</span>
                    <span className="muted small">{c.target.kind === 'track' ? `#${c.target.trackId}` : `px @${c.target.frame}`}</span>
                    <span className="mono small" style={{ color: c.residualPx === null ? undefined : errorColour(c.residualPx) }}>
                      {fmt(c.residualPx)} px
                    </span>
                    <span className="mono small">{fmt(c.residualMm, 0)} mm</span>
                    <button type="button" className="icon remove" aria-label={`Remove ${c.name}`} disabled={!canCam} onClick={() => void run('Removing correspondence', { verb: 'remove_correspondence', id: c.id })}>
                      ×
                    </button>
                  </li>
                ))}
              </ul>
              <div className="seg" role="group" aria-label="Align">
                <button type="button" disabled={!canCam || busy || doc.correspondences.length < 3} onClick={() => void run('Aligning to the LiDAR', { verb: 'align_to_lidar', method: 'similarity' })} title="Scale, rotation and position from 3+ correspondences (Umeyama)">
                  Align
                </button>
                <button type="button" disabled={!canCam || busy || !doc.alignment} onClick={() => void run('Refining with ICP', { verb: 'align_to_lidar', method: 'icp' })} title="Refine the alignment: track points onto the scan's surface (point-to-plane ICP)">
                  ICP
                </button>
                <button type="button" disabled={!canCam || busy || !doc.alignment || doc.correspondences.length < 3} onClick={() => void run('Solving with LiDAR', { verb: 'align_to_lidar', method: 'constrained' })} title="Solve again with the correspondences as constraints, in the scan's coordinates">
                  Solve with LiDAR
                </button>
              </div>
              {!doc.alignment ? <p className="muted small hint">Until it is aligned, the scan is shown at the solve’s size and centre, to pick between. Tie three or more features to it, then Align.</p> : null}
              {doc.alignment ? (
                <p className="small hint">
                  {doc.alignment.method}: RMS {fmt(doc.alignment.rmsMm, 1)} mm / {fmt(doc.alignment.rmsPx)} px · confidence {(doc.alignment.confidence * 100).toFixed(0)} %
                </p>
              ) : null}
            </>
          ) : (
            <p className="muted small hint">No scan? Skip this step: the solve exports on its own.</p>
          )}
        </>
      ),
    },
    {
      id: 'export',
      title: 'Export',
      hint: 'Set which way is up and the scale, then write the camera.',
      done: Boolean(exportedCam),
      waiting: solveRec ? null : 'Solve first (step 3).',
      content: (
        <>
          <details className="sub">
            <summary>Scene orientation: origin, ground, scale</summary>
            <div className="track-grid">
              <label>
                <span className="muted small">Units</span>
                <select aria-label="Scene units" value={doc.coords.units} disabled={!canCam || !solveRec} onChange={(e) => void run('Setting units', { verb: 'set_coordinate_system', units: e.target.value as (typeof SCENE_UNITS)[number] })}>
                  {SCENE_UNITS.map((u) => (
                    <option key={u}>{u}</option>
                  ))}
                </select>
              </label>
              <label>
                <span className="muted small">Exports up</span>
                <select aria-label="Export up axis" value={doc.coords.upAxis} disabled={!canCam || !solveRec} onChange={(e) => void run('Setting the up axis', { verb: 'set_coordinate_system', upAxis: e.target.value as 'y' | 'z' })}>
                  <option value="y">Y-up</option>
                  <option value="z">Z-up</option>
                </select>
              </label>
            </div>
            <div className="seg" role="group" aria-label="Coordinate tools">
              <button type="button" className={tool === 'origin' ? 'on' : undefined} disabled={!canCam || !solveRec} onClick={() => setTool(tool === 'origin' ? 'select' : 'origin')} title="Click a track: it becomes the origin">
                Origin
              </button>
              <button
                type="button"
                className={tool === 'ground' ? 'on' : undefined}
                disabled={!canCam || !solveRec}
                onClick={() => {
                  setTool(tool === 'ground' ? 'select' : 'ground');
                  setPicks([]);
                }}
                title="Click three tracks on the ground"
              >
                Ground {tool === 'ground' ? `${picks.length}/3` : ''}
              </button>
              <button
                type="button"
                className={tool === 'scale' ? 'on' : undefined}
                disabled={!canCam || !solveRec}
                onClick={() => {
                  setTool(tool === 'scale' ? 'select' : 'scale');
                  setPicks([]);
                }}
                title="Click two tracks a known distance apart"
              >
                Scale {tool === 'scale' ? `${picks.length}/2` : ''}
              </button>
            </div>
            {tool === 'scale' && picks.length === 2 ? (
              <div className="row">
                <span className="small">
                  #{picks[0]} ↔ #{picks[1]} =
                </span>
                <input className="tiny" aria-label="Distance" value={scaleDistance} onChange={(e) => setScaleDistance(e.target.value)} />
                <span className="small">{doc.coords.units}</span>
                <button
                  type="button"
                  className="small-button"
                  onClick={() =>
                    void run('Setting the scale', { verb: 'set_coordinate_system', scale: { trackIds: [picks[0]!, picks[1]!], distance: Number(scaleDistance) || 1 } }).then(() => {
                      setPicks([]);
                      setTool('select');
                    })
                  }
                >
                  Set
                </button>
              </div>
            ) : null}
            <p className="muted small hint">
              {[doc.coords.origin.kind !== 'none' ? `origin ${doc.coords.origin.kind === 'track' ? `#${doc.coords.origin.trackId}` : 'point'}` : null, doc.coords.ground ? `ground #${doc.coords.ground.trackIds.join(', #')}` : null, doc.coords.scale ? `scale ${doc.coords.scale.distance} ${doc.coords.units}` : null].filter(Boolean).join(' · ') ||
                'Default: first camera at the origin, Y up.'}
            </p>
            {doc.coords.origin.kind !== 'none' || doc.coords.ground || doc.coords.scale ? (
              <button type="button" className="small-button" disabled={!canCam} onClick={() => void run('Resetting the coordinate system', { verb: 'set_coordinate_system', origin: null, ground: null, scale: null })}>
                Reset
              </button>
            ) : null}
          </details>
          <details className="sub">
            <summary>Formats ({formats.size} of {CAMERA_EXPORT_FORMATS.length})</summary>
            <div className="check-grid">
              {CAMERA_EXPORT_FORMATS.map((f) => (
                <label key={f} className="check">
                  <input
                    type="checkbox"
                    checked={formats.has(f)}
                    onChange={(e) =>
                      setFormats((s) => {
                        const n = new Set(s);
                        if (e.target.checked) n.add(f);
                        else n.delete(f);
                        return n;
                      })
                    }
                  />{' '}
                  {{ nuke: 'Nuke .nk', maya: 'Maya .ma', blender: 'Blender .py', ae: 'After Effects .jsx', usd: 'USD .usda', unreal: 'Unreal 5 .py', unity: 'Unity .cs', houdini: 'Houdini .py', fusion: 'Fusion / Resolve', max: '3ds Max .ms', fbx: 'FBX 7.4 ASCII', chan: '.chan', json: 'JSON', obj: 'Points .obj' }[f]}
                </label>
              ))}
            </div>
            <label className="check">
              <input type="checkbox" checked={stmaps} onChange={(e) => setStmaps(e.target.checked)} /> Lens STMaps (EXR)
            </label>
          </details>
          <button type="button" className="primary big" disabled={!canCam || busy || !solveRec || !session?.exportable} title={session && !session.exportable ? 'Available in the desktop app: exports are written into the shot package on disk.' : undefined} onClick={() => void run('Exporting the camera', { verb: 'export_camera', formats: [...formats], stmaps })}>
            Export camera {versionTag(camVersion)}
          </button>
          <p className="muted small hint">
            {exportedCam ? `${versionTag(camVersion)} written ${exportedCam.writtenAt.replace('T', ' ').slice(0, 16)} by ${exportedCam.by} into ${exportedCam.folder}. Approve the camera track in Details on the right.` : 'Into 06_CAMERA_TRACK with a report and a JSON of the camera and lens. Exporting puts the track up for review.'}
            {session && !session.exportable ? ' Exporting is done in the desktop app.' : ''}
          </p>
          {lockedNote}
        </>
      ),
    },
  ];

  const anyTracked = t2dTracks.some((t) => t.frames.some((f) => f.status === 'tracked'));
  const lost = selT2d ? selT2d.frames.filter((f) => f.status === 'lost').length : 0;
  const t2dConf = selT2d ? selT2d.frames.filter((f) => f.status !== 'key').map((f) => f.confidence) : [];
  const onKeyFrame = Boolean(selT2d?.keys.some((k) => k.frame === frame));
  const nearest2dKey = selT2d?.keys.length ? selT2d.keys.reduce((a, k) => (Math.abs(k.frame - frame) < Math.abs(a.frame - frame) ? k : a)).frame : null;

  const t2dSteps: StepDef[] = [
    {
      id: 'draw',
      title: 'Draw a surface or point',
      hint: 'Click the four corners of a flat surface, or one point.',
      done: t2dTracks.length > 0,
      content: (
        <>
          <div className="seg" role="group" aria-label="New track">
            <button
              type="button"
              className={tool === 'planar' ? 'on' : undefined}
              disabled={!can2d}
              onClick={() => {
                setTool(tool === 'planar' ? 'select' : 'planar');
                setDraft([]);
              }}
              title="Click the surface's four corners on this frame (clockwise from top-left)"
            >
              {tool === 'planar' ? `Corner ${draft.length + 1} of 4…` : 'New planar'}
            </button>
            <button
              type="button"
              className={tool === 'point' ? 'on' : undefined}
              disabled={!can2d}
              onClick={() => {
                setTool(tool === 'point' ? 'select' : 'point');
                setDraft([]);
              }}
              title="Click a feature to track"
            >
              New point
            </button>
          </div>
          <p className="muted small hint">Planar: clockwise from the top-left corner. Esc cancels.</p>
          {t2dTracks.length ? (
            <ul className="roto-parts" aria-label="2D tracks">
              {t2dTracks.map((t) => {
                const conf = t.frames.filter((f) => f.status !== 'key').map((f) => f.confidence);
                return (
                  <li key={t.id} className={t.id === selT2d?.id ? 'selected' : undefined}>
                    <span style={{ color: t.color }}>{t.kind === 'planar' ? '▱' : '✛'}</span>
                    <button type="button" className="part-name" onClick={() => setT2dSelected(t.id)}>
                      {t.name}
                    </button>
                    <span className="muted small part-meta">
                      {t.frames.length} fr · {t.keys.length}◆{conf.length ? ` · ${Math.min(...conf).toFixed(2)}` : ''}
                    </span>
                    <button type="button" className="icon remove" aria-label={`Delete ${t.name}`} disabled={!can2d} onClick={() => void run('Deleting the track', { verb: 'track2d_delete', trackId: t.id })}>
                      ×
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </>
      ),
    },
    {
      id: 'track',
      title: 'Track it',
      hint: 'Follow it from its key frame through the shot.',
      done: anyTracked,
      waiting: selT2d ? null : 'Draw a surface or a point first (step 1).',
      content: selT2d ? (
        <>
          <p className="step-text">
            <b>{selT2d.name}</b>:{' '}
            {onKeyFrame ? (
              'this frame is a key frame.'
            ) : (
              <>
                go to a key frame to track from it.{' '}
                {nearest2dKey !== null ? (
                  <button type="button" className="link" onClick={() => onFrame(nearest2dKey)}>
                    Go to key frame {nearest2dKey}
                  </button>
                ) : null}
              </>
            )}
          </p>
          <button type="button" className="primary big" disabled={!can2d || busy || !onKeyFrame} onClick={() => void run(`Re-tracking ${selT2d.name}`, { verb: 'track2d_track', trackId: selT2d.id, from: frame, direction: 'around' })} title="Track both ways to the neighbouring keys, blended">
            ◀ Track both ways ▶
          </button>
          <div className="seg" role="group" aria-label="Track the surface">
            <button type="button" disabled={!can2d || busy || !onKeyFrame} onClick={() => void run(`Tracking ${selT2d.name}`, { verb: 'track2d_track', trackId: selT2d.id, from: frame, direction: 'backward' })} title="Track backward from this key frame to the previous key">
              ◀ Back
            </button>
            <button type="button" disabled={!can2d || busy || !onKeyFrame} onClick={() => void run(`Re-tracking ${selT2d.name}`, { verb: 'track2d_track', trackId: selT2d.id, from: frame, direction: 'around' })} title="Re-track both ways to the neighbouring keys, blended">
              ◀ Around ▶
            </button>
            <button type="button" disabled={!can2d || busy || !onKeyFrame} onClick={() => void run(`Tracking ${selT2d.name}`, { verb: 'track2d_track', trackId: selT2d.id, from: frame, direction: 'forward' })} title="Track forward from this key frame to the next key">
              Forward ▶
            </button>
          </div>
        </>
      ) : null,
    },
    {
      id: 'fix',
      title: 'Fix drifting frames',
      hint: 'Drag a corner where it slips; re-track around it.',
      done: anyTracked && lost === 0,
      waiting: anyTracked ? null : 'Track first (step 2).',
      content: selT2d ? (
        <>
          <p className="step-text">The strip under the picture shows how sure the tracker is on each frame (red: lost). Drag a corner on the picture to correct a frame: it becomes a key; then track both ways from it (step 2).</p>
          {onKeyFrame && selT2d.keys.length > 1 ? (
            <button type="button" className="small-button" disabled={!can2d} onClick={() => void run('Removing the key', { verb: 'track2d_remove_key', trackId: selT2d.id, frame })}>
              Remove this key
            </button>
          ) : null}
          {state.roto?.parts.length ? (
            <div className="check-col">
              <span className="muted small">Hidden by (roto parts that pass in front)</span>
              {state.roto.parts.map((p) => (
                <label key={p.id} className="check">
                  <input type="checkbox" checked={selT2d.occluders.includes(p.id)} disabled={!can2d} onChange={(e) => void run('Setting occluders', { verb: 'track2d_update', trackId: selT2d.id, occluders: e.target.checked ? [...selT2d.occluders, p.id] : selT2d.occluders.filter((x) => x !== p.id) })} /> {p.name}
                </label>
              ))}
            </div>
          ) : null}
        </>
      ) : null,
    },
    {
      id: 'preview',
      title: 'Preview an insert',
      hint: 'Pin an image or video to the surface to judge the track.',
      optional: true,
      done: Boolean(dropIn),
      waiting: selT2d?.kind === 'planar' ? null : 'Needs a planar surface (step 1).',
      content: (
        <label className="field-col">
          <span className="muted small">Image or video to pin</span>
          <input
            type="file"
            accept="image/*,video/*"
            aria-label="Drop-in image or video"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              if (dropIn) URL.revokeObjectURL(dropIn.url);
              setDropIn({ url: URL.createObjectURL(f), kind: f.type.startsWith('video') ? 'video' : 'image', name: f.name });
            }}
          />
          {dropIn ? (
            <button
              type="button"
              className="small-button"
              onClick={() => {
                URL.revokeObjectURL(dropIn.url);
                setDropIn(null);
              }}
            >
              Remove {dropIn.name}
            </button>
          ) : null}
        </label>
      ),
    },
    {
      id: 'export',
      title: 'Export',
      hint: 'Corner pins and track data for the compositor.',
      done: Boolean(exported2d),
      waiting: t2dTracks.length ? null : 'Draw and track first.',
      content: (
        <>
          <div className="check-grid">
            {TRACK2D_EXPORT_FORMATS.map((f) => (
              <label key={f} className="check">
                <input
                  type="checkbox"
                  checked={t2dFormats.has(f)}
                  onChange={(e) =>
                    setT2dFormats((s) => {
                      const n = new Set(s);
                      if (e.target.checked) n.add(f);
                      else n.delete(f);
                      return n;
                    })
                  }
                />{' '}
                {{ nuke: 'Nuke CornerPin2D', ae: 'After Effects .jsx', mocha: 'AE keyframe text', json: 'JSON' }[f]}
              </label>
            ))}
          </div>
          <button type="button" className="primary big" disabled={!can2d || busy || !t2dTracks.length || !session?.exportable} title={session && !session.exportable ? 'Available in the desktop app: track data is written into the shot package on disk.' : undefined} onClick={() => void run('Exporting 2D tracks', { verb: 'track2d_export', formats: [...t2dFormats] })}>
            Export tracks {versionTag(t2dVersion)}
          </button>
          <p className="muted small hint">
            {exported2d ? `${versionTag(t2dVersion)} written into ${exported2d.folder}.` : 'Into 05_TRACKS_2D. Exporting puts the 2D track task up for review.'}
            {session && !session.exportable ? ' Exporting is done in the desktop app.' : ''}
          </p>
          {lockedNote}
        </>
      ),
    },
  ];

  const rms = solveRec?.stats.rms;
  const info =
    sub === 'camera' ? (
      <>
        <Stats>
          <Stat label="RMS error" value={rms !== undefined ? rms.toFixed(2) : '—'} unit={rms !== undefined ? ' px' : undefined} tone={rms === undefined ? undefined : rms < 0.8 ? 'ok' : rms < 1.5 ? 'warn' : 'bad'} title="Average distance between the tracks and the solved points, in pixels. Under 1 px is good." />
          <Stat label="Focal length" value={solveRec ? (solveRec.intrinsics.focalMm ? solveRec.intrinsics.focalMm.toFixed(1) : solveRec.intrinsics.focalPx.toFixed(0)) : doc.lens.focalMm ? String(doc.lens.focalMm) : '—'} unit={solveRec ? (solveRec.intrinsics.focalMm ? ' mm' : ' px') : doc.lens.focalMm ? ' mm' : undefined} title={solveRec ? 'Solved' : 'From the lens settings'} />
          <Stat label="Frames solved" value={solveRec ? solveRec.stats.framesSolved : '—'} unit={solveRec ? ` / ${solveRec.stats.framesTotal}` : undefined} tone={solveRec ? (solveRec.stats.framesSolved === solveRec.stats.framesTotal ? 'ok' : 'warn') : undefined} />
          <Stat label="Confidence" value={solveRec ? (solveRec.stats.confidence * 100).toFixed(0) : '—'} unit={solveRec ? ' %' : undefined} tone={solveRec ? (solveRec.stats.confidence >= 0.7 ? 'ok' : 'warn') : undefined} />
          <Stat label="Tracks" value={solveRec ? solveRec.stats.tracksUsed : doc.trackSet ? doc.trackSet.tracks : '—'} title={solveRec ? 'Used by the solve' : 'Tracked'} />
          <Stat label="Exported" value={exportedCam ? versionTag(camVersion) : 'not yet'} tone={exportedCam ? 'ok' : undefined} />
        </Stats>
        {solveRec ? (
          <div className="info-notes">
            {doc.solves.length > 1 ? <p className="info-line">Solve {solveRec.number} of {doc.solves.length}</p> : null}
            {solveRec.stats.nodal ? <p className="info-line">Nodal (the camera only turned)</p> : null}
            {solveRec.stats.warnings.map((w) => (
              <p key={w} className="warn">
                ⚠ {w}
              </p>
            ))}
            {doc.alignment ? (
              <p className="info-line">
                Aligned to LiDAR: {fmt(doc.alignment.rmsMm, 1)} mm · {(doc.alignment.confidence * 100).toFixed(0)} %
              </p>
            ) : null}
          </div>
        ) : null}
        {props.taskInfo}
      </>
    ) : (
      <>
        <Stats>
          <Stat label="Tracks" value={t2dTracks.length} />
          <Stat label="Frames tracked" value={selT2d ? selT2d.frames.filter((f) => f.status !== 'lost').length : '—'} unit={selT2d ? ` / ${Math.max(0, last - first + 1)}` : undefined} />
          <Stat label="Lowest confidence" value={t2dConf.length ? Math.min(...t2dConf).toFixed(2) : '—'} tone={t2dConf.length ? (Math.min(...t2dConf) < 0.6 ? 'warn' : 'ok') : undefined} />
          <Stat label="Lost frames" value={selT2d ? lost : '—'} tone={selT2d ? (lost ? 'bad' : anyTracked ? 'ok' : undefined) : undefined} />
          <Stat label="Key frames" value={selT2d ? selT2d.keys.length : '—'} />
          <Stat label="Exported" value={exported2d ? versionTag(t2dVersion) : 'not yet'} tone={exported2d ? 'ok' : undefined} />
        </Stats>
        {selT2d ? (
          <p className="info-line">
            Selected: <b style={{ color: selT2d.color }}>{selT2d.name}</b> ({selT2d.kind})
          </p>
        ) : null}
        {props.taskInfo}
      </>
    );

  return (
    <ModuleLayout
      label={sub === 'camera' ? 'Camera Track' : '2D Track'}
      steps={
        <>
          {aiButton}
          <StepList steps={sub === 'camera' ? camSteps : t2dSteps} resetKey={`${shotId}:${sub}`} />
        </>
      }
      info={info}
      ai={{
        open: aiOpen,
        onToggle: setAiOpen,
        panel: <AiAssistant api={api} project={project} shotId={shotId} projectKey={projectKey} canEdit={canEdit} actor={actor} onTrack={onTrack} notify={notify} onFrame={onFrame} onClose={() => setAiOpen(false)} />,
      }}
    >
      <div className="viewer track-view" aria-label={`${sub === 'camera' ? 'Camera Track' : '2D Track'} — ${state.vfxShotId ?? shotId}`}>
        <div className="viewer-toolbar roto-toolbar">
          {sub === 'camera' ? (
            <>
              <label className="check">
                <input type="checkbox" checked={showTrails} onChange={(e) => setShowTrails(e.target.checked)} /> Trails
              </label>
              <span className="muted legend">
                Error <i style={{ background: errorColour(0.2) }} /> &lt; 0.5 px <i style={{ background: errorColour(1) }} /> 1 px <i style={{ background: errorColour(2) }} /> 2 px+
              </span>
              <div className="spacer" />
              {tool !== 'select' ? <span className="tool-note">{toolNote(tool, picks.length, Boolean(corrFeature))} · Esc cancels</span> : null}
              <button type="button" className={show3d ? 'on' : undefined} aria-pressed={show3d} onClick={() => setShow3d((s) => !s)} title="3D view (3)">
                3D view
              </button>
            </>
          ) : (
            <>
              <span className="tool-note">{tool === 'planar' ? `Click corner ${draft.length + 1} of 4, clockwise from the top-left.` : tool === 'point' ? 'Click the feature to track.' : 'Drag a corner to correct this frame. Esc cancels.'}</span>
              <div className="spacer" />
            </>
          )}
        </div>

        <div className={`track-views${show3d && sub === 'camera' ? ' split' : ''}`}>
          <div className="viewer-stage roto-stage" ref={stageRef} data-frame={frame}>
            {message ? <p className="viewer-message">{message}</p> : null}
            {!session && !sessionError ? <p className="viewer-message muted">Opening…</p> : null}
            {current && 'error' in current ? <p className="viewer-message error">{current.error}</p> : null}
            {session?.available ? (
              <div className="roto-frame" style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
                {current && 'data' in current ? <img className="frame" src={current.data} alt={`Frame ${frame}`} draggable={false} /> : null}
                {sub === '2d' && dropIn && dropTransform ? (
                  dropIn.kind === 'image' ? (
                    <img className="drop-in" src={dropIn.url} alt="" style={{ transform: dropTransform }} />
                  ) : (
                    <video ref={videoRef} className="drop-in" src={dropIn.url} muted playsInline style={{ transform: dropTransform }} />
                  )
                ) : null}
                <canvas ref={overlayRef} className={`track-overlay tool-${tool}`} aria-label="Tracks on the frame" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
              </div>
            ) : null}
            {session?.sample ? <span className="stage-tag">sample frames</span> : null}
          </div>
          {show3d && sub === 'camera' ? (
            <PointCloudView
              clouds={clouds3d}
              tracks={tracks3d}
              cameras={cams3d}
              currentFrame={frame}
              fovDeg={solveRec && plate ? (2 * Math.atan(plate.width / (2 * solveRec.intrinsics.focalPx)) * 180) / Math.PI : 50}
              aspect={plate ? plate.width / plate.height : 16 / 9}
              marks={marks3d}
              onPick={(p) => void onPick3d(p)}
              {...(tool === 'corr' ? { pickOnly: corrFeature ? ('clouds' as const) : ('tracks' as const) } : {})}
              frameKey={`${viewKey}|${JSON.stringify(doc.coords.transform)}`}
            />
          ) : null}
        </div>

        <div className="viewer-info roto-info">
          <span className="mono frame-no" aria-label="Frame">
            {frame}
          </span>
          {sub === 'camera' ? (
            <>
              {solveFrames.length ? (
                (() => {
                  const fr = solveFrames.find((f) => f.frame === frame);
                  return fr ? <span style={{ color: fr.solved ? errorColour(fr.rms) : 'var(--danger)' }}>{fr.solved ? `${fr.rms.toFixed(3)} px over ${fr.tracks} tracks${fr.keyframe ? ' · ◆ keyframe' : ''}` : 'not solved'}</span> : null;
                })()
              ) : (
                <span className="muted">{doc.trackSet ? 'not solved yet' : 'no tracks yet'}</span>
              )}
              {selectedTrack !== null ? (
                <span>
                  track #{selectedTrack}
                  {errById.has(selectedTrack) ? ` · ${errById.get(selectedTrack)!.toFixed(3)} px` : ''}
                </span>
              ) : null}
            </>
          ) : selT2d ? (
            (() => {
              const r = selT2d.frames.find((f) => f.frame === frame);
              return <span>{r ? `${selT2d.name}: ${r.status}${r.status === 'tracked' ? ` · confidence ${r.confidence.toFixed(2)}` : ''}` : `${selT2d.name}: not tracked on this frame`}</span>;
            })()
          ) : null}
        </div>

        {sub === 'camera' ? <ErrorGraph frames={solveFrames} first={first} last={last} current={frame} onFrame={onFrame} /> : null}
        {sub === '2d' && selT2d ? (
          <div className="roto-timeline" aria-label="Confidence timeline">
            <div className="roto-cells">
              {Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => first + i).map((f) => {
                const r = selT2d.frames.find((x) => x.frame === f);
                const isKey = selT2d.keys.some((k) => k.frame === f);
                return (
                  <button
                    key={f}
                    type="button"
                    className={['cell', f === frame ? 'current' : '', r?.status === 'lost' ? 'flagged' : ''].filter(Boolean).join(' ')}
                    style={{ background: r ? (r.status === 'lost' ? '#5a2020' : `hsl(${Math.round(r.confidence * 120)} 60% 45%)`) : undefined }}
                    aria-label={`Frame ${f}`}
                    title={`${f}${r ? ` · ${r.status} · ${r.confidence.toFixed(2)}` : ''}`}
                    onClick={() => onFrame(f)}
                  >
                    {isKey ? (
                      <span className="key-mark" style={{ color: selT2d.color }}>
                        ◆
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
        <div className="transport track-transport">
          <button type="button" aria-label="Back 10 frames" title="Back 10 frames (Shift+←)" onClick={() => onFrame(Math.max(first, frame - 10))}>
            −10
          </button>
          <button type="button" aria-label="Back 1 frame" title="Back 1 frame (←)" onClick={() => onFrame(Math.max(first, frame - 1))}>
            −1
          </button>
          <button type="button" aria-label="Forward 1 frame" title="Forward 1 frame (→)" onClick={() => onFrame(Math.min(last, frame + 1))}>
            +1
          </button>
          <button type="button" aria-label="Forward 10 frames" title="Forward 10 frames (Shift+→)" onClick={() => onFrame(Math.min(last, frame + 10))}>
            +10
          </button>
          <div className="scrub">
            <input type="range" aria-label="Scrub" min={first} max={last} value={frame} onChange={(e) => onFrame(Number(e.target.value))} />
          </div>
          <span className="mono muted range">
            {first}–{last}
          </span>
        </div>
      </div>
    </ModuleLayout>
  );
}

/** What the active picking tool wants next, in the viewer's toolbar. */
function toolNote(tool: Tool, picks: number, corrFeature: boolean): string {
  switch (tool) {
    case 'detect':
      return 'Drag a rectangle to add features there';
    case 'include':
      return 'Drag a rectangle: features only inside';
    case 'exclude':
      return 'Drag a rectangle to keep features out';
    case 'origin':
      return 'Click a track: it becomes the origin';
    case 'ground':
      return `Click three tracks on the ground (${picks}/3)`;
    case 'scale':
      return `Click two tracks a known distance apart (${picks}/2)`;
    case 'corr':
      return corrFeature ? 'Now click the same point in the cloud' : 'Click a feature in the frame';
    default:
      return '';
  }
}

/** Per-frame RMS reprojection error of the active solve (§10, "error graph"). */
export function ErrorGraph({ frames, first, last, current, onFrame }: { frames: { frame: number; solved: boolean; rms: number; tracks: number; keyframe: boolean }[]; first: number; last: number; current: number; onFrame(f: number): void }) {
  const n = Math.max(1, last - first + 1);
  const max = Math.max(1, ...frames.map((f) => f.rms));
  const W = 1000;
  const H = 64;
  const bw = W / n;
  return (
    <div className="error-graph" aria-label="Error graph">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onFrame(Math.round(first + ((e.clientX - r.left) / r.width) * (n - 1)));
        }}
      >
        {[0.5, 1].filter((v) => v < max).map((v) => (
          <line key={v} x1={0} x2={W} y1={H - (v / max) * (H - 4)} y2={H - (v / max) * (H - 4)} className="grid" />
        ))}
        {frames.map((f) => {
          const x = (f.frame - first) * bw;
          if (!f.solved) return <rect key={f.frame} x={x} y={0} width={Math.max(1, bw - 0.5)} height={H} fill="rgba(224,122,107,0.25)" />;
          const h = Math.max(1, (f.rms / max) * (H - 4));
          return <rect key={f.frame} x={x} y={H - h} width={Math.max(1, bw - 0.5)} height={h} fill={errorColour(f.rms)} />;
        })}
        {frames.filter((f) => f.keyframe).map((f) => (
          <rect key={`k${f.frame}`} x={(f.frame - first) * bw} y={0} width={Math.max(1, bw - 0.5)} height={3} fill="#f2a33a" />
        ))}
        <line x1={(current - first + 0.5) * bw} x2={(current - first + 0.5) * bw} y1={0} y2={H} className="cursor" />
      </svg>
      <div className="roto-scale mono small muted">
        <span>{first}</span>
        <span>{frames.length ? `per-frame RMS reprojection error · max ${max.toFixed(2)} px · ◆ keyframes in amber` : 'Solve to see the error per frame'}</span>
        <span>{last}</span>
      </div>
    </div>
  );
}
