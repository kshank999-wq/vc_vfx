import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { HandoffIssue } from '@vcvfx/domain';
import { ENCODINGS, PROJECT_EXR_COLOR, capabilityFrom, type ProjectExrColor, type StatusSendOutcome } from '@vcvfx/domain';
import type { AccountStatus, AppInfo, FfmpegInfo, FilmStudioInfo, LicenceStanding, Settings, VcvfxApi } from '../../shared/bridge';

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <button type="button" className="icon" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer>{footer}</footer> : null}
      </div>
    </div>
  );
}

export function IssuesDialog({ title, intro, issues, onClose }: { title: string; intro: string; issues: HandoffIssue[]; onClose: () => void }) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      wide
      footer={
        <button type="button" className="primary" onClick={onClose}>
          OK
        </button>
      }
    >
      <p>{intro}</p>
      <table className="issues">
        <thead>
          <tr>
            <th>Where</th>
            <th>Problem</th>
          </tr>
        </thead>
        <tbody>
          {issues.map((i, n) => (
            <tr key={n}>
              <td className="mono">{i.path || '(file)'}</td>
              <td>{i.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}

export function PromptDialog({
  title,
  label,
  initial,
  confirmLabel,
  detail,
  optional = false,
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  initial: string;
  confirmLabel: string;
  detail?: string;
  /** The value may be left empty. */
  optional?: boolean;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => input.current?.select(), []);
  const submit = () => {
    if (value.trim() || optional) onSubmit(value.trim());
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={!value.trim() && !optional} onClick={submit}>
            {confirmLabel}
          </button>
        </>
      }
    >
      {detail ? <p className="muted">{detail}</p> : null}
      <label className="field">
        <span>{label}</span>
        <input
          ref={input}
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />
      </label>
    </Modal>
  );
}

export function SettingsDialog({
  api,
  settings,
  outputRoot,
  hasProject,
  plateColorDefault,
  onPlateColorDefault,
  onSaved,
  onChooseOutputRoot,
  filmStudio = null,
  onFilmStudio,
  filmStudioProduction = null,
  onFilmStudioProduction,
  onClose,
}: {
  api: VcvfxApi;
  settings: Settings;
  outputRoot: string | null;
  hasProject: boolean;
  /** The open project's default for EXR plates; null with no project. */
  plateColorDefault: ProjectExrColor | null;
  onPlateColorDefault: (value: ProjectExrColor) => void;
  onSaved: (s: Settings) => void;
  onChooseOutputRoot: () => void;
  /** Where the VFX status goes (addendum 19); null where the host has no Film Studio. */
  filmStudio?: FilmStudioInfo | null;
  onFilmStudio?: (info: FilmStudioInfo) => void;
  /** The open project's Film Studio production; null with no project. */
  filmStudioProduction?: string | null;
  onFilmStudioProduction?: (value: string) => void;
  onClose: () => void;
}) {
  const [operatorName, setOperatorName] = useState(settings.operatorName);
  const [ffmpegPath, setFfmpegPath] = useState(settings.ffmpegPath);
  const [ffmpeg, setFfmpeg] = useState<FfmpegInfo | null>(null);
  const [fsUrl, setFsUrl] = useState(filmStudio && filmStudio.url !== filmStudio.defaultUrl ? filmStudio.url : '');
  const [fsKey, setFsKey] = useState('');
  const [fsAuto, setFsAuto] = useState(Boolean(filmStudio?.autoSend));
  const [fsProduction, setFsProduction] = useState(filmStudioProduction ?? '');
  const [fsMessage, setFsMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const canSend = Boolean(filmStudio?.available && api.configureFilmStudio);
  const detect = async () => setFfmpeg(await api.detectFfmpeg());
  useEffect(() => {
    void detect();
  }, []);
  const save = async () => {
    const next = await api.setSettings({ operatorName: operatorName.trim(), ffmpegPath: ffmpegPath.trim() });
    if (filmStudioProduction !== null && fsProduction.trim() !== filmStudioProduction) onFilmStudioProduction?.(fsProduction);
    if (canSend && api.configureFilmStudio) {
      const r = await api.configureFilmStudio({ url: fsUrl, autoSend: fsAuto, ...(fsKey.trim() ? { key: fsKey } : {}) });
      if (!r.ok) {
        // The other settings are saved; this one says what to fix.
        setFsMessage({ kind: 'error', text: r.error });
        onSaved(next);
        return;
      }
      setFsKey('');
      setFsMessage(null);
      onFilmStudio?.(r.data);
    }
    onSaved(next);
    await detect();
  };
  const removeKey = async () => {
    if (!api.configureFilmStudio) return;
    const r = await api.configureFilmStudio({ clearKey: true });
    if (!r.ok) return setFsMessage({ kind: 'error', text: r.error });
    onFilmStudio?.(r.data);
    setFsMessage({ kind: 'ok', text: 'The upload key was removed from this computer.' });
  };
  return (
    <Modal
      title="Settings"
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Close
          </button>
          <button type="button" className="primary" onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <label className="field">
        <span>Operator name</span>
        <input value={operatorName} onChange={(e) => setOperatorName(e.target.value)} placeholder="Used in the log and as the approver when signed out" />
      </label>
      <label className="field">
        <span>ffmpeg</span>
        <input value={ffmpegPath} onChange={(e) => setFfmpegPath(e.target.value)} placeholder="Leave empty to use the ffmpeg bundled with VC VFX" className="mono" />
      </label>
      <p className="small">
        {ffmpeg === null ? (
          <span className="muted">Looking for ffmpeg…</span>
        ) : ffmpeg.found ? (
          <span className="ok-text">
            {ffmpeg.source === 'bundled' ? 'Bundled with VC VFX' : ffmpeg.source === 'settings' ? 'Set here' : 'Found on PATH'}: {ffmpeg.version}
          </span>
        ) : (
          <span className="warn-text">
            {ffmpeg.problem ?? 'ffmpeg was not found.'} macOS: <code>brew install ffmpeg</code> · Windows: <code>winget install Gyan.FFmpeg</code> ·{' '}
            <button type="button" className="link" onClick={() => void api.openExternal('ffmpeg')}>
              ffmpeg.org
            </button>
          </span>
        )}
      </p>
      {hasProject ? (
        <div className="field">
          <span>Output root for this project</span>
          <div className="row">
            <span className="mono path">{outputRoot ?? 'Not chosen'}</span>
            <button type="button" onClick={onChooseOutputRoot}>
              {outputRoot ? 'Change…' : 'Choose…'}
            </button>
          </div>
          <p className="muted small">Kept on this computer, not in the project file. Never inside a source media folder.</p>
        </div>
      ) : null}
      {hasProject && plateColorDefault ? (
        <label className="field">
          <span>EXR plates in this project</span>
          <select aria-label="EXR plates in this project" value={plateColorDefault} onChange={(e) => onPlateColorDefault(e.target.value as ProjectExrColor)}>
            {PROJECT_EXR_COLOR.map((v) => (
              <option key={v} value={v}>
                {v === 'as_shot' ? 'As shot (no conversion)' : `Convert to ${ENCODINGS[v].label}`}
              </option>
            ))}
          </select>
          <span className="muted small">
            Saved in the project and logged. Applies when a shot’s source encoding is known and it has no choice of its own; DPX and TIFF plates always keep the camera encoding. No display look is ever applied to plates.
          </span>
        </label>
      ) : null}
      <fieldset className="settings-group" aria-label="VC Film Studio">
        <legend>VC Film Studio</legend>
        <p className="muted small">
          Sends the VFX status — what is processed, what is ready to hand off, what is not working — to the production’s VC Film Studio. Make an upload key on Film Studio’s data desk: From VC VFX → Send from VC VFX.
        </p>
        {filmStudio && !filmStudio.available ? <p className="warn-text small">{filmStudio.reason}</p> : null}
        <label className="field">
          <span>Film Studio address</span>
          <input value={fsUrl} disabled={!canSend} onChange={(e) => setFsUrl(e.target.value)} placeholder={filmStudio?.defaultUrl ?? 'https://www.vcfilmstudio.com'} className="mono" />
        </label>
        <label className="field">
          <span>Upload key</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={fsKey}
            disabled={!canSend}
            onChange={(e) => setFsKey(e.target.value)}
            placeholder={filmStudio?.hasKey ? `Stored (${filmStudio.keyHint}). Paste a new key to replace it.` : 'vcvfx_… — shown once on Film Studio’s data desk'}
            className="mono"
          />
        </label>
        <div className="row small">
          {filmStudio?.hasKey ? (
            <>
              <span className={filmStudio.encrypted ? 'ok-text' : 'warn-text'}>
                {filmStudio.encrypted
                  ? `Key ${filmStudio.keyHint} is kept in this computer’s keychain, encrypted — never in the project file or the log.`
                  : `Key ${filmStudio.keyHint} is kept in VC VFX’s settings folder as text: this computer offers no keychain to encrypt it with. It is never in the project file or the log.`}
              </span>
              <button type="button" className="link" onClick={() => void removeKey()}>
                Remove key
              </button>
            </>
          ) : canSend ? (
            <span className="muted">No key yet: the status can still be exported and imported on Film Studio’s data desk.</span>
          ) : null}
        </div>
        {filmStudioProduction !== null ? (
          <label className="field">
            <span>Film Studio production for this project</span>
            <input value={fsProduction} onChange={(e) => setFsProduction(e.target.value)} placeholder="As Film Studio names it; empty: the project’s own name" />
          </label>
        ) : null}
        <label className="check">
          <input type="checkbox" checked={fsAuto} disabled={!canSend} onChange={(e) => setFsAuto(e.target.checked)} /> Send the status after each package (at most once a minute)
        </label>
        {fsMessage ? <p className={`small ${fsMessage.kind === 'ok' ? 'ok-text' : 'warn-text'}`} role="status">{fsMessage.text}</p> : null}
      </fieldset>
    </Modal>
  );
}

/**
 * Film Studio's answer to a send, as Film Studio wrote it — `says` on
 * success, every refusal's `error` verbatim — or why nothing was sent. A
 * failed send is safe to repeat; the file is always offered instead.
 */
export function FilmStudioSendDialog({ result, onExport, onSettings, onClose }: { result: { outcome: StatusSendOutcome } | { error: string }; onExport: () => void; onSettings: () => void; onClose: () => void }) {
  const outcome = 'outcome' in result ? result.outcome : null;
  const title = !outcome ? 'Not sent to VC Film Studio' : outcome.kind === 'sent' ? 'Sent to VC Film Studio' : outcome.kind === 'refused' ? 'VC Film Studio refused the report' : 'Not sent to VC Film Studio';
  const keyTrouble = !outcome || (outcome.kind === 'refused' && (outcome.status === 401 || outcome.status === 409));
  const SUMMARY: [string, string][] = [
    ['readyToHandOff', 'ready to hand off'],
    ['inReview', 'in review'],
    ['needsCorrection', 'need correction'],
    ['inProgress', 'in progress'],
    ['notStarted', 'not started'],
    ['delivered', 'delivered'],
  ];
  return (
    <Modal
      title={title}
      onClose={onClose}
      wide
      footer={
        <>
          {outcome?.kind !== 'sent' ? (
            <button type="button" onClick={onExport}>
              Export for VC Film Studio…
            </button>
          ) : null}
          {keyTrouble ? (
            <button type="button" onClick={onSettings}>
              Settings…
            </button>
          ) : null}
          <button type="button" className="primary" onClick={onClose}>
            OK
          </button>
        </>
      }
    >
      {!outcome ? (
        <p className="send-answer warn-text">{(result as { error: string }).error}</p>
      ) : outcome.kind === 'sent' ? (
        <>
          <p className="send-answer ok-text">{outcome.says}</p>
          <p className="muted small">
            {outcome.production ? `Production: ${outcome.production} · ` : ''}
            {outcome.url}
            {outcome.stale ? ' · Film Studio already had a newer report; this one is kept in its history.' : ''}
          </p>
          {outcome.summary ? (
            <ul className="send-summary">
              <li>
                <b>{outcome.summary['shots'] ?? outcome.shots}</b> shots
              </li>
              {SUMMARY.filter(([k]) => outcome.summary![k] !== undefined).map(([k, label]) => (
                <li key={k}>
                  <b>{outcome.summary![k]}</b> {label}
                </li>
              ))}
            </ul>
          ) : null}
          {outcome.warnings.length ? (
            <>
              <h3>Film Studio’s warnings</h3>
              <ul className="send-warnings">
                {outcome.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      ) : outcome.kind === 'refused' ? (
        <>
          <p className="send-answer warn-text">{outcome.error}</p>
          {outcome.issues.length ? (
            <ul className="send-warnings mono small">
              {outcome.issues.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          ) : null}
          <p className="muted small">
            {outcome.url} answered HTTP {outcome.status}. Nothing was changed in VC VFX; the send is in the project log.
          </p>
        </>
      ) : (
        <>
          <p className="send-answer warn-text">{outcome.error}</p>
          <p className="muted small">The attempt is in the project log.</p>
        </>
      )}
    </Modal>
  );
}

export function AccountDialog({
  api,
  info,
  account,
  standing,
  onAccount,
  onStanding,
  onClose,
}: {
  api: VcvfxApi;
  info: AppInfo | null;
  account: AccountStatus;
  standing: LicenceStanding | null;
  onAccount: (a: AccountStatus) => void;
  onStanding: (s: LicenceStanding | null) => void;
  onClose: () => void;
}) {
  const [email, setEmail] = useState(account.email ?? '');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [working, setWorking] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setWorking(true);
    setMessage(null);
    try {
      await fn();
    } finally {
      setWorking(false);
    }
  };
  const capability = capabilityFrom(standing, new Date());
  const configured = info?.cloudConfigured ?? account.configured;

  return (
    <Modal
      title="Account & licence"
      onClose={onClose}
      footer={
        <button type="button" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className={`licence-summary ${capability}`}>
        <strong>{capability === 'full' ? 'Full access' : 'Read-only'}</strong>
        <span className="muted">
          {standing
            ? `Licence ${standing.status}${standing.expiresAt ? ` · renews/ends ${standing.expiresAt.slice(0, 10)}` : ''} · checked ${standing.checkedAt.slice(0, 16).replace('T', ' ')}`
            : 'No licence on this computer yet'}
        </span>
      </div>

      {!configured ? (
        <p className="notice-inline">
          Sign-in is not available in this build (it was built without a Supabase project). VC VFX works fully offline in read-only mode: open, browse,
          verify sources and print shot lists.
        </p>
      ) : !account.signedIn ? (
        <div className="signin">
          <label className="field">
            <span>Email</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={sent} placeholder="you@production.com" />
          </label>
          {!sent ? (
            <label className="field">
              <span>Password (if you have one)</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </label>
          ) : null}
          {sent ? (
            <label className="field">
              <span>Code from the email</span>
              <input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus />
            </label>
          ) : null}
          <div className="row">
            {!sent && password ? (
              <button
                type="button"
                className="primary"
                disabled={working || !email.includes('@')}
                onClick={() =>
                  void run(async () => {
                    const r = await api.signInWithPassword(email.trim(), password);
                    if (r.ok) {
                      setPassword('');
                      onAccount(r.data);
                      onStanding(await api.licenceStanding(true));
                    } else setMessage({ kind: 'error', text: r.error });
                  })
                }
              >
                Sign in
              </button>
            ) : null}
            {!sent ? (
              <button
                type="button"
                className={password ? undefined : 'primary'}
                disabled={working || !email.includes('@')}
                onClick={() =>
                  void run(async () => {
                    const r = await api.requestSignInCode(email.trim());
                    if (r.ok) setSent(true);
                    else setMessage({ kind: 'error', text: r.error });
                  })
                }
              >
                Email me a code
              </button>
            ) : (
              <>
                <button type="button" onClick={() => setSent(false)} disabled={working}>
                  Back
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={working || code.length < 6}
                  onClick={() =>
                    void run(async () => {
                      const r = await api.verifySignInCode(email.trim(), code);
                      if (r.ok) {
                        onAccount(r.data);
                        onStanding(await api.licenceStanding(true));
                      } else setMessage({ kind: 'error', text: r.error });
                    })
                  }
                >
                  Sign in
                </button>
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="signed-in">
          <p>
            Signed in as <strong>{account.displayName ?? account.email}</strong>
            {account.displayName && account.email ? <span className="muted"> ({account.email})</span> : null}
          </p>
          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={working}
              onClick={() =>
                void run(async () => {
                  const r = await api.activateLicence();
                  setMessage(r.ok ? { kind: 'ok', text: r.data.message } : { kind: 'error', text: r.error });
                  onStanding(await api.licenceStanding(false));
                })
              }
            >
              Activate this computer
            </button>
            <button type="button" disabled={working} onClick={() => void run(async () => onStanding(await api.licenceStanding(true)))}>
              Check licence now
            </button>
            <button
              type="button"
              disabled={working}
              onClick={() =>
                void run(async () => {
                  await api.signOut();
                  onAccount(await api.accountStatus());
                })
              }
            >
              Sign out
            </button>
          </div>
        </div>
      )}
      {message ? <p className={message.kind === 'ok' ? 'ok-text' : 'warn-text'}>{message.text}</p> : null}
      <p className="small muted">
        No subscription yet?{' '}
        <button type="button" className="link" onClick={() => void api.openExternal('subscribe')}>
          Subscribe at vc-vfx.com
        </button>{' '}
        ·{' '}
        <button type="button" className="link" onClick={() => void api.openExternal('account')}>
          Manage devices
        </button>
      </p>
    </Modal>
  );
}
