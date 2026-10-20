import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { HandoffIssue } from '@vcvfx/domain';
import { ENCODINGS, PROJECT_EXR_COLOR, capabilityFrom, type ProjectExrColor } from '@vcvfx/domain';
import type { AccountStatus, AppInfo, FfmpegInfo, LicenceStanding, Settings, VcvfxApi } from '../../shared/bridge';

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
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  initial: string;
  confirmLabel: string;
  detail?: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => input.current?.select(), []);
  const submit = () => {
    if (value.trim()) onSubmit(value.trim());
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
          <button type="button" className="primary" disabled={!value.trim()} onClick={submit}>
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
  onClose: () => void;
}) {
  const [operatorName, setOperatorName] = useState(settings.operatorName);
  const [ffmpegPath, setFfmpegPath] = useState(settings.ffmpegPath);
  const [ffmpeg, setFfmpeg] = useState<FfmpegInfo | null>(null);
  const detect = async () => setFfmpeg(await api.detectFfmpeg());
  useEffect(() => {
    void detect();
  }, []);
  const save = async () => {
    const next = await api.setSettings({ operatorName: operatorName.trim(), ffmpegPath: ffmpegPath.trim() });
    onSaved(next);
    await detect();
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
          {sent ? (
            <label className="field">
              <span>Code from the email</span>
              <input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus />
            </label>
          ) : null}
          <div className="row">
            {!sent ? (
              <button
                type="button"
                className="primary"
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
