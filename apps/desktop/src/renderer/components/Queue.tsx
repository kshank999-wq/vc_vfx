import { useEffect, useRef, useState } from 'react';
import {
  PREP_TASKS,
  PREP_TASK_KINDS,
  SHOT_STATUSES,
  SHOT_STATUS_LABELS,
  TASK_STATE_LABELS,
  scenesOf,
  statusCounts,
  type PrepTaskKind,
  type Project,
  type QueueFilter,
  type QueueRow,
  type ShotStatus,
} from '@vcvfx/domain';
import { deliveredRange, requiredPrep } from '../../shared/queue';
import { MODULES, moduleStatus, type ModuleId } from '../modules';
import { Icon } from './Icons';

const PROGRESS: ModuleId[] = ['plates', 'roto', 'key', 'camera', 'track2d', 'deliver'];

/** One icon per module, coloured by how its task stands on this shot (faint: the shot does not need it). */
export function ModuleProgress({ project, shotId, onOpen }: { project: Project; shotId: string; onOpen?: (id: ModuleId) => void }) {
  return (
    <span className="progress-icons">
      {PROGRESS.map((id) => {
        const s = moduleStatus(project, shotId, id);
        const tone = s.kind === 'task' ? `task-state-${s.state}` : s.kind === 'shot' ? `status-${s.status}` : 'absent';
        const label = `${MODULES[id].label}: ${s.kind === 'task' ? TASK_STATE_LABELS[s.state] : s.kind === 'shot' ? SHOT_STATUS_LABELS[s.status] : 'not needed'}`;
        return (
          <span key={id} className={`progress-icon ${tone}`} title={label} aria-label={label} role="img" onDoubleClick={onOpen ? (e) => (e.stopPropagation(), onOpen(id)) : undefined}>
            <Icon name={id} size={18} />
          </span>
        );
      })}
    </span>
  );
}

export function StatusPill({ status }: { status: ShotStatus }) {
  return <span className={`pill status-${status}`}>{SHOT_STATUS_LABELS[status]}</span>;
}

export function CircleDot({ circled }: { circled: boolean }) {
  return circled ? <span className="circle-dot" title="Circle take" aria-label="Circle take" /> : <span className="circle-dot empty" aria-hidden="true" />;
}

const VERIFY_LABEL: Record<string, string> = { verified: 'Verified', mismatch: 'Mismatch', missing: 'Missing', unchecked: 'Unchecked' };

export function QueueFilters({ project, filter, onChange }: { project: Project; filter: QueueFilter; onChange: (f: QueueFilter) => void }) {
  const counts = statusCounts(project);
  const active = new Set(filter.statuses ?? []);
  const toggle = (s: ShotStatus) => {
    const next = new Set(active);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    onChange({ ...filter, statuses: [...next] });
  };
  const usedTasks = PREP_TASK_KINDS.filter((k) => project.shots.some((s) => s.tasks.some((t) => t.kind === k)));
  return (
    <div className="filters" role="toolbar" aria-label="Queue filters">
      <div className="chips">
        <button type="button" className={`chip${active.size === 0 ? ' on' : ''}`} onClick={() => onChange({ ...filter, statuses: [] })}>
          All <span className="count">{project.shots.length}</span>
        </button>
        {SHOT_STATUSES.map((s) => (
          <button
            type="button"
            key={s}
            className={`chip status-${s}${active.has(s) ? ' on' : ''}${counts[s] === 0 ? ' zero' : ''}`}
            aria-pressed={active.has(s)}
            onClick={() => toggle(s)}
          >
            <span className="dot" />
            {SHOT_STATUS_LABELS[s]} <span className="count">{counts[s]}</span>
          </button>
        ))}
      </div>
      <div className="filter-controls">
        <label className="field-inline">
          <span>Scene</span>
          <select aria-label="Scene" value={filter.scene ?? ''} onChange={(e) => onChange({ ...filter, scene: e.target.value || undefined })}>
            <option value="">All scenes</option>
            {scenesOf(project).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="field-inline">
          <span>Task</span>
          <select aria-label="Task" value={filter.task ?? ''} onChange={(e) => onChange({ ...filter, task: (e.target.value || undefined) as PrepTaskKind | undefined })}>
            <option value="">Any task</option>
            {usedTasks.map((k) => (
              <option key={k} value={k}>
                {PREP_TASKS[k].label}
              </option>
            ))}
          </select>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={Boolean(filter.circledOnly)} onChange={(e) => onChange({ ...filter, circledOnly: e.target.checked || undefined })} />
          <span className="circle-dot" aria-hidden="true" /> Circle takes only
        </label>
        <input
          className="search"
          type="search"
          placeholder="Search shots, clips, notes…"
          aria-label="Search"
          value={filter.search ?? ''}
          onChange={(e) => onChange({ ...filter, search: e.target.value || undefined })}
        />
      </div>
    </div>
  );
}

/** How a row was clicked: plainly, with Ctrl/Cmd (add or remove one), or with Shift (a range). */
export type SelectGesture = 'single' | 'toggle' | 'range';

/** Shown above the queue while several shots are picked: one task added to all of them. */
export function BulkBar({
  project,
  shotIds,
  canEdit,
  busy,
  onAddTask,
  onClear,
}: {
  project: Project;
  shotIds: string[];
  canEdit: boolean;
  busy: boolean;
  onAddTask: (kind: PrepTaskKind) => void;
  onClear: () => void;
}) {
  const [kind, setKind] = useState<PrepTaskKind | ''>('');
  const missing = (k: PrepTaskKind) => shotIds.filter((id) => !project.shots.find((s) => s.shotId === id)?.tasks.some((t) => t.kind === k)).length;
  return (
    <div className="bulk-bar" role="toolbar" aria-label="Selected shots">
      <strong>{shotIds.length} shots selected</strong>
      <select aria-label="Task for selected shots" value={kind} disabled={!canEdit} onChange={(e) => setKind(e.target.value as PrepTaskKind | '')}>
        <option value="">Add a task to all…</option>
        {PREP_TASK_KINDS.map((k) => (
          <option key={k} value={k} disabled={missing(k) === 0}>
            {PREP_TASKS[k].label}
            {missing(k) < shotIds.length ? ` (${missing(k)} need it)` : ''}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={!kind || !canEdit || busy}
        onClick={() => {
          if (kind) onAddTask(kind);
          setKind('');
        }}
      >
        Add to {shotIds.length} shots
      </button>
      <button type="button" className="link" onClick={onClear}>
        Clear selection
      </button>
      <span className="muted small">Shift-click a range · Ctrl/⌘-click to add or remove</span>
    </div>
  );
}

export function QueueTable({
  project,
  rows,
  selected,
  marked = [],
  onSelect,
  onOpen,
  compact = false,
}: {
  project: Project;
  rows: QueueRow[];
  selected: string | null;
  marked?: string[];
  onSelect: (shotId: string, gesture: SelectGesture) => void;
  /** Double-click: open the shot in a module tab. */
  onOpen?: (shotId: string) => void;
  /** Beside the viewer: shot, frames and status only. */
  compact?: boolean;
}) {
  const selectedRef = useRef<HTMLTableRowElement | null>(null);
  useEffect(() => {
    selectedRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);

  if (rows.length === 0) {
    return <div className="queue-empty">No shots match these filters.</div>;
  }
  return (
    <table className={`queue${compact ? ' compact' : ''}`} aria-label="Shot queue" data-tour="queue">
      <thead>
        <tr>
          <th className="col-shot">Shot</th>
          <th>Scene / Setup</th>
          <th className="num">Take</th>
          <th className="num">Frames</th>
          <th className="col-prep">Prep</th>
          <th title="Plates · Roto · Key · Camera Track · 2D Track · Deliver">Progress</th>
          <th>Status</th>
          <th>Source</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ shot, state, status }) => {
          const isSelected = shot.shotId === selected;
          const isMarked = marked.includes(shot.shotId);
          return (
          <tr
            key={shot.shotId}
            ref={isSelected ? selectedRef : undefined}
            className={[isSelected ? 'selected' : '', isMarked ? 'marked' : ''].filter(Boolean).join(' ') || undefined}
            aria-selected={isSelected || isMarked}
            data-shot={shot.shotId}
            onMouseDown={(e) => {
              // Keep Shift-click from selecting the table's text.
              if (e.shiftKey) e.preventDefault();
            }}
            onClick={(e) => onSelect(shot.shotId, e.shiftKey ? 'range' : e.metaKey || e.ctrlKey ? 'toggle' : 'single')}
            onDoubleClick={() => onOpen?.(shot.shotId)}
            title={onOpen && !compact ? 'Click to select · double-click to open it in its next job' : undefined}
          >
            <td className="col-shot">
              <CircleDot circled={shot.circled} />
              <span className="shot-id" title={state.vfxShotId ? `Handoff ID ${shot.shotId}` : shot.clip ? `Clip ${shot.clip}` : undefined}>
                {state.vfxShotId ?? shot.shotId}
              </span>
            </td>
            <td>
              {shot.scene}
              {shot.setup ? <span className="muted"> / Setup {shot.setup}</span> : null}
            </td>
            <td className="num">{shot.take ?? '—'}</td>
            {(() => {
              const frames = deliveredRange(project, shot);
              return frames === '—' ? (
                <td className="num muted" title="Frame range unknown: not in the handoff, and the clip has not been read yet">
                  —
                </td>
              ) : (
                <td className="num">{frames}</td>
              );
            })()}
            <td className="col-prep">{requiredPrep(project, shot, state)}</td>
            <td>
              <ModuleProgress project={project} shotId={shot.shotId} />
            </td>
            <td title={state.approval ? `Approved by ${state.approval.by}` : undefined}>
              <StatusPill status={status} />
            </td>
            <td>
              <span className={`verify verify-${state.sourceVerified}`}>{VERIFY_LABEL[state.sourceVerified]}</span>
            </td>
          </tr>
          );
        })}
      </tbody>
    </table>
  );
}
