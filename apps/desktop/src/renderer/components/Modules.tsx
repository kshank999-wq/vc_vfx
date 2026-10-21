import {
  PACKAGE_FOLDERS,
  PREP_TASKS,
  TASK_STATE_LABELS,
  handoffShot,
  outputFor,
  planFor,
  plateColorFor,
  shotFolderSegments,
  shotState,
  shotStatus,
  shotTiming,
  statusCounts,
  versionTag,
  SHOT_STATUS_LABELS,
  type PackageFolder,
  type PrepTaskKind,
} from '@vcvfx/domain';
import type { VcvfxApi } from '../../shared/bridge';
import { canApproveShot, canDeliver, canPackage, canReopen } from '../actions';
import { MODULES, type ModuleId } from '../modules';
import { Icon } from './Icons';
import { InfoSection, ModuleLayout, Stat, StepList, Stats, type StepDef } from './Layout';
import { ActionButton, CameraColour, MODULE_OF, OutputRoot, PlateColorPanel, ReviewMarks, SequencePlan, ShotLog, SourceDetails, TaskCard, type ShotDetailProps } from './ShotDetail';
import { Viewer } from './Viewer';
import { KeyInfo, KeyViewer, keyStepDefs, useKeyController, type KeyWorkspaceProps } from './key/KeyWorkspace';

/**
 * The Plates, Key and Deliver tabs (addendum 08). The Key tab places the
 * key workspace's steps, viewer and numbers (key/KeyWorkspace.tsx, addendum
 * 09) in the shell's zones. Roto, Camera Track and 2D Track are their
 * workspaces (RotoWorkspace, TrackWorkspace) in the same three-zone layout.
 */

export interface ModuleScreenProps extends ShotDetailProps {
  api: VcvfxApi;
  projectKey: string;
  frame: number;
  onFrame(frame: number): void;
  onClose(): void;
  onToggleMark(frame: number, viewing: string, note: string): void;
}

const VERIFY_WORDS: Record<string, string> = { verified: 'Verified', mismatch: 'Mismatch', missing: 'Missing', unchecked: 'Not checked' };

/** The task's card and the shot's recent log, for the Details panel of a module. */
export function TaskInfo({ props, kind }: { props: ShotDetailProps; kind: PrepTaskKind }) {
  const task = shotState(props.project, props.shotId)?.tasks.find((t) => t.kind === kind);
  return (
    <>
      {task ? (
        <InfoSection title="Task and approval">
          <ul className="tasks">
            <TaskCard task={task} props={props} inModule />
          </ul>
        </InfoSection>
      ) : null}
      <InfoSection title="History" collapsible defaultOpen={false}>
        <ShotLog project={props.project} shotId={props.shotId} limit={12} />
      </InfoSection>
    </>
  );
}

/** The compact "this shot has no such task" card for the top of a steps panel. */
function MissingCard({ props, module }: { props: ShotDetailProps; module: ModuleId }) {
  const state = shotState(props.project, props.shotId);
  const task = MODULES[module].task!;
  const reason = !props.canEdit ? 'Read-only: adding a task needs an active subscription.' : state?.stage !== 'prep' ? `The shot is ${state?.stage}; reopen it first.` : null;
  return (
    <div className="missing-card" role="status">
      <p>
        <b>{state?.vfxShotId ?? props.shotId}</b> has no {MODULES[module].label} task yet. You can look at its frames; add the task to work on it here.
      </p>
      <button type="button" className="primary" disabled={Boolean(reason)} title={reason ?? undefined} onClick={() => props.onAddTask(task)}>
        Add {MODULES[module].label} to this shot
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ Plates

export function PlatesModule(props: ModuleScreenProps) {
  const { project, shotId } = props;
  const shot = handoffShot(project, shotId);
  const state = shotState(project, shotId);
  if (!shot || !state) return null;
  const task = state.tasks.find((t) => t.kind === 'sequence_conversion');
  const plan = planFor(project, shot);
  const timing = shotTiming(project, shot);
  const decision = plateColorFor(project, shotId);
  const output = outputFor(project.handoff, shot);
  const written = task ? state.plates.find((r) => r.version === task.version) : undefined;
  const latest = state.plates[state.plates.length - 1];
  const stage = state.stage;
  const platesAllowed =
    stage !== 'prep'
      ? ({ allowed: false, reason: `The shot is ${stage}; reopen it first.` } as const)
      : task?.state === 'approved'
        ? ({ allowed: false, reason: 'These plates are approved. Reopen the task to make a new version.' } as const)
        : decision.blocked
          ? ({ allowed: false, reason: decision.blocked } as const)
          : ({ allowed: true } as const);

  const steps: StepDef[] = [
    {
      id: 'source',
      title: 'Check source & colour',
      hint: 'Which frames, which format, and what colour the plates will be.',
      done: Boolean(timing) && !decision.blocked,
      content: (
        <>
          <SequencePlan {...props} />
          <PlateColorPanel {...props} bare />
        </>
      ),
    },
    {
      id: 'generate',
      title: 'Generate plates',
      hint: 'ffmpeg writes the numbered image sequence.',
      done: Boolean(written),
      waiting: timing ? null : 'The frame range is needed first (step 1, Read from clip).',
      content: (
        <>
          <ActionButton allowed={platesAllowed} onClick={props.onGeneratePlates} canEdit={props.canEdit} busy={props.busy} primary showReason className="big">
            Generate plates {task ? versionTag(task.version) : ''}
          </ActionButton>
          <p className="step-text">
            {plan ? `${plan.frameCount} frames as ${plan.format.toUpperCase()} ${plan.bitDepth}-bit, into 01_PLATES.` : 'Into 01_PLATES.'} The camera files are only read, never changed.
          </p>
          <OutputRoot {...props} />
          {written ? (
            <p className="muted small hint">
              {versionTag(written.version)} written {written.writtenAt.replace('T', ' ').slice(0, 16)} by {written.by}.
            </p>
          ) : null}
        </>
      ),
    },
    {
      id: 'review',
      title: 'Review in the viewer',
      hint: 'Compare plate and camera original; mark any frame to fix.',
      done: task?.state === 'approved',
      waiting: written || latest ? null : 'Generate the plates first (step 2). You can look at the source now.',
      content: (
        <>
          <p className="step-text">
            Above the picture, choose <b>Wipe</b> (drag across the image) or <b>A/B</b> (press B) to compare the plate with the camera original. Under it, <b>Mark for correction</b> notes a frame that needs fixing.
          </p>
          <p className="step-text">When they look right, approve the task in Details on the right.</p>
        </>
      ),
    },
  ];

  const info = (
    <>
      <Stats>
        <Stat label="Frames" value={plan ? plan.frameCount : '—'} title={plan ? `${plan.deliveredIn}–${plan.deliveredOut}, ${plan.handles} handles` : 'Frame range unknown'} />
        <Stat label="Format" value={plan ? `${plan.format.toUpperCase()} ${plan.bitDepth}` : output.format.toUpperCase()} unit={plan ? '-bit' : undefined} />
        <Stat label="Resolution" value={timing?.resolution ? `${timing.resolution.width}×${timing.resolution.height}` : '—'} />
        <Stat label="Plates written" value={latest ? versionTag(latest.version) : 'none'} tone={written ? 'ok' : undefined} />
        <Stat label="Marked to fix" value={state.reviewMarks.length} tone={state.reviewMarks.length ? 'warn' : undefined} />
        <Stat label="Source check" value={VERIFY_WORDS[state.sourceVerified] ?? state.sourceVerified} tone={state.sourceVerified === 'verified' ? 'ok' : state.sourceVerified === 'unchecked' ? undefined : 'bad'} />
      </Stats>
      <p className={`pc-summary${decision.blocked ? ' blocked' : ''}`}>{decision.blocked ?? decision.summary}</p>
      <ReviewMarks project={project} shotId={shotId} />
      {task ? <TaskInfo props={props} kind="sequence_conversion" /> : null}
      <InfoSection title="Camera & colour" collapsible defaultOpen={false}>
        <CameraColour project={project} shotId={shotId} />
      </InfoSection>
      <InfoSection title="Source files" collapsible defaultOpen={false}>
        <SourceDetails project={project} shotId={shotId} />
      </InfoSection>
      {task ? null : (
        <InfoSection title="History" collapsible defaultOpen={false}>
          <ShotLog project={project} shotId={shotId} limit={12} />
        </InfoSection>
      )}
    </>
  );

  return (
    <ModuleLayout label="Plates" steps={task ? <StepList steps={steps} resetKey={shotId} /> : <MissingCard props={props} module="plates" />} info={info}>
      <Viewer api={props.api} project={project} shotId={shotId} projectKey={props.projectKey} canEdit={props.canEdit} frame={props.frame} onFrame={props.onFrame} onClose={props.onClose} onToggleMark={props.onToggleMark} />
    </ModuleLayout>
  );
}

// ------------------------------------------------------------------ Key

/** What the Key tab needs from the app beyond a module screen's props: the job runner, notices and mutations. */
export type KeyWork = Pick<KeyWorkspaceProps, 'actor' | 'runJob' | 'notify' | 'onKey'>;

export function KeyModule(props: ModuleScreenProps & { work: KeyWork }) {
  const { project, shotId } = props;
  const state = shotState(project, shotId);
  const shot = handoffShot(project, shotId);
  const ctl = useKeyController({
    api: props.api,
    project,
    shotId,
    projectKey: props.projectKey,
    canEdit: props.canEdit,
    busy: props.busy,
    actor: props.work.actor,
    frame: props.frame,
    onFrame: props.onFrame,
    onKey: props.work.onKey,
    runJob: props.work.runJob,
    notify: props.work.notify,
    onAddKeyTask: () => props.onAddTask('key'),
    onOpenRoto: (_partId, f) => {
      props.onFrame(f);
      props.onOpenModule?.('roto');
    },
  });
  if (!state || !shot) return null;
  const task = state.tasks.find((t) => t.kind === 'key');
  const despill = state.tasks.find((t) => t.kind === 'despill');
  const info = (
    <>
      {task ? <KeyInfo ctl={ctl} /> : null}
      {shot.supervisorNotes ? (
        <InfoSection title="Supervisor notes">
          <p className="info-line">{shot.supervisorNotes}</p>
        </InfoSection>
      ) : null}
      {task ? <TaskInfo props={props} kind="key" /> : null}
      {despill ? (
        <InfoSection title="Despill task">
          <ul className="tasks">
            <TaskCard task={despill} props={props} inModule />
          </ul>
        </InfoSection>
      ) : null}
    </>
  );
  return (
    <ModuleLayout label="Key" steps={task ? <StepList steps={keyStepDefs(ctl)} resetKey={shotId} /> : <MissingCard props={props} module="key" />} info={info}>
      {task && ctl.supported ? (
        <KeyViewer ctl={ctl} />
      ) : (
        <Viewer api={props.api} project={project} shotId={shotId} projectKey={props.projectKey} canEdit={props.canEdit} frame={props.frame} onFrame={props.onFrame} onClose={props.onClose} onToggleMark={props.onToggleMark} />
      )}
    </ModuleLayout>
  );
}

// ------------------------------------------------------------------ Deliver

/** What goes into each package folder for this shot, and how it stands. */
function PackageMap({ props }: { props: ShotDetailProps }) {
  const { project, shotId, outputRoot } = props;
  const shot = handoffShot(project, shotId);
  const state = shotState(project, shotId);
  if (!shot || !state) return null;
  const segments = shotFolderSegments(project.handoff.project, shot.scene, state.vfxShotId ?? shotId);
  const byFolder = new Map<PackageFolder, PrepTaskKind[]>();
  for (const t of state.tasks) {
    const f = PREP_TASKS[t.kind].folder as PackageFolder;
    byFolder.set(f, [...(byFolder.get(f) ?? []), t.kind]);
  }
  const fixed: Partial<Record<PackageFolder, string>> = {
    '00_SOURCE_REFERENCE': `${shot.references.length} reference file${shot.references.length === 1 ? '' : 's'} from the handoff, and the source checksums`,
    '08_PREVIEWS': 'Contact sheets and previews',
    '09_PROJECT_DATA': 'The colour transform and LUT, the prep report and the manifest',
    '10_DELIVERY': 'Hand-off notes for the vendor',
  };
  return (
    <section className="package-map" aria-label="Package contents">
      <header>
        <h2>
          <Icon name="folder" size={22} /> What goes where
        </h2>
        <p className="mono path">
          {outputRoot ? `${outputRoot}/` : '‹output folder›/'}
          {segments.join('/')}
          {state.packageVersion > 0 ? `  ·  package ${versionTag(state.packageVersion)}` : ''}
        </p>
      </header>
      <ol className="folders">
        {PACKAGE_FOLDERS.map((f) => {
          const kinds = byFolder.get(f) ?? [];
          const note = fixed[f];
          const used = kinds.length > 0 || Boolean(note);
          return (
            <li key={f} className={used ? 'used' : 'unused'}>
              <span className="folder-name mono">{f}</span>
              <span className="folder-what">
                {kinds.length
                  ? kinds.map((k) => {
                      const t = state.tasks.find((x) => x.kind === k)!;
                      const module = MODULE_OF[k];
                      return (
                        <span key={k} className="folder-task">
                          {module ? (
                            <button type="button" className="link" onClick={() => props.onOpenModule?.(module)} title={`Open ${MODULES[module].label}`}>
                              {PREP_TASKS[k].label}
                            </button>
                          ) : (
                            <span>{PREP_TASKS[k].label}</span>
                          )}{' '}
                          <span className={`pill task-state-${t.state}`}>{TASK_STATE_LABELS[t.state]}</span>
                        </span>
                      );
                    })
                  : (note ?? <span className="muted">Nothing for this shot</span>)}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="muted small">Every file written is checksummed into the manifest. Approved versions are never overwritten: packaging again writes the next version.</p>
    </section>
  );
}

export function DeliverModule(props: ModuleScreenProps & { onVerify(): void; onPrint(mode: 'print' | 'pdf'): void; shownShots: number }) {
  const { project, shotId, now, canEdit, busy } = props;
  const state = shotState(project, shotId);
  if (!state) return null;
  const approved = state.tasks.filter((t) => t.state === 'approved').length;
  const verified = project.shots.filter((s) => s.sourceVerified === 'verified').length;
  const counts = statusCounts(project);
  const status = shotStatus(state);

  const steps: StepDef[] = [
    {
      id: 'verify',
      title: 'Verify sources',
      hint: 'Check the camera files still match the DIT’s checksums.',
      done: state.sourceVerified === 'verified',
      content: (
        <>
          <button type="button" className="primary big" disabled={busy} onClick={props.onVerify}>
            Verify sources (all shots)
          </button>
          <p className="step-text">
            This shot: <span className={`verify verify-${state.sourceVerified}`}>{VERIFY_WORDS[state.sourceVerified]}</span>. All shots: {verified} of {project.shots.length} verified.
          </p>
          <p className="muted small hint">Reads every source file and compares its checksum with the handoff. Nothing is written beside the media.</p>
        </>
      ),
    },
    {
      id: 'approve',
      title: 'Approve',
      hint: 'Each task, then the shot — a named person’s sign-off.',
      done: Boolean(state.approval),
      content: (
        <>
          <ul className="approve-list">
            {state.tasks.map((t) => {
              const module = MODULE_OF[t.kind];
              return (
                <li key={t.kind}>
                  <span className="approve-name">
                    {module ? (
                      <button type="button" className="link" onClick={() => props.onOpenModule?.(module)} title={`Open ${MODULES[module].label}`}>
                        {PREP_TASKS[t.kind].label}
                      </button>
                    ) : (
                      PREP_TASKS[t.kind].label
                    )}
                  </span>
                  <span className={`pill task-state-${t.state}`}>{TASK_STATE_LABELS[t.state]}</span>
                  {t.state === 'needs_review' ? (
                    <button type="button" className="small-button" disabled={!canEdit || busy} onClick={() => props.onApproveTask(t.kind)}>
                      Approve…
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {state.approval ? (
            <p className="step-text">
              Shot approved by <strong>{state.approval.by}</strong> <span className="muted">{state.approval.at.replace('T', ' ').slice(0, 16)}</span>
            </p>
          ) : (
            <ActionButton allowed={canApproveShot(project, shotId, now)} onClick={props.onApproveShot} canEdit={canEdit} busy={busy} primary showReason className="big">
              Approve shot…
            </ActionButton>
          )}
        </>
      ),
    },
    {
      id: 'package',
      title: 'Package',
      hint: 'Write the vendor folder with a checksummed manifest.',
      done: state.packageVersion > 0,
      waiting: state.approval ? null : 'Approve the shot first (step 2).',
      content: (
        <>
          <ActionButton allowed={canPackage(project, shotId, now)} onClick={props.onPackage} canEdit={canEdit} busy={busy} primary showReason className="big">
            {state.packageVersion > 0 ? 'Package again' : 'Package'}
          </ActionButton>
          <OutputRoot {...props} />
          <div className="row">
            <ActionButton allowed={canDeliver(project, shotId, now)} onClick={props.onDeliver} canEdit={canEdit} busy={busy}>
              Mark delivered
            </ActionButton>
            <ActionButton allowed={canReopen(project, shotId, now)} onClick={props.onReopen} canEdit={canEdit} busy={busy}>
              Reopen
            </ActionButton>
          </div>
        </>
      ),
    },
    {
      id: 'print',
      title: 'Print shot list',
      hint: 'A paper list of the shots for the set or the vendor.',
      optional: true,
      done: false,
      content: (
        <>
          <div className="row">
            <button type="button" className="primary" onClick={() => props.onPrint('print')}>
              Print…
            </button>
            <button type="button" onClick={() => props.onPrint('pdf')}>
              Export PDF…
            </button>
          </div>
          <p className="muted small hint">
            The {props.shownShots} shot{props.shownShots === 1 ? '' : 's'} shown on the Shots tab (its filters apply), with a tick box each.
          </p>
        </>
      ),
    },
  ];

  const info = (
    <>
      <Stats>
        <Stat label="Shot status" value={SHOT_STATUS_LABELS[status]} />
        <Stat label="Tasks approved" value={approved} unit={` / ${state.tasks.length}`} tone={state.tasks.length && approved === state.tasks.length ? 'ok' : undefined} />
        <Stat label="Source check" value={VERIFY_WORDS[state.sourceVerified] ?? state.sourceVerified} tone={state.sourceVerified === 'verified' ? 'ok' : state.sourceVerified === 'unchecked' ? undefined : 'bad'} />
        <Stat label="Package" value={state.packageVersion > 0 ? versionTag(state.packageVersion) : 'not yet'} tone={state.packageVersion > 0 ? 'ok' : undefined} />
      </Stats>
      <InfoSection title="All shots">
        <p className="info-line">
          {counts.prep_approved} approved · {counts.packaged} packaged · {counts.delivered} delivered of {project.shots.length}
        </p>
      </InfoSection>
      <InfoSection title="History" collapsible defaultOpen={false}>
        <ShotLog project={project} shotId={shotId} limit={12} />
      </InfoSection>
    </>
  );

  return (
    <ModuleLayout label="Deliver" steps={<StepList steps={steps} resetKey={shotId} />} info={info}>
      <PackageMap props={props} />
    </ModuleLayout>
  );
}

