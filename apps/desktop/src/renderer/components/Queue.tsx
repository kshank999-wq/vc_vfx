import { useEffect, useRef } from 'react';
import {
  PREP_TASKS,
  PREP_TASK_KINDS,
  SHOT_STATUSES,
  SHOT_STATUS_LABELS,
  scenesOf,
  statusCounts,
  type PrepTaskKind,
  type Project,
  type QueueFilter,
  type QueueRow,
  type ShotStatus,
} from '@vcvfx/domain';
import { deliveredRange, requiredPrep } from '../../shared/queue';

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

export function QueueTable({
  project,
  rows,
  selected,
  onSelect,
}: {
  project: Project;
  rows: QueueRow[];
  selected: string | null;
  onSelect: (shotId: string) => void;
}) {
  const selectedRef = useRef<HTMLTableRowElement | null>(null);
  useEffect(() => {
    selectedRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);

  if (rows.length === 0) {
    return <div className="queue-empty">No shots match these filters.</div>;
  }
  return (
    <table className="queue" aria-label="Shot queue">
      <thead>
        <tr>
          <th className="col-shot">Shot</th>
          <th>Scene / Setup</th>
          <th className="num">Take</th>
          <th className="num">Frames</th>
          <th>Required prep</th>
          <th>Status</th>
          <th>Approval</th>
          <th>Source</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ shot, state, status }) => (
          <tr
            key={shot.shotId}
            ref={shot.shotId === selected ? selectedRef : undefined}
            className={shot.shotId === selected ? 'selected' : undefined}
            aria-selected={shot.shotId === selected}
            data-shot={shot.shotId}
            onClick={() => onSelect(shot.shotId)}
          >
            <td className="col-shot">
              <CircleDot circled={shot.circled} />
              <span className="shot-id">{shot.shotId}</span>
            </td>
            <td>
              {shot.scene}
              {shot.setup ? <span className="muted"> / Setup {shot.setup}</span> : null}
            </td>
            <td className="num">{shot.take ?? '—'}</td>
            <td className="num">{deliveredRange(project, shot)}</td>
            <td>{requiredPrep(project, shot, state)}</td>
            <td>
              <StatusPill status={status} />
            </td>
            <td className={state.approval ? '' : 'muted'}>{state.approval ? state.approval.by : '—'}</td>
            <td>
              <span className={`verify verify-${state.sourceVerified}`}>{VERIFY_LABEL[state.sourceVerified]}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
