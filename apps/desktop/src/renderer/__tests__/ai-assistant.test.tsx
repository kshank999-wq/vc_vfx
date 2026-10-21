// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SAMPLE_HANDOFF, createProject, parseHandoff, parseProject, shotState, type Project, type Result } from '@vcvfx/domain';
import type { AiRunEvent, AiRunRequest } from '../../shared/bridge';
import { AiAssistant } from '../components/AiAssistant';
import type { TrackMutation } from '../components/TrackWorkspace';
import { stubBridge } from './bridge-stub';

/**
 * The AI assistant's panel (addendum 07 §7): on the desktop it applies the
 * changes main asks for through the App (and the log) and answers with the
 * project; read-only copies cannot run it; the frames choice is stored per
 * project. jsdom, no model.
 */

afterEach(cleanup);

function project(): Project {
  const h = parseHandoff(JSON.stringify(SAMPLE_HANDOFF));
  if (!h.ok) throw new Error('sample');
  return createProject(h.handoff, '/drive/handoff.json', 'Ana', new Date('2026-10-20T10:00:00Z'));
}

function setup(o: { canEdit?: boolean } = {}) {
  let current = project();
  const listeners: ((e: AiRunEvent) => void)[] = [];
  const acks: unknown[] = [];
  const frames = vi.fn(async ({ allowed }: { projectKey: string; allowed?: boolean }) => Boolean(allowed));
  let finishRun: (v: unknown) => void = () => undefined;
  const runs: AiRunRequest[] = [];
  const api = stubBridge({
    aiTrackRun: (input) => {
      runs.push(input);
      return new Promise((resolve) => (finishRun = resolve as never));
    },
    aiTrackAck: async (ack) => void acks.push(ack),
    aiTrackCancel: async () => undefined,
    onAiEvent: (l) => {
      listeners.push(l);
      return () => undefined;
    },
    aiAllowance: async () => ({ ok: true, data: { used: 12, limit: 400, remaining: 388, resetsAt: '2026-11-01T00:00:00.000Z', model: 'claude-opus-5-5' } }),
    aiFrames: frames,
  });
  // A stand-in App: holds the project, re-renders the panel with it, applies mutations synchronously.
  function Harness() {
    const [p, setP] = useState(current);
    const onTrack = (fn: TrackMutation): boolean => {
      const r: Result = fn(current, 'Ana', new Date('2026-10-21T12:00:00Z'));
      if (r.ok) {
        current = r.project;
        setP(r.project);
      }
      return r.ok;
    };
    return <AiAssistant api={api} project={p} shotId="020_010" projectKey="/p.vcvfx" canEdit={o.canEdit ?? true} actor="Ana" onTrack={onTrack} notify={() => undefined} onFrame={() => undefined} />;
  }
  const view = render(<Harness />);
  return { view, listeners, acks, frames, runs, finish: (v: unknown) => finishRun(v), current: () => current };
}

describe('the AI assistant panel', () => {
  it('runs on the desktop: applies what main asks for through the App, answers with the project, shows the calls and the report', async () => {
    const s = setup();
    await waitFor(() => expect(screen.getByText(/388.0 of 400 left · resets 1 November/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Track & solve' }));
    await waitFor(() => expect(s.runs).toHaveLength(1));
    const runId = s.runs[0]!.runId;
    expect(s.runs[0]!).toMatchObject({ shotId: '020_010', operator: 'Ana', framesAllowed: false, exportAllowed: false, creditCap: 40 });
    act(() => {
      s.listeners.forEach((l) => l({ runId, type: 'tool_call', id: 't1', name: 'set_lens_constraints', input: { focal_mode: 'approx', focal_mm: 30 } }));
    });
    expect(screen.getByText('Lens constraints')).toBeTruthy();
    // main asks the panel to apply set_lens's op…
    const { newCamTrackDocument } = await import('@vcvfx/domain');
    const next = { ...newCamTrackDocument(s.current(), '020_010'), lens: { ...newCamTrackDocument(s.current(), '020_010').lens, focalMm: 30 } };
    act(() => {
      s.listeners.forEach((l) => l({ runId, type: 'apply', seq: 1, ops: [{ op: 'camtrack', change: { command: 'set_lens', summary: 'Lens 30 mm', doc: next, task: null } }] }));
      s.listeners.forEach((l) => l({ runId, type: 'command', toolId: 't1', entry: { verb: 'set_lens', ok: true, summary: 'Lens 30 mm' } }));
      s.listeners.forEach((l) => l({ runId, type: 'tool_result', id: 't1', name: 'set_lens_constraints', ok: true, summary: 'Lens 30 mm' }));
      s.listeners.forEach((l) => l({ runId, type: 'usage', credits: 2.5, last: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.125, credits: 2.5 }, allowance: null }));
    });
    // …and the change is in the project, logged under the assistant's name; main gets the project back.
    expect(shotState(s.current(), '020_010')!.camtrack!.lens.focalMm).toBe(30);
    expect(s.current().log.at(-1)).toMatchObject({ action: 'camtrack.set_lens', actor: 'Ana (AI assistant)' });
    const ack = s.acks[0] as { ok: boolean; text: string; seq: number };
    expect(ack.ok).toBe(true);
    expect(ack.seq).toBe(1);
    expect(parseProject(ack.text).ok).toBe(true);
    expect(screen.getByText(/Lens 30 mm/)).toBeTruthy();
    expect(screen.getByText('2.5')).toBeTruthy();
    await act(async () => {
      s.finish({ ok: true, data: { reason: 'finished', message: 'Finished: targets met.', report: { summary: 'All good.', actions: ['Set the lens'], finalStats: { rmsPx: 0.31 }, targetsMet: true, concerns: [], framesToCheck: [{ frame: 1012, reason: 'worst frame' }], nextSteps: [] }, text: null, credits: 2.5, turns: 2, created2d: [], conversationId: 'c1' } });
    });
    expect(screen.getByText('All good.')).toBeTruthy();
    expect(screen.getByText('Targets met')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Undo the assistant’s changes' })).toBeTruthy();
    // Undo reverts the camera track, logged.
    fireEvent.click(screen.getByRole('button', { name: 'Undo the assistant’s changes' }));
    expect(s.current().log.at(-1)).toMatchObject({ action: 'camtrack.ai_revert' });
  });

  it('is disabled with the reason in read-only mode', () => {
    setup({ canEdit: false });
    expect(screen.getByText(/Read-only/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Track & solve' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('stores the frames choice per project and explains what is sent', async () => {
    const s = setup();
    expect(screen.getByText(/no frames leave this computer/)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: /Let AI see frames/ }));
    await waitFor(() => expect(s.frames).toHaveBeenCalledWith({ projectKey: '/p.vcvfx', allowed: true }));
    expect(screen.getByText(/downscaled to at most 1024 px/)).toBeTruthy();
    expect(screen.getByText(/does not use API data to train its models by default/)).toBeTruthy();
  });
});
