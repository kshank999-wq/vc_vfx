import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { defaultMode, modeLabel, sourceUrl, type CameraBody, type CameraBodyInput, type CameraCategory, type CameraMode, type CamTrackDocument } from '@vcvfx/domain';

/**
 * The camera picker of the Track workspace (addendum 06, "Camera database"):
 * a searchable list of camera bodies grouped by maker, with category chips;
 * then the body's recording modes ("4.6K 3:2 Open Gate — 27.99 × 19.22 mm ·
 * 4608×3164"). Unverified figures carry a "verify" badge whose popover gives
 * the notes and the source (a link: the system browser on the desktop, a new
 * tab in the preview). Multi-camera drones and phones are one entry per
 * camera; choosing a fixed-lens one fills the focal (the command does it).
 * "Custom…" adds a body (sensor mm and pixels) to the project's cameras.
 */

export const CATEGORY_CHIPS: { id: string; label: string; categories: CameraCategory[] }[] = [
  { id: 'cinema', label: 'Cinema', categories: ['cinema'] },
  { id: 'mirrorless', label: 'Mirrorless', categories: ['mirrorless'] },
  { id: 'drone', label: 'Drone', categories: ['drone', 'gimbal'] },
  { id: 'broadcast', label: 'Broadcast', categories: ['broadcast'] },
  { id: 'phone', label: 'Phone', categories: ['phone'] },
  { id: 'action', label: 'Action', categories: ['action'] },
];

const lower = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
const compact = (s: string) => lower(s).replace(/[^a-z0-9]+/g, '');

/** Bodies whose maker, model, aliases or sensor format contain every word of the query. */
export function searchCameras(bodies: readonly CameraBody[], query: string, chip: string | null): CameraBody[] {
  const cats = chip ? (CATEGORY_CHIPS.find((c) => c.id === chip)?.categories ?? null) : null;
  const words = lower(query).split(/\s+/).filter(Boolean);
  return bodies.filter((b) => {
    if (cats && !b.custom && !cats.includes(b.category)) return false;
    if (!words.length) return true;
    const hay = lower([b.make, b.model, b.sensorFormat, ...b.aliases].join(' '));
    const hayC = compact(hay);
    return words.every((w) => hay.includes(w) || (compact(w).length > 0 && hayC.includes(compact(w))));
  });
}

/** Grouped by maker in the database's order; the project's own cameras first. */
export function groupCameras(bodies: readonly CameraBody[]): { make: string; bodies: CameraBody[] }[] {
  const groups = new Map<string, CameraBody[]>();
  for (const b of bodies) {
    const k = b.custom ? 'Project cameras' : b.make;
    groups.set(k, [...(groups.get(k) ?? []), b]);
  }
  return [...groups].map(([make, list]) => ({ make, bodies: list })).sort((a, b) => (a.make === 'Project cameras' ? -1 : b.make === 'Project cameras' ? 1 : 0));
}

const customId = (make: string, model: string, taken: readonly CameraBody[]) => {
  const base = `custom-${`${make}-${model}`.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`.slice(0, 56).replace(/-+$/, '') || 'custom';
  let id = base;
  for (let n = 2; taken.some((b) => b.id === id); n += 1) id = `${base}-${n}`;
  return id;
};

function VerifyBadge({ body, mode }: { body: CameraBody; mode: CameraMode | null }) {
  const url = sourceUrl(body);
  const notes = [mode?.notes, body.verifiedNotes].filter(Boolean).join(' — ');
  const ref = useRef<HTMLSpanElement | null>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Fixed-positioned so the side panel's scroll box does not clip it; stays while the pointer is on it (to reach the link).
  const show = () => {
    if (timer.current) clearTimeout(timer.current);
    const r = ref.current?.getBoundingClientRect();
    if (r) setAt({ left: Math.max(8, Math.min(r.left, window.innerWidth - 300)), top: r.bottom + 4 });
  };
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setAt(null), 200);
  };
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return (
    <span ref={ref} className="verify-badge" tabIndex={0} aria-label={`Not verified: ${notes || 'check against the spec sheet'}`} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      verify
      {at ? (
        <span className="verify-pop" role="tooltip" style={{ left: at.left, top: at.top }} onMouseEnter={show} onMouseLeave={hide}>
          <b>Not verified against the manufacturer.</b> {notes || 'Check the figures against the camera’s spec sheet, or override the film back.'}
          {url ? (
            <>
              {' '}
              <a href={url} target="_blank" rel="noopener noreferrer" onFocus={show} onBlur={hide}>
                Source ↗
              </a>
            </>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

export interface CameraPickerProps {
  bodies: readonly CameraBody[];
  camera: CamTrackDocument['camera'];
  disabled: boolean;
  /** The handoff's camera text for this shot ("Sony VENICE 2 · 8.6K 3:2"), if any. */
  handoffText: string | null;
  onPick(cameraId: string, modeId: string): void;
  onCustom(body: Omit<CameraBodyInput, 'custom'>): void;
}

export function CameraPicker(props: CameraPickerProps) {
  const { bodies, camera, disabled } = props;
  const body = bodies.find((b) => b.id === camera?.cameraId) ?? null;
  const mode = body?.modes.find((m) => m.id === camera?.modeId) ?? null;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [chip, setChip] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [custom, setCustom] = useState<null | { make: string; model: string; mode: string; w: string; h: string; pw: string; ph: string }>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);

  const results = useMemo(() => searchCameras(bodies, query, chip), [bodies, query, chip]);
  const groups = useMemo(() => groupCameras(results), [results]);
  const flat = useMemo(() => groups.flatMap((g) => g.bodies), [groups]);
  // The last row is "Custom…".
  const rows = flat.length + 1;

  // The list is fixed-positioned under the field so the side panel's scroll does not clip it.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = inputRef.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.min(Math.max(r.width, 380), window.innerWidth - r.left - 8);
      setPos({ left: r.left, top: r.bottom + 2, width, maxHeight: Math.max(160, window.innerHeight - r.bottom - 16) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!inputRef.current?.parentElement?.contains(t) && !listRef.current?.contains(t)) setOpen(false);
    };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [open]);

  useEffect(() => setActive(0), [query, chip]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-row="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (row: number) => {
    setOpen(false);
    setQuery('');
    if (row >= flat.length) {
      setCustom({ make: '', model: '', mode: 'Full', w: '', h: '', pw: '', ph: '' });
      return;
    }
    const b = flat[row]!;
    props.onPick(b.id, defaultMode(b).id);
  };

  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(rows - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter' && open) {
      e.preventDefault();
      choose(active);
    } else if (e.key === 'Escape' && open) {
      e.stopPropagation();
      setOpen(false);
    }
  };

  const fromHandoff = camera?.source === 'handoff' ? (camera.handoffText ?? camera.label) : null;
  const num = (s: string) => Number(s.replace(',', '.'));
  const customOk = custom && custom.make.trim() && custom.model.trim() && num(custom.w) > 1 && num(custom.w) < 100 && num(custom.h) > 1 && num(custom.h) < 100 && Number.isInteger(num(custom.pw)) && num(custom.pw) > 0 && Number.isInteger(num(custom.ph)) && num(custom.ph) > 0;
  let row = -1;

  return (
    <div className="camera-picker">
      <label className="field-col">
        <span className="muted small">Camera</span>
        <input
          ref={inputRef}
          role="combobox"
          aria-label="Camera body"
          aria-expanded={open}
          aria-controls="camera-picker-list"
          aria-activedescendant={open ? `camera-row-${active}` : undefined}
          aria-autocomplete="list"
          disabled={disabled}
          placeholder={body ? `${body.make} ${body.model}` : (camera?.label ?? 'Search cameras… (e.g. venice, mavic, fx3)')}
          value={open ? query : body ? `${body.make} ${body.model}` : (camera?.label ?? '')}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={onKey}
        />
      </label>
      {open && pos ? (
        <div ref={listRef} id="camera-picker-list" className="camera-list" role="listbox" aria-label="Cameras" style={{ left: pos.left, top: pos.top, width: pos.width, maxHeight: pos.maxHeight }}>
          <div className="chips camera-chips" role="group" aria-label="Category">
            <button type="button" className={`chip${chip === null ? ' on' : ''}`} onClick={() => setChip(null)}>
              All
            </button>
            {CATEGORY_CHIPS.map((c) => (
              <button key={c.id} type="button" className={`chip${chip === c.id ? ' on' : ''}`} aria-pressed={chip === c.id} onClick={() => setChip((x) => (x === c.id ? null : c.id))}>
                {c.label}
              </button>
            ))}
          </div>
          <div className="camera-rows">
            {groups.map((g) => (
              <div key={g.make} role="group" aria-label={g.make}>
                <div className="camera-group">{g.make}</div>
                {g.bodies.map((b) => {
                  row += 1;
                  const r = row;
                  const dm = defaultMode(b);
                  return (
                    <div
                      key={b.id}
                      id={`camera-row-${r}`}
                      data-row={r}
                      role="option"
                      aria-selected={b.id === body?.id}
                      className={`camera-row${r === active ? ' active' : ''}${b.id === body?.id ? ' current' : ''}`}
                      onPointerEnter={() => setActive(r)}
                      onPointerDown={(e) => e.preventDefault()}
                      onClick={() => choose(r)}
                    >
                      <span className="camera-name">{b.model}</span>
                      <span className="camera-meta muted small">
                        {[b.sensorFormat, `${b.modes.length} mode${b.modes.length === 1 ? '' : 's'}`, b.fixedFocalMm ? `fixed ${b.fixedFocalMm} mm${b.equivFocalMm ? ` (${b.equivFocalMm} mm eq.)` : ''}` : null].filter(Boolean).join(' · ')}
                      </span>
                      {!b.verified || !dm.verified ? (
                        <span className="verify-badge static" title={[dm.notes, b.verifiedNotes].filter(Boolean).join(' — ') || 'Not verified against the manufacturer'}>
                          verify
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ))}
            {!flat.length ? <p className="muted small camera-none">No camera matches “{query}”.</p> : null}
            <div
              id={`camera-row-${flat.length}`}
              data-row={flat.length}
              role="option"
              aria-selected={false}
              className={`camera-row custom-row${active === flat.length ? ' active' : ''}`}
              onPointerEnter={() => setActive(flat.length)}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => choose(flat.length)}
            >
              <span className="camera-name">Custom…</span>
              <span className="camera-meta muted small">type the sensor size and pixels; saved to this project</span>
            </div>
          </div>
        </div>
      ) : null}

      {custom ? (
        <div className="camera-custom" role="group" aria-label="Custom camera">
          <div className="track-grid">
            <label>
              <span className="muted small">Make</span>
              <input aria-label="Custom make" value={custom.make} onChange={(e) => setCustom({ ...custom, make: e.target.value })} />
            </label>
            <label>
              <span className="muted small">Model</span>
              <input aria-label="Custom model" value={custom.model} onChange={(e) => setCustom({ ...custom, model: e.target.value })} />
            </label>
            <label>
              <span className="muted small">Sensor width (mm)</span>
              <input aria-label="Sensor width mm" inputMode="decimal" value={custom.w} onChange={(e) => setCustom({ ...custom, w: e.target.value })} />
            </label>
            <label>
              <span className="muted small">Sensor height (mm)</span>
              <input aria-label="Sensor height mm" inputMode="decimal" value={custom.h} onChange={(e) => setCustom({ ...custom, h: e.target.value })} />
            </label>
            <label>
              <span className="muted small">Width (px)</span>
              <input aria-label="Width px" inputMode="numeric" value={custom.pw} onChange={(e) => setCustom({ ...custom, pw: e.target.value })} />
            </label>
            <label>
              <span className="muted small">Height (px)</span>
              <input aria-label="Height px" inputMode="numeric" value={custom.ph} onChange={(e) => setCustom({ ...custom, ph: e.target.value })} />
            </label>
          </div>
          <label className="field-col">
            <span className="muted small">Mode name</span>
            <input aria-label="Custom mode name" value={custom.mode} onChange={(e) => setCustom({ ...custom, mode: e.target.value })} />
          </label>
          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={!customOk || disabled}
              onClick={() => {
                if (!custom || !customOk) return;
                props.onCustom({
                  id: customId(custom.make, custom.model, bodies),
                  make: custom.make.trim(),
                  model: custom.model.trim(),
                  category: 'other',
                  aliases: [],
                  source: 'Entered by hand',
                  modes: [{ id: 'custom', name: custom.mode.trim() || 'Full', filmBackMm: { width: num(custom.w), height: num(custom.h) }, px: { width: num(custom.pw), height: num(custom.ph) }, verified: false, aliases: [] }],
                });
                setCustom(null);
              }}
            >
              Save &amp; use
            </button>
            <button type="button" onClick={() => setCustom(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {body ? (
        <label className="field-col">
          <span className="muted small">Recording mode</span>
          <select aria-label="Recording mode" value={camera?.modeId ?? ''} disabled={disabled} onChange={(e) => props.onPick(body.id, e.target.value)}>
            {!mode ? <option value="">{camera ? `${camera.filmBackMm.width} × ${camera.filmBackMm.height} mm (from the handoff)` : 'Choose a mode…'}</option> : null}
            {body.modes.map((m) => (
              <option key={m.id} value={m.id}>
                {modeLabel(m)}
                {m.verified ? '' : ' (unverified)'}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <p className="muted small hint camera-status">
        {camera ? (
          <>
            Film back {camera.filmBackMm.width} × {camera.filmBackMm.height} mm{camera.sensorPx ? ` · ${camera.sensorPx.width}×${camera.sensorPx.height}` : ''}
            {mode && mode.anamorphicSqueeze !== 1 ? ` · ${mode.anamorphicSqueeze}× anamorphic raster` : ''}
            {camera.verified ? ' · verified ' : ' '}
            {body && !camera.verified ? <VerifyBadge body={body} mode={mode} /> : null}
            {!body && !camera.verified ? '· not verified' : null}
          </>
        ) : (
          'No camera: a nominal 36 mm film back is used and the focal length is solved in pixels.'
        )}
      </p>
      {body?.fixedFocalMm ? (
        <p className="muted small hint">
          Fixed lens: {body.fixedFocalMm} mm{body.equivFocalMm ? ` (${body.equivFocalMm} mm equivalent)` : ''} — {body.fixedFocalNotes || 'derived from the 35 mm equivalent; check it against the clip metadata.'}
        </p>
      ) : null}
      {fromHandoff ? (
        <p className="small hint matched-from">
          matched from handoff: <span className="mono">{fromHandoff}</span>
        </p>
      ) : props.handoffText && !camera ? (
        <p className="small hint matched-from muted">
          The handoff says <span className="mono">{props.handoffText}</span>, which does not match a camera with confidence — choose it above.
        </p>
      ) : null}
    </div>
  );
}
