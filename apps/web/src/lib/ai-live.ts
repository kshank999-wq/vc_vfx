import { anthropicClient, type AiDeps } from './ai';
import { env, hasAi } from './env';
import { adminClient, currentUser } from './supabase';

/** The AI routes' real dependencies: Supabase (service role), the Anthropic SDK, the environment. */
export const liveAiDeps: AiDeps = {
  configured: hasAi,
  user: async () => {
    const u = await currentUser();
    return u ? { id: u.id } : null;
  },
  db: adminClient,
  anthropic: () => anthropicClient(env.anthropicApiKey),
  config: () => ({ model: env.aiModel, effort: env.aiEffort, monthlyCredits: env.aiMonthlyCredits, maxTokens: env.aiMaxOutputTokens }),
  now: () => new Date(),
};
