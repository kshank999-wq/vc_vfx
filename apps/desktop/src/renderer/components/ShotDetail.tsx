import { useEffect, useState, type ReactNode } from 'react';
import {
  COLOR_ENCODINGS,
  ENCODINGS,
  PLATE_COLOR_LABELS,
  PREP_TASKS,
  PREP_TASK_KINDS,
  SHOT_PLATE_COLOR,
  TASK_STATE_LABELS,
  parseColorEncoding,
  plateColorFor,
  type ColorEncodingId,
  type ShotPlateColor,
  formatRange,
  framePattern,
  handoffShot,
  outputFor,
  planFor,
  shotState,
  shotStatus,
  shotTiming,
  versionTag,
  type PrepTaskKind,
  type Project,
  type TaskRecord,
  type TaskState,
} from '@vcvfx/domain';
import { canApproveShot, canApproveTask, canDeliver, canPackage, canReopen, canSetTask, READ_ONLY_TITLE, type Allowed } from '../actions';
import { CircleDot, StatusPill } from './Queue';

export interface ShotDetailHandlers {
  onTaskState(kind: PrepTaskKind, state: Exclude<TaskState, 'approved'>): void;
  onApproveTask(kind: PrepTaskKind): void;
  onApproveShot(): void;
  onPackage(): void;
  onDeliver(): void;
  onReopen(): void;
  onTaskNotes(kind: PrepTaskKind, notes: string): void;
  onShotNotes(notes: string): void;
  onAddTask(kind: PrepTaskKind): void;
  /** Assign (or clear, with "") the VFX editor's shot number. */
  onSetVfxShotId(value: string): void;
  /** Read the source clip with ffprobe; absent where that cannot be done (the sample, the browser). */
  onProbe?: () => void;
  onGeneratePlates(): void;
  onChangeOutputRoot(): void;
  onRevealOutput(): void;
  /** The plate colour choice and/or the operator's reading of the source encoding (null: the handoff's). */
  onPlateColor(change: { choice?: ShotPlateColor; encoding?: ColorEncodingId | null }): void;
  /** Open the frame viewer on this shot. */
  onView(): void;
}

interface Props extends ShotDetailHandlers {
  project: Project;
  shotId: string;
  now: Date;
  canEdit: boolean;
  busy: boolean;
  outputRoot: string | null;
}

/** A button whose disabled state carries the reason, both as a tooltip and visibly. */
function ActionButton({
  allowed,
  onClick,
  children,
  primary,
  canEdit,
  busy,
  showReason,
}: {
  allowed: Allowed;
  onClick: () => void;
  children: ReactNode;
  primary?: boolean;
  canEdit: boolean;
  busy: boolean;
  showReason?: boolean;
}) {
  const reason = !canEdit ? READ_ONLY_TITLE : !allowed.allowed ? allowed.reason : busy ? 'Another job is running.' : undefined;
  const disabled = Boolean(reason);
  return (
    <span className="action">
      <button type="button" className={primary ? 'primary' : undefined} disabled={disabled} title={reason} onClick={onClick}>
        {children}
      </button>
      {showReason && disabled && reason ? <span className="reason" role="note">{reason}</span> : null}
    </span>
  );
}

function NotesField({ value, onCommit, disabled, label, placeholder }: { value: string; onCommit: (v: string) => void; disabled: boolean; label: string; placeholder?: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <textarea
      aria-label={label}
      className="notes"
      value={draft}
      disabled={disabled}
      placeholder={placeholder}
      rows={2}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
    />
  );
}

const KV = ({ rows }: { rows: [string, ReactNode][] }) => (
  <dl className="kv">
    {rows.map(([k, v]) => (
      <div key={k} className="kv-row">
        <dt>{k}</dt>
        <dd>{v === undefined || v === null || v === '' ? <span className="muted">—</span> : v}</dd>
      </div>
    ))}
  </dl>
);

const NEXT_STATES: Record<TaskState, { state: Exclude<TaskState, 'approved'>; label: string }[]> = {
  pending: [
    { state: 'processing', label: 'Start' },
    { state: 'needs_review', label: 'Submit for review' },
  ],
  processing: [
    { state: 'needs_review', label: 'Submit for review' },
    { state: 'needs_correction', label: 'Needs correction' },
  ],
  needs_review: [{ state: 'needs_correction', label: 'Needs correction' }],
  needs_correction: [
    { state: 'processing', label: 'Start' },
    { state: 'needs_review', label: 'Submit for review' },
  ],
  approved: [{ state: 'needs_correction', label: 'Reopen (new version)' }],
};

function TaskCard({ task, props }: { task: TaskRecord; props: Props }) {
  const { project, shotId, now, canEdit, busy } = props;
  const info = PREP_TASKS[task.kind];
  const stage = shotState(project, shotId)?.stage ?? 'prep';
  const approve = canApproveTask(project, shotId, task.kind, now);
  const plates = task.kind === 'sequence_conversion';
  const platesAllowed: Allowed =
    stage !== 'prep'
      ? { allowed: false, reason: `The shot is ${stage}; reopen it first.` }
      : task.state === 'approved'
        ? { allowed: false, reason: 'These plates are approved. Reopen the task to make a new version.' }
        : { allowed: true };
  return (
    <li className={`task task-${task.state}`}>
      <div className="task-head">
        <span className="task-name">{info.label}</span>
        <span className={`pill task-state-${task.state}`}>{TASK_STATE_LABELS[task.state]}</span>
        <span className="muted mono">{versionTag(task.version)}</span>
        {!info.available ? <span className="tag" title="Done in another application and tracked here">tracked</span> : null}
      </div>
      {task.approval ? (
        <div className="approval-line">
          Approved by <strong>{task.approval.by}</strong> <span className="muted">{task.approval.at.replace('T', ' ').slice(0, 16)}</span>
        </div>
      ) : null}
      <div className="task-actions">
        {plates ? (
          <ActionButton allowed={platesAllowed} onClick={props.onGeneratePlates} canEdit={canEdit} busy={busy}>
            Generate plates
          </ActionButton>
        ) : null}
        {NEXT_STATES[task.state].map((n) => (
          <ActionButton key={n.state} allowed={canSetTask(project, shotId, task.kind, n.state, now)} onClick={() => props.onTaskState(task.kind, n.state)} canEdit={canEdit} busy={busy}>
            {n.label}
          </ActionButton>
        ))}
        {task.state === 'needs_review' ? (
          <ActionButton allowed={approve} onClick={() => props.onApproveTask(task.kind)} canEdit={canEdit} busy={busy} primary>
            Approve…
          </ActionButton>
        ) : null}
      </div>
      <NotesField label={`${info.label} notes`} value={task.notes} disabled={!canEdit} placeholder="Task notes" onCommit={(v) => props.onTaskNotes(task.kind, v)} />
    </li>
  );
}

function VfxIdField({ value, handoffId, disabled, onCommit }: { value: string | null; handoffId: string; disabled: boolean; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => setDraft(value ?? ''), [value]);
  const changed = draft.trim() !== (value ?? '');
  return (
    <form
      className="vfx-id"
      onSubmit={(e) => {
        e.preventDefault();
        if (changed) onCommit(draft);
      }}
    >
      <label>
        <span className="muted">VFX shot number</span>
        <input aria-label="VFX shot number" value={draft} disabled={disabled} placeholder={`e.g. ${handoffId.split('_')[0] ?? ''}_010 — from the VFX editor`} onChange={(e) => setDraft(e.target.value)} />
      </label>
      <button type="submit" disabled={disabled || !changed}>
        {draft.trim() || !value ? 'Set' : 'Clear'}
      </button>
    </form>
  );
}

export function ShotDetail(props: Props) {
  const { project, shotId, now, canEdit, busy } = props;
  const shot = handoffShot(project, shotId);
  const state = shotState(project, shotId);
  const [newTask, setNewTask] = useState<PrepTaskKind | ''>('');
  if (!shot || !state) return <aside className="detail empty">Select a shot.</aside>;

  const output = outputFor(project.handoff, shot);
  const plan = planFor(project, shot);
  const timing = shotTiming(project, shot);
  const name = state.vfxShotId ?? shot.shotId;
  const status = shotStatus(state);
  const plateVersion = state.tasks.find((t) => t.kind === 'sequence_conversion')?.version ?? 1;
  const approve = canApproveShot(project, shotId, now);
  const missingKinds = PREP_TASK_KINDS.filter((k) => !state.tasks.some((t) => t.kind === k));
  const log = project.log.filter((l) => l.shotId === shotId).slice().reverse();
  const cam = shot.camera;
  const color = shot.color;

  return (
    <aside className="detail" aria-label={`Shot ${shot.shotId}`}>
      <header className="detail-head">
        <div className="detail-title">
          <CircleDot circled={shot.circled} />
          <h2>{name}</h2>
          <StatusPill status={status} />
          <span className="spacer" />
          <button type="button" onClick={props.onView} title="Open the frame viewer and contact sheet (or double-click the row)">
            View frames
          </button>
        </div>
        <div className="detail-sub">
          Scene {shot.scene}
          {shot.setup ? ` · Setup ${shot.setup}` : ''}
          {shot.take ? ` · Take ${shot.take}` : ''}
          {shot.circled ? ' · Circle take' : ''}
          {shot.clip ? ` · ${shot.clip}` : ''}
          {state.vfxShotId ? <span className="muted"> · handoff ID {shot.shotId}</span> : null}
        </div>
        <VfxIdField value={state.vfxShotId} handoffId={shot.shotId} disabled={!canEdit || busy} onCommit={props.onSetVfxShotId} />
      </header>

      <section className="panel approval">
        <div className="approval-state">
          {state.approval ? (
            <>
              Shot approved by <strong>{state.approval.by}</strong> <span className="muted">{state.approval.at.replace('T', ' ').slice(0, 16)}</span>
            </>
          ) : (
            <span className="muted">Shot not approved</span>
          )}
          {state.stage !== 'prep' ? <span className="tag">{state.stage} {versionTag(state.packageVersion)}</span> : null}
        </div>
        <div className="shot-actions">
          {state.approval ? null : (
            <ActionButton allowed={approve} onClick={props.onApproveShot} canEdit={canEdit} busy={busy} primary showReason>
              Approve shot…
            </ActionButton>
          )}
          <ActionButton allowed={canPackage(project, shotId, now)} onClick={props.onPackage} canEdit={canEdit} busy={busy}>
            {state.packageVersion > 0 ? 'Package again' : 'Package'}
          </ActionButton>
          <ActionButton allowed={canDeliver(project, shotId, now)} onClick={props.onDeliver} canEdit={canEdit} busy={busy}>
            Mark delivered
          </ActionButton>
          <ActionButton allowed={canReopen(project, shotId, now)} onClick={props.onReopen} canEdit={canEdit} busy={busy}>
            Reopen
          </ActionButton>
        </div>
        <div className="output-root">
          <span className="muted">Output root</span>
          <span className="mono path" title={props.outputRoot ?? undefined}>
            {props.outputRoot ?? 'not chosen — asked on first package'}
          </span>
          <button type="button" className="link" onClick={props.onChangeOutputRoot} disabled={busy}>
            {props.outputRoot ? 'Change' : 'Choose'}
          </button>
          {props.outputRoot && state.packageVersion > 0 ? (
            <button type="button" className="link" onClick={props.onRevealOutput}>
              Reveal
            </button>
          ) : null}
        </div>
      </section>

      <section className="panel">
        <h3>Prep tasks</h3>
        {state.tasks.length === 0 ? (
          <p className="muted">No prep tasks yet. Add one below — or Shift/Ctrl-click several shots in the queue to add a task to all of them.</p>
        ) : null}
        <ul className="tasks">
          {state.tasks.map((t) => (
            <TaskCard key={t.kind} task={t} props={props} />
          ))}
        </ul>
        {missingKinds.length ? (
          <div className="add-task">
            <select aria-label="Add task" value={newTask} disabled={!canEdit || state.stage !== 'prep'} onChange={(e) => setNewTask(e.target.value as PrepTaskKind | '')}>
              <option value="">Add a task…</option>
              {missingKinds.map((k) => (
                <option key={k} value={k}>
                  {PREP_TASKS[k].label}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!newTask || !canEdit || busy}
              title={!canEdit ? READ_ONLY_TITLE : state.stage !== 'prep' ? 'Reopen the shot first' : undefined}
              onClick={() => {
                if (newTask) props.onAddTask(newTask);
                setNewTask('');
              }}
            >
              Add
            </button>
          </div>
        ) : null}
      </section>

      <section className="panel">
        <h3>Notes</h3>
        <div className="supervisor-notes">
          <span className="label">Supervisor</span>
          <p>{shot.supervisorNotes ?? <span className="muted">—</span>}</p>
        </div>
        <NotesField label="Shot notes" value={state.notes} disabled={!canEdit} placeholder="Prep notes for this shot" onCommit={props.onShotNotes} />
        {state.reviewMarks.length ? (
          <div className="review-marks">
            <span className="label">Marked for correction</span>
            <ul>
              {state.reviewMarks.map((m) => (
                <li key={m.frame}>
                  <span className="mono">{m.frame}</span> <span className="muted">{m.viewing} · {m.by}</span>
                  {m.note ? <span> — {m.note}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section className="panel">
        <h3>Sequence plan</h3>
        {plan ? (
          <KV
            rows={[
              ['Source in–out', <span className="num">{formatRange(plan.sourceIn, plan.sourceOut)}</span>],
              ['Delivered in–out', <span className="num">{formatRange(plan.deliveredIn, plan.deliveredOut)}</span>],
              ['Editorial in–out', <span className="num">{formatRange(plan.editorialIn, plan.editorialOut)}</span>],
              ['Handles · frames', <span className="num">{`${plan.handles} · ${plan.frameCount}`}</span>],
              ['Format', `${plan.format.toUpperCase()} ${plan.bitDepth}-bit${output.compression ? ` · ${output.compression}` : ''}`],
              ['File pattern', <span className="mono">{framePattern(name, 'plate', plateVersion, plan.format)}</span>],
            ]}
          />
        ) : (
          <div className="range-unknown">
            <p className="muted">
              Frame range unknown. The handoff does not give one{project.handoff.origin ? ' (VCDIT sends none)' : ''}, and the clip has not been read yet. Plates
              cover the whole take once it is read.
            </p>
            {props.onProbe ? (
              <button type="button" onClick={props.onProbe} disabled={busy}>
                Read from clip
              </button>
            ) : null}
          </div>
        )}
      </section>

      <PlateColorPanel {...props} />

      <section className="panel">
        <h3>Camera &amp; colour</h3>
        <KV
          rows={[
            ['Camera', [cam.body, cam.sensorMode].filter(Boolean).join(' · ')],
            ['Film back', cam.filmBackMm ? `${cam.filmBackMm.width} × ${cam.filmBackMm.height} mm` : ''],
            ['Lens', [cam.lens, cam.focalLengthMm ? `${cam.focalLengthMm} mm` : ''].filter(Boolean).join(' · ')],
            ['Focus · iris', [cam.focusDistance, cam.iris].filter(Boolean).join(' · ')],
            ['Source colour', color.sourceColorSpace],
            ['Gamma', color.gamma],
            ['Working · display', [color.workingColorSpace, color.displayTransform].filter(Boolean).join(' · ')],
            ['Look (never baked)', color.lookReference],
          ]}
        />
      </section>

      <section className="panel">
        <h3>Source</h3>
        <KV
          rows={[
            ['Timecode', timing?.timecodeIn ? `${timing.timecodeIn}${shot.timecodeOut ? ` – ${shot.timecodeOut}` : ''}` : ''],
            [
              'Frames (source)',
              timing ? (
                <span className="num">
                  {formatRange(timing.frameIn, timing.frameOut)}
                  {timing.from === 'probe' ? <span className="muted"> · whole clip, read with ffprobe</span> : null}
                </span>
              ) : (
                'unknown'
              ),
            ],
            ['Frame rate', `${timing?.frameRate ?? shot.frameRate} fps${!timing && project.handoff.origin ? ' (production setting)' : ''}`],
            ['Resolution', timing?.resolution ? `${timing.resolution.width} × ${timing.resolution.height}` : ''],
            ['Codec', state.probe?.codec],
            ['Unit · day', [shot.unit, shot.shootDay].filter(Boolean).join(' · ')],
            ['Roll · clip', [shot.cameraRoll, shot.clip].filter(Boolean).join(' · ')],
            ['Flagged by', shot.flaggedBy],
            ['Path', <span className="mono path">{shot.sourcePath}</span>],
            ...(shot.sourceFiles?.length
              ? ([['Other files', <span className="mono path">{shot.sourceFiles.map((f) => f.split('/').pop()).join(', ')}</span>]] as [string, ReactNode][])
              : []),
            ['Verification', <span className={`verify verify-${state.sourceVerified}`}>{state.sourceVerified}</span>],
          ]}
        />
        {shot.checksums.length ? (
          <ul className="checksums">
            {shot.checksums.map((c) => (
              <li key={`${c.path}-${c.algorithm}`}>
                <span className="tag">{c.algorithm}</span>
                <span className="mono hash" title={c.value}>
                  {c.value}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">No checksums in the handoff.</p>
        )}
        {shot.references.length ? (
          <>
            <h4>References</h4>
            <ul className="refs">
              {shot.references.map((r) => (
                <li key={r.path}>
                  <span className="tag">{r.kind.replace(/_/g, ' ')}</span> <span className="mono path">{r.path}</span>
                  {r.notes ? <span className="muted"> — {r.notes}</span> : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>

      <section className="panel">
        <h3>Operation log</h3>
        <ol className="log">
          {log.map((l, i) => (
            <li key={`${l.at}-${i}`}>
              <span className="mono muted">{l.at.replace('T', ' ').slice(0, 16)}</span>
              <span className="log-action">{l.action}</span>
              <span className="muted">{l.actor}</span>
              {l.detail ? <span className="log-detail">{l.detail}</span> : null}
            </li>
          ))}
          {log.length === 0 ? <li className="muted">Nothing yet.</li> : null}
        </ol>
      </section>
    </aside>
  );
}

/** Plate colour (spec §4, addendum 03): what the plates' pixels will be, said in one line. */
function PlateColorPanel(props: Props) {
  const { project, shotId, canEdit, busy } = props;
  const shot = handoffShot(project, shotId);
  const state = shotState(project, shotId);
  if (!shot || !state) return null;
  const decision = plateColorFor(project, shotId);
  const parsed = parseColorEncoding(shot.color.sourceColorSpace, shot.color.gamma);
  const task = state.tasks.find((t) => t.kind === 'sequence_conversion');
  const locked = state.stage !== 'prep' ? `The shot is ${state.stage}; reopen it first.` : task?.state === 'approved' ? 'These plates are approved; reopen the task to change how the next version is made.' : null;
  const disabled = !canEdit || busy || Boolean(locked);
  const title = !canEdit ? READ_ONLY_TITLE : (locked ?? undefined);
  const exrDefault = project.plateColorDefault;
  const output = outputFor(project.handoff, shot);
  const autoLabel = output.format === 'exr' ? (exrDefault === 'as_shot' ? 'As shot' : `Convert to ${ENCODINGS[exrDefault].label.replace(/ \(.*\)$/, '')}`) : 'As shot';
  const written = state.plates.find((r) => r.version === (task?.version ?? 1));
  return (
    <section className="panel plate-colour">
      <h3>Plate colour</h3>
      <div className="pc-grid">
        <label>
          <span className="muted">Source encoding</span>
          <select
            aria-label="Source encoding"
            value={state.sourceEncoding ?? ''}
            disabled={disabled}
            title={title}
            onChange={(e) => props.onPlateColor({ encoding: (e.target.value || null) as ColorEncodingId | null })}
          >
            <option value="">{parsed.encoding ? `From handoff: ${ENCODINGS[parsed.encoding].label}` : `From handoff: unknown${shot.color.sourceColorSpace ? ` (“${shot.color.sourceColorSpace}”)` : ''}`}</option>
            {COLOR_ENCODINGS.map((id) => (
              <option key={id} value={id}>
                {ENCODINGS[id].label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="muted">Plates</span>
          <select aria-label="Plate colour" value={state.plateColor} disabled={disabled} title={title} onChange={(e) => props.onPlateColor({ choice: e.target.value as ShotPlateColor })}>
            {SHOT_PLATE_COLOR.map((c) => (
              <option key={c} value={c}>
                {c === 'auto' ? `Project default (${autoLabel})` : PLATE_COLOR_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className={`pc-summary${decision.blocked ? ' blocked' : ''}`} role="status">
        {decision.blocked ?? decision.summary}
      </p>
      {decision.warnings.map((w) => (
        <p key={w} className="pc-warning small">
          {w}
        </p>
      ))}
      {written ? (
        <p className="muted small">
          {versionTag(written.version)} written {written.writtenAt.replace('T', ' ').slice(0, 16)} by {written.by}
          {written.color.summary === decision.summary ? ', as above.' : `: ${written.color.summary} The next version follows the choice above.`}
        </p>
      ) : null}
      <p className="muted small">The transform and its LUT are written to 09_PROJECT_DATA with the plates. Display looks are never applied to plates.</p>
    </section>
  );
}
