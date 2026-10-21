import type { BetaMessage, BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { creditsFor, usageCost } from '@vcvfx/domain';
import type { ModelCallResult, ModelClient, TrackAgentRequest } from './protocol';

/**
 * A scripted stand-in for the model (addendum 07 §8), for the browser
 * preview's demo and for tests: a deterministic matchmover that reads the
 * real tool results and decides the next real command from them — so the
 * commands, the numbers and the log are genuine; only the "thinking" is
 * written in advance. No request leaves the page.
 *
 * Credits are an estimate of what the same conversation would cost on the
 * real model (tokens ≈ characters ÷ 4, the stable prefix read from cache),
 * labelled as such in the panel.
 */

export type DemoScript = 'solve' | 'cleanup' | 'lidar' | 'surface';

/** Which demo a free-text instruction is closest to. */
export function demoScriptFor(instruction: string): DemoScript {
  const t = instruction.toLowerCase();
  if (/lidar|scan|survey|align/.test(t)) return 'lidar';
  if (/surface|screen|sign|poster|planar|corner|monitor|laptop/.test(t)) return 'surface';
  if (/clean|prune|delete|worst|re-?solve|improve/.test(t)) return 'cleanup';
  return 'solve';
}

type Step = { think: string; tool: string; input: Record<string, unknown> } | { think: string; text: string };

interface Seen {
  name: string;
  ok: boolean;
  summary: string;
  data: Record<string, unknown> | null;
}

/** The tool results so far, newest last, paired with their calls. */
function history(messages: readonly BetaMessageParam[]): Seen[] {
  const calls = new Map<string, string>();
  const out: Seen[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') continue;
    for (const b of m.content) {
      if (b.type === 'tool_use') calls.set(b.id, b.name);
      if (b.type === 'tool_result') {
        const text = typeof b.content === 'string' ? b.content : (b.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('\n');
        const nl = text.indexOf('\n');
        let data: Record<string, unknown> | null = null;
        if (nl >= 0)
          try {
            data = JSON.parse(text.slice(nl + 1)) as Record<string, unknown>;
          } catch {
            data = null;
          }
        out.push({ name: calls.get(b.tool_use_id) ?? '?', ok: !b.is_error, summary: nl >= 0 ? text.slice(0, nl) : text, data });
      }
    }
  }
  return out;
}

const last = (seen: Seen[], name: string) => [...seen].reverse().find((s) => s.name === name && s.ok);
const count = (seen: Seen[], name: string) => seen.filter((s) => s.name === name).length;

/** A quad on the sample shot's back wall (the preview's synthetic room), plate pixels at 640×360. */
export const DEMO_SURFACE = { name: 'back wall panel', corners: { tl: { x: 250, y: 118 }, tr: { x: 372, y: 118 }, br: { x: 372, y: 205 }, bl: { x: 250, y: 205 } } };

function nextStep(script: DemoScript, seen: Seen[]): Step {
  const ctx = last(seen, 'get_shot_context')?.data as { tracks?: { count: number } | null; activeSolve?: number | null; shot?: { frames?: { first: number; last: number } | null }; tracks2d?: { id: string; name: string; keys: number[]; tracked: number }[]; lidar?: { id: string }[]; correspondences?: unknown[] } | undefined;
  if (!ctx) return { think: 'Starting with what the shot already has: camera, lens, tracks and any earlier solve.', tool: 'get_shot_context', input: {} };
  const report = last(seen, 'get_solve_report')?.data as { rmsPx: number; frames: string; focalMm: number | null; tracks: string; worstTracks: { id: number; rmsPx: number }[]; perFrame: { worst: { frame: number; rmsPx: number }[] }; targets: { goodPx: number; acceptablePx: number; rmsMet: boolean; allFramesSolved: boolean; coverageMet: boolean } } | undefined;
  const finishFromReport = (r: NonNullable<typeof report>, actions: string[], extraConcerns: string[] = []): Step => {
    const [solved, total] = r.frames.split('/').map(Number);
    const met = r.targets.rmsMet && r.targets.allFramesSolved;
    return {
      think: 'The numbers are where they should be; writing the report.',
      tool: 'finish',
      input: {
        summary: met ? `The camera solves at ${r.rmsPx} px RMS over all ${total} frames, under the ${r.targets.goodPx} px target.` : `The solve reaches ${r.rmsPx} px RMS over ${solved} of ${total} frames; it does not meet every target.`,
        actions,
        final_stats: { rms_px: r.rmsPx, ...(r.focalMm !== null ? { focal_mm: r.focalMm } : {}), frames_solved: solved, frames_total: total, tracks: Number(r.tracks.split('/')[0]) },
        targets_met: met,
        concerns: [...extraConcerns, ...(r.targets.coverageMet ? [] : ['Some frames have fewer than 20 tracks.'])],
        frames_to_check: r.perFrame.worst.slice(0, 2).map((f) => ({ frame: f.frame, reason: `Highest per-frame error (${f.rmsPx} px) — check the camera there.` })),
        next_steps: ['Look at the solve in the 3D view and scrub the worst frames.', 'Approve the camera-track task in the shot panel if you agree.'],
      },
    };
  };

  if (script === 'surface') {
    const drawn = ctx.tracks2d?.find((t) => t.keys.length && !t.tracked);
    const tracked = last(seen, 'planar_track')?.data as { trackId: string; frames: number; lost: number; meanConfidence: number; lowest: { frame: number; confidence: number }[] } | undefined;
    if (!tracked && count(seen, 'planar_track') === 0) {
      if (drawn) return { think: `The artist has drawn ${drawn.name}; tracking it both ways from its key frame.`, tool: 'planar_track', input: { track_id: drawn.id, frame: drawn.keys[0], direction: 'both' } };
      const first = ctx.shot?.frames?.first ?? 1001;
      return { think: 'No surface is drawn yet. The back wall has a flat, textured panel near the centre of the frame; proposing its corners for the artist to confirm.', tool: 'planar_track', input: { name: DEMO_SURFACE.name, frame: first, corners: DEMO_SURFACE.corners, direction: 'forward', reason: 'A flat, well-textured panel on the back wall, visible through the shot.' } };
    }
    if (!tracked) return { think: 'The proposal was declined, so nothing was tracked.', text: 'Nothing was tracked: the proposed corners were declined. Draw the surface in 2D / planar and run “Track this surface” again.' };
    return {
      think: 'The planar track held; summarising.',
      tool: 'finish',
      input: {
        summary: `Tracked the surface over ${tracked.frames} frames with mean confidence ${tracked.meanConfidence}${tracked.lost ? `; ${tracked.lost} frames were lost` : ' and no lost frames'}.`,
        actions: ['Read the shot', `Planar-tracked ${tracked.trackId}`],
        final_stats: { mean_confidence_2d: tracked.meanConfidence },
        targets_met: tracked.lost === 0,
        concerns: tracked.lost ? ['Some frames were lost; correct a corner there and re-track around it.'] : [],
        frames_to_check: tracked.lowest.slice(0, 2).map((f) => ({ frame: f.frame, reason: `Lowest confidence (${f.confidence})` })),
        next_steps: ['Check the drop-in preview on the surface.', 'Export the 2D track when it looks right.'],
      },
    };
  }

  if (script === 'lidar') {
    if (!ctx.lidar?.length) return { think: 'There is no scan on this shot, so there is nothing to align to.', tool: 'finish', input: { summary: 'No LiDAR or survey file is imported on this shot, so the camera could not be aligned.', actions: ['Read the shot'], final_stats: {}, targets_met: false, concerns: ['No scan imported.'], frames_to_check: [], next_steps: ['Import the scan (LiDAR › Import…).', 'Pick at least three correspondences between tracked features and the scan, then run “Align to LiDAR” again.'] } };
    if (!last(seen, 'list_lidar_candidates')) return { think: 'A scan is imported; checking what correspondences exist or can be trusted.', tool: 'list_lidar_candidates', input: {} };
    const corr = (ctx.correspondences ?? []).length;
    if (corr < 3) return { think: 'Fewer than three correspondences, and no named survey points: guessing scan positions would be worse than asking.', tool: 'finish', input: { summary: `The scan is imported but only ${corr} correspondence${corr === 1 ? ' is' : 's are'} picked; alignment needs at least three trustworthy ones.`, actions: ['Read the shot', 'Listed LiDAR candidates'], final_stats: {}, targets_met: false, concerns: ['No trustworthy automatic correspondences without named survey points.'], frames_to_check: [], next_steps: ['Pick three to six correspondences (LiDAR › Pick correspondence), spread across the set.', 'Run “Align to LiDAR” again: it will align, refine with ICP and solve constrained.'] } };
    if (!last(seen, 'align_to_lidar')) return { think: 'Enough correspondences; a similarity fit first.', tool: 'align_to_lidar', input: { method: 'similarity' } };
    if (!last(seen, 'solve_with_lidar')) return { think: 'Aligned; now the constrained solve in the scan’s coordinates.', tool: 'solve_with_lidar', input: {} };
    if (!report || count(seen, 'get_solve_report') < 1) return { think: 'Checking residuals.', tool: 'get_solve_report', input: { worst_n: 8 } };
    return finishFromReport(report, ['Read the shot', 'Aligned to the scan (similarity)', 'Solved with the LiDAR constraints']);
  }

  // solve / cleanup
  const at = (name: string) => seen.map((x) => x.name).lastIndexOf(name);
  if (!ctx.tracks && at('auto_track') < 0) return { think: 'No tracks yet. Tracking the whole shot at about 300 features, a good density for this plate size.', tool: 'auto_track', input: { max_features: 300 } };
  if (at('get_track_stats') < 0) return { think: 'Checking coverage before solving: count per frame and how evenly the features spread.', tool: 'get_track_stats', input: {} };
  if (at('solve') < 0 && (script === 'solve' || !ctx.activeSolve)) return { think: script === 'solve' ? 'Coverage is healthy. Solving with the lens as set.' : 'There is no solve to clean up yet; solving first.', tool: 'solve', input: {} };
  if (at('get_solve_report') < 0 || at('get_solve_report') < at('solve')) return { think: 'Reading the solve report: RMS, worst frames and worst tracks.', tool: 'get_solve_report', input: { worst_n: 10 } };
  if (report && at('delete_tracks') < 0 && (script === 'cleanup' || !report.targets.rmsMet || (report.worstTracks[0]?.rmsPx ?? 0) > Math.max(3 * report.rmsPx, 1.5))) {
    const threshold = Math.round(Math.max(3 * report.rmsPx, 1.0) * 100) / 100;
    return { think: `A few tracks sit far above the RMS (worst ${report.worstTracks[0]?.rmsPx ?? '—'} px). Deleting tracks above ${threshold} px — about 3 × RMS — and very short ones, then re-solving.`, tool: 'delete_tracks', input: { error_above_px: threshold, shorter_than_frames: 5 } };
  }
  if (at('delete_tracks') > at('solve') && last(seen, 'delete_tracks')) return { think: 'Re-solving without the bad tracks.', tool: 'solve', input: {} };
  if (report) {
    const deleted = last(seen, 'delete_tracks');
    return finishFromReport(report, ['Read the shot', ...(at('auto_track') >= 0 ? ['Auto-tracked the shot'] : []), 'Checked track coverage', ...(count(seen, 'solve') ? [`Solved ${count(seen, 'solve') === 1 ? 'once' : `${count(seen, 'solve')} times`}`] : []), ...(deleted ? [deleted.summary] : [])]);
  }
  return { think: 'Solving.', tool: 'solve', input: {} };
}

/** The scripted model: one step per call, from the real tool results so far. */
export function demoModel(script: DemoScript, options: { delayMs?: number } = {}): ModelClient {
  let n = 0;
  return {
    async call(request: TrackAgentRequest, o): Promise<ModelCallResult> {
      if (o.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const step = nextStep(script, history(request.messages));
      n += 1;
      if (options.delayMs) {
        o.onFragment?.({ kind: 'block', index: 0, block: 'thinking' });
        o.onFragment?.({ kind: 'delta', index: 0, delta: 'thinking', text: step.think });
        await new Promise((r) => setTimeout(r, options.delayMs));
        if (o.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      }
      const content = [{ type: 'thinking', thinking: step.think, signature: '' }, 'tool' in step ? { type: 'tool_use', id: `toolu_demo_${n}`, name: step.tool, input: step.input } : { type: 'text', text: step.text, citations: null }];
      // What this call would cost on the real model: the tools + system prefix from cache, the rest fresh.
      const prefix = Math.round((request.system.length + JSON.stringify(request.tools).length) / 4);
      const rest = Math.round(JSON.stringify(request.messages).length / 4);
      const usage = { input_tokens: rest, output_tokens: 250 + Math.round(step.think.length / 3), cache_read_input_tokens: n > 1 ? prefix : 0, cache_creation_input_tokens: n > 1 ? 0 : prefix };
      const cost = usageCost(usage, 'claude-opus-5-5');
      const message = { id: `msg_demo_${n}`, type: 'message', role: 'assistant', model: 'demo', content, stop_reason: 'tool' in step ? 'tool_use' : 'end_turn', stop_sequence: null, stop_details: null, usage } as unknown as BetaMessage;
      return { message, usage: { inputTokens: cost.inputTokens, outputTokens: cost.outputTokens, cacheReadTokens: cost.cacheReadTokens, cacheWriteTokens: cost.cacheWriteTokens, costUsd: cost.costUsd, credits: creditsFor(cost.costUsd) }, allowance: null };
    },
  };
}
