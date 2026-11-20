import type { Env } from '../env';

/** Path the desktop model gateway serves (apps/desktop/src/main/model-gateway.ts). */
export const LOCAL_MODEL_GATEWAY_PATH = '/local-model/v1';

/**
 * Spec 036: in the local runtime, OpenCode without a saved cloud credential talks to the
 * host-local model service through the desktop model gateway. The workspace authenticates
 * with its own callback token, and the node agent fills in the relay address it already uses.
 * Returns null outside the local runtime or when no local model is configured.
 */
export function buildLocalOpencodeInferenceConfig(env: Env): {
  provider: 'openai-compatible';
  baseURL: string;
  model: string;
  apiKeySource: 'callback-token';
} | null {
  if (env.SAM_RUNTIME_MODE !== 'local') return null;
  const model = env.LOCAL_DEFAULT_MODEL?.trim();
  if (!model) return null;
  return {
    provider: 'openai-compatible',
    baseURL: `{controlPlaneUrl}${LOCAL_MODEL_GATEWAY_PATH}`,
    model,
    apiKeySource: 'callback-token',
  };
}
