import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { SHOT_STATUS_LABELS, TASK_STATE_LABELS, handoffShot, shotState, shotStatus, type Project, type QueueRow } from '@vcvfx/domain';
import { MODULES, MODULE_IDS, PREF, moduleStatus, readPref, writePref, type ModuleId, type ModuleStatus } from '../modules';
import { Icon } from './Icons';
import { StatusPill } from './Queue';

/**
 * The frame of the app after addendum 08: module tabs in the top toolbar, a
 * shot bar under them, and every module screen built the same way — numbered
 * steps on the left, the picture in the middle, the numbers that matter on
 * the right.
 */

/** ⌘ on a Mac, Ctrl elsewhere, for tooltips. */
export function modKey(): string {
  const p = typeof navigator !== 'undefined' ? `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}` : '';
  return /Mac|iPhone|iPad/.test(p) ? '⌘' : 'Ctrl+';
}

/** The CSS colour token of a module status, for its dot. */
export function statusTone(s: ModuleStatus): string {
  if (s.kind === 'task') return `task-state-${s.state}`;
  if (s.kind === 'shot') return `status-${s.status}`;
  return 'none';
}
export function statusText(s: ModuleStatus): string {
  if (s.kind === 'task') return TASK_STATE_LABELS[s.state];
  if (s.kind === 'shot') return SHOT_STATUS_LABELS[s.status];
  if (s.kind === 'missing') return 'Not on this shot';
  return '';
}

// ------------------------------------------------------------------ module tabs

export function ModuleTabs({ project, shotId, active, onSelect }: { project: Project | null; shotId: string | null; active: ModuleId; onSelect(id: ModuleId): void }) {
  const mod = modKey();
  return (
    <nav className="module-tabs" role="tablist" aria-label="Modules">
      {MODULE_IDS.map((id, i) => {
        const info = MODULES[id];
        const status = project ? moduleStatus(project, shotId, id) : ({ kind: 'none' } as ModuleStatus);
        const missing = status.kind === 'missing';
        const title = `${info.label} (${mod}${i + 1}) — ${missing ? status.reason : info.blurb}`;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            data-tour={`tab-${id}`}
            aria-label={info.label}
            aria-description={status.kind === 'none' ? undefined : statusText(status)}
            aria-selected={active === id}
            className={['module-tab', active === id ? 'on' : '', missing ? 'missing' : ''].filter(Boolean).join(' ')}
            disabled={!project && id !== 'shots'}
            title={title}
            onClick={() => onSelect(id)}
          >
            <Icon name={id} size={22} />
            <span className="module-tab-label">{info.label}</span>
            {status.kind === 'task' || status.kind === 'shot' ? <span className={`module-dot ${statusTone(status)}`} aria-hidden="true" /> : null}
          </button>
        );
      })}
    </nav>
  );
}

// ------------------------------------------------------------------ shot bar

export function ShotBar({
  project,
  rows,
  shotId,
  module,
  onSelect,
  onMove,
}: {
  project: Project;
  rows: QueueRow[];
  shotId: string;
  module: ModuleId;
  onSelect(shotId: string): void;
  onMove(delta: number): void;
}) {
  const shot = handoffShot(project, shotId);
  const state = shotState(project, shotId);
  if (!shot || !state) return null;
  const index = rows.findIndex((r) => r.shot.shotId === shotId);
  const name = state.vfxShotId ?? shot.shotId;
  const status = moduleStatus(project, shotId, module);
  const mod = modKey();
  const meta = [
    `Scene ${shot.scene}`,
    shot.setup ? `Setup ${shot.setup}` : null,
    shot.take ? `Take ${shot.take}` : null,
    shot.circled ? 'Circle take' : null,
    [shot.camera.body, shot.camera.lens].filter(Boolean).join(' · ') || null,
    shot.clip ?? null,
  ].filter(Boolean);
  return (
    <div className="shot-bar" role="region" aria-label="Current shot">
      <button type="button" className="shot-step" aria-label="Previous shot" title={`Previous shot (${mod}↑)`} disabled={index <= 0} onClick={() => onMove(-1)}>
        <Icon name="prev" />
      </button>
      <div className="shot-bar-name">
        <h2 className="shot-name">{name}</h2>
        <span className="shot-meta">{meta.join(' · ')}</span>
      </div>
      <StatusPill status={shotStatus(state)} />
      {module !== 'deliver' && (status.kind === 'task' || status.kind === 'missing') ? (
        <span className={`pill module-pill ${statusTone(status)}`} title={`${MODULES[module].label} task`}>
          {MODULES[module].label}: {statusText(status)}
        </span>
      ) : null}
      <div className="spacer" />
      <label className="shot-pick">
        <span>Shot</span>
        <select aria-label="Go to shot" value={shotId} onChange={(e) => onSelect(e.target.value)}>
          {rows.some((r) => r.shot.shotId === shotId) ? null : <option value={shotId}>{name}</option>}
          {rows.map((r) => (
            <option key={r.shot.shotId} value={r.shot.shotId}>
              {r.state.vfxShotId ?? r.shot.shotId} — Scene {r.shot.scene}
              {r.shot.take ? ` / Take ${r.shot.take}` : ''}
            </option>
          ))}
        </select>
      </label>
      <span className="shot-count">{index >= 0 ? `${index + 1} of ${rows.length}` : ''}</span>
      <button type="button" className="shot-step" aria-label="Next shot" title={`Next shot (${mod}↓)`} disabled={index < 0 || index >= rows.length - 1} onClick={() => onMove(1)}>
        <Icon name="next" />
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ the three zones

function usePref(key: string): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState(() => readPref(key) === '1');
  return [
    on,
    (v: boolean) => {
      setOn(v);
      writePref(key, v ? '1' : null);
    },
  ];
}

/**
 * Where toasts go: a module screen offers a dock at the top of its viewer, so
 * a toast never sits over the steps or the details panel (and its Approve
 * button). Without a module on screen they fall back to the window.
 */
export const NoticeDock = createContext<(el: HTMLElement | null) => void>(() => {});

export interface SidePanel {
  open: boolean;
  onToggle(open: boolean): void;
  panel: ReactNode;
}

/**
 * One module screen: steps (left), the viewer and its timeline (centre), the
 * numbers (right). Both sides collapse to a strip, remembered per viewer; with
 * `ai`, the right side switches between the numbers and the AI assistant.
 */
export function ModuleLayout({ label, steps, info, ai, children, stepsTitle = 'Steps' }: { label: string; steps: ReactNode; info: ReactNode; ai?: SidePanel; children: ReactNode; stepsTitle?: string }) {
  const [stepsHidden, setStepsHidden] = usePref(PREF.stepsCollapsed);
  const [infoHidden, setInfoHidden] = usePref(PREF.infoCollapsed);
  const right = ai?.open ? 'ai' : 'info';
  const dock = useContext(NoticeDock);
  return (
    <main className={['module', stepsHidden ? 'steps-hidden' : '', infoHidden ? 'info-hidden' : '', right === 'ai' && !infoHidden ? 'ai-open' : ''].filter(Boolean).join(' ')} aria-label={label}>
      {stepsHidden ? (
        <button type="button" className="side-strip left" onClick={() => setStepsHidden(false)} title="Show the steps" aria-label="Show the steps">
          <Icon name="next" size={18} />
          <span>{stepsTitle}</span>
        </button>
      ) : (
        <aside className="steps-panel" aria-label={stepsTitle} data-tour="steps">
          <header className="side-head">
            <h3>{stepsTitle}</h3>
            <button type="button" className="icon" onClick={() => setStepsHidden(true)} title="Hide the steps (more room for the picture)" aria-label="Hide the steps">
              <Icon name="prev" size={18} />
            </button>
          </header>
          <div className="side-scroll">{steps}</div>
        </aside>
      )}
      <section className="module-center" aria-label="Viewer">
        {children}
        <div className="notice-dock" ref={dock} />
      </section>
      {infoHidden ? (
        <button type="button" className="side-strip right" onClick={() => setInfoHidden(false)} title="Show the details" aria-label="Show the details">
          <Icon name="prev" size={18} />
          <span>{ai ? 'Details · AI' : 'Details'}</span>
        </button>
      ) : null}
      {/* Kept mounted while hidden: an AI run carries on, and comes back as it was. */}
      {infoHidden && !ai ? null : (
        <aside className="info-panel" aria-label={right === 'ai' ? 'AI assistant panel' : 'Details'} hidden={infoHidden}>
          <header className="side-head">
            {ai ? (
              <div className="seg side-switch" role="tablist" aria-label="Right panel">
                <button type="button" role="tab" aria-selected={right === 'info'} className={right === 'info' ? 'on' : undefined} onClick={() => ai.onToggle(false)}>
                  <Icon name="info" size={16} /> Details
                </button>
                <button type="button" role="tab" aria-selected={right === 'ai'} className={right === 'ai' ? 'on' : undefined} onClick={() => ai.onToggle(true)}>
                  <Icon name="ai" size={16} /> AI assistant
                </button>
              </div>
            ) : (
              <h3>Details</h3>
            )}
            <span className="spacer" />
            <button type="button" className="icon" onClick={() => setInfoHidden(true)} title="Hide this panel (more room for the picture)" aria-label="Hide the details">
              <Icon name="next" size={18} />
            </button>
          </header>
          {ai ? (
            <div className="side-fill" hidden={right !== 'ai'}>
              {ai.panel}
            </div>
          ) : null}
          {right === 'info' ? <div className="side-scroll">{info}</div> : null}
        </aside>
      )}
    </main>
  );
}

// ------------------------------------------------------------------ steps

export interface StepDef {
  id: string;
  title: string;
  /** One line under the title saying what this step is for. */
  hint?: string;
  done: boolean;
  optional?: boolean;
  /** Shown in place of the body (and the step greyed) until earlier work is there. */
  waiting?: string | null;
  content: ReactNode;
}

/** Numbered steps: the first not yet done is marked as the next one and opened; done steps are ticked. */
export function StepList({ steps, resetKey }: { steps: StepDef[]; resetKey: string }) {
  const current = steps.find((s) => !s.done && !s.optional)?.id ?? null;
  const [open, setOpen] = useState<Set<string>>(() => new Set(current ? [current] : steps.slice(0, 1).map((s) => s.id)));
  useEffect(() => {
    setOpen(new Set(current ? [current] : steps.slice(0, 1).map((s) => s.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);
  // When a step is finished, fold the finished ones away and open the next.
  const [lastCurrent, setLastCurrent] = useState(current);
  if (current !== lastCurrent) {
    setLastCurrent(current);
    if (current) setOpen((o) => new Set([...[...o].filter((id) => !steps.find((s) => s.id === id)?.done), current]));
  }
  return (
    <ol className="steps">
      {steps.map((s, i) => {
        const isOpen = open.has(s.id);
        const state = s.done ? 'done' : s.id === current ? 'current' : s.optional ? 'optional' : 'todo';
        return (
          <li key={s.id} className={`step step-${state}${isOpen ? ' open' : ''}`} data-step={s.id}>
            <button
              type="button"
              className="step-head"
              aria-expanded={isOpen}
              onClick={() =>
                setOpen((o) => {
                  const n = new Set(o);
                  if (n.has(s.id)) n.delete(s.id);
                  else n.add(s.id);
                  return n;
                })
              }
            >
              <span className="step-num" aria-hidden="true">
                {s.done ? <Icon name="check" size={18} /> : i + 1}
              </span>
              <span className="step-title">
                <span>
                  {s.title}
                  {s.optional ? <span className="step-tag">optional</span> : null}
                  {state === 'current' ? <span className="step-tag next">next</span> : null}
                </span>
                {s.hint ? <span className="step-hint">{s.hint}</span> : null}
              </span>
              <span className="sr-only">{s.done ? '(done)' : ''}</span>
              <Icon name="chevron" size={18} className="step-chevron" />
            </button>
            {isOpen ? <div className="step-body">{s.waiting ? <p className="step-waiting">{s.waiting}</p> : s.content}</div> : null}
          </li>
        );
      })}
    </ol>
  );
}

// ------------------------------------------------------------------ info panel

export function Stat({ label, value, unit, tone, title }: { label: string; value: ReactNode; unit?: string; tone?: 'ok' | 'warn' | 'bad' | undefined; title?: string }) {
  return (
    <div className={`stat${tone ? ` ${tone}` : ''}${typeof value === 'string' && value.length > 6 && !/^[\d.,]+$/.test(value) ? ' long' : ''}`} title={title}>
      <span className="stat-value">
        {value}
        {unit ? <span className="stat-unit">{unit}</span> : null}
      </span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

export function Stats({ children }: { children: ReactNode }) {
  return <div className="stats">{children}</div>;
}

export function InfoSection({ title, children, collapsible, defaultOpen = true }: { title: string; children: ReactNode; collapsible?: boolean; defaultOpen?: boolean }) {
  if (!collapsible)
    return (
      <section className="info-section">
        <h4>{title}</h4>
        {children}
      </section>
    );
  return (
    <details className="info-section" open={defaultOpen}>
      <summary>
        <h4>{title}</h4>
      </summary>
      {children}
    </details>
  );
}

/** A module whose task the shot does not have: say so, and offer to add it. */
export function TaskMissing({ module, shotName, canEdit, locked, onAdd, children }: { module: ModuleId; shotName: string; canEdit: boolean; locked: string | null; onAdd(): void; children?: ReactNode }) {
  const info = MODULES[module];
  const reason = !canEdit ? 'Read-only: adding a task needs an active subscription.' : locked;
  return (
    <div className="task-missing" role="status">
      <Icon name={module} size={44} />
      <h2>
        {shotName} has no {info.label} task
      </h2>
      <p>{info.blurb}</p>
      <button type="button" className="primary big" disabled={Boolean(reason)} title={reason ?? undefined} onClick={onAdd}>
        Add {info.label} to this shot
      </button>
      {reason ? <p className="muted">{reason}</p> : <p className="muted">Adding it is logged. Nothing is processed until you start.</p>}
      {children}
    </div>
  );
}

// ------------------------------------------------------------------ "What's here"

export function WhatsHere({ onOpen }: { onOpen(id: ModuleId): void }) {
  const [hidden, setHidden] = useState(() => readPref(PREF.whatsHereHidden) === '1');
  if (hidden) return null;
  return (
    <section className="whats-here" aria-label="What’s here">
      <div className="whats-here-head">
        <strong>What’s here</strong>
        <span className="muted">Pick a shot below, then a tab at the top to work on it.</span>
        <span className="spacer" />
        <button
          type="button"
          className="link"
          onClick={() => {
            setHidden(true);
            writePref(PREF.whatsHereHidden, '1');
          }}
        >
          Got it — hide this
        </button>
      </div>
      <ul>
        {MODULE_IDS.filter((id) => id !== 'shots').map((id) => (
          <li key={id}>
            <button type="button" onClick={() => onOpen(id)} title={`Open ${MODULES[id].label} for the selected shot`}>
              <Icon name={id} size={20} />
              <span>
                <strong>{MODULES[id].label}</strong>
                <span className="whats-blurb">{MODULES[id].blurb}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ------------------------------------------------------------------ first-run tour

const TOUR: { target: string; title: string; body: string }[] = [
  { target: '[data-tour="tab-shots"]', title: 'Shots is home', body: 'Every shot in the DIT’s handoff is listed here, with what each one needs and how far it has got. You can always come back with this tab.' },
  { target: '[data-tour="queue"]', title: 'Pick a shot', body: 'Click a shot to select it; its details show on the right. Double-click to open it straight in its next job.' },
  { target: '[data-tour="tabs"]', title: 'One tab per job', body: 'Plates, Roto, Key, Clean Plate, Sky & BG, Camera Track, 2D Track and Deliver each work on the selected shot. A dot shows how that job stands; a greyed tab means the shot doesn’t need it yet — open it to add it.' },
  { target: '[data-tour="tabs"]', title: 'Follow the steps', body: 'Inside each tab, the numbered steps on the left walk you through the job. The picture is in the middle; the numbers that matter are on the right. Done steps get a tick.' },
];

export function Tour({ onClose }: { onClose(): void }) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const step = TOUR[i]!;
  useLayoutEffect(() => {
    const measure = () => setRect(document.querySelector(step.target)?.getBoundingClientRect() ?? null);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [step.target]);
  const card = useMemo(() => {
    if (!rect || typeof window === 'undefined') return { left: '50%', top: '30%', transform: 'translateX(-50%)' } as const;
    const width = 400;
    const left = Math.min(Math.max(16, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 16);
    const below = rect.bottom + 16;
    const top = below + 260 < window.innerHeight ? below : Math.max(16, rect.top - 276);
    return { left, top } as const;
  }, [rect]);
  const finish = () => {
    writePref(PREF.tourDone, '1');
    onClose();
  };
  return (
    <div className="tour-layer">
      {rect ? <div className="tour-spot" style={{ left: rect.left - 6, top: rect.top - 6, width: rect.width + 12, height: rect.height + 12 }} aria-hidden="true" /> : <div className="tour-dim" aria-hidden="true" />}
      <div className="modal tour-card" role="dialog" aria-modal="true" aria-label="Quick tour" style={card}>
        <header>
          <h2>{step.title}</h2>
          <span className="tour-count">
            {i + 1} of {TOUR.length}
          </span>
        </header>
        <div className="modal-body">
          <p>{step.body}</p>
        </div>
        <footer>
          <button type="button" className="link" onClick={finish}>
            Skip the tour
          </button>
          <span className="spacer" />
          {i > 0 ? (
            <button type="button" onClick={() => setI(i - 1)}>
              Back
            </button>
          ) : null}
          {i < TOUR.length - 1 ? (
            <button type="button" className="primary" onClick={() => setI(i + 1)} autoFocus>
              Next
            </button>
          ) : (
            <button type="button" className="primary" onClick={finish} autoFocus>
              Done
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
