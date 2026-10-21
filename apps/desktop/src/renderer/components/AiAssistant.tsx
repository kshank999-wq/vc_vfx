import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { newCamTrackDocument, resetsOnLabel, serializeProject, shotState, type CamTrackDocument, type Project, type Result } from '@vcvfx/domain';
import type { AiAllowanceInfo, AiRunEvent, ViewerFrame, VcvfxApi } from '../../shared/bridge';
import { runTrackAgent, type AgentEvent, type StopReason } from '../../shared/ai/agent';
import { demoModel, demoScriptFor, type DemoScript } from '../../shared/ai/demo';
import { applyAiOps, type AiOp } from '../../shared/ai/ops';
import type { CommandEntry, FinishReport, QuadProposal } from '../../shared/ai/tools';
import { bridgeHost } from '../ai-host';
import type { TrackMutation } from './TrackWorkspace';
import './ai-assistant.css';

/**
 * The AI tracking assistant's panel (addendum 07 §7), docked on the right of
 * the Track workspace. The artist says what they want (or picks a preset);
 * the assistant drives the same tracking commands they use, and every call
 * and its log entry appears here as it happens. Stop at any time; Undo
 * reverts the run. The final report says what was done, the numbers, the
 * concerns and the frames to look at — approval stays the artist's.
 *
 * On the desktop the loop runs in the main process and asks this panel to
 * apply each change (so it goes through the domain and the log like any
 * other) and to confirm proposed corners. In the browser preview there is no
 * model: a scripted demo replays a plausible session with real commands.
 */

export interface AiAssistantProps {
  api: VcvfxApi;
  project: Project;
  shotId: string;
  projectKey: string;
  canEdit: boolean;
  actor: string;
  onTrack(fn: TrackMutation): boolean;
  notify(kind: 'ok' | 'error' | 'info', text: string): void;
  onFrame(frame: number): void;
}

type Item =
  | { id: number; kind: 'thinking'; text: string }
  | { id: number; kind: 'text'; text: string }
  | { id: number; kind: 'tool'; toolId: string; name: string; input: unknown; result?: { ok: boolean; summary: string }; commands: CommandEntry[] }
  | { id: number; kind: 'note'; text: string; tone: 'info' | 'error' };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

interface Pending {
  proposal: QuadProposal;
  answer(a: { accepted: boolean; note?: string }): void;
}

const CAPS = [10, 20, 40, 60, 100];
const MAX_TURNS = 40;

const PRESETS: { id: DemoScript; label: string; instruction: string }[] = [
  { id: 'solve', label: 'Solve camera', instruction: 'Track and solve the camera for this shot. Keep features off anything that moves independently of the set.' },
  { id: 'cleanup', label: 'Clean up and re-solve', instruction: 'Clean up the tracks of the current solve — outliers and very short tracks — and re-solve. Keep the better solve active.' },
  { id: 'lidar', label: 'Align to LiDAR', instruction: 'Align the camera solve to the imported LiDAR scan and solve with it as a constraint. Check the residuals.' },
];

const TOOL_WORDS: Record<string, string> = {
  get_shot_context: 'Read the shot',
  get_track_stats: 'Track statistics',
  get_solve_report: 'Solve report',
  auto_track: 'Auto-track',
  detect_features: 'Detect features',
  track_features: 'Track features',
  delete_tracks: 'Delete tracks',
  set_camera: 'Set camera',
  search_cameras: 'Search cameras',
  set_lens_constraints: 'Lens constraints',
  solve: 'Solve',
  select_solve: 'Select solve',
  exclude_moving_objects: 'Exclude roto parts',
  exclude_region: 'Exclude region',
  create_exclusion_matte: 'Exclusion matte',
  list_lidar_candidates: 'LiDAR candidates',
  add_correspondence: 'Add correspondence',
  remove_correspondence: 'Remove correspondence',
  align_to_lidar: 'Align to LiDAR',
  solve_with_lidar: 'Solve with LiDAR',
  set_coordinate_system: 'Coordinate system',
  planar_track: 'Planar track',
  export: 'Export',
  get_frame_image: 'Look at a frame',
  finish: 'Report',
};

const STOP_WORDS: Record<StopReason, string> = {
  finished: 'Finished',
  end_turn: 'Stopped',
  max_turns: 'Turn limit',
  credit_cap: 'Credit limit',
  cancelled: 'Stopped',
  refusal: 'Declined',
  max_tokens: 'Cut off',
  allowance: 'Allowance used up',
  error: 'Error',
};

/** A tool call's input, briefly. */
function brief(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const parts = Object.entries(input as Record<string, unknown>)
    .filter(([k]) => !['summary', 'actions', 'concerns', 'frames_to_check', 'next_steps', 'reason'].includes(k))
    .map(([k, v]) => `${k.replace(/_/g, ' ')} ${typeof v === 'object' ? JSON.stringify(v).replace(/"/g, '').slice(0, 60) : String(v)}`);
  return parts.join(' · ').slice(0, 140);
}

const credits$ = (c: number) => `$${(c * 0.05).toFixed(2)}`;

export function AiAssistant({ api, project, shotId, projectKey, canEdit, actor, onTrack, notify, onFrame }: AiAssistantProps) {
  const demo = !api.aiTrackRun;
  const state = shotState(project, shotId);
  const hasCam = Boolean(state?.tasks.some((t) => t.kind === 'camera_track'));
  const has2d = Boolean(state?.tasks.some((t) => t.kind === 'track_2d'));
  const projectRef = useRef(project);
  projectRef.current = project;

  const [open, setOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem('vcvfx.ai.open') !== '0';
    } catch {
      return true;
    }
  });
  const [instruction, setInstruction] = useState('');
  const [frames, setFrames] = useState(false);
  const [exportOk, setExportOk] = useState(false);
  const [cap, setCap] = useState(40);
  const [running, setRunning] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [live, setLive] = useState('');
  const [turn, setTurn] = useState(0);
  const [progress, setProgress] = useState<{ label: string; done: number; total: number } | null>(null);
  const [credits, setCredits] = useState(0);
  const [allowance, setAllowance] = useState<AiAllowanceInfo | null>(null);
  const [allowanceError, setAllowanceError] = useState<string | null>(null);
  const [report, setReport] = useState<FinishReport | null>(null);
  const [ended, setEnded] = useState<{ reason: StopReason; message: string; text: string | null; turns: number } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [undoable, setUndoable] = useState<{ doc: CamTrackDocument | null; created2d: string[] } | null>(null);
  const [top, setTop] = useState(52);
  const dockRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLOListElement | null>(null);
  const runIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const nextId = useRef(1);
  const createdRef = useRef<string[]>([]);

  useEffect(() => {
    try {
      localStorage.setItem('vcvfx.ai.open', open ? '1' : '0');
    } catch {
      // per-viewer convenience only
    }
  }, [open]);

  // Sit below the viewer's header bar.
  useLayoutEffect(() => {
    const bar = dockRef.current?.closest('.viewer')?.querySelector('.viewer-bar');
    if (bar) setTop(Math.round(bar.getBoundingClientRect().height));
  }, [open]);

  useEffect(() => {
    let alive = true;
    if (api.aiFrames) void api.aiFrames({ projectKey }).then((v) => alive && setFrames(v));
    else setFrames(false);
    return () => {
      alive = false;
    };
  }, [api, projectKey]);

  const refreshAllowance = useCallback(() => {
    if (!api.aiAllowance) return;
    void api.aiAllowance().then((r) => {
      if (r.ok) {
        setAllowance(r.data);
        setAllowanceError(null);
      } else setAllowanceError(r.error);
    });
  }, [api]);
  useEffect(() => refreshAllowance(), [refreshAllowance]);

  useEffect(() => {
    listRef.current?.lastElementChild?.scrollIntoView?.({ block: 'nearest' });
  }, [items, live, pending]);

  // A new shot starts a new conversation.
  useEffect(() => {
    setConversationId(null);
    setItems([]);
    setReport(null);
    setEnded(null);
    setUndoable(null);
  }, [shotId]);

  const push = (item: DistributiveOmit<Item, 'id'>) => setItems((xs) => [...xs, { ...item, id: nextId.current++ } as Item]);

  /** Apply the assistant's ops through the App (the domain and the log), synchronously. */
  const applyOps = useCallback(
    (ops: readonly AiOp[]): Result => {
      let result = { ok: false, reason: 'The change was not applied.' } as Result;
      onTrack((p, a, now) => (result = applyAiOps(p, shotId, ops, `${a} (AI assistant)`, now)));
      if (result.ok) projectRef.current = result.project;
      return result;
    },
    [onTrack, shotId],
  );

  const onAgentEvent = useCallback((e: AgentEvent | Exclude<AiRunEvent, { type: 'apply' | 'confirm' }>) => {
    switch (e.type) {
      case 'turn':
        setTurn(e.turn);
        setLive('');
        break;
      case 'fragment':
        if (e.fragment.kind === 'delta' && e.fragment.delta === 'thinking') {
          const add = e.fragment.text;
          setLive((t) => (t + add).slice(-400));
        }
        break;
      case 'thinking':
        setLive('');
        push({ kind: 'thinking', text: e.text });
        break;
      case 'text':
        push({ kind: 'text', text: e.text });
        break;
      case 'tool_call':
        setProgress(null);
        push({ kind: 'tool', toolId: e.id, name: e.name, input: e.input, commands: [] });
        break;
      case 'command':
        setItems((xs) => xs.map((x) => (x.kind === 'tool' && x.toolId === e.toolId ? { ...x, commands: [...x.commands, e.entry] } : x)));
        break;
      case 'tool_result':
        setProgress(null);
        setItems((xs) => xs.map((x) => (x.kind === 'tool' && x.toolId === e.id ? { ...x, result: { ok: e.ok, summary: e.summary } } : x)));
        break;
      case 'usage':
        setCredits(e.credits);
        if (e.allowance) setAllowance((a) => ({ ...(a ?? {}), ...e.allowance! }));
        break;
      case 'progress':
        setProgress({ label: e.label, done: e.done, total: e.total });
        break;
    }
  }, []);

  const askConfirm = useCallback((proposal: QuadProposal) => new Promise<{ accepted: boolean; note?: string }>((resolve) => setPending({ proposal, answer: (a) => (setPending(null), resolve(a)) })), []);

  const drawn = state?.track2d?.tracks.find((t) => t.kind === 'planar' && t.keys.length > 0 && !t.frames.some((f) => f.status === 'tracked'));
  const surface = drawn
    ? { instruction: `Track the surface “${drawn.name}” through the shot.`, notes: [`The artist has drawn a planar 2D track ${drawn.id} (“${drawn.name}”) with a key at frame ${drawn.keys[0]!.frame}.`] }
    : { instruction: 'Find the flat surface worth tracking for a replacement, propose its corners for me to confirm, and track it.', notes: [] as string[] };
  const surfaceReady = has2d && (Boolean(drawn) || frames || demo);

  const start = async (text: string, script: DemoScript | null, notes: string[] = []) => {
    const words = text.trim();
    if (!words || running) return;
    const baseline = shotState(projectRef.current, shotId)?.camtrack ?? null;
    setRunning(true);
    setItems([]);
    setReport(null);
    setEnded(null);
    setPending(null);
    setCredits(0);
    setTurn(0);
    setLive('');
    setUndoable(null);
    createdRef.current = [];
    push({ kind: 'note', tone: 'info', text: `“${words}”` });
    const exportAllowed = exportOk;
    try {
      if (demo) {
        const controller = new AbortController();
        abortRef.current = controller;
        const host = bridgeHost({ api, shotId, projectKey, actor: `${actor} (AI assistant)`, project: () => projectRef.current, apply: applyOps, confirm: askConfirm, framesAllowed: frames });
        const outcome = await runTrackAgent({ model: demoModel(script ?? demoScriptFor(words), { delayMs: 650 }), host, instruction: words, notes, framesAllowed: frames, exportAllowed, limits: { creditCap: cap, maxTurns: MAX_TURNS }, signal: controller.signal, onEvent: onAgentEvent, sessionId: 'demo', shotRef: shotId });
        setReport(outcome.report);
        setEnded({ reason: outcome.reason, message: outcome.message, text: outcome.text, turns: outcome.turns });
        createdRef.current = outcome.created2d;
      } else {
        const runId = `ai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        runIdRef.current = runId;
        const off = api.onAiEvent?.((e) => {
          if (e.runId !== runId) return;
          if (e.type === 'apply') {
            const r = applyOps(e.ops as AiOp[]);
            void api.aiTrackAck?.({ runId, seq: e.seq, ok: r.ok, ...(r.ok ? { text: serializeProject(r.project) } : { error: r.reason }) });
          } else if (e.type === 'confirm') {
            void askConfirm(e.proposal).then((a) => api.aiTrackAck?.({ runId, seq: e.seq, ok: true, accepted: a.accepted, ...(a.note ? { note: a.note } : {}) }));
          } else onAgentEvent(e);
        });
        const r = await api.aiTrackRun!({ text: serializeProject(projectRef.current), shotId, projectKey, runId, operator: actor, instruction: words, ...(notes.length ? { notes } : {}), framesAllowed: frames, exportAllowed, creditCap: cap, maxTurns: MAX_TURNS, focalRange: null, conversationId });
        off?.();
        if (!r.ok) {
          push({ kind: 'note', tone: 'error', text: r.error });
          setEnded({ reason: 'error', message: r.error, text: null, turns: 0 });
        } else {
          setReport(r.data.report);
          setEnded({ reason: r.data.reason, message: r.data.message, text: r.data.text, turns: r.data.turns });
          setConversationId(r.data.conversationId);
          createdRef.current = r.data.created2d;
        }
        refreshAllowance();
      }
      const after = shotState(projectRef.current, shotId);
      if (JSON.stringify(after?.camtrack ?? null) !== JSON.stringify(baseline) || createdRef.current.length) setUndoable({ doc: baseline, created2d: [...createdRef.current] });
    } catch (error) {
      push({ kind: 'note', tone: 'error', text: (error as Error).message });
      setEnded({ reason: 'error', message: (error as Error).message, text: null, turns: 0 });
    } finally {
      setRunning(false);
      setProgress(null);
      setLive('');
      setPending(null);
      abortRef.current = null;
      runIdRef.current = null;
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    if (runIdRef.current) void api.aiTrackCancel?.(runIdRef.current);
  };

  const undo = () => {
    if (!undoable) return;
    const doc = undoable.doc ?? newCamTrackDocument(projectRef.current, shotId);
    const ops: AiOp[] = [{ op: 'camtrack_revert', doc, summary: 'Reverted the AI assistant’s changes to the camera track' }, ...undoable.created2d.map((trackId): AiOp => ({ op: 'track2d_remove', trackId }))];
    const r = applyOps(ops);
    if (r.ok) {
      notify('ok', 'The assistant’s changes were reverted (logged).');
      setUndoable(null);
    } else notify('error', r.reason);
  };

  const toggleFrames = (on: boolean) => {
    setFrames(on);
    setConversationId(null); // the tools differ, so a new conversation
    if (api.aiFrames) void api.aiFrames({ projectKey, allowed: on });
  };

  const exhausted = allowance && allowance.remaining !== null && allowance.remaining <= 0;
  const blocked = !canEdit ? 'Read-only: the assistant changes the camera track, which needs an active VC VFX subscription. Subscribe or renew at vc-vfx.com, then activate this computer under Account.' : exhausted ? `AI allowance used up this month — resets on ${resetsOnLabel(allowance!.resetsAt)}.` : null;
  const disabled = running || Boolean(blocked);
  const preset = (p: (typeof PRESETS)[number]) => {
    setInstruction(p.instruction);
    void start(p.instruction, p.id);
  };

  if (!open)
    return (
      <div className="ai-dock" ref={dockRef} style={{ top }}>
        <button type="button" className="ai-tab" onClick={() => setOpen(true)} title="AI tracking assistant">
          AI assistant{running ? ' ●' : ''}
        </button>
      </div>
    );

  return (
    <div className="ai-dock open" ref={dockRef} style={{ top }}>
      <aside className="ai-panel" aria-label="AI assistant">
        <header className="ai-head">
          <h3>AI assistant</h3>
          {demo ? <span className="ai-tag">Demo</span> : null}
          <span className="spacer" />
          <button type="button" className="link" onClick={() => setOpen(false)} aria-label="Hide the AI assistant" title="Hide">
            ✕
          </button>
        </header>

        <div className="ai-scroll">
          {demo ? (
            <p className="ai-callout">
              <strong>Demo — the real assistant runs in the desktop app.</strong> Here a scripted matchmover replays a session on the sample shot. The commands and numbers are real; no AI model is called and nothing leaves this page.
            </p>
          ) : null}
          {blocked ? <p className="ai-callout warn">{blocked}</p> : null}
          {!hasCam && !has2d ? <p className="ai-callout">Add a Camera track or 2D track task to this shot first.</p> : null}

          <section className="ai-ask">
            <textarea
              aria-label="What should the assistant do?"
              placeholder={conversationId ? 'Follow up…' : 'Track the camera; ignore the actor; align to the LiDAR'}
              value={instruction}
              rows={3}
              disabled={disabled}
              onChange={(e) => {
                setInstruction(e.target.value);
                if (/\bexport/i.test(e.target.value)) setExportOk(true);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void start(instruction, null);
              }}
            />
            <div className="ai-presets">
              {PRESETS.map((p) => (
                <button key={p.id} type="button" className="small-button" disabled={disabled || !hasCam} onClick={() => preset(p)}>
                  {p.label}
                </button>
              ))}
              <button
                type="button"
                className="small-button"
                disabled={disabled || !surfaceReady}
                title={!has2d ? 'Add a 2D track task first' : surfaceReady ? undefined : 'Draw the surface’s four corners in 2D / planar first, or let the assistant see frames'}
                onClick={() => {
                  setInstruction(surface.instruction);
                  void start(surface.instruction, 'surface', surface.notes);
                }}
              >
                Track this surface
              </button>
            </div>
            <div className="ai-run-row">
              {running ? (
                <button type="button" className="danger" onClick={stop}>
                  Stop
                </button>
              ) : (
                <button type="button" className="primary" disabled={disabled || !instruction.trim() || (!hasCam && !has2d)} onClick={() => void start(instruction, null)}>
                  {conversationId ? 'Send' : 'Run'}
                </button>
              )}
              <label className="ai-cap">
                <span className="muted small">Limit</span>
                <select aria-label="Credit limit for this run" value={cap} disabled={running} onChange={(e) => setCap(Number(e.target.value))}>
                  {CAPS.map((c) => (
                    <option key={c} value={c}>
                      {c} credits ({credits$(c)})
                    </option>
                  ))}
                </select>
              </label>
              {conversationId && !running ? (
                <button type="button" className="link small" onClick={() => setConversationId(null)}>
                  New conversation
                </button>
              ) : null}
            </div>
            <label className="check small">
              <input type="checkbox" checked={exportOk} disabled={running} onChange={(e) => setExportOk(e.target.checked)} /> Let it export when the work is good
            </label>
          </section>

          <section className="ai-frames">
            <label className="check">
              <input type="checkbox" checked={frames} disabled={running} onChange={(e) => toggleFrames(e.target.checked)} /> <strong>Let AI see frames</strong> of this project
            </label>
            <p className="muted small">
              {frames
                ? 'On: the assistant may look at a few frames of this project, downscaled to at most 1024 px, to find surfaces and moving objects. They are sent through vc-vfx.com to Anthropic, the AI provider, only to answer this request; Anthropic does not use API data to train its models by default.'
                : 'Off: no frames leave this computer. The assistant works from your instruction and the shot’s tracking data — counts, errors, camera and lens settings and names — which are sent through vc-vfx.com to Anthropic, the AI provider.'}
              {demo ? ' (In this demo nothing is sent anywhere.)' : ''}
            </p>
          </section>

          <section className="ai-meter" aria-live="polite">
            {running ? (
              <div className="ai-progress" role="progressbar" aria-label="Assistant progress" aria-valuemin={0} aria-valuemax={MAX_TURNS} aria-valuenow={turn}>
                <span className="ai-spinner" aria-hidden="true" />
                <span>{progress ? `${progress.label}${progress.total > 1 ? ` · ${Math.round((100 * progress.done) / progress.total)} %` : ''}` : `Step ${turn} of up to ${MAX_TURNS}`}</span>
              </div>
            ) : null}
            <div className="ai-credits small">
              <span>
                This run: <strong>{credits.toFixed(1)}</strong> credit{credits === 1 ? '' : 's'} ({credits$(credits)}){demo ? ' · estimated' : ''} of {cap}
              </span>
              <span className="muted">
                {demo
                  ? 'Monthly allowance: in the desktop app'
                  : allowance
                    ? allowance.remaining === null
                      ? `Month: ${allowance.used.toFixed(1)} used (not metered)`
                      : `Month: ${allowance.remaining.toFixed(1)} of ${allowance.limit} left · resets ${resetsOnLabel(allowance.resetsAt)}`
                    : allowanceError
                      ? `Allowance: ${allowanceError}`
                      : 'Month: —'}
              </span>
            </div>
          </section>

          {pending ? <ConfirmCard api={api} project={project} shotId={shotId} projectKey={projectKey} pending={pending} /> : null}

          {items.length || live ? (
            <ol className="ai-activity" ref={listRef} aria-label="What the assistant did">
              {items.map((it) => (
                <ActivityItem key={it.id} item={it} />
              ))}
              {live ? <li className="ai-thinking live">{live}</li> : null}
            </ol>
          ) : null}

          {ended ? (
            <section className={`ai-ended ${ended.reason === 'finished' ? 'ok' : ended.reason === 'error' || ended.reason === 'allowance' || ended.reason === 'refusal' ? 'bad' : ''}`}>
              {ended.message.startsWith(STOP_WORDS[ended.reason]) ? ended.message : (
                <>
                  <strong>{STOP_WORDS[ended.reason]}</strong> · {ended.message}
                </>
              )}
              {ended.text && !report ? <p className="ai-text">{ended.text}</p> : null}
            </section>
          ) : null}

          {report ? <ReportCard report={report} onFrame={onFrame} /> : null}

          {undoable && !running ? (
            <div className="ai-undo">
              <button type="button" onClick={undo} disabled={!canEdit}>
                Undo the assistant’s changes
              </button>
              <span className="muted small">Restores the camera track as it was before this run{undoable.created2d.length ? ' and removes the 2D tracks it made' : ''}; the earlier solves stay available.</span>
            </div>
          ) : null}
        </div>
      </aside>
    </div>
  );
}

function ActivityItem({ item }: { item: Item }) {
  if (item.kind === 'thinking') return <li className="ai-thinking">{item.text}</li>;
  if (item.kind === 'text') return <li className="ai-text">{item.text}</li>;
  if (item.kind === 'note') return <li className={`ai-note ${item.tone}`}>{item.text}</li>;
  const state = item.result ? (item.result.ok ? 'ok' : 'bad') : 'busy';
  return (
    <li className={`ai-tool ${state}`}>
      <div className="ai-tool-head">
        <span className="ai-dot" aria-hidden="true" />
        <strong>{TOOL_WORDS[item.name] ?? item.name}</strong>
        {item.name !== 'finish' ? <span className="muted small ai-input">{brief(item.input)}</span> : null}
      </div>
      {item.commands.map((c, k) => (
        <div key={k} className={`ai-command ${c.ok ? '' : 'bad'}`}>
          <code>{c.verb.includes('.') ? c.verb : c.verb.startsWith('track2d_') ? `track2d.${c.verb.slice(8)}` : `camtrack.${c.verb}`}</code> {c.summary}
        </div>
      ))}
      {item.result && !item.commands.length && item.name !== 'finish' ? <div className={`ai-result ${item.result.ok ? '' : 'bad'}`}>{item.result.summary}</div> : item.result && !item.result.ok && item.commands.every((c) => c.ok) ? <div className="ai-result bad">{item.result.summary}</div> : null}
    </li>
  );
}

function ReportCard({ report, onFrame }: { report: FinishReport; onFrame(f: number): void }) {
  const s = report.finalStats;
  const stats: [string, string][] = [
    ...(s.rmsPx !== undefined ? [['RMS', `${s.rmsPx.toFixed(3)} px`] as [string, string]] : []),
    ...(s.focalMm !== undefined ? [['Focal', `${s.focalMm.toFixed(2)} mm`] as [string, string]] : []),
    ...(s.framesSolved !== undefined ? [['Frames', `${s.framesSolved}${s.framesTotal ? ` / ${s.framesTotal}` : ''}`] as [string, string]] : []),
    ...(s.tracks !== undefined ? [['Tracks', String(s.tracks)] as [string, string]] : []),
    ...(s.meanConfidence2d !== undefined ? [['2D confidence', s.meanConfidence2d.toFixed(2)] as [string, string]] : []),
  ];
  return (
    <section className="ai-report" aria-label="The assistant’s report">
      <div className="ai-report-head">
        <h4>Report</h4>
        <span className={`ai-badge ${report.targetsMet ? 'ok' : 'warn'}`}>{report.targetsMet ? 'Targets met' : 'Targets not met'}</span>
      </div>
      <p>{report.summary}</p>
      {stats.length ? (
        <dl className="ai-stats">
          {stats.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {report.concerns.length ? (
        <>
          <h5>Concerns</h5>
          <ul>
            {report.concerns.map((c, k) => (
              <li key={k}>{c}</li>
            ))}
          </ul>
        </>
      ) : null}
      {report.framesToCheck.length ? (
        <>
          <h5>Frames to check</h5>
          <ul className="ai-frames-list">
            {report.framesToCheck.map((f, k) => (
              <li key={k}>
                <button type="button" className="link" onClick={() => onFrame(f.frame)}>
                  {f.frame}
                </button>{' '}
                {f.reason}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {report.actions.length ? (
        <details>
          <summary>What it did ({report.actions.length})</summary>
          <ol>
            {report.actions.map((a, k) => (
              <li key={k}>{a}</li>
            ))}
          </ol>
        </details>
      ) : null}
      {report.nextSteps.length ? (
        <>
          <h5>Next</h5>
          <ul>
            {report.nextSteps.map((c, k) => (
              <li key={k}>{c}</li>
            ))}
          </ul>
        </>
      ) : null}
      <p className="muted small">The assistant cannot approve. Review the solve, then approve the task in the shot panel if you agree.</p>
    </section>
  );
}

function ConfirmCard({ api, project, shotId, projectKey, pending }: { api: VcvfxApi; project: Project; shotId: string; projectKey: string; pending: Pending }) {
  const { proposal } = pending;
  const [img, setImg] = useState<ViewerFrame | null>(null);
  const [plate, setPlate] = useState<{ width: number; height: number } | null>(null);
  const [note, setNote] = useState('');
  const text = useMemo(() => serializeProject(project), [project]);
  useEffect(() => {
    let alive = true;
    void api.trackSession({ text, shotId, projectKey }).then((r) => alive && r.ok && setPlate(r.data.plate));
    void api.trackFrame({ text, shotId, projectKey, frame: proposal.frame, maxWidth: 640 }).then((r) => alive && r.ok && setImg(r.data));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposal]);
  const pts = proposal.corners.map(([x, y]) => `${x},${y}`).join(' ');
  return (
    <section className="ai-confirm" aria-label="Confirm the proposed surface">
      <h4>Track “{proposal.name}”?</h4>
      <p className="small">{proposal.reason || 'The assistant proposes these corners.'} Frame {proposal.frame}.</p>
      <div className="ai-confirm-frame">
        {img ? <img src={img.url} alt={`Frame ${proposal.frame}`} /> : <div className="ai-confirm-blank" />}
        {plate ? (
          <svg viewBox={`0 0 ${plate.width} ${plate.height}`} preserveAspectRatio="none" aria-hidden="true">
            <polygon points={pts} />
            {proposal.corners.map(([x, y], k) => (
              <circle key={k} cx={x} cy={y} r={Math.max(3, plate.width / 120)} />
            ))}
          </svg>
        ) : null}
      </div>
      <input type="text" className="ai-note-input" placeholder="Note for the assistant (optional)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note for the assistant" />
      <div className="ai-run-row">
        <button type="button" className="primary" onClick={() => pending.answer({ accepted: true })}>
          Track it
        </button>
        <button type="button" onClick={() => pending.answer({ accepted: false, ...(note.trim() ? { note: note.trim() } : {}) })}>
          Not that
        </button>
      </div>
      <p className="muted small">You can correct any corner afterwards by dragging it in 2D / planar; that frame becomes a key.</p>
    </section>
  );
}
