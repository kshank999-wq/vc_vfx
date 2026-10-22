import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
  recordPlates,
  reopenShot,
  serializeProject,
  setPlateColorDefault,
  setProbedMedia,
  setShotPlateColor,
  setShotNotes,
  setSourceVerified,
  setVfxShotId,
  setTaskNotes,
  setTaskState,
  shotState,
  shotTiming,
  toggleReviewMark,
  type HandoffIssue,
  type PrepTaskKind,
  type Project,
  type QueueFilter,
  type Result,
  type TaskState,
} from '@vcvfx/domain';
import type { AccountStatus, AppInfo, JobProgress, LicenceStanding, MenuCommand, ProbeResult, Settings, VcvfxApi } from '../shared/bridge';
import { projectKey } from '../shared/queue';
import { clampFrame, viewerTimeline } from '../shared/viewer';
import { BulkBar, QueueFilters, QueueTable, type SelectGesture } from './components/Queue';
import { ShotDetail, type ShotDetailProps } from './components/ShotDetail';
import { AccountDialog, IssuesDialog, PromptDialog, SettingsDialog } from './components/Dialogs';
import { Icon } from './components/Icons';
import { ModuleTabs, NoticeDock, ShotBar, Tour, WhatsHere, modKey } from './components/Layout';
import { CleanPlateModule, DeliverModule, IsolateModule, KeyModule, PlatesModule, TaskInfo, TextureModule } from './components/Modules';
import { RotoWorkspace } from './components/RotoWorkspace';
import { TrackWorkspace } from './components/TrackWorkspace';
import { MODULES, MODULE_IDS, PREF, moduleForDigit, moduleToOpen, readPref, type ModuleId } from './modules';
import { NOTICE_MS, pushNotice, type Notice } from './notices';

interface Doc {
  project: Project;
  path: string | null;
  dirty: boolean;
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
  /** The module tab on screen (addendum 08); Shots is the overview. */
  const [module, setModuleState] = useState<ModuleId>('shots');
  /** The last module other than Shots, opened again by a double-click. */
  const [lastModule, setLastModule] = useState<ModuleId | null>(null);
  /** The frame the module tabs share, for the shot it belongs to. */
  const [frameOf, setFrameOf] = useState<{ shotId: string; frame: number } | null>(null);
  const [tour, setTour] = useState(false);
  const tourOffered = useRef(false);

  const capability = capabilityFrom(standing, now());
  const canEdit = capability === 'full';
  const operator = account.displayName || account.email || settings.operatorName || '';
  const actor = operator || 'Operator';
  const busy = job !== null;

  /** The viewer's toast dock while a module is on screen (null: the window). */
  const [noticeDock, setNoticeDock] = useState<HTMLElement | null>(null);
  /** Expiry timers of info and ok notices; paused while the pointer is over one. */
  const noticeTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const dropNotice = useCallback((id: number) => {
    clearTimeout(noticeTimers.current.get(id));
    noticeTimers.current.delete(id);
    setNotices((n) => n.filter((x) => x.id !== id));
  }, []);
  const expireNotice = useCallback((id: number, ms: number) => {
    clearTimeout(noticeTimers.current.get(id));
    noticeTimers.current.set(id, setTimeout(() => dropNotice(id), ms));
  }, [dropNotice]);
  const holdNotice = useCallback((id: number) => {
    clearTimeout(noticeTimers.current.get(id));
  }, []);
  const notify = useCallback((kind: Notice['kind'], text: string, action?: Notice['action']) => {
    const id = (noticeSeq += 1);
    setNotices((n) => pushNotice(n, { id, kind, text, ...(action ? { action } : {}) }));
    if (kind !== 'error') expireNotice(id, NOTICE_MS);
  }, [expireNotice]);

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
      setModuleState('shots');
      setFrameOf(null);
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
        `${ffmpeg.problem ?? 'ffmpeg was not found.'} No plates were written and the task is unchanged.`,
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
    // What was applied to the plates, exactly, goes into the project and its log (§19).
    const record = r.data.record;
    if (record) apply((p) => recordPlates(p, shotId, record, actor, now()));
    // Processing finishing never approves anything (§15.6): it goes to review.
    apply((p) => setTaskState(p, shotId, 'sequence_conversion', 'needs_review', actor, now()));
    notify('ok', `${r.data.frames} frames written as ${r.data.pattern}. Review them, then approve the task.`, { label: 'View', run: () => openModule('plates', shotId) });
  };

  // --- modules, shots and frames --------------------------------------------
  const rows = useMemo(() => (doc ? queueRows(doc.project, filter) : []), [doc, filter]);

  const setModule = useCallback((id: ModuleId) => {
    setModuleState(id);
    if (id !== 'shots') setLastModule(id);
  }, []);
  /** Open a module tab, on a given shot if one is named. */
  const openModule = (id: ModuleId, shotId?: string) => {
    if (shotId) {
      setSelected(shotId);
      setMarked([]);
    }
    setModule(id);
  };

  const project = doc?.project ?? null;
  const timeline = useMemo(() => (project && selected ? viewerTimeline(project, selected) : null), [project, selected]);
  const frame = frameOf && frameOf.shotId === selected ? frameOf.frame : (timeline?.editorialIn ?? timeline?.first ?? 0);
  const setFrame = useCallback(
    (f: number) => {
      if (!selected) return;
      setFrameOf({ shotId: selected, frame: timeline ? clampFrame(timeline, f) : f });
    },
    [selected, timeline],
  );

  // --- menu and keyboard ----------------------------------------------------
  const commands = useRef<(c: MenuCommand) => void>(() => undefined);
  commands.current = (command: MenuCommand) => {
    if (command.startsWith('open-recent:')) return void openPath(command.slice('open-recent:'.length));
    if (command.startsWith('show-') && command !== 'show-tour') {
      const id = command.slice('show-'.length) as ModuleId;
      if (MODULE_IDS.includes(id) && (docRef.current || id === 'shots')) setModule(id);
      return;
    }
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
      case 'show-tour':
        if (docRef.current) {
          setModule('shots');
          setTour(true);
        }
        return;
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
    setMarked([]);
  };
  // The keys the App owns: ⌘/Ctrl+1…9 and 0 the tabs (modules.ts MODULE_DIGITS), ⌘/Ctrl+↑/↓ the shot (anywhere); ↑/↓ the shot on
  // the Shots tab; ←/→ the frame and Esc back to Shots in the tabs whose viewer does not do it itself.
  const keys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keys.current = (e: KeyboardEvent) => {
    if (document.querySelector('.modal')) return;
    const target = e.target as HTMLElement | null;
    const typing = Boolean(target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
      const id = moduleForDigit(e.key);
      if (id) {
        if (!docRef.current && id !== 'shots') return;
        e.preventDefault();
        return setModule(id);
      }
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !typing) {
        e.preventDefault();
        return moveSelection(e.key === 'ArrowDown' ? 1 : -1);
      }
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (module === 'shots' && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      moveSelection(e.key === 'ArrowDown' ? 1 : -1);
    } else if ((module === 'roto' || module === 'camera' || module === 'track2d') && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      setFrame(frame + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 10 : 1));
    } else if (e.key === 'Escape' && (module === 'roto' || module === 'camera' || module === 'track2d' || module === 'deliver')) {
      e.preventDefault();
      setModule('shots');
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Keep the selection on a visible row.
  useEffect(() => {
    if (rows.length && !rows.some((r) => r.shot.shotId === selected)) setSelected(rows[0]!.shot.shotId);
  }, [rows, selected]);

  // The first time a project is open, offer the tour (once; Help › Show the tour brings it back).
  useEffect(() => {
    if (!project || tourOffered.current) return;
    tourOffered.current = true;
    if (readPref(PREF.tourDone) !== '1') {
      setModuleState('shots');
      setTour(true);
    }
  }, [project]);

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

  // --- the shot's handlers, shared by the Shots tab and the modules ----------
  const shotProps = (shotId: string, p: Project): ShotDetailProps => ({
    project: p,
    shotId,
    now: now(),
    canEdit,
    busy,
    outputRoot,
    onTaskState: (kind: PrepTaskKind, state: Exclude<TaskState, 'approved'>) => apply((x) => setTaskState(x, shotId, kind, state, actor, now())),
    onApproveTask: (kind) =>
      askApprover('Approve task', `Approval is recorded with your name and the time, per task (${PREP_TASKS[kind].label}).`, (name) => {
        setPrompt(null);
        apply((x) => approveTask(x, shotId, kind, name, now()));
      }),
    onApproveShot: () =>
      askApprover('Approve shot', `Sign off ${shotId} as prep approved. This is a production decision, recorded with your name.`, (name) => {
        setPrompt(null);
        apply((x) => approveShot(x, shotId, name, now()));
      }),
    onPackage: () => void packageSelected(shotId),
    onDeliver: () => apply((x) => markDelivered(x, shotId, actor, now())),
    onReopen: () => apply((x) => reopenShot(x, shotId, actor, now())),
    onTaskNotes: (kind, notes) => apply((x) => setTaskNotes(x, shotId, kind, notes, actor, now())),
    onShotNotes: (notes) => apply((x) => setShotNotes(x, shotId, notes, actor, now())),
    onAddTask: (kind) => apply((x) => addTask(x, shotId, kind, actor, now())),
    onSetVfxShotId: (value) => apply((x) => setVfxShotId(x, shotId, value, actor, now())),
    ...(api.probeSources && p.handoffPath !== 'sample' ? { onProbe: () => void probeSources([shotId]) } : {}),
    onGeneratePlates: () => void generatePlates(shotId),
    onChangeOutputRoot: () => void chooseOutputRoot(),
    onRevealOutput: () => outputRoot && void api.revealPath(outputRoot),
    onPlateColor: (change) => apply((x) => setShotPlateColor(x, shotId, change, actor, now())),
    onOpenModule: (id) => openModule(id, shotId),
  });

  const moduleScreen = () => {
    if (!project || !doc) return null;
    if (!selected || !key) return <main className="module module-missing">Select a shot on the Shots tab.</main>;
    const props = shotProps(selected, project);
    const screen = {
      ...props,
      api,
      projectKey: key,
      frame,
      onFrame: setFrame,
      onClose: () => setModule('shots'),
      onToggleMark: (f: number, seen: string, note: string) => apply((p) => toggleReviewMark(p, selected, { frame: f, viewing: seen, note }, actor, now())),
    };
    const work = { api, project, shotId: selected, projectKey: key, canEdit, busy, actor, frame, onFrame: setFrame, runJob, notify };
    switch (module) {
      case 'plates':
        return <PlatesModule {...screen} />;
      case 'key':
        return <KeyModule {...screen} work={{ actor, runJob, notify, onKey: (fn) => apply((p) => fn(p, actor, now())) }} />;
      case 'cleanplate':
        return <CleanPlateModule {...screen} work={{ actor, runJob, notify, onCleanPlate: (fn) => apply((p) => fn(p, actor, now())) }} />;
      case 'isolate':
        return <IsolateModule {...screen} work={{ actor, runJob, notify, onIsolate: (fn) => apply((p) => fn(p, actor, now())) }} />;
      case 'texture':
        return <TextureModule {...screen} work={{ actor, runJob, notify, onTexture: (fn) => apply((p) => fn(p, actor, now())) }} />;
      case 'roto':
        return <RotoWorkspace {...work} onRoto={(fn) => apply((p) => fn(p, actor, now()))} onAddRotoTask={() => apply((p) => addTask(p, selected, 'roto', actor, now()))} taskInfo={<TaskInfo props={props} kind="roto" />} />;
      case 'camera':
      case 'track2d':
        return (
          <TrackWorkspace
            key={module}
            {...work}
            mode={module === 'camera' ? 'camera' : '2d'}
            onTrack={(fn) => apply((p) => fn(p, actor, now()))}
            onAddTask={(kind) => apply((p) => addTask(p, selected, kind, actor, now()))}
            taskInfo={<TaskInfo props={props} kind={module === 'camera' ? 'camera_track' : 'track_2d'} />}
          />
        );
      case 'deliver':
        return <DeliverModule {...screen} onVerify={() => void verify()} onPrint={(mode) => void print(mode)} shownShots={rows.length} />;
      default:
        return null;
    }
  };

  // --- render ---------------------------------------------------------------
  const mod = modKey();
  return (
    <NoticeDock.Provider value={setNoticeDock}>
    <div className="app">
      <header className="topbar">
        <div className="brand" title={doc?.path ?? undefined}>
          <span className="logo">VFX</span>
          <span className="brand-text">
            <span className="brand-name">VC VFX</span>
            <span className="brand-project">
              {project ? project.handoff.project : 'No project open'}
              {doc?.dirty ? (
                <span className="dirty" title="Unsaved changes">
                  {' '}
                  •
                </span>
              ) : null}
            </span>
          </span>
        </div>
        <div className="tabs-wrap" data-tour="tabs">
          <ModuleTabs project={project} shotId={selected} active={module} onSelect={setModule} />
        </div>
        <div className="spacer" />
        <div className="top-actions">
          <button
            type="button"
            className="top-icon"
            disabled={!project}
            onClick={() => {
              setModule('shots');
              setTour(true);
            }}
            title="Help: show the quick tour of the tabs"
            aria-label="Help"
          >
            <Icon name="help" size={20} />
            <span>Help</span>
          </button>
          <button type="button" className={`licence-pill ${capability}`} onClick={() => setDialog('account')} title={`Account & licence${account.signedIn ? ` — ${account.displayName ?? account.email}` : ''}`}>
            <Icon name="user" size={18} />
            {capability === 'full' ? 'Licensed' : 'Read-only'}
          </button>
          <button type="button" className="top-icon" aria-label="Settings" title={`Settings (${mod},)`} onClick={() => setDialog('settings')}>
            <Icon name="settings" size={20} />
            <span>Settings</span>
          </button>
        </div>
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
        module === 'shots' ? (
          <div className="shots-screen">
            <ProjectHeader
              project={project}
              path={doc.path}
              dirty={doc.dirty}
              shown={rows.length}
              onOpenHandoff={() => void openHandoff()}
              onOpenProject={() => void openProject()}
              onSample={openSample}
            />
            <WhatsHere onOpen={(id) => openModule(id)} />
            <QueueFilters project={project} filter={filter} onChange={setFilter} />
            <main className="workspace" aria-label="Shots">
              <section className="queue-pane" aria-label="Queue">
                {visibleMarked.length > 1 ? <BulkBar project={project} shotIds={visibleMarked} canEdit={canEdit} busy={busy} onAddTask={addTaskToMarked} onClear={() => setMarked([])} /> : null}
                <QueueTable project={project} rows={rows} selected={selected} marked={visibleMarked} onSelect={selectShot} onOpen={(id) => openModule(moduleToOpen(project, id, lastModule), id)} />
              </section>
              {selected ? <ShotDetail {...shotProps(selected, project)} /> : <aside className="detail empty">Select a shot.</aside>}
            </main>
          </div>
        ) : (
          <>
            {selected ? <ShotBar project={project} rows={rows} shotId={selected} module={module} onSelect={(id) => openModule(module, id)} onMove={moveSelection} /> : null}
            {moduleScreen()}
          </>
        )
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
              module !== 'shots' ? `${MODULES[module].label}` : null,
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
        ) : (
          <span className="muted keys-hint">
            {mod}1–9, {mod}0 tabs (Textures: click) · {mod}↑/↓ shots
          </span>
        )}
      </footer>

      {(() => {
        const list = (
          <div className={noticeDock ? 'notices docked' : 'notices'} aria-live="polite">
            {notices.map((n) => (
              <div key={n.id} className={`notice ${n.kind}`} onMouseEnter={() => holdNotice(n.id)} onMouseLeave={() => (n.kind !== 'error' ? expireNotice(n.id, NOTICE_MS / 2) : undefined)}>
                <span>
                  {n.text}
                  {n.count && n.count > 1 ? <b className="notice-count"> ×{n.count}</b> : null}
                </span>
                {n.action ? (
                  <button type="button" className="link" onClick={n.action.run}>
                    {n.action.label}
                  </button>
                ) : null}
                <button type="button" className="icon" aria-label="Dismiss" onClick={() => dropNotice(n.id)}>
                  ×
                </button>
              </div>
            ))}
          </div>
        );
        return noticeDock ? createPortal(list, noticeDock) : list;
      })()}

      {tour && project ? <Tour onClose={() => setTour(false)} /> : null}
      {issues ? <IssuesDialog {...issues} onClose={() => setIssues(null)} /> : null}
      {prompt ? <PromptDialog {...prompt} onClose={() => setPrompt(null)} /> : null}
      {dialog === 'settings' ? (
        <SettingsDialog
          api={api}
          settings={settings}
          outputRoot={outputRoot}
          hasProject={Boolean(project)}
          plateColorDefault={project?.plateColorDefault ?? null}
          onPlateColorDefault={(value) => apply((p) => setPlateColorDefault(p, value, actor, now()))}
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
    </NoticeDock.Provider>
  );
}

/** The Shots tab's head: the project, where it came from, and opening another. */
function ProjectHeader({
  project,
  path,
  dirty,
  shown,
  onOpenHandoff,
  onOpenProject,
  onSample,
}: {
  project: Project;
  path: string | null;
  dirty: boolean;
  shown: number;
  onOpenHandoff: () => void;
  onOpenProject: () => void;
  onSample: () => void;
}) {
  const h = project.handoff;
  const day = h.origin?.day ? [h.origin.day.number !== undefined ? `Day ${h.origin.day.number}` : null, h.origin.day.date].filter(Boolean).join(' · ') : null;
  const facts = [h.productionCompany, day, h.vfxSupervisor ? `VFX Sup ${h.vfxSupervisor}` : null, h.ditOperator ? `DIT ${h.ditOperator}` : null].filter(Boolean);
  return (
    <section className="project-head" aria-label="Project">
      <div className="project-title">
        <h1>{h.project}</h1>
        <p className="project-facts">
          {facts.join(' · ')}
          {h.origin?.tool ? <span className="muted"> · handed off by {h.origin.tool}</span> : null}
        </p>
        <p className="project-file muted" title={path ?? undefined}>
          {path ? path.split(/[\\/]/).pop() : project.handoffPath === 'sample' ? 'Sample project — not saved' : 'Not saved'}
          {dirty ? <span className="dirty"> · unsaved changes</span> : path ? ' · saved' : ''} · {shown} of {project.shots.length} shots shown
        </p>
      </div>
      <div className="project-actions">
        <button type="button" onClick={onOpenHandoff} title="Open the VCDIT handoff from the drive (Ctrl/Cmd+O)">
          Open handoff…
        </button>
        <button type="button" onClick={onOpenProject} title="Open a saved VC VFX project (Ctrl/Cmd+Shift+O)">
          Open project…
        </button>
        <button type="button" onClick={onSample}>
          Sample project
        </button>
      </div>
    </section>
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
