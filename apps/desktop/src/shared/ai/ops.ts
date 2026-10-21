import { addPart, addStroke, applyCamTrack, recordPropagation, removeTrack2d, shotState, type CamTrackDocument, type Project, type Result, type RotoPropagationResult } from '@vcvfx/domain';
import { applyOps, type ProjectOp } from '../camera/commands';

/**
 * The project changes the AI tracking assistant asks for (addendum 07 §3).
 * The camera verbs' own `ProjectOp`s, plus the few roto mutations an
 * exclusion matte needs and the revert of a whole run. Like a human's
 * commands, every one goes through the domain's mutations — checked against
 * the approval rules and logged — in the renderer, which owns the project.
 */
export type AiOp =
  | ProjectOp
  | { op: 'roto_part'; input: { name: string; color?: string } }
  | { op: 'roto_stroke'; partId: string; frame: number; stroke: { mode: 'include' | 'exclude'; radius: number; points: [number, number][] } }
  | { op: 'roto_propagation'; result: RotoPropagationResult }
  | { op: 'camtrack_revert'; doc: CamTrackDocument; summary: string }
  | { op: 'track2d_remove'; trackId: string };

/** Apply the assistant's ops in order through the domain; stops at the first refusal. */
export function applyAiOps(p: Project, shotId: string, ops: readonly AiOp[], actor: string, now: Date): Result {
  let project = p;
  for (const o of ops) {
    let r: Result;
    switch (o.op) {
      case 'roto_part':
        r = addPart(project, shotId, o.input, actor, now);
        break;
      case 'roto_stroke':
        r = addStroke(project, shotId, o.partId, o.frame, o.stroke, actor, now);
        break;
      case 'roto_propagation':
        r = recordPropagation(project, shotId, o.result, actor, now);
        break;
      case 'camtrack_revert': {
        // Track-cache ids are never reused: the reverted document keeps the newer sequence number.
        const seq = Math.max(o.doc.seq, shotState(project, shotId)?.camtrack?.seq ?? 0);
        r = applyCamTrack(project, shotId, { command: 'ai_revert', summary: o.summary, doc: { ...o.doc, seq }, task: null }, actor, now);
        break;
      }
      case 'track2d_remove':
        r = removeTrack2d(project, shotId, o.trackId, actor, now);
        break;
      default:
        r = applyOps(project, shotId, [o], actor, now);
    }
    if (!r.ok) return r;
    project = r.project;
  }
  return { ok: true, project };
}
