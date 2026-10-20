import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PREP_TASKS,
  SAMPLE_HANDOFF,
  addTask,
  addTaskToShots,
  approveShot,
  approveTask,
  capabilityFrom,
  createProject,
  markDelivered,
  parseHandoff,
  parseProject,
  queueRows,
  reopenShot,
  serializeProject,
  setProbedMedia,
  setShotNotes,
  setSourceVerified,
  setVfxShotId,
  setTaskNotes,
  setTaskState,
  shotState,
  shotTiming,
  type HandoffIssue,
  type PrepTaskKind,
  type Project,
  type QueueFilter,
  type Result,
  type TaskState,
} from '@vcvfx/domain';
import type { AccountStatus, AppInfo, JobProgress, LicenceStanding, MenuCommand, ProbeResult, Settings, VcvfxApi } from '../shared/bridge';
import { projectKey } from '../shared/queue';
import { BulkBar, QueueFilters, QueueTable, type SelectGesture } from './components/Queue';
import { ShotDetail } from './components/ShotDetail';
import { AccountDialog, IssuesDialog, PromptDialog, SettingsDialog } from './components/Dialogs';

interface Doc {
  project: Project;
  path: string | null;
  dirty: boolean;
}

interface Notice {
  id: number;
  kind: 'info' | 'error' | 'ok';
  text: string;
  action?: { label: string; run: () => void };
}

interface Prompt {
  title: string;
  label: string;
  initial: string;
  confirmLabel: string;
  detail?: string;
  onSubmit: (value: string) => void;
}

const SIGNED_OUT: AccountStatus = { configured: false, signedIn: false, email: null, displayName: null };
const EMPTY_SETTINGS: Settings = { operatorName: '', ffmpegPath: '', outputRoots: {}, recent: [] };
const AUTOSAVE_MS = 700;

let noticeSeq = 0;
let jobSeq = 0;

export function App({ api, now = () => new Date() }: { api: VcvfxApi; now?: () => Date }) {
  const [doc, setDocState] = useState<Doc | null>(null);
  const docRef = useRef<Doc | null>(null);
  const setDoc = useCallback((next: Doc | null) => {
    docRef.current = next;
    setDocState(next);
  }, []);

  const [filter, setFilter] = useState<QueueFilter>({});
  const [selected, setSelected] = useState<string | null>(null);
  /** Shots picked with Shift/Ctrl/Cmd-click for a bulk action; empty when only one is selected. */
  const [marked, setMarked] = useState<string[]>([]);
  const [issues, setIssues] = useState<{ title: string; intro: string; issues: HandoffIssue[] } | null>(null);
  const [warnings, setWarnings] = useState<HandoffIssue[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [dialog, setDialog] = useState<'settings' | 'account' | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [account, setAccount] = useState<AccountStatus>(SIGNED_OUT);
  const [standing, setStanding] = useState<LicenceStanding | null>(null);
  const [settings, setSettings] = useState<Settings>(EMPTY_SETTINGS);
  const [job, setJob] = useState<JobProgress | null>(null);

  const capability = capabilityFrom(standing, now());
  const canEdit = capability === 'full';
  const operator = account.displayName || account.email || settings.operatorName || '';
  const actor = operator || 'Operator';
  const busy = job !== null;

  const notify = useCallback((kind: Notice['kind'], text: string, action?: Notice['action']) => {
    const id = (noticeSeq += 1);
    setNotices((n) => [...n.slice(-3), { id, kind, text, ...(action ? { action } : {}) }]);
    if (kind !== 'error') setTimeout(() => setNotices((n) => n.filter((x) => x.id !== id)), 8000);
  }, []);

  // --- start-up -----------------------------------------------------------
  useEffect(() => {
    void api.appInfo().then(setInfo);
    void api.accountStatus().then(setAccount);
    void api.licenceStanding(false).then(setStanding);
    void api.getSettings().then(setSettings);
    return api.onProgress((p) => setJob((current) => (current && current.jobId === p.jobId ? p : current)));
  }, [api]);

  // --- document title and autosave ---------------------------------------
  useEffect(() => {
    const title = doc ? doc.project.handoff.project : 'VC VFX';
    document.title = doc ? `${title}${doc.dirty ? ' •' : ''} — VC VFX` : 'VC VFX';
    void api.setDocumentState({ path: doc?.path ?? null, title, dirty: Boolean(doc?.dirty) });
  }, [api, doc?.path, doc?.dirty, doc?.project.handoff.project]);

  useEffect(() => {
    if (!doc || !doc.dirty || !doc.path) return;
    const snapshot = doc;
    const timer = setTimeout(async () => {
      const r = await api.saveProject({ path: snapshot.path, text: serializeProject(snapshot.project) });
      if (!r.ok) notify('error', `Autosave failed: ${r.error}`);
      else if (docRef.current?.project === snapshot.project) setDoc({ ...snapshot, dirty: false });
    }, AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [api, doc, notify, setDoc]);

  // --- mutations ----------------------------------------------------------
  const apply = useCallback(
    (fn: (p: Project) => Result): boolean => {
      const current = docRef.current;
      if (!current) return false;
      const r = fn(current.project);
      if (!r.ok) {
        notify('error', r.reason);
        return false;
      }
      setDoc({ ...current, project: r.project, dirty: true });
      return true;
    },
    [notify, setDoc],
  );

  const confirmReplace = () => !docRef.current || !docRef.current.dirty || docRef.current.path !== null || window.confirm('The current project has never been saved. Discard it?');

  const loadProject = useCallback(
    (project: Project, path: string | null, dirty: boolean) => {
      setDoc({ project, path, dirty });
      setFilter({});
      setMarked([]);
      setSelected(queueRows(project)[0]?.shot.shotId ?? null);
    },
    [setDoc],
  );

  const save = useCallback(
    async (saveAs: boolean) => {
      const current = docRef.current;
      if (!current) return;
      const r = await api.saveProject({ path: current.path, text: serializeProject(current.project), saveAs });
      if (!r.ok) return notify('error', r.error);
      if (!r.data) return;
      const latest = docRef.current ?? current;
      setDoc({ ...latest, path: r.data.path, dirty: latest.project !== current.project });
      notify('ok', `Saved ${r.data.path}`);
      void api.getSettings().then(setSettings);
    },
    [api, notify, setDoc],
  );

  const runJob = useCallback(
    async <T,>(label: string, fn: (jobId: string) => Promise<T>): Promise<T> => {
      const jobId = `job-${(jobSeq += 1)}`;
      setJob({ jobId, label, done: 0, total: 0 });
      try {
        return await fn(jobId);
      } finally {
        setJob(null);
      }
    },
    [],
  );

  /** Record ffprobe's answers in the project, and say what could not be read. */
  const applyProbes = useCallback(
    (results: ProbeResult[]) => {
      const current = docRef.current;
      if (!current) return;
      let next = current.project;
      const failed: string[] = [];
      const at = now();
      for (const r of results) {
        if (!r.media) {
          failed.push(`${r.shotId}: ${r.error ?? 'not read'}`);
          continue;
        }
        const applied = setProbedMedia(next, r.shotId, r.media, actor, at);
        if (applied.ok) next = applied.project;
        else failed.push(`${r.shotId}: ${applied.reason}`);
      }
      if (next !== current.project) setDoc({ ...current, project: next, dirty: true });
      const read = results.length - failed.length;
      if (failed.length) notify('error', `Read ${read} of ${results.length} clips. Not read — ${failed.slice(0, 3).join('; ')}${failed.length > 3 ? `; and ${failed.length - 3} more` : ''}`);
      else if (read) notify('ok', `Read ${read} clip${read === 1 ? '' : 's'} with ffprobe: frame ranges, timecode and resolution filled in.`);
    },
    [actor, notify, setDoc],
  );

  /** Read the clips of shots with no frame range (a VCDIT handoff sends none). */
  const probeSources = useCallback(
    async (shotIds?: string[]) => {
      const current = docRef.current;
      if (!current || !api.probeSources || current.project.handoffPath === 'sample') return;
      const probe = api.probeSources.bind(api);
      const r = await runJob('Reading clips', (jobId) => probe({ jobId, text: serializeProject(current.project), ...(shotIds ? { shotIds } : {}) }));
      if (!r.ok) return notify('error', r.error);
      if (!r.data.ffprobe) {
        notify('error', 'ffprobe (part of ffmpeg) was not found, so clip lengths, timecode and resolution were not read; frame ranges stay unknown (“—”). Install ffmpeg or set its path in Settings, then use “Read from clip”.', {
          label: 'ffmpeg.org',
          run: () => void api.openExternal('ffmpeg'),
        });
        return;
      }
      applyProbes(r.data.results);
    },
    [api, applyProbes, notify, runJob],
  );

  const openHandoff = useCallback(async () => {
    if (!confirmReplace()) return;
    const r = await api.openHandoffDialog();
    if (!r.ok) return notify('error', r.error);
    if (!r.data) return;
    const parsed = parseHandoff(r.data.text);
    if (!parsed.ok) {
      setIssues({
        title: 'This handoff cannot be read',
        intro: `${r.data.path} has ${parsed.issues.length} problem${parsed.issues.length === 1 ? '' : 's'}. Nothing was opened. Fix the handoff in VCDIT and try again.`,
        issues: parsed.issues,
      });
      return;
    }
    const project = createProject(parsed.handoff, r.data.path, actor, now());
    loadProject(project, null, true);
    setWarnings(parsed.warnings);
    // Save straight away, beside the handoff unless the operator says otherwise.
    const saved = await api.saveProject({ path: null, text: serializeProject(project) });
    if (saved.ok && saved.data) {
      const latest = docRef.current;
      if (latest) setDoc({ ...latest, path: saved.data.path, dirty: latest.project !== project });
      void api.getSettings().then(setSettings);
    } else if (!saved.ok) notify('error', saved.error);
    else notify('info', 'The project is not saved yet. Use File › Save to keep it.');
    // VCDIT sends no frame ranges: read them from the clips now.
    if (project.handoff.shots.some((shot) => !shotTiming(project, shot))) await probeSources();
  }, [api, actor, loadProject, notify, setDoc, probeSources]);

  const openProjectText = useCallback(
    (path: string, text: string) => {
      const parsed = parseProject(text);
      if (!parsed.ok) return notify('error', `${path} could not be opened: ${parsed.reason}`);
      setWarnings([]);
      loadProject(parsed.project, path, false);
    },
    [loadProject, notify],
  );

  const openProject = useCallback(async () => {
    if (!confirmReplace()) return;
    const r = await api.openProjectDialog();
    if (!r.ok) return notify('error', r.error);
    if (r.data) openProjectText(r.data.path, r.data.text);
  }, [api, notify, openProjectText]);

  const openPath = useCallback(
    async (path: string) => {
      if (!confirmReplace()) return;
      const r = await api.openProjectPath(path);
      if (!r.ok) return notify('error', r.error);
      openProjectText(r.data.path, r.data.text);
    },
    [api, notify, openProjectText],
  );

  const openSample = useCallback(() => {
    if (!confirmReplace()) return;
    const parsed = parseHandoff(JSON.stringify(SAMPLE_HANDOFF));
    if (!parsed.ok) return notify('error', 'The sample handoff did not parse.');
    setWarnings([]);
    loadProject(createProject(parsed.handoff, 'sample', actor, now()), null, true);
  }, [actor, loadProject, notify]);

  const print = useCallback(
    async (mode: 'print' | 'pdf') => {
      const current = docRef.current;
      if (!current) return notify('info', 'Open a project first.');
      const r = await api.printShotList({ text: serializeProject(current.project), filter, mode });
      if (!r.ok) return notify('error', r.error);
      if (r.data?.path) {
        const path = r.data.path;
        notify('ok', `Shot list saved to ${path}`, { label: 'Reveal', run: () => void api.revealPath(path) });
      }
    },
    [api, filter, notify],
  );

  const verify = useCallback(async () => {
    const current = docRef.current;
    if (!current) return notify('info', 'Open a project first.');
    const r = await runJob('Verifying sources', (jobId) => api.verifySources({ jobId, text: serializeProject(current.project) }));
    if (!r.ok) return notify('error', r.error);
    let next = docRef.current?.project ?? current.project;
    const at = now();
    for (const v of r.data) {
      const applied = setSourceVerified(next, v.shotId, v.result, v.detail, actor, at);
      if (applied.ok) next = applied.project;
    }
    const latest = docRef.current ?? current;
    setDoc({ ...latest, project: next, dirty: true });
    const tally = (k: string) => r.data.filter((v) => v.result === k).length;
    notify(
      tally('mismatch') || tally('missing') ? 'error' : 'ok',
      `Sources: ${tally('verified')} verified · ${tally('mismatch')} mismatched · ${tally('missing')} missing · ${tally('unchecked')} without a checksum to check`,
    );
  }, [actor, api, notify, runJob, setDoc]);

  // --- shot actions ---------------------------------------------------------
  const key = doc ? projectKey(doc.path, doc.project.handoffPath) : null;
  const outputRoot = key ? (settings.outputRoots[key] ?? null) : null;

  const askApprover = (title: string, detail: string, onSubmit: (name: string) => void) =>
    setPrompt({ title, label: 'Approved by', initial: operator, confirmLabel: 'Approve', detail, onSubmit });

  const chooseOutputRoot = async () => {
    const current = docRef.current;
    if (!current) return;
    const r = await api.chooseOutputRoot({ projectKey: projectKey(current.path, current.project.handoffPath), text: serializeProject(current.project) });
    if (!r.ok) return notify('error', r.error);
    setSettings(await api.getSettings());
  };

  const packageSelected = async (shotId: string) => {
    const current = docRef.current;
    if (!current) return;
    const r = await runJob(`Packaging ${shotId}`, (jobId) =>
      api.packageShot({ jobId, text: serializeProject(current.project), shotId, projectKey: projectKey(current.path, current.project.handoffPath), operator: actor }),
    );
    setSettings(await api.getSettings());
    if (!r.ok) return notify('error', r.error);
    const parsed = parseProject(r.data.text);
    if (!parsed.ok) return notify('error', parsed.reason);
    setDoc({ ...(docRef.current ?? current), project: parsed.project, dirty: true });
    const folder = r.data.folder;
    notify('ok', `${shotId} packaged as v${String(r.data.version).padStart(3, '0')} (${r.data.files} files checksummed)`, { label: 'Reveal', run: () => void api.revealPath(folder) });
  };

  const generatePlates = async (shotId: string) => {
    const current = docRef.current;
    if (!current) return;
    const ffmpeg = await api.detectFfmpeg();
    if (!ffmpeg.found) {
      notify(
        'error',
        'ffmpeg was not found, so no plates were written and the task is unchanged. Install it (macOS: brew install ffmpeg · Windows: winget install Gyan.FFmpeg) or set its path in Settings.',
        { label: 'ffmpeg.org', run: () => void api.openExternal('ffmpeg') },
      );
      return;
    }
    const before = shotState(current.project, shotId)?.tasks.find((t) => t.kind === 'sequence_conversion')?.state;
    if (!before) return;
    if (before !== 'processing' && !apply((p) => setTaskState(p, shotId, 'sequence_conversion', 'processing', actor, now()))) return;
    const started = docRef.current ?? current;
    const r = await runJob(`Writing plates for ${shotId}`, (jobId) =>
      api.generateSequence({ jobId, text: serializeProject(started.project), shotId, projectKey: projectKey(started.path, started.project.handoffPath) }),
    );
    setSettings(await api.getSettings());
    if (!r.ok) {
      if (before !== 'processing' && before !== 'approved') apply((p) => setTaskState(p, shotId, 'sequence_conversion', before, actor, now()));
      return notify('error', r.error);
    }
    const probed = r.data.probed;
    if (probed) apply((p) => setProbedMedia(p, shotId, probed, actor, now()));
    // Processing finishing never approves anything (§15.6): it goes to review.
    apply((p) => setTaskState(p, shotId, 'sequence_conversion', 'needs_review', actor, now()));
    const folder = r.data.folder;
    notify('ok', `${r.data.frames} frames written as ${r.data.pattern}. Review them, then approve the task.`, { label: 'Reveal', run: () => void api.revealPath(folder) });
  };

  // --- menu and keyboard ----------------------------------------------------
  const rows = useMemo(() => (doc ? queueRows(doc.project, filter) : []), [doc, filter]);
  const commands = useRef<(c: MenuCommand) => void>(() => undefined);
  commands.current = (command: MenuCommand) => {
    if (command.startsWith('open-recent:')) return void openPath(command.slice('open-recent:'.length));
    switch (command) {
      case 'open-handoff':
        return void openHandoff();
      case 'open-project':
        return void openProject();
      case 'open-sample':
        return openSample();
      case 'save':
        return void save(false);
      case 'save-as':
        return void save(true);
      case 'print':
        return void print('print');
      case 'export-pdf':
        return void print('pdf');
      case 'verify':
        return void verify();
      case 'settings':
        return setDialog('settings');
      case 'account':
        return setDialog('account');
      case 'next-shot':
      case 'previous-shot':
        return moveSelection(command === 'next-shot' ? 1 : -1);
    }
  };
  useEffect(() => api.onMenu((c) => commands.current(c)), [api]);

  const moveSelection = (delta: number) => {
    if (rows.length === 0) return;
    const index = rows.findIndex((r) => r.shot.shotId === selected);
    const next = index < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, index + delta));
    setSelected(rows[next]!.shot.shotId);
  };
  const moveRef = useRef(moveSelection);
  moveRef.current = moveSelection;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (document.querySelector('.modal')) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        moveRef.current(e.key === 'ArrowDown' ? 1 : -1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Keep the selection on a visible row.
  useEffect(() => {
    if (rows.length && !rows.some((r) => r.shot.shotId === selected)) setSelected(rows[0]!.shot.shotId);
  }, [rows, selected]);

  // Click selects one shot; Ctrl/Cmd-click adds or removes a shot; Shift-click takes the range from the selected one.
  const selectShot = (shotId: string, gesture: SelectGesture) => {
    const ids = rows.map((r) => r.shot.shotId);
    if (gesture === 'toggle') {
      const base = marked.length ? marked : selected ? [selected] : [];
      const next = base.includes(shotId) ? base.filter((id) => id !== shotId) : [...base, shotId];
      setMarked(next.length > 1 ? next : []);
      setSelected(next.includes(shotId) ? shotId : (next[next.length - 1] ?? shotId));
      return;
    }
    if (gesture === 'range' && selected) {
      const a = ids.indexOf(selected);
      const b = ids.indexOf(shotId);
      if (a >= 0 && b >= 0) {
        const range = ids.slice(Math.min(a, b), Math.max(a, b) + 1);
        setMarked(range.length > 1 ? range : []);
        return;
      }
    }
    setMarked([]);
    setSelected(shotId);
  };
  // Only shots still visible stay marked.
  const visibleMarked = marked.filter((id) => rows.some((r) => r.shot.shotId === id));

  const addTaskToMarked = (kind: PrepTaskKind) => {
    const current = docRef.current;
    if (!current) return;
    const r = addTaskToShots(current.project, visibleMarked, kind, actor, now());
    if (r.added.length) setDoc({ ...current, project: r.project, dirty: true });
    const label = PREP_TASKS[kind].label;
    const skipped = r.skipped.length ? ` Skipped ${r.skipped.length}: ${r.skipped.map((x) => x.reason).slice(0, 3).join('; ')}${r.skipped.length > 3 ? '…' : ''}` : '';
    notify(r.added.length ? 'ok' : 'error', `${label} added to ${r.added.length} shot${r.added.length === 1 ? '' : 's'}.${skipped}`);
  };

  // --- render ---------------------------------------------------------------
  const project = doc?.project ?? null;
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">VFX</span>
          <span className="brand-name">VC VFX</span>
        </div>
        {project ? (
          <div className="doc-title">
            <strong>{project.handoff.project}</strong>
            {project.handoff.productionCompany ? <span className="muted"> · {project.handoff.productionCompany}</span> : null}
            {project.handoff.origin?.day ? (
              <span className="muted doc-day" title={project.handoff.origin.tool ? `Handed off by ${project.handoff.origin.tool}` : undefined}>
                {' · '}
                {[
                  project.handoff.origin.day.number !== undefined ? `Day ${project.handoff.origin.day.number}` : null,
                  project.handoff.origin.day.date,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            ) : null}
            <span className="doc-path" title={doc?.path ?? undefined}>
              {doc?.path ? doc.path.split(/[\\/]/).pop() : project.handoffPath === 'sample' ? 'Sample — not saved' : 'Not saved'}
              {doc?.dirty ? <span className="dirty" title="Unsaved changes"> •</span> : null}
            </span>
          </div>
        ) : (
          <div className="doc-title muted">No project open</div>
        )}
        <div className="spacer" />
        <div className="toolbar">
          <button type="button" onClick={() => void openHandoff()} title="Open VCDIT Handoff (Ctrl/Cmd+O)">
            Open Handoff
          </button>
          <button type="button" onClick={() => void verify()} disabled={!project || busy}>
            Verify Sources
          </button>
          <button type="button" onClick={() => void print('print')} disabled={!project} title="Print Shot List (Ctrl/Cmd+P)">
            Print
          </button>
          <button type="button" onClick={() => void print('pdf')} disabled={!project}>
            Export PDF
          </button>
        </div>
        <button type="button" className={`licence-pill ${capability}`} onClick={() => setDialog('account')} title="Account & licence">
          {capability === 'full' ? 'Licensed' : 'Read-only'}
          {account.signedIn ? <span className="muted"> · {account.displayName ?? account.email}</span> : null}
        </button>
        <button type="button" className="icon" aria-label="Settings" title="Settings" onClick={() => setDialog('settings')}>
          ⚙
        </button>
      </header>

      {capability === 'read_only' ? (
        <div className="banner" role="status">
          <span>
            <strong>Read-only.</strong> You can open, browse, verify and print. Changing work, running ffmpeg and writing packages need an active subscription.
          </span>
          <button type="button" className="link" onClick={() => void api.openExternal('subscribe')}>
            Subscribe at vc-vfx.com
          </button>
          <button type="button" className="link" onClick={() => setDialog('account')}>
            Sign in &amp; activate
          </button>
        </div>
      ) : null}

      {warnings.length ? (
        <div className="banner warn" role="status">
          <span>
            Handoff loaded with {warnings.length} warning{warnings.length === 1 ? '' : 's'}.
          </span>
          <button type="button" className="link" onClick={() => setIssues({ title: 'Handoff warnings', intro: 'The handoff opened. These are worth knowing:', issues: warnings })}>
            Show
          </button>
          <button type="button" className="link" onClick={() => setWarnings([])}>
            Dismiss
          </button>
        </div>
      ) : null}

      {project && doc ? (
        <>
          <QueueFilters project={project} filter={filter} onChange={setFilter} />
          <main className="workspace">
            <section className="queue-pane" aria-label="Queue">
              {visibleMarked.length > 1 ? (
                <BulkBar project={project} shotIds={visibleMarked} canEdit={canEdit} busy={busy} onAddTask={addTaskToMarked} onClear={() => setMarked([])} />
              ) : null}
              <QueueTable project={project} rows={rows} selected={selected} marked={visibleMarked} onSelect={selectShot} />
            </section>
            {selected ? (
              <ShotDetail
                project={project}
                shotId={selected}
                now={now()}
                canEdit={canEdit}
                busy={busy}
                outputRoot={outputRoot}
                onTaskState={(kind: PrepTaskKind, state: Exclude<TaskState, 'approved'>) => apply((p) => setTaskState(p, selected, kind, state, actor, now()))}
                onApproveTask={(kind) =>
                  askApprover('Approve task', `Approval is recorded with your name and the time, per task (${kind.replace(/_/g, ' ')}).`, (name) => {
                    setPrompt(null);
                    apply((p) => approveTask(p, selected, kind, name, now()));
                  })
                }
                onApproveShot={() =>
                  askApprover('Approve shot', `Sign off ${selected} as prep approved. This is a production decision, recorded with your name.`, (name) => {
                    setPrompt(null);
                    apply((p) => approveShot(p, selected, name, now()));
                  })
                }
                onPackage={() => void packageSelected(selected)}
                onDeliver={() => apply((p) => markDelivered(p, selected, actor, now()))}
                onReopen={() => apply((p) => reopenShot(p, selected, actor, now()))}
                onTaskNotes={(kind, notes) => apply((p) => setTaskNotes(p, selected, kind, notes, actor, now()))}
                onShotNotes={(notes) => apply((p) => setShotNotes(p, selected, notes, actor, now()))}
                onAddTask={(kind) => apply((p) => addTask(p, selected, kind, actor, now()))}
                onSetVfxShotId={(value) => apply((p) => setVfxShotId(p, selected, value, actor, now()))}
                {...(api.probeSources && project.handoffPath !== 'sample' ? { onProbe: () => void probeSources([selected]) } : {})}
                onGeneratePlates={() => void generatePlates(selected)}
                onChangeOutputRoot={() => void chooseOutputRoot()}
                onRevealOutput={() => outputRoot && void api.revealPath(outputRoot)}
              />
            ) : (
              <aside className="detail empty">Select a shot.</aside>
            )}
          </main>
        </>
      ) : (
        <Welcome recent={settings.recent} onOpenHandoff={() => void openHandoff()} onOpenProject={() => void openProject()} onSample={openSample} onRecent={(p) => void openPath(p)} />
      )}

      <footer className="statusbar">
        {project ? (
          <span className="muted">
            {[
              `${rows.length} of ${project.shots.length} shots`,
              project.handoff.vfxSupervisor ? `VFX Sup ${project.handoff.vfxSupervisor}` : null,
              project.handoff.ditOperator ? `DIT ${project.handoff.ditOperator}` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        ) : (
          <span className="muted">VC VFX {info?.version ?? ''}</span>
        )}
        <div className="spacer" />
        {job ? (
          <div className="job" role="progressbar" aria-label={job.label} aria-valuemin={0} aria-valuemax={job.total || 1} aria-valuenow={job.done}>
            <span>{job.label}</span>
            <span className="bar">
              <span style={{ width: `${job.total ? Math.min(100, (job.done / job.total) * 100) : 5}%` }} />
            </span>
            {job.detail ? <span className="muted job-detail">{job.detail}</span> : null}
            <button type="button" className="link" onClick={() => void api.cancelJob(job.jobId)}>
              Cancel
            </button>
          </div>
        ) : null}
      </footer>

      <div className="notices" aria-live="polite">
        {notices.map((n) => (
          <div key={n.id} className={`notice ${n.kind}`}>
            <span>{n.text}</span>
            {n.action ? (
              <button type="button" className="link" onClick={n.action.run}>
                {n.action.label}
              </button>
            ) : null}
            <button type="button" className="icon" aria-label="Dismiss" onClick={() => setNotices((all) => all.filter((x) => x.id !== n.id))}>
              ×
            </button>
          </div>
        ))}
      </div>

      {issues ? <IssuesDialog {...issues} onClose={() => setIssues(null)} /> : null}
      {prompt ? <PromptDialog {...prompt} onClose={() => setPrompt(null)} /> : null}
      {dialog === 'settings' ? (
        <SettingsDialog
          api={api}
          settings={settings}
          outputRoot={outputRoot}
          hasProject={Boolean(project)}
          onSaved={(s) => {
            setSettings(s);
            notify('ok', 'Settings saved');
          }}
          onChooseOutputRoot={() => void chooseOutputRoot()}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === 'account' ? (
        <AccountDialog api={api} info={info} account={account} standing={standing} onAccount={setAccount} onStanding={setStanding} onClose={() => setDialog(null)} />
      ) : null}
    </div>
  );
}

function Welcome({
  recent,
  onOpenHandoff,
  onOpenProject,
  onSample,
  onRecent,
}: {
  recent: string[];
  onOpenHandoff: () => void;
  onOpenProject: () => void;
  onSample: () => void;
  onRecent: (path: string) => void;
}) {
  return (
    <main className="welcome">
      <div className="welcome-card">
        <h1>VFX prep, from the DIT’s handoff</h1>
        <p className="muted">Open the VCDIT handoff from the drive to build the shot queue. Source media is read only; nothing is written beside it.</p>
        <div className="row">
          <button type="button" className="primary" onClick={onOpenHandoff}>
            Open VCDIT Handoff…
          </button>
          <button type="button" onClick={onOpenProject}>
            Open Project…
          </button>
          <button type="button" onClick={onSample}>
            Open sample project
          </button>
        </div>
        {recent.length ? (
          <>
            <h3>Recent</h3>
            <ul className="recent">
              {recent.map((p) => (
                <li key={p}>
                  <button type="button" className="link" onClick={() => onRecent(p)} title={p}>
                    {p.split(/[\\/]/).pop()}
                  </button>
                  <span className="muted mono small">{p}</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </main>
  );
}
