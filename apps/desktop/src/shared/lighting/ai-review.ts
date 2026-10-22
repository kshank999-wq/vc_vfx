import { kelvinRgb, lightingLens, lightingRig, LIGHT_ROLES, LIGHT_TYPES, type LightFields, type LightSpec, type LightingAiReviewInput, type LightingDocument } from '@vcvfx/domain';
import type { BetaTool, ModelClient, TrackAgentRequest } from '../ai/protocol';

/**
 * "Ask AI to review the rig" (addendum 14 §7): a second opinion on the
 * estimate from the AI assistant, through vc-vfx.com's proxy, metered and
 * allowance-checked like the tracking assistant, and only with the artist's
 * per-project consent to let AI see frames. One request: a downscaled frame
 * and the computed estimates (with their ranges and evidence); the answer is
 * one call of a strict tool, `suggest_light_changes`, read into suggestions
 * the artist accepts or rejects one by one. Nothing is applied by the model;
 * the local analysis needs none of this and works offline.
 */

export const LIGHTING_REVIEW_PROMPT_VERSION = 'lighting-review/1';
export const LIGHTING_REVIEW_TOOL = 'suggest_light_changes';

const num = { type: 'number' } as const;
const nullable = (s: Record<string, unknown>) => ({ anyOf: [s, { type: 'null' }] });

const CHANGE_FIELDS = {
  azimuth_deg: nullable(num),
  elevation_deg: nullable(num),
  distance_m: nullable(num),
  intensity_stops: nullable(num),
  size_deg: nullable(num),
  temperature_k: nullable(num),
  role: nullable({ type: 'string', enum: [...LIGHT_ROLES] }),
  type: nullable({ type: 'string', enum: [...LIGHT_TYPES] }),
} as const;

const NEW_LIGHT = {
  role: { type: 'string', enum: [...LIGHT_ROLES] },
  type: { type: 'string', enum: [...LIGHT_TYPES] },
  name: { type: 'string' },
  azimuth_deg: num,
  elevation_deg: num,
  distance_m: nullable(num),
  intensity_stops: num,
  size_deg: nullable(num),
  temperature_k: nullable(num),
} as const;

export const LIGHTING_REVIEW_TOOL_DEF: BetaTool = {
  name: LIGHTING_REVIEW_TOOL,
  description:
    'Report your review of the estimated light rig: a one-paragraph summary, then concrete suggestions — adjust a light (only the fields to change, others null), add a light the estimate missed (a likely motivated source or a visible practical), remove one that is not there, or a note. Directions use the rig’s convention: azimuth from the camera side (+90 = from frame right, ±180 = from behind the subject), elevation above the horizon; intensity in stops relative to the key.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'suggestions'],
    properties: {
      summary: { type: 'string' },
      suggestions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'light_id', 'reason', 'confidence', 'changes', 'new_light'],
          properties: {
            kind: { type: 'string', enum: ['adjust', 'add', 'remove', 'note'] },
            light_id: nullable({ type: 'string' }),
            reason: { type: 'string' },
            confidence: num,
            changes: nullable({ type: 'object', additionalProperties: false, required: Object.keys(CHANGE_FIELDS), properties: CHANGE_FIELDS }),
            new_light: nullable({ type: 'object', additionalProperties: false, required: Object.keys(NEW_LIGHT), properties: NEW_LIGHT }),
          },
        },
      },
    },
  } as BetaTool['input_schema'],
};

const SYSTEM = `You are a cinematographer and lighting technical director reviewing an automatic estimate of how a film shot was lit, made by VC VFX so the look can be rebuilt in Unreal Engine.
You get one frame of the shot and the estimate: each light with its role, type, direction, intensity, softness and colour temperature, every figure with a range and the evidence it rests on; the lens; the analysis' notes.
Look at the frame for what the estimate may have missed or got wrong: motivated sources (windows, lamps, screens, the sun), visible practicals, a rim or kicker, the fill's side, the colour contrast between sources, hard against soft shadows.
Be specific and conservative: suggest a change only where the picture gives evidence, and say what that evidence is. Keep within the ranges unless the picture clearly contradicts them.
Answer by calling the tool ${LIGHTING_REVIEW_TOOL} exactly once. The artist accepts or rejects each suggestion; you change nothing yourself.`;

/** The estimate as the model sees it. */
export function reviewPayload(doc: LightingDocument, shotRef: string, note?: string) {
  const a = doc.analysis;
  const lens = lightingLens(doc);
  return {
    shot: shotRef,
    frame: a?.frame ?? null,
    lights: lightingRig(doc).map((l) => ({
      id: l.id,
      ...l.spec,
      rgb: undefined,
      ranges: l.estimate ? { azimuth: l.estimate.azimuth, elevation: l.estimate.elevation, intensity: l.estimate.intensity, size: l.estimate.size, temperature: l.estimate.temperature } : null,
      evidence: l.estimate?.evidence ?? ['artist'],
      motivation: l.estimate?.motivation ?? '',
      artistFields: l.locked,
      practicalInFrame: l.estimate?.practical ?? null,
    })),
    lens: { focalMm: lens.focalMm, from: lens.focalSource, hfovDeg: lens.hfovDeg },
    notes: a?.warnings ?? [],
    marks: (a?.marks ?? []).map((m) => ({ kind: m.kind, x: m.x, y: m.y, label: m.label })),
    artistNote: note ?? null,
  };
}

export function reviewRequest(doc: LightingDocument, image: { mediaType: 'image/jpeg' | 'image/png'; data: string }, shotRef: string, sessionId: string, note?: string): TrackAgentRequest {
  return {
    system: SYSTEM,
    tools: [LIGHTING_REVIEW_TOOL_DEF],
    maxTokens: 2500,
    shotRef,
    sessionId,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } },
          { type: 'text', text: `The estimate (JSON; image coordinates are 0 … 1 of the frame's width and height):\n${JSON.stringify(reviewPayload(doc, shotRef, note))}` },
        ],
      },
    ],
  };
}

type RawChange = Partial<Record<keyof typeof CHANGE_FIELDS, number | string | null>>;
type RawLight = Partial<Record<keyof typeof NEW_LIGHT, number | string | null>>;

const fieldsOf = (c: RawChange | null | undefined): LightFields | null => {
  if (!c) return null;
  const out: LightFields = {};
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  if (n(c.azimuth_deg) !== null) out.azimuthDeg = Math.max(-180, Math.min(180, n(c.azimuth_deg)!));
  if (n(c.elevation_deg) !== null) out.elevationDeg = Math.max(-90, Math.min(90, n(c.elevation_deg)!));
  if (n(c.distance_m) !== null) out.distanceM = Math.max(0.05, n(c.distance_m)!);
  if (n(c.intensity_stops) !== null) out.intensityStops = Math.max(-20, Math.min(20, n(c.intensity_stops)!));
  if (n(c.size_deg) !== null) out.sizeDeg = Math.max(0, Math.min(180, n(c.size_deg)!));
  if (n(c.temperature_k) !== null) {
    out.temperatureK = Math.max(1000, Math.min(40000, n(c.temperature_k)!));
    out.rgb = kelvinRgb(out.temperatureK);
  }
  if (typeof c.role === 'string' && (LIGHT_ROLES as readonly string[]).includes(c.role)) out.role = c.role as LightSpec['role'];
  if (typeof c.type === 'string' && (LIGHT_TYPES as readonly string[]).includes(c.type)) out.type = c.type as LightSpec['type'];
  return Object.keys(out).length ? out : null;
};

const lightOf = (l: RawLight | null | undefined): LightSpec | null => {
  if (!l || typeof l.role !== 'string' || typeof l.type !== 'string') return null;
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const k = typeof l.temperature_k === 'number' ? Math.max(1000, Math.min(40000, l.temperature_k)) : null;
  return {
    role: (LIGHT_ROLES as readonly string[]).includes(l.role) ? (l.role as LightSpec['role']) : 'fill',
    type: (LIGHT_TYPES as readonly string[]).includes(l.type) ? (l.type as LightSpec['type']) : 'point',
    name: (typeof l.name === 'string' && l.name.trim() ? l.name.trim() : 'Suggested light').slice(0, 60),
    enabled: true,
    azimuthDeg: Math.max(-180, Math.min(180, n(l.azimuth_deg, 0))),
    elevationDeg: Math.max(-90, Math.min(90, n(l.elevation_deg, 20))),
    distanceM: typeof l.distance_m === 'number' ? Math.max(0.05, l.distance_m) : null,
    intensityStops: Math.max(-20, Math.min(20, n(l.intensity_stops, -2))),
    sizeDeg: typeof l.size_deg === 'number' ? Math.max(0, Math.min(180, l.size_deg)) : null,
    temperatureK: k,
    rgb: kelvinRgb(k ?? 5600),
  };
};

/** Ask the model; returns the review for `recordLightingAiReview` (the artist decides each suggestion). */
export async function runLightingReview(model: ModelClient, request: TrackAgentRequest, signal?: AbortSignal): Promise<LightingAiReviewInput> {
  const result = await model.call(request, { ...(signal ? { signal } : {}) });
  const content = result.message.content as unknown as { type: string; name?: string; input?: unknown; text?: string }[];
  const call = content.find((b) => b.type === 'tool_use' && b.name === LIGHTING_REVIEW_TOOL);
  const text = content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join(' ').trim();
  if (!call) return { model: result.message.model, promptVersion: LIGHTING_REVIEW_PROMPT_VERSION, summary: text.slice(0, 1200) || 'The assistant gave no suggestions.', credits: result.usage.credits, suggestions: [] };
  const input = call.input as { summary?: string; suggestions?: { kind?: string; light_id?: string | null; reason?: string; confidence?: number; changes?: RawChange | null; new_light?: RawLight | null }[] };
  const kinds = ['adjust', 'add', 'remove', 'note'] as const;
  return {
    model: result.message.model,
    promptVersion: LIGHTING_REVIEW_PROMPT_VERSION,
    summary: String(input.summary ?? text ?? '').slice(0, 1200),
    credits: result.usage.credits,
    suggestions: (input.suggestions ?? []).slice(0, 20).map((s) => ({
      kind: (kinds as readonly string[]).includes(s.kind ?? '') ? (s.kind as (typeof kinds)[number]) : 'note',
      lightId: typeof s.light_id === 'string' ? s.light_id : null,
      change: fieldsOf(s.changes),
      light: lightOf(s.new_light),
      reason: String(s.reason ?? '').slice(0, 600),
      confidence: typeof s.confidence === 'number' ? Math.max(0, Math.min(1, s.confidence)) : 0.5,
    })),
  };
}
