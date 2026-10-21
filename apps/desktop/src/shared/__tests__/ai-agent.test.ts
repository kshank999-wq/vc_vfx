import { describe, expect, it } from 'vitest';
import { shotState } from '@vcvfx/domain';
import type { BetaContentBlock, BetaToolResultBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { runTrackAgent, turnContent, type AgentEvent } from '../ai/agent';
import { demoModel } from '../ai/demo';
import { ModelCallError, type ModelClient } from '../ai/protocol';
import { TRACK_AGENT_SYSTEM } from '../ai/prompt';
import { agentTools, executeTool, schemaProblem, TOOL_NAMES, type ToolContext } from '../ai/tools';
import { FIRST, injectBadTracks, N, NOW, SHOT, say, scriptedModel, testHost, thinking, use, type TestHost } from './ai-helpers';

/**
 * The AI tracking assistant's loop and tools (addendum 07 §9), with a mock
 * model — no API is called. The tools run the real command layer on a
 * rendered shot; the ops go through the domain, so the log is real.
 */

const results = (req: { messages: { role: string; content: unknown }[] }, k = req.messages.length - 1) => req.messages[k]!.content as BetaToolResultBlockParam[];
const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ framesAllowed: false, exportAllowed: false, maxImages: 4, imagesUsed: 0, focalRange: null, created2d: [], ...over });
const finishInput = (over: Record<string, unknown> = {}) => ({ summary: 'Done.', actions: ['x'], final_stats: {}, targets_met: false, concerns: [], frames_to_check: [], next_steps: [], ...over });

async function tracked(): Promise<TestHost> {
  const host = testHost();
  for (const c of [{ verb: 'set_lens', focalMode: 'approx', focalMm: 25 }, { verb: 'set_track_settings', maxFeatures: 300 }, { verb: 'auto_track' }] as const) {
    const o = await host.command(c);
    if (!o.ok) throw new Error(o.error);
    await host.apply(o.ops);
  }
  return host;
}

describe('tools', () => {
  it('are strict, closed schemas in a fixed order; the frames tool only when frames are allowed', () => {
    const off = agentTools({ framesAllowed: false });
    const on = agentTools({ framesAllowed: true });
    expect(off.map((t) => t.name)).not.toContain('get_frame_image');
    expect(on.map((t) => t.name)).toContain('get_frame_image');
    expect(on.map((t) => t.name)).toEqual([...on.map((t) => t.name)].sort());
    expect(JSON.stringify(agentTools({ framesAllowed: false }))).toBe(JSON.stringify(off)); // byte-stable for the cache
    const closed = (s: Record<string, unknown>): boolean => (s['type'] === 'object' ? s['additionalProperties'] === false && Object.values((s['properties'] ?? {}) as Record<string, Record<string, unknown>>).every(closed) : s['type'] === 'array' ? closed(s['items'] as Record<string, unknown>) : true);
    for (const t of on) {
      expect(t.strict).toBe(true);
      expect(closed(t.input_schema as unknown as Record<string, unknown>)).toBe(true);
      expect(JSON.stringify(t.input_schema)).not.toMatch(/minimum|maximum|minLength|maxLength|minItems/);
      expect(t.description!.length).toBeGreaterThan(60);
    }
    expect(TRACK_AGENT_SYSTEM).not.toMatch(/\d{4}-\d{2}-\d{2}/); // nothing dated in the cached prefix
  });

  it('validate inputs against the schema', () => {
    const solve = agentTools({ framesAllowed: false }).find((t) => t.name === 'delete_tracks')!.input_schema as never;
    expect(schemaProblem(solve, { error_above_px: 2 })).toBeNull();
    expect(schemaProblem(solve, { error_above_px: 'two' })).toMatch(/number/);
    expect(schemaProblem(solve, { nonsense: 1 })).toMatch(/not a parameter/);
    expect(schemaProblem(solve, { region: { frame: 1001, x0: 0, y0: 0, x1: 4 } })).toMatch(/y1 is required/);
  });

  it('refuse a frame image when frames are not allowed, and count images when they are', async () => {
    const host = testHost({ frames: true });
    const no = await executeTool(host, ctx(), 'get_frame_image', { frame: FIRST, overlay: 'none' });
    expect(no.ok).toBe(false);
    const c = ctx({ framesAllowed: true, maxImages: 1 });
    const yes = await executeTool(host, c, 'get_frame_image', { frame: FIRST + 3, overlay: 'tracks', max_width: 2000 });
    expect(yes.ok).toBe(true);
    expect(Array.isArray(yes.content) && yes.content[1]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg' } });
    expect(JSON.stringify(yes.content)).toMatch(/plate pixel = image pixel × 1/);
    const again = await executeTool(host, c, 'get_frame_image', { frame: FIRST, overlay: 'none' });
    expect(again.ok).toBe(false);
    expect(again.content).toMatch(/used up/);
  });

  it('refuse to export unless the run allows it', async () => {
    const host = testHost();
    const out = await executeTool(host, ctx(), 'export', { what: 'camera' });
    expect(out.ok).toBe(false);
    expect(host.commands).not.toContain('export_camera');
  });

  it('a proposed planar surface needs the artist’s confirmation: declined → nothing tracked; accepted → created and tracked', async () => {
    const declined = testHost({ confirm: () => ({ accepted: false, note: 'wrong wall' }) });
    // The 2D track task: the sample's 010_030 has it; give 020_010 one too through the domain.
    const input = { name: 'panel', frame: FIRST, corners: { tl: { x: 180, y: 90 }, tr: { x: 300, y: 90 }, br: { x: 300, y: 180 }, bl: { x: 180, y: 180 } }, direction: 'forward', reason: 'flat panel' };
    const d = await executeTool(declined, ctx(), 'planar_track', input);
    expect(d.ok).toBe(true);
    expect(d.content).toMatch(/declined/);
    expect(declined.proposals).toHaveLength(1);
    expect(declined.commands).toEqual([]);

    const { addTask } = await import('@vcvfx/domain');
    const accepted = testHost({ confirm: (p) => ({ accepted: true, corners: p.corners.map(([x, y]) => [x + 1, y] as [number, number]) }) });
    const r = addTask(accepted.current, SHOT, 'track_2d', 'Ana', NOW);
    if (!r.ok) throw new Error(r.reason);
    accepted.current = r.project;
    const c = ctx();
    const a = await executeTool(accepted, c, 'planar_track', { ...input, direction: 'forward' });
    expect(a.ok).toBe(true);
    expect(accepted.commands).toEqual(['track2d_create', 'track2d_track']);
    const t = shotState(accepted.current, SHOT)!.track2d!.tracks[0]!;
    expect(t.keys[0]!.points[0]).toEqual([181, 90]); // the artist's adjusted corner
    expect(t.frames.length).toBe(N);
    expect(c.created2d).toEqual([t.id]);
  });

  it('the report is refused when its numbers disagree with the active solve', async () => {
    const host = await tracked();
    const s = await host.command({ verb: 'solve' });
    if (!s.ok) throw new Error(s.error);
    await host.apply(s.ops);
    const rms = shotState(host.current, SHOT)!.camtrack!.solves[0]!.stats.rms;
    const lie = await executeTool(host, ctx(), 'finish', finishInput({ final_stats: { rms_px: rms / 2 }, targets_met: true }));
    expect(lie.ok).toBe(false);
    expect(lie.content).toMatch(/disagrees/);
    const truth = await executeTool(host, ctx(), 'finish', finishInput({ final_stats: { rms_px: Math.round(rms * 1000) / 1000, frames_solved: N }, targets_met: true }));
    expect(truth.ok).toBe(true);
    expect(truth.report?.finalStats.rmsPx).toBeCloseTo(rms, 2);
  }, 60_000);
});

describe('the agent loop', () => {
  it('dispatches tool calls to commands, returns parallel results together in one message, and passes thinking back unchanged', async () => {
    const host = testHost();
    const model = scriptedModel([
      () => ({ content: [thinking('Look first.'), use('get_shot_context'), use('set_lens_constraints', { focal_mode: 'approx', focal_mm: 25 })] }),
      () => ({ content: [thinking('Done.'), use('finish', finishInput())] }),
    ]);
    const events: AgentEvent[] = [];
    const out = await runTrackAgent({ model, host, instruction: 'Set the lens.', framesAllowed: false, exportAllowed: false, onEvent: (e) => events.push(e) });
    expect(out.reason).toBe('finished');
    const second = model.requests[1]!;
    // The assistant turn goes back exactly as it came, thinking signature included.
    expect(second.messages[1]).toEqual({ role: 'assistant', content: [thinking('Look first.'), expect.objectContaining({ name: 'get_shot_context' }), expect.objectContaining({ name: 'set_lens_constraints' })] });
    expect((second.messages[1]!.content as { signature?: string }[])[0]!.signature).toBe('sig-11');
    const rs = results(second);
    expect(rs).toHaveLength(2);
    expect(rs.every((r) => r.type === 'tool_result' && !r.is_error)).toBe(true);
    expect(host.commands).toEqual(['set_lens']);
    // The command is in the shot's log, as the artist's would be, under the assistant's name.
    expect(host.current.log.some((l) => l.action === 'camtrack.set_lens' && l.actor === 'Ana (AI assistant)')).toBe(true);
    expect(events.filter((e) => e.type === 'command').map((e) => (e as { entry: { verb: string } }).entry.verb)).toEqual(['set_lens']);
    // The prefix (system + tools) is identical on every call.
    expect(model.requests[0]!.system).toBe(model.requests[1]!.system);
    expect(JSON.stringify(model.requests[0]!.tools)).toBe(JSON.stringify(model.requests[1]!.tools));
    // The run's facts are in the first user message, not the system prompt.
    expect(JSON.stringify(model.requests[0]!.messages[0])).toMatch(/<briefing>[\s\S]*Shot 020_010[\s\S]*Export: not allowed/);
  });

  it('a failing or invalid call is an is_error result the model can read; an unknown tool too', async () => {
    const host = testHost();
    const model = scriptedModel([() => ({ content: [use('solve'), use('delete_tracks', { error_above_px: 'lots' }), use('make_coffee')] }), () => ({ content: [say('I cannot proceed.')] })]);
    const out = await runTrackAgent({ model, host, instruction: 'Solve.', framesAllowed: false, exportAllowed: false });
    const rs = results(model.requests[1]!);
    expect(rs.map((r) => r.is_error)).toEqual([true, true, true]);
    expect(String(rs[0]!.content)).toMatch(/no tracks/i);
    expect(String(rs[1]!.content)).toMatch(/Invalid input/);
    expect(String(rs[2]!.content)).toMatch(/no tool called make_coffee/);
    expect(out.reason).toBe('end_turn');
    expect(out.text).toBe('I cannot proceed.');
  });

  it('stops at the turn limit', async () => {
    const model = scriptedModel([() => ({ content: [use('get_shot_context')] })]);
    const out = await runTrackAgent({ model, host: testHost(), instruction: 'Loop.', framesAllowed: false, exportAllowed: false, limits: { maxTurns: 3 } });
    expect(out.reason).toBe('max_turns');
    expect(model.requests).toHaveLength(3);
  });

  it('stops at the run’s credit cap', async () => {
    const model = scriptedModel([() => ({ content: [use('get_shot_context')] })], 4);
    const out = await runTrackAgent({ model, host: testHost(), instruction: 'Loop.', framesAllowed: false, exportAllowed: false, limits: { creditCap: 10 } });
    expect(out.reason).toBe('credit_cap');
    expect(model.requests).toHaveLength(3);
    expect(out.credits).toBe(12);
  });

  it('Stop cancels between tools and during a model call', async () => {
    const controller = new AbortController();
    const host = testHost();
    const model = scriptedModel([
      () => {
        return { content: [use('get_shot_context'), use('get_track_stats')] };
      },
    ]);
    const out = await runTrackAgent({
      model,
      host,
      instruction: 'Go.',
      framesAllowed: false,
      exportAllowed: false,
      signal: controller.signal,
      onEvent: (e) => {
        if (e.type === 'tool_result') controller.abort();
      },
    });
    expect(out.reason).toBe('cancelled');
    // The second call was answered as stopped, so the history stays well formed.
    const last = out.conversation.messages[out.conversation.messages.length - 1]!.content as BetaToolResultBlockParam[];
    expect(last.map((r) => r.is_error ?? false)).toEqual([false, true]);

    const slow: ModelClient = { call: (_r, o) => new Promise((_, reject) => o.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))) };
    const c2 = new AbortController();
    setTimeout(() => c2.abort(), 20);
    const out2 = await runTrackAgent({ model: slow, host, instruction: 'Go.', framesAllowed: false, exportAllowed: false, signal: c2.signal });
    expect(out2.reason).toBe('cancelled');
  });

  it('a refusal stops the run without running that turn’s tools', async () => {
    const host = testHost();
    const model = scriptedModel([() => ({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: null } as never, content: [use('auto_track')] })]);
    const out = await runTrackAgent({ model, host, instruction: 'Go.', framesAllowed: false, exportAllowed: false });
    expect(out.reason).toBe('refusal');
    expect(out.message).toMatch(/declined/);
    expect(host.commands).toEqual([]);
  });

  it('a tool call cut off at max_tokens is not run', async () => {
    const host = testHost();
    const model = scriptedModel([() => ({ stop_reason: 'max_tokens', content: [thinking('…'), use('delete_tracks', { ids: [1] })] })]);
    const out = await runTrackAgent({ model, host, instruction: 'Go.', framesAllowed: false, exportAllowed: false });
    expect(out.reason).toBe('max_tokens');
    expect(host.commands).toEqual([]);
  });

  it('the monthly allowance running out ends the run with the server’s words', async () => {
    const model: ModelClient = { call: async () => Promise.reject(new ModelCallError('AI allowance used up this month — resets on 1 November.', 402)) };
    const out = await runTrackAgent({ model, host: testHost(), instruction: 'Go.', framesAllowed: false, exportAllowed: false });
    expect(out.reason).toBe('allowance');
    expect(out.message).toMatch(/resets on 1 November/);
  });

  it('the frames tool is not offered when frames are not allowed', async () => {
    const model = scriptedModel([() => ({ content: [use('get_frame_image', { frame: FIRST, overlay: 'none' })] }), () => ({ content: [say('ok')] })]);
    await runTrackAgent({ model, host: testHost({ frames: true }), instruction: 'Look.', framesAllowed: false, exportAllowed: false });
    expect(model.requests[0]!.tools.map((t) => t.name)).not.toContain('get_frame_image');
    expect(results(model.requests[1]!)[0]!.is_error).toBe(true);
    expect(JSON.stringify(model.requests[0]!.messages[0])).toMatch(/may not see frames/);
  });

  it('after a refusal fallback mid-output, the declined partial is neither echoed nor run', () => {
    const content = [thinking('declined part'), use('delete_tracks', { ids: [1] }), say('partial'), { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } }, thinking('rescued'), use('get_shot_context')] as unknown as BetaContentBlock[];
    const { echo, toolUses } = turnContent(content);
    expect(toolUses.map((t) => t.name)).toEqual(['get_shot_context']);
    expect(echo.map((b) => b.type)).toEqual(['text', 'thinking', 'tool_use']);
  });

  it('a follow-up instruction continues the conversation, answering the open finish call first', async () => {
    const host = testHost();
    const model = scriptedModel([() => ({ content: [use('finish', finishInput())] })]);
    const first = await runTrackAgent({ model, host, instruction: 'One.', framesAllowed: false, exportAllowed: false });
    expect(first.conversation.unanswered).toHaveLength(1);
    const model2 = scriptedModel([() => ({ content: [say('Two.')] })]);
    await runTrackAgent({ model: model2, host, instruction: 'Two.', framesAllowed: false, exportAllowed: false, conversation: first.conversation });
    const opening = model2.requests[0]!.messages[2]!.content as { type: string; tool_use_id?: string }[];
    expect(opening[0]).toMatchObject({ type: 'tool_result', tool_use_id: first.conversation.unanswered[0] });
    expect(opening[1]!.type).toBe('text');
    await expect(runTrackAgent({ model: model2, host, instruction: 'Three.', framesAllowed: true, exportAllowed: false, conversation: first.conversation })).rejects.toThrow(/frames setting/);
  });
});

describe('a full scripted session on the rendered shot', () => {
  it('from nothing: tracks, solves, reports and finishes with the true numbers', async () => {
    const host = testHost();
    const events: AgentEvent[] = [];
    const out = await runTrackAgent({ model: demoModel('solve'), host, instruction: 'Solve the camera.', framesAllowed: false, exportAllowed: false, onEvent: (e) => events.push(e) });
    expect(out.reason).toBe('finished');
    const doc = shotState(host.current, SHOT)!.camtrack!;
    const active = doc.solves.find((s) => s.number === doc.activeSolve)!;
    expect(active.stats.framesSolved).toBe(N);
    expect(active.stats.rms).toBeLessThan(0.5);
    expect(out.report!.targetsMet).toBe(true);
    expect(out.report!.finalStats.rmsPx).toBeCloseTo(active.stats.rms, 2);
    expect(host.commands).toEqual(expect.arrayContaining(['auto_track', 'solve', 'get_report']));
    expect(shotState(host.current, SHOT)!.tasks.find((t) => t.kind === 'camera_track')!.state).toBe('needs_review'); // never approved
    expect(events.some((e) => e.type === 'thinking')).toBe(true);
  }, 120_000);

  it('with drifting tracks injected: deletes those above 3 × RMS, re-solves, and the RMS drops under the target', async () => {
    const host = await tracked();
    const bad = await injectBadTracks(host, 40, 7, 3, 1.2);
    const s = await host.command({ verb: 'solve' });
    if (!s.ok) throw new Error(s.error);
    await host.apply(s.ops);
    const before = shotState(host.current, SHOT)!.camtrack!.solves.at(-1)!.stats.rms;
    expect(before).toBeGreaterThan(0.5);
    const out = await runTrackAgent({ model: demoModel('cleanup'), host, instruction: 'Clean up and re-solve.', framesAllowed: false, exportAllowed: false });
    expect(out.reason).toBe('finished');
    const doc = shotState(host.current, SHOT)!.camtrack!;
    const after = doc.solves.find((x) => x.number === doc.activeSolve)!.stats.rms;
    expect(after).toBeLessThan(before - 0.05);
    expect(after).toBeLessThan(0.5);
    expect(host.commands.filter((c) => c === 'delete_tracks')).toHaveLength(1);
    expect(doc.trackSet!.deleted).toBeGreaterThan(5);
    // Mostly the injected ones went.
    const del = host.current.log.find((l) => l.action === 'camtrack.delete_tracks')!;
    expect(del.detail).toMatch(/error > /);
    expect(bad.length).toBeGreaterThan(30);
    expect(out.report!.targetsMet).toBe(true);
    expect(out.report!.finalStats.rmsPx).toBeCloseTo(after, 2);
  }, 120_000);
});
