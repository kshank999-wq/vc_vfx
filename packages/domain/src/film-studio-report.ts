import { versionTag } from './frames.js';
import { TASK_STATE_LABELS } from './tasks.js';
import {
  STATUS_BUCKETS,
  STATUS_BUCKET_TITLES,
  readiness,
  statusCountsOf,
  statusSays,
  statusTaskShort,
  type StatusBucket,
  type VfxStatusDocument,
  type VfxStatusShot,
} from './film-studio.js';

/**
 * The printed VFX status log and its CSV (addendum 19), made from the very
 * document VC VFX sends to VC Film Studio — so the paper on the supervisor's
 * desk and Film Studio's board can never say different things.
 *
 * The same sections, in the same order, as Film Studio's printed log: Ready to
 * hand off, In review, Needs correction, In progress, Not started, Delivered.
 * Per shot: a tick box, the shot, its slate and shoot day, its status, every
 * task with its state, version and approver, the package, and what is holding
 * it or not working. Then notes and a signature block for the VFX supervisor.
 * Landscape. No script, so it prints from the browser preview as it is.
 */

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const e = (v: unknown): string => escapeHtml(v === undefined || v === null || v === '' ? '—' : String(v));
const day = (iso: string | undefined) => (iso ? iso.slice(0, 10) : '');
const stamp = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

/** The name a shot goes by: its VFX shot number once it has one, else the handoff's id. */
export const statusShotName = (s: Pick<VfxStatusShot, 'vfxShotId' | 'handoffShotId'>): string => s.vfxShotId ?? s.handoffShotId;
/** "14 / B / 3" — scene, setup, take as the slate had them. */
export const statusSlate = (s: Pick<VfxStatusShot, 'scene' | 'setup' | 'take'>): string => [s.scene, s.setup, s.take].filter(Boolean).join(' / ');

export interface StatusReportOptions {
  /** Printed under the signature line; the handoff's VFX supervisor when it names one. */
  supervisor?: string;
}

function shotRow(s: VfxStatusShot): string {
  const r = readiness(s);
  const name = statusShotName(s);
  const tasks = s.tasks.length
    ? s.tasks
        .map(
          (t) =>
            `<div class="task t-${t.state}"><b>${e(statusTaskShort(t))}</b> ${e(TASK_STATE_LABELS[t.state])} ${versionTag(t.version)}${t.approval ? ` <span class="by">· ${e(t.approval.by)}</span>` : ''}${
              t.confidence ? ` <span class="conf">${t.confidence.mean.toFixed(2)} mean${t.confidence.low ? ` · ${t.confidence.low} low` : ''}</span>` : ''
            }</div>`,
        )
        .join('')
    : '<span class="muted">No prep tasks</span>';
  const pkg = s.packaged
    ? `${versionTag(s.packaged.version)} <span class="muted">${e(day(s.packaged.at))}</span>${s.status.key !== 'packaged' && !r.delivered ? '<div class="stale">out of date</div>' : ''}`
    : '—';
  const holding: string[] = [];
  if (r.delivered) holding.push(`<div class="done">Delivered ${e(day(s.delivered?.at))}${s.delivered?.to ? ` to ${e(s.delivered.to)}` : ''}</div>`);
  else if (r.ready) holding.push('<div class="done">Ready to hand off</div>');
  for (const w of r.why) holding.push(`<div class="why">${e(w)}</div>`);
  for (const x of s.problems) holding.push(`<div class="problem p-${x.severity}"><span class="sev">${x.severity === 'warn' ? 'warning' : x.severity}</span> ${e(x.text)}</div>`);
  const approval = s.approval ? `<div class="by">Shot approved · ${e(s.approval.by)} ${e(day(s.approval.at))}</div>` : '';
  const notes = [s.supervisorNotes ? `Sup: ${s.supervisorNotes}` : null, s.notes ? `Prep: ${s.notes}` : null].filter(Boolean).join(' — ');
  return `<tr>
<td class="box"></td>
<td class="shot"><b>${e(name)}</b>${s.circled ? ' <span class="circ" title="Circle take">●</span>' : ''}${s.vfxShotId ? `<div class="muted small">${e(s.handoffShotId)}</div>` : ''}</td>
<td class="nw">${e(statusSlate(s))}${s.cameraRoll || s.clip ? `<div class="muted small">${e([s.cameraRoll, s.clip].filter(Boolean).join(' · '))}</div>` : ''}</td>
<td class="nw">${e(s.shootDay ?? s.shootDate)}</td>
<td class="nw">${e(s.status.label)}${approval}</td>
<td class="tasks">${tasks}</td>
<td class="nw">${pkg}</td>
<td class="holding">${holding.join('') || '—'}${notes ? `<div class="notes">${e(notes)}</div>` : ''}</td>
</tr>`;
}

/** A complete, self-contained HTML document: the VFX status log, ready to print or save as PDF. */
export function vfxStatusReportHtml(doc: VfxStatusDocument, options: StatusReportOptions = {}): string {
  const counts = statusCountsOf(doc);
  const says = statusSays(counts);
  const groups = new Map<StatusBucket, VfxStatusShot[]>(STATUS_BUCKETS.map((b) => [b, []]));
  for (const s of doc.shots) groups.get(readiness(s).bucket)!.push(s);
  const o = doc.project.origin;
  const meta = [
    doc.project.productionCompany,
    o?.day ? [o.day.number !== undefined ? `Shoot day ${o.day.number}` : null, o.day.date].filter(Boolean).join(' · ') : null,
    doc.filmStudio ? `Film Studio: ${doc.filmStudio.production}` : null,
    doc.operator ? `Prepared by ${doc.operator}` : null,
    `Generated ${stamp(doc.generatedAt)} by ${doc.generator.app} ${doc.generator.version}`,
  ].filter((m): m is string => Boolean(m));
  const tile = (label: string, n: number, cls: string) => `<div class="tile ${cls}${n ? '' : ' zero'}"><b>${n}</b><span>${escapeHtml(label)}</span></div>`;
  const tasksByState = Object.entries(doc.summary.byTaskState)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${escapeHtml(TASK_STATE_LABELS[k as keyof typeof TASK_STATE_LABELS]?.toLowerCase() ?? k)}`)
    .join(' · ');
  const sections = STATUS_BUCKETS.map((b) => {
    const shots = groups.get(b)!;
    const head = `<h2 class="b-${b}">${escapeHtml(STATUS_BUCKET_TITLES[b])} <span class="count">${shots.length}</span></h2>`;
    if (!shots.length) return `<section class="empty">${head}<p class="muted">No shots.</p></section>`;
    return `<section>${head}
<table>
<thead><tr><th class="box">✓</th><th>Shot</th><th>Scene / setup / take</th><th>Shoot day</th><th>Status</th><th>Tasks</th><th>Package</th><th>${b === 'ready' || b === 'delivered' ? 'Notes' : 'What is holding it'}</th></tr></thead>
<tbody>
${shots.map(shotRow).join('\n')}
</tbody></table></section>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${e(doc.project.name)} — VFX Status</title>
<style>
@page { size: landscape; margin: 11mm; }
* { box-sizing: border-box; }
body { font: 9pt/1.35 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #111; margin: 0; background: #fff; }
h1 { font-size: 15pt; margin: 0 0 2pt; }
.meta { color: #555; margin-bottom: 8pt; }
.says { font-size: 11pt; font-weight: 600; margin: 0 0 8pt; padding: 6pt 8pt; border-left: 3pt solid #888; background: #f4f4f4; }
.says.ok { border-color: #2e7d32; } .says.warn { border-color: #b26a00; } .says.bad { border-color: #c62828; }
.tiles { display: flex; gap: 6pt; margin-bottom: 4pt; flex-wrap: wrap; }
.tile { border: 0.6pt solid #bbb; border-radius: 3pt; padding: 3pt 8pt; min-width: 70pt; }
.tile b { font-size: 14pt; display: block; } .tile span { color: #444; font-size: 8pt; text-transform: uppercase; letter-spacing: .03em; }
.tile.zero { color: #999; } .tile.ready b { color: #2e7d32; } .tile.correction b { color: #c62828; } .tile.review b { color: #b26a00; }
.subtotals { color: #555; margin-bottom: 10pt; font-size: 8.5pt; }
h2 { font-size: 11pt; margin: 12pt 0 4pt; padding-bottom: 2pt; border-bottom: 1.2pt solid #333; break-after: avoid; }
h2 .count { color: #666; font-weight: 400; }
section.empty h2 { border-bottom-color: #ccc; color: #777; } section.empty p { margin: 0 0 4pt; }
table { width: 100%; border-collapse: collapse; }
th, td { border: 0.5pt solid #aaa; padding: 3pt 4pt; text-align: left; vertical-align: top; }
th { background: #eee; font-size: 7.5pt; text-transform: uppercase; letter-spacing: .04em; }
thead { display: table-header-group; }
tr { break-inside: avoid; page-break-inside: avoid; }
.box { width: 9mm; } .nw { white-space: nowrap; } .shot { white-space: nowrap; } .tasks { width: 25%; } .holding { width: 32%; }
.task { white-space: nowrap; } .task.t-needs_correction { color: #c62828; } .task.t-needs_review { color: #b26a00; } .task.t-pending { color: #777; }
.by, .conf, .muted { color: #666; } .small { font-size: 7.5pt; }
.circ { color: #b00; font-size: 7pt; }
.done { color: #2e7d32; font-weight: 600; } .why { font-weight: 600; } .stale { color: #c62828; font-size: 7.5pt; }
.problem { margin-top: 1pt; } .sev { font-size: 6.8pt; text-transform: uppercase; letter-spacing: .04em; padding: 0 2pt; border: 0.5pt solid currentColor; border-radius: 2pt; }
.p-error { color: #c62828; } .p-warn { color: #8a5300; } .p-info { color: #555; }
.notes { color: #444; font-style: italic; margin-top: 2pt; }
.sign { margin-top: 16pt; display: grid; grid-template-columns: 2fr 1fr; gap: 14pt; break-inside: avoid; page-break-inside: avoid; }
.sign .lines { border: 0.6pt solid #aaa; min-height: 60pt; padding: 4pt 6pt; color: #666; }
.sign .who div { border-bottom: 0.6pt solid #333; height: 22pt; margin-bottom: 2pt; }
.sign .who span { color: #555; font-size: 8pt; display: block; margin-bottom: 8pt; }
footer { margin-top: 10pt; color: #777; font-size: 7.5pt; }
</style></head><body>
<h1>${e(doc.project.name)} — VFX Status</h1>
<div class="meta">${meta.map(escapeHtml).join(' · ')}</div>
<p class="says ${says.tone}">${escapeHtml(says.text)}</p>
<div class="tiles">
${tile('Ready to hand off', counts.ready, 'ready')}
${tile('In review', counts.review, 'review')}
${tile('Needs correction', counts.correction, 'correction')}
${tile('In progress', counts.progress, 'progress')}
${tile('Not started', counts.notStarted, 'not-started')}
${tile('Delivered', counts.delivered, 'delivered')}
${tile('Shots', counts.shots, 'total')}
</div>
<div class="subtotals">Tasks: ${tasksByState || 'none'} · Problems on shots not yet delivered: ${counts.problems.error} error${counts.problems.error === 1 ? '' : 's'}, ${counts.problems.warn} warning${counts.problems.warn === 1 ? '' : 's'}, ${counts.problems.info} note${counts.problems.info === 1 ? '' : 's'}</div>
${sections}
<div class="sign">
<div class="lines">VFX supervisor’s notes</div>
<div class="who"><div></div><span>VFX supervisor${options.supervisor ? ` — ${e(options.supervisor)}` : ''}</span><div></div><span>Signature</span><div></div><span>Date</span></div>
</div>
<footer>“Ready to hand off”: the shot is approved, packaged and not reopened since, every task approved at the version that was packaged, nothing needs correction, and it has not been delivered — the rule VC Film Studio applies to this same report. ● marks a circle take. Versions are task versions (v001 …); a reopened task gets a new one.</footer>
</body></html>
`;
}

/* ------------------------------------------------------------------ CSV --- */

export const STATUS_CSV_COLUMNS: { key: string; label: string }[] = [
  { key: 'shot', label: 'VFX shot' },
  { key: 'handoff', label: 'Handoff shot' },
  { key: 'scene', label: 'Scene' },
  { key: 'setup', label: 'Setup' },
  { key: 'take', label: 'Take' },
  { key: 'day', label: 'Shoot day' },
  { key: 'status', label: 'Status' },
  { key: 'section', label: 'Section' },
  { key: 'ready', label: 'Ready to hand off' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'approval', label: 'Shot approved' },
  { key: 'package', label: 'Package' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'problems', label: 'Problems' },
  { key: 'why', label: 'What is holding it' },
];

/** One row per shot, the columns Film Studio's own CSV export has. */
export function statusCsvRow(s: VfxStatusShot): Record<string, string> {
  const r = readiness(s);
  return {
    shot: statusShotName(s),
    handoff: s.handoffShotId,
    scene: s.scene,
    setup: s.setup ?? '',
    take: s.take ?? '',
    day: s.shootDate ?? s.shootDay ?? '',
    status: s.status.label,
    section: STATUS_BUCKET_TITLES[r.bucket],
    ready: r.ready ? 'Yes' : r.delivered ? 'Delivered' : 'No',
    tasks: s.tasks.map((t) => `${statusTaskShort(t)}: ${TASK_STATE_LABELS[t.state]} ${versionTag(t.version)}${t.approval ? ` (${t.approval.by})` : ''}`).join('; '),
    approval: s.approval ? `${s.approval.by}, ${s.approval.at.slice(0, 10)}` : '',
    package: s.packaged ? `${versionTag(s.packaged.version)} ${s.packaged.at.slice(0, 10)}` : '',
    delivered: s.delivered ? `${s.delivered.at.slice(0, 10)}${s.delivered.to ? ` to ${s.delivered.to}` : ''}` : '',
    problems: s.problems.map((x) => `[${x.severity}] ${x.text}`).join('; '),
    why: r.why.join('; '),
  };
}

const csvCell = (v: string): string => {
  // A leading = + - @ would be read as a formula by a spreadsheet; quote it as text.
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) || safe !== v ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** The status as CSV (UTF-8 with a byte-order mark, CRLF), one row per shot. */
export function vfxStatusCsv(doc: Pick<VfxStatusDocument, 'shots'>): string {
  const lines = [STATUS_CSV_COLUMNS.map((c) => csvCell(c.label)).join(',')];
  for (const s of doc.shots) {
    const row = statusCsvRow(s);
    lines.push(STATUS_CSV_COLUMNS.map((c) => csvCell(row[c.key] ?? '')).join(','));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}
