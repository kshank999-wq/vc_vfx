import type { AiAllowance } from '@vcvfx/domain';
import { collectAnswer, ModelCallError, ndjsonLines, type ModelClient } from '../../shared/ai/protocol';

/**
 * The desktop's model client (addendum 07 §4): each turn is a POST to
 * vc-vfx.com's `/api/ai/track-agent` with the signed-in account's access
 * token, answered as an NDJSON stream. The site holds the Anthropic key,
 * chooses the model and meters the call; the desktop never sees a key.
 * No Electron here, so it is tested with a fake fetch.
 */

export interface SiteClientOptions {
  siteUrl: string;
  token: () => Promise<string>;
  fetch?: typeof fetch;
}

async function refusal(response: Response): Promise<ModelCallError> {
  const payload = (await response.json().catch(() => null)) as { error?: string; allowance?: AiAllowance } | null;
  const fallback =
    response.status === 401 ? 'Sign in to use the AI assistant (VC VFX › Account).' : response.status === 403 ? 'The AI assistant needs an active VC VFX licence.' : response.status === 503 ? 'The AI assistant is not available on vc-vfx.com yet.' : `vc-vfx.com answered ${response.status}.`;
  return new ModelCallError(payload?.error ?? fallback, response.status, payload?.allowance ?? null);
}

export function siteModelClient(o: SiteClientOptions): ModelClient {
  const doFetch = o.fetch ?? fetch;
  return {
    async call(request, { signal, onFragment }) {
      const token = await o.token();
      let response: Response;
      try {
        response = await doFetch(`${o.siteUrl}/api/ai/track-agent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify(request),
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new ModelCallError('vc-vfx.com could not be reached. Check the connection and try again.', 0);
      }
      if (!response.ok) throw await refusal(response);
      if (!response.body) throw new ModelCallError('vc-vfx.com sent no answer.', 502);
      return collectAnswer(ndjsonLines(response.body as unknown as AsyncIterable<Uint8Array>), onFragment);
    },
  };
}

/** This month's credits, for the panel. */
export async function fetchAllowance(o: SiteClientOptions): Promise<AiAllowance & { licensed?: boolean }> {
  const response = await (o.fetch ?? fetch)(`${o.siteUrl}/api/ai/allowance`, { headers: { authorization: `Bearer ${await o.token()}` } });
  if (!response.ok) throw await refusal(response);
  return (await response.json()) as AiAllowance & { licensed?: boolean };
}
