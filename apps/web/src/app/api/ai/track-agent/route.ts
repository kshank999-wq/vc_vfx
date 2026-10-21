import { handleTrackAgent } from '@/lib/ai';
import { liveAiDeps } from '@/lib/ai-live';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A model turn with high effort can take minutes; the desktop shows progress as it streams.
export const maxDuration = 300;

/**
 * One model turn for the desktop's AI tracking assistant (addendum 07 §4).
 *
 * `Authorization: Bearer <supabase access token>`. Body
 * `{system, tools, messages, maxTokens?, shotRef?, sessionId?}`.
 * 200 NDJSON stream (`start`, `block`/`delta`…, `final` | `error`) ·
 * 400 invalid · 401 not signed in · 402 allowance used up `{error, remaining: 0, resetsAt}` ·
 * 403 no live licence · 413 too large · 503 not configured.
 */
export async function POST(request: Request): Promise<Response> {
  return handleTrackAgent(request, liveAiDeps);
}
