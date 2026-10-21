import { describe, expect, it } from 'vitest';
import { addTask, serializeProject, shotState, type Project } from '@vcvfx/domain';
import type { AiRunEvent, AiRunRequest } from '../../shared/bridge';
import { applyAiOps, type AiOp } from '../../shared/ai/ops';
import { ModelCallError } from '../../shared/ai/protocol';
import { FIRST, NOW, SHOT, makeProject, scriptedModel, testHost, use } from '../../shared/__tests__/ai-helpers';
import { fetchAllowance, siteModelClient } from '../ai/client';
import { ackAiRun, cancelAiRun, runAiTrack, type AiServiceDeps } from '../ai/service';

/**
 * The assistant's main-process side (addendum 07 §2): the loop here, the
 * project in the "renderer" (simulated: it applies the ops through the domain
 * and answers with the project text), the camera commands on a rendered shot.
 */

function renderer(start: Project, o: { decline?: boolean } = {}) {
  let project = start;
  const events: AiRunEvent[] = [];
  const send = (e: AiRunEvent) => {
    events.push(e);
    if (e.type === 'apply')
      queueMicrotask(() => {
        const r = applyAiOps(project, SHOT, e.ops as AiOp[], 'Ana (AI assistant)', NOW);
        if (r.ok) project = r.project;
        ackAiRun({ runId: e.runId, seq: e.seq, ok: r.ok, ...(r.ok ? { text: serializeProject(r.project) } : { error: r.reason }) });
      });
    if (e.type === 'confirm') queueMicrotask(() => ackAiRun({ runId: e.runId, seq: e.seq, ok: true, accepted: !o.decline, note: o.decline ? 'not that one' : undefined } as never));
  };
  return { send, events, project: () => project };
}

function deps(model: AiServiceDeps['model'], send: AiServiceDeps['send'], o: { canEdit?: boolean; frames?: boolean } = {}): AiServiceDeps {
  // The camera side of the test host, driven by the project main holds.
  const shot = testHost();
  return {
    model,
    canEdit: async () => o.canEdit ?? true,
    readOnlyReason: 'Read-only mode.',
    session: async () => shot.session(),
    command: async (project, _r, command) => {
      shot.current = project;
      return shot.command(command);
    },
    view: async (project, _r, clouds) => {
      shot.current = project;
      return shot.view({ clouds });
    },
    ...(o.frames ? { frame: async (_p, _r, frame) => ({ url: `vcvfx-frame://cache/${'a'.repeat(64)}.jpg`, frame, viewLabel: 'test' }), image: async (_vf, maxWidth) => ({ mediaType: 'image/jpeg' as const, data: 'AAAA', width: maxWidth, height: 270 }) } : {}),
    send,
    ackTimeoutMs: 5000,
  };
}

const req = (over: Partial<AiRunRequest> = {}): AiRunRequest => ({ text: '', shotId: SHOT, projectKey: '/p.vcvfx', runId: `run-${Math.random()}`, operator: 'Ana', instruction: 'Set the lens and look.', framesAllowed: false, exportAllowed: false, creditCap: 20, maxTurns: 10, ...over });
const finish = { summary: 's', actions: [], final_stats: {}, targets_met: false, concerns: [], frames_to_check: [], next_steps: [] };

describe('the assistant in main', () => {
  it('runs commands on the project main holds, has the renderer apply the ops, and continues from the renderer’s project', async () => {
    const r = renderer(makeProject());
    const model = scriptedModel([() => ({ content: [use('set_lens_constraints', { focal_mode: 'approx', focal_mm: 32 }), use('get_shot_context')] }), () => ({ content: [use('finish', finish)] })]);
    const out = await runAiTrack(serializeProject(r.project()), req(), deps(model, r.send));
    expect(out.reason).toBe('finished');
    expect(r.events.filter((e) => e.type === 'apply')).toHaveLength(1);
    // The renderer's project has the change, logged under the assistant's name…
    expect(shotState(r.project(), SHOT)!.camtrack!.lens.focalMm).toBe(32);
    expect(r.project().log.some((l) => l.action === 'camtrack.set_lens' && l.actor === 'Ana (AI assistant)')).toBe(true);
    // …and the next tool saw it (get_shot_context ran after the apply).
    const ctxResult = JSON.stringify(model.requests[1]!.messages.at(-1));
    expect(ctxResult).toMatch(/\\"focalMm\\":32/);
    expect(out.conversationId).toMatch(/[0-9a-f-]{36}/);
  });

  it('refuses mutating commands in read-only mode, but answers questions', async () => {
    const r = renderer(makeProject());
    const model = scriptedModel([() => ({ content: [use('auto_track'), use('get_shot_context')] }), () => ({ content: [use('finish', finish)] })]);
    await runAiTrack(serializeProject(r.project()), req(), deps(model, r.send, { canEdit: false }));
    const results = model.requests[1]!.messages.at(-1)!.content as { is_error?: boolean; content: string }[];
    expect(results[0]!.is_error).toBe(true);
    expect(results[0]!.content).toMatch(/Read-only/);
    expect(results[1]!.is_error).toBeFalsy();
  });

  it('offers frames only when allowed, and asks the renderer to confirm a proposed surface', async () => {
    const start = addTask(makeProject(), SHOT, 'track_2d', 'Ana', NOW);
    if (!start.ok) throw new Error(start.reason);
    const r = renderer(start.project, { decline: true });
    const model = scriptedModel([
      () => ({ content: [use('get_frame_image', { frame: FIRST, overlay: 'none' })] }),
      () => ({ content: [use('planar_track', { name: 'sign', frame: FIRST, direction: 'forward', corners: { tl: { x: 1, y: 1 }, tr: { x: 50, y: 1 }, br: { x: 50, y: 40 }, bl: { x: 1, y: 40 } } })] }),
      () => ({ content: [use('finish', finish)] }),
    ]);
    await runAiTrack(serializeProject(r.project()), req({ framesAllowed: true }), deps(model, r.send, { frames: true }));
    expect(model.requests[0]!.tools.map((t) => t.name)).toContain('get_frame_image');
    const image = model.requests[1]!.messages.at(-1)!.content as { content: { type: string }[] }[];
    expect(image[0]!.content.map((c) => c.type)).toEqual(['text', 'image']);
    expect(r.events.some((e) => e.type === 'confirm')).toBe(true);
    expect(JSON.stringify(model.requests[2]!.messages.at(-1))).toMatch(/declined/);
    expect(shotState(r.project(), SHOT)!.track2d?.tracks ?? []).toHaveLength(0);

    const r2 = renderer(makeProject());
    const m2 = scriptedModel([() => ({ content: [use('finish', finish)] })]);
    await runAiTrack(serializeProject(r2.project()), req({ framesAllowed: false }), deps(m2, r2.send, { frames: true }));
    expect(m2.requests[0]!.tools.map((t) => t.name)).not.toContain('get_frame_image');
  });

  it('Stop ends the run', async () => {
    const r = renderer(makeProject());
    const run = req();
    const model = { call: (_q: unknown, o: { signal?: AbortSignal }) => new Promise<never>((_, reject) => o.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))) };
    const p = runAiTrack(serializeProject(r.project()), run, deps(model, r.send));
    setTimeout(() => cancelAiRun(run.runId), 20);
    expect((await p).reason).toBe('cancelled');
  });
});

describe('the vc-vfx.com client', () => {
  const stream = (lines: unknown[]) =>
    new Response(
      new ReadableStream({
        start(c) {
          const text = lines.map((l) => JSON.stringify(l)).join('\n');
          // Split mid-line, as a network would.
          c.enqueue(new TextEncoder().encode(text.slice(0, 37)));
          c.enqueue(new TextEncoder().encode(text.slice(37)));
          c.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
    );

  it('posts the turn with the bearer token and reads the NDJSON stream', async () => {
    const seen: { url: string; auth: string | null; body: unknown }[] = [];
    const allowance = { used: 1, limit: 400, remaining: 399, resetsAt: '2026-11-01T00:00:00.000Z', model: 'claude-opus-5-5' };
    const fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) });
      return stream([{ type: 'start', model: 'claude-opus-5-5', allowance }, { type: 'block', index: 0, block: 'thinking' }, { type: 'delta', index: 0, kind: 'thinking', text: 'Hm.' }, { type: 'final', message: { content: [], stop_reason: 'end_turn' }, usage: { credits: 0.5 }, allowance }]);
    }) as unknown as typeof globalThis.fetch;
    const frags: unknown[] = [];
    const c = siteModelClient({ siteUrl: 'https://vc-vfx.com', token: async () => 'tok', fetch });
    const out = await c.call({ system: 's', tools: [], messages: [{ role: 'user', content: 'hi' }] }, { onFragment: (f) => frags.push(f) });
    expect(seen[0]).toMatchObject({ url: 'https://vc-vfx.com/api/ai/track-agent', auth: 'Bearer tok' });
    expect(out.usage.credits).toBe(0.5);
    expect(frags).toEqual([{ kind: 'block', index: 0, block: 'thinking' }, { kind: 'delta', index: 0, delta: 'thinking', text: 'Hm.' }]);
  });

  it('turns a 402 into the allowance message, and an error line into an error', async () => {
    const f402 = (async () => new Response(JSON.stringify({ error: 'AI allowance used up this month — resets on 1 November.', remaining: 0 }), { status: 402 })) as unknown as typeof fetch;
    const c = siteModelClient({ siteUrl: 'https://x', token: async () => 't', fetch: f402 });
    const e = await c.call({ system: 's', tools: [], messages: [] }, {}).catch((x) => x);
    expect(e).toBeInstanceOf(ModelCallError);
    expect(e.status).toBe(402);
    expect(e.message).toMatch(/resets on 1 November/);
    const fErr = (async () => stream([{ type: 'start' }, { type: 'error', status: 503, error: 'Overloaded.' }])) as unknown as typeof fetch;
    const e2 = await siteModelClient({ siteUrl: 'https://x', token: async () => 't', fetch: fErr }).call({ system: 's', tools: [], messages: [] }, {}).catch((x) => x);
    expect(e2.message).toBe('Overloaded.');
    const fA = (async () => new Response(JSON.stringify({ used: 2, limit: 400, remaining: 398, resetsAt: 'x', model: 'claude-opus-5-5' }), { status: 200 })) as unknown as typeof fetch;
    expect((await fetchAllowance({ siteUrl: 'https://x', token: async () => 't', fetch: fA })).remaining).toBe(398);
  });
});
