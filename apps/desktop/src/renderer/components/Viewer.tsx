import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { contactSheetFrames, encodingLabel, handoffShot, serializeProject, shotState, versionTag, type Project, type ViewTransformId } from '@vcvfx/domain';
import type { ViewerFrame, ViewerLayer, ViewerSources, VcvfxApi } from '../../shared/bridge';
import { clampFrame, viewerTimeline } from '../../shared/viewer';

/**
 * The frame viewer and contact sheet (master spec §5.2, §15.4; addendum 03),
 * the picture in the middle of the Plates, Key and Deliver tabs (addendum 08).
 *
 * Shows a shot's source or its plates, frame by frame in delivered numbering
 * with the clip's timecode, an A/B wipe or toggle between source and plate,
 * and a contact sheet of representative frames. The View menu is a display
 * transform for looking only; it never touches a plate. Frames come from
 * main (`viewerFrame`), which extracts and caches them; this component only
 * asks, shows and prefetches. The frame is the App's, shared by the tabs.
 */

export interface ViewerProps {
  api: VcvfxApi;
  project: Project;
  shotId: string;
  projectKey: string;
  canEdit: boolean;
  frame: number;
  onFrame(frame: number): void;
  /** Esc: back to the Shots tab. */
  onClose?(): void;
  onToggleMark(frame: number, viewing: string, note: string): void;
  /** Hide "Mark for correction" (it belongs to reviewing plates). */
  noMarks?: boolean;
  /** Extra controls at the end of the viewer's toolbar. */
  toolbarExtra?: ReactNode;
}

type Compare = 'off' | 'wipe' | 'toggle';
type Loaded = { url: string; viewLabel: string } | { error: string };

const SIZES = [480, 960, 1280, 1920];
const TILE_WIDTH = 320;
const sizeFor = (px: number) => SIZES.find((s) => s >= px) ?? 1920;

export function Viewer({ api, project, shotId, projectKey, canEdit, frame, onFrame, onClose, onToggleMark, noMarks, toolbarExtra }: ViewerProps) {
  const shot = handoffShot(project, shotId);
  const state = shotState(project, shotId);
  const timeline = useMemo(() => viewerTimeline(project, shotId), [project, shotId]);
  // One serialisation per project change, shared by every frame request.
  const text = useMemo(() => serializeProject(project), [project]);
  const textRef = useRef(text);
  textRef.current = text;

  const [sources, setSources] = useState<ViewerSources | null>(null);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [layer, setLayer] = useState<ViewerLayer>('source');
  const [version, setVersion] = useState<number | null>(null);
  const [compare, setCompare] = useState<Compare>('off');
  const [showB, setShowB] = useState(false);
  const [wipe, setWipe] = useState(0.5);
  const [view, setView] = useState<ViewTransformId>('rec709');
  const [playing, setPlaying] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [note, setNote] = useState('');
  const [stageWidth, setStageWidth] = useState(1280);
  const [, setTick] = useState(0);
  const loaded = useRef(new Map<string, Loaded>());
  const pending = useRef(new Set<string>());
  const stageRef = useRef<HTMLDivElement | null>(null);
  const setFrame = onFrame;

  // A new shot starts afresh.
  useEffect(() => {
    loaded.current = new Map();
    pending.current = new Set();
    setPlaying(false);
    setCompare('off');
    setLayer('source');
    setNote('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shotId]);

  // What there is to look at.
  const plateVersions = sources?.plates ?? [];
  useEffect(() => {
    let live = true;
    setSources(null);
    setSourcesError(null);
    void api.viewerSources({ text: textRef.current, shotId, projectKey }).then((r) => {
      if (!live) return;
      if (!r.ok) return setSourcesError(r.error);
      setSources(r.data);
      const latest = r.data.plates[r.data.plates.length - 1];
      setVersion(latest ? latest.version : null);
      if (!r.data.source.available && latest) setLayer('plates');
    });
    return () => {
      live = false;
    };
    // Plates appear when they are written: look again when the shot's plate records change.
  }, [api, shotId, projectKey, state?.plates.length]);

  // The stage's width decides the frame size asked for.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => entry && setStageWidth(entry.contentRect.width * (window.devicePixelRatio || 1)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const mainWidth = sizeFor(stageWidth);

  const keyOf = (l: ViewerLayer, v: number | null, f: number, w: number) => `${l}:${v ?? 0}:${view}:${f}:${w}`;
  const want = useCallback(
    (l: ViewerLayer, v: number | null, f: number, w: number, prefetch: boolean): Loaded | undefined => {
      const key = `${l}:${v ?? 0}:${view}:${f}:${w}`;
      const have = loaded.current.get(key);
      if (have || pending.current.has(key)) return have;
      if (l === 'plates' && v === null) return undefined;
      pending.current.add(key);
      void api
        .viewerFrame({ text: textRef.current, shotId, projectKey, layer: l, ...(l === 'plates' && v !== null ? { version: v } : {}), frame: f, view, maxWidth: w, prefetch })
        .then((r) => {
          pending.current.delete(key);
          // A dropped prefetch is simply asked for again when it is needed.
          if (!r.ok && /Prefetch dropped/.test(r.error)) return;
          loaded.current.set(key, r.ok ? { url: (r.data as ViewerFrame).url, viewLabel: r.data.viewLabel } : { error: r.error });
          setTick((t) => t + 1);
        });
      return undefined;
    },
    [api, projectKey, shotId, view],
  );

  const available = (l: ViewerLayer) => (l === 'source' ? Boolean(sources?.source.available) : version !== null && plateVersions.length > 0);
  const comparing = compare !== 'off' && available('source') && available('plates');
  const primary: ViewerLayer = comparing ? (compare === 'toggle' && showB ? 'plates' : 'source') : layer;

  // The frame on screen, and its neighbours fetched ahead.
  const current = available(primary) ? want(primary, version, frame, mainWidth, false) : undefined;
  const second = comparing && compare === 'wipe' ? want('plates', version, frame, mainWidth, false) : undefined;
  useEffect(() => {
    if (!timeline || playing) return;
    const layers: ViewerLayer[] = comparing ? ['source', 'plates'] : [primary];
    for (const d of [1, -1, 2, 10, -10]) {
      const f = clampFrame(timeline, frame + d);
      for (const l of layers) if (available(l)) want(l, version, f, mainWidth, true);
    }
  });

  // Playback at the shot's rate, best effort: a frame is shown once it has arrived.
  const frameRef = useRef(frame);
  frameRef.current = frame;
  useEffect(() => {
    if (!playing || !timeline) return;
    const step = 1000 / timeline.frameRate;
    const timer = setInterval(() => {
      const next = frameRef.current + 1;
      if (next > timeline.last) {
        setPlaying(false);
        return;
      }
      for (let k = 1; k <= 8; k += 1) {
        const f = next + k;
        if (f <= timeline.last && available(primary)) want(primary, version, f, mainWidth, true);
      }
      const ready = !available(primary) || loaded.current.has(keyOf(primary, version, next, mainWidth));
      if (ready) setFrame(next);
      else want(primary, version, next, mainWidth, false);
    }, step);
    return () => clearInterval(timer);
  });

  const go = useCallback((f: number) => timeline && setFrame(clampFrame(timeline, f)), [timeline, setFrame]);

  // Keyboard: ←/→ one frame, Shift ten, Space play, Esc back to the queue.
  const keys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keys.current = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) && e.key !== 'Escape') return;
    if (document.querySelector('.modal') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      setPlaying(false);
      go(frame + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 10 : 1));
    } else if (e.key === ' ') {
      e.preventDefault();
      setPlaying((p) => !p);
    } else if (e.key === 'Escape') {
      if (!onClose) return;
      e.preventDefault();
      onClose();
    } else if ((e.key === 'b' || e.key === 'B') && compare === 'toggle') {
      setShowB((b) => !b);
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const dragWipe = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!comparing || compare !== 'wipe') return;
    if (e.type === 'pointermove' && e.buttons !== 1) return;
    const box = e.currentTarget.getBoundingClientRect();
    if (box.width > 0) setWipe(Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)));
  };

  if (!shot || !state) return <section className="viewer empty">No shot.</section>;
  const name = state.vfxShotId ?? shot.shotId;
  const marks = state.reviewMarks;
  const markHere = marks.find((m) => m.frame === frame);
  const plateLabel = version !== null ? `Plates ${versionTag(version)}` : 'Plates';
  const viewing = primary === 'plates' ? plateLabel.toLowerCase() : 'source';
  const encodingOf = (l: ViewerLayer) => (l === 'source' ? sources?.source.encoding : plateVersions.find((p) => p.version === version)?.encoding) ?? null;
  const viewLabel = current && 'viewLabel' in current ? current.viewLabel : null;
  const sheet = timeline ? contactSheetFrames(timeline.first, timeline.last, 12) : [];
  const unavailable = !available(primary) ? (primary === 'source' ? sources?.source.reason : 'No plates written for this shot yet.') : null;

  const img = (l: Loaded | undefined, alt: string) => (l && 'url' in l ? <img className="frame" src={l.url} alt={alt} draggable={false} /> : null);

  return (
    <section className="viewer" aria-label={`Viewer — ${name}`}>
      <header className="viewer-toolbar">
        <label className="field-inline">
          <span>Show</span>
          <select
            aria-label="Show"
            value={comparing ? 'compare' : layer === 'plates' && version !== null ? `plates:${version}` : 'source'}
            disabled={comparing}
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'source') setLayer('source');
              else {
                setLayer('plates');
                setVersion(Number(v.split(':')[1]));
              }
            }}
          >
            <option value="source" disabled={!sources?.source.available}>
              Source (camera)
            </option>
            {plateVersions.map((p) => (
              <option key={p.version} value={`plates:${p.version}`}>
                Plates {versionTag(p.version)} · {p.format.toUpperCase()}
              </option>
            ))}
            {comparing ? <option value="compare">Source / plates</option> : null}
          </select>
        </label>
        <div className="seg" role="group" aria-label="Compare source and plates">
          {(['off', 'wipe', 'toggle'] as const).map((c) => (
            <button
              key={c}
              type="button"
              className={compare === c ? 'on' : undefined}
              aria-pressed={compare === c}
              disabled={c !== 'off' && !(available('source') && available('plates'))}
              title={c === 'off' ? 'One image' : c === 'wipe' ? 'A/B wipe: source left, plate right — drag across the image' : 'A/B toggle: press B to swap'}
              onClick={() => setCompare(c)}
            >
              {c === 'off' ? 'Single' : c === 'wipe' ? 'Wipe' : 'A/B'}
            </button>
          ))}
        </div>
        <label className="field-inline">
          <span>View</span>
          <select aria-label="View" value={view} onChange={(e) => setView(e.target.value as ViewTransformId)} title="For looking only: never applied to plates">
            <option value="rec709">Rec.709 (approx.)</option>
            <option value="raw">Raw values</option>
          </select>
        </label>
        <div className="spacer" />
        {sources?.sample ? (
          <span className="tag" title="The browser preview has no media; these frames stand in for the shot’s">
            sample frames
          </span>
        ) : null}
        {toolbarExtra}
        <button type="button" className={sheetOpen ? 'on' : undefined} aria-pressed={sheetOpen} onClick={() => setSheetOpen((o) => !o)} title="First and last frames and twelve between">
          Contact sheet
        </button>
      </header>

      <div className="viewer-main">
        <div
          className={`viewer-stage${comparing && compare === 'wipe' ? ' wiping' : ''}`}
          ref={stageRef}
          onPointerDown={dragWipe}
          onPointerMove={dragWipe}
          data-frame={frame}
        >
          {sourcesError ? <p className="viewer-message">{sourcesError}</p> : null}
          {!timeline ? <p className="viewer-message">The frame range is unknown. Read it from the clip first (step 1, Read from clip).</p> : null}
          {timeline && unavailable ? <p className="viewer-message">{unavailable}</p> : null}
          {current && 'error' in current ? <p className="viewer-message error">{current.error}</p> : null}
          {img(current, `${primary === 'source' ? 'Source' : plateLabel} frame ${frame}`)}
          {comparing && compare === 'wipe' ? (
            <>
              <div className="wipe-b" style={{ clipPath: `inset(0 0 0 ${wipe * 100}%)` }}>
                {img(second, `${plateLabel} frame ${frame}`)}
              </div>
              <div className="wipe-line" style={{ left: `${wipe * 100}%` }} aria-hidden="true" />
              <span className="wipe-tag a">A · Source</span>
              <span className="wipe-tag b">B · {plateLabel}</span>
            </>
          ) : null}
          {comparing && compare === 'toggle' ? <span className="wipe-tag a">{showB ? `B · ${plateLabel}` : 'A · Source'} — press B</span> : null}
          {!comparing && current && 'url' in current ? <span className="wipe-tag a">{primary === 'source' ? 'Source' : plateLabel}</span> : null}
          {!current && timeline && !unavailable && !sourcesError ? <p className="viewer-message muted">Reading frame {frame}…</p> : null}
        </div>

        {sheetOpen ? (
          <section className="contact-sheet" aria-label="Contact sheet">
            <header>
              <strong>Contact sheet</strong>
              <span className="muted small">
                {sheet.length} frames, first to last · {primary === 'source' ? 'source' : plateLabel}
                {marks.length ? ` · ${marks.length} marked for correction` : ''}
              </span>
            </header>
            {!available(primary) ? <p className="muted small sheet-empty">Nothing to show for this shot yet.</p> : null}
            {available(primary) ? (
              <ol className="tiles">
                {sheet.map((f) => {
                  const tile = available(primary) ? want(primary, version, f, TILE_WIDTH, false) : undefined;
                  const marked = marks.some((m) => m.frame === f);
                  return (
                    <li key={f} className={[f === frame ? 'current' : '', marked ? 'marked' : ''].filter(Boolean).join(' ') || undefined}>
                      <button type="button" onClick={() => go(f)} aria-label={`Frame ${f}`} title={timeline?.timecode(f) ?? undefined}>
                        <span className="tile-img">{tile && 'url' in tile ? <img src={tile.url} alt="" draggable={false} /> : <span className="tile-wait">{tile && 'error' in tile ? '—' : '…'}</span>}</span>
                        <span className="tile-label mono">
                          {f}
                          {marked ? <span className="tile-mark"> ●</span> : null}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            ) : null}
          </section>
        ) : null}

        <div className="viewer-info">
          <span className="mono frame-no" aria-label="Frame">
            {frame}
          </span>
          {timeline?.timecode(frame) ? <span className="mono muted tc">TC {timeline.timecode(frame)}</span> : null}
          {timeline && (frame < timeline.editorialIn || frame > timeline.editorialOut) ? <span className="tag">handle</span> : null}
          <span className="muted view-label" title="Viewing only: never applied to plates">
            {viewLabel ?? (view === 'raw' ? 'Raw values' : `${encodingLabel(encodingOf(primary))} → Rec.709 (approx.)`)} · viewing only
          </span>
          <div className="spacer" />
          {noMarks ? null : (
            <>
              <input className="mark-note" aria-label="Correction note" placeholder="Note (optional)" value={note} disabled={!canEdit || Boolean(markHere)} onChange={(e) => setNote(e.target.value)} />
              <button
                type="button"
                className={markHere ? 'marked' : undefined}
                aria-pressed={Boolean(markHere)}
                disabled={!canEdit || state.stage !== 'prep'}
                title={markHere ? `Marked by ${markHere.by}${markHere.note ? `: ${markHere.note}` : ''} — click to clear` : 'Add a correction note for this frame to the shot (logged)'}
                onClick={() => {
                  onToggleMark(frame, viewing, markHere ? '' : note);
                  setNote('');
                }}
              >
                {markHere ? '● Marked for correction' : 'Mark for correction'}
              </button>
            </>
          )}
        </div>

        {timeline ? (
          <div className="transport">
            <button type="button" aria-label="First frame" title="First frame" onClick={() => go(timeline.first)}>
              ⏮
            </button>
            <button type="button" aria-label="Back 10 frames" title="Back 10 frames (Shift+←)" onClick={() => go(frame - 10)}>
              −10
            </button>
            <button type="button" aria-label="Back 1 frame" title="Back 1 frame (←)" onClick={() => go(frame - 1)}>
              −1
            </button>
            <button type="button" className="play" aria-label={playing ? 'Pause' : 'Play'} title="Play / pause (Space)" onClick={() => setPlaying((p) => !p)}>
              {playing ? '❚❚' : '▶'}
            </button>
            <button type="button" aria-label="Forward 1 frame" title="Forward 1 frame (→)" onClick={() => go(frame + 1)}>
              +1
            </button>
            <button type="button" aria-label="Forward 10 frames" title="Forward 10 frames (Shift+→)" onClick={() => go(frame + 10)}>
              +10
            </button>
            <button type="button" aria-label="Last frame" title="Last frame" onClick={() => go(timeline.last)}>
              ⏭
            </button>
            <div className="scrub">
              <div
                className="scrub-editorial"
                style={{
                  left: `${((timeline.editorialIn - timeline.first) / Math.max(1, timeline.last - timeline.first)) * 100}%`,
                  width: `${((timeline.editorialOut - timeline.editorialIn) / Math.max(1, timeline.last - timeline.first)) * 100}%`,
                }}
              />
              {marks.map((m) => (
                <span key={m.frame} className="scrub-mark" style={{ left: `${((m.frame - timeline.first) / Math.max(1, timeline.last - timeline.first)) * 100}%` }} title={`${m.frame}${m.note ? `: ${m.note}` : ''}`} />
              ))}
              <input
                type="range"
                aria-label="Scrub"
                min={timeline.first}
                max={timeline.last}
                value={frame}
                onChange={(e) => {
                  setPlaying(false);
                  go(Number(e.target.value));
                }}
              />
            </div>
            <span className="mono muted range">
              {timeline.first}–{timeline.last} · {timeline.frameRate} fps
            </span>
          </div>
        ) : null}
      </div>
    </section>
  );
}
