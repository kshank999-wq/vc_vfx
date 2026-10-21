import { handleAllowance } from '@/lib/ai';
import { liveAiDeps } from '@/lib/ai-live';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** This month's AI credits: `{used, limit, remaining, resetsAt, model, licensed}` (limit and remaining null for admins). */
export async function GET(): Promise<Response> {
  return handleAllowance(liveAiDeps);
}
