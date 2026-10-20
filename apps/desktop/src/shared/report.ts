import {
  plateColorFor,
  PREP_TASKS,
  SHOT_STATUS_LABELS,
  TASK_STATE_LABELS,
  formatRange,
  framePattern,
  handoffShot,
  outputFor,
  planFor,
  shotState,
  shotTiming,
  shotStatus,
  versionTag,
  type Project,
} from '@vcvfx/domain';
import { escapeHtml } from './html';

/**
 * The per-shot prep report written into each package beside the manifest
 * (master spec §17: "prep_report.pdf-or-printable-report"). A self-contained
 * HTML document — printable from any browser — carrying the same facts as the
 * manifest in a form a person reads: metadata, plates, tasks, approvals, log.
 */
export function prepReportHtml(p: Project, shotId: string, input: { generatedAt: Date; appVersion: string; operator: string }): string {
  const shot = handoffShot(p, shotId);
  const state = shotState(p, shotId);
  if (!shot || !state) throw new Error(`No shot ${shotId}`);
  const output = outputFor(p.handoff, shot);
  const plan = planFor(p, shot);
  const timing = shotTiming(p, shot);
  const name = state.vfxShotId ?? shot.shotId;
  const range = (a: number | undefined, b: number | undefined) => (a === undefined || b === undefined ? 'unknown' : formatRange(a, b));
  const e = (v: unknown) => escapeHtml(v === undefined || v === null || v === '' ? '—' : String(v));
  const row = (label: string, value: unknown) => `<tr><th>${escapeHtml(label)}</th><td>${e(value)}</td></tr>`;
  const cam = shot.camera;
  const color = shot.color;
  // What was applied to this version's plates when they were written; else what will be.
  const plateVersion = state.tasks.find((t) => t.kind === 'sequence_conversion')?.version ?? 1;
  const written = state.plates.find((r) => r.version === plateVersion);
  const plateColour = written ? `${written.color.summary}${written.color.transform ? ` ${written.color.transform}` : ''}` : `${plateColorFor(p, shotId).summary} (planned; no plates written yet)`;
  const tasks = state.tasks
    .map(
      (t) => `<tr><td>${escapeHtml(PREP_TASKS[t.kind].label)}</td><td>${escapeHtml(TASK_STATE_LABELS[t.state])}</td><td>${versionTag(t.version)}</td><td>${
        t.approval ? `${e(t.approval.by)}<br><small>${e(t.approval.at)}</small>` : '—'
      }</td><td>${e(t.notes)}</td></tr>`,
    )
    .join('\n');
  const log = p.log
    .filter((l) => l.shotId === shotId)
    .map((l) => `<tr><td class="num">${e(l.at.replace('T', ' ').slice(0, 19))}</td><td>${e(l.actor)}</td><td>${e(l.action)}</td><td>${e(l.detail)}</td></tr>`)
    .join('\n');
  const checksums = shot.checksums.map((c) => `<tr><td>${e(c.path)}</td><td>${e(c.algorithm)}</td><td class="mono">${e(c.value)}</td></tr>`).join('\n');
  const references = shot.references.map((r) => `<li>${e(r.kind.replace(/_/g, ' '))}: <span class="mono">${e(r.path)}</span>${r.notes ? ` — ${e(r.notes)}` : ''}</li>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${e(name)} — Prep Report</title>
<style>
@page { margin: 14mm; }
body { font: 10pt/1.4 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #111; margin: 24px; }
h1 { font-size: 16pt; margin: 0; } h2 { font-size: 11pt; margin: 18pt 0 6pt; text-transform: uppercase; letter-spacing: .05em; color: #444; }
.meta { color: #555; margin: 4pt 0 0; }
table { border-collapse: collapse; width: 100%; } th, td { border: 0.6pt solid #bbb; padding: 3pt 6pt; text-align: left; vertical-align: top; }
table.kv th { width: 30%; background: #f3f3f3; font-weight: 600; }
thead th { background: #eee; font-size: 8.5pt; text-transform: uppercase; }
.num { white-space: nowrap; font-variant-numeric: tabular-nums; } .mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 8.5pt; word-break: break-all; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 18pt; }
footer { margin-top: 18pt; color: #777; font-size: 8pt; }
</style></head><body>
<h1>${e(p.handoff.project)} — Shot ${e(name)}</h1>
<p class="meta">Package ${versionTag(Math.max(1, state.packageVersion))} · ${e(SHOT_STATUS_LABELS[shotStatus(state)])} · Shot approval: ${
    state.approval ? `${e(state.approval.by)} (${e(state.approval.at)})` : 'not approved'
  } · Source verification: ${e(state.sourceVerified)}</p>
<div class="grid">
<div><h2>Shot</h2><table class="kv">
${state.vfxShotId ? row('Handoff shot ID', shot.shotId) : ''}
${row('Scene / setup / take', [shot.scene, shot.setup, shot.take].filter(Boolean).join(' / '))}
${row('Circle take', shot.circled ? 'Yes' : 'No')}
${row('Unit / shoot day', [shot.unit, shot.shootDay].filter(Boolean).join(' / '))}
${row('Camera roll / clip', [shot.cameraRoll, shot.clip].filter(Boolean).join(' / '))}
${row('Flagged by', shot.flaggedBy)}
${row('Source', shot.sourcePath)}
${row('Timecode', timing?.timecodeIn ? `${timing.timecodeIn}${shot.timecodeOut ? ` – ${shot.timecodeOut}` : ''}` : '')}
${row('Frame rate', timing?.frameRate ?? shot.frameRate)}
${row('Resolution', timing?.resolution ? `${timing.resolution.width} × ${timing.resolution.height}` : '')}
${row('Range from', timing ? (timing.from === 'probe' ? `the whole clip, read with ffprobe${state.probe?.codec ? ` (${state.probe.codec})` : ''}` : 'the handoff') : 'unknown')}
</table></div>
<div><h2>Camera &amp; colour</h2><table class="kv">
${row('Body / sensor mode', [cam.body, cam.sensorMode].filter(Boolean).join(' / '))}
${row('Film back', cam.filmBackMm ? `${cam.filmBackMm.width} × ${cam.filmBackMm.height} mm` : '')}
${row('Lens / focal length', [cam.lens, cam.focalLengthMm ? `${cam.focalLengthMm} mm` : ''].filter(Boolean).join(' / '))}
${row('Focus / iris', [cam.focusDistance, cam.iris].filter(Boolean).join(' / '))}
${row('Source colour space', color.sourceColorSpace)}
${row('Working / display', [color.workingColorSpace, color.displayTransform].filter(Boolean).join(' / '))}
${row('Look reference (not baked)', color.lookReference)}
</table></div>
</div>
<h2>Plates</h2><table class="kv">
${row('Format', `${output.format.toUpperCase()} ${output.bitDepth}-bit${output.compression ? ` (${output.compression})` : ''}`)}
${row('Source in–out (with handles)', range(plan?.sourceIn, plan?.sourceOut))}
${row('Delivered in–out', range(plan?.deliveredIn, plan?.deliveredOut))}
${row('Editorial in–out', range(plan?.editorialIn, plan?.editorialOut))}
${row('Handles / frame count', `${plan?.handles ?? shot.handles} / ${plan?.frameCount ?? 'unknown'}`)}
${row('File pattern', framePattern(name, 'plate', state.tasks.find((t) => t.kind === 'sequence_conversion')?.version ?? 1, output.format))}
${row('Plate colour', plateColour)}
${row('Display look baked into plates', 'No')}
</table>
<h2>Supervisor notes</h2><p>${e(shot.supervisorNotes)}</p>
${state.notes ? `<h2>Prep notes</h2><p>${e(state.notes)}</p>` : ''}
${references ? `<h2>References</h2><ul>${references}</ul>` : ''}
<h2>Tasks</h2><table><thead><tr><th>Task</th><th>State</th><th>Version</th><th>Approval</th><th>Notes</th></tr></thead><tbody>
${tasks || '<tr><td colspan="5">No prep tasks</td></tr>'}
</tbody></table>
<h2>Source checksums</h2><table><thead><tr><th>Path</th><th>Algorithm</th><th>Value</th></tr></thead><tbody>
${checksums || '<tr><td colspan="3">None supplied by the handoff</td></tr>'}
</tbody></table>
<h2>Operation log</h2><table><thead><tr><th>When (UTC)</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead><tbody>
${log || '<tr><td colspan="4">No operations recorded</td></tr>'}
</tbody></table>
<footer>Generated ${e(input.generatedAt.toISOString())} by VC VFX ${e(input.appVersion)} for ${e(input.operator)}. Delivered-file checksums are in the manifest.</footer>
</body></html>
`;
}
