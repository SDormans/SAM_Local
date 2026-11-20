import * as v from 'valibot';

import type { Env } from '../env';
import { type LocalModelConnectionInput, StoredLocalModelConnectionSchema } from '../schemas/local';

/** Matches the desktop gateway's connection ID (apps/desktop/src/main/workspaces/workspace-token-authorizer.ts). */
export const LOCAL_MODEL_CONNECTION_ID = 'ollama';
const CONNECTION_KEY = 'local-runtime:model-connection';
const LOOPBACK_HOST = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/;
const VERIFY_TIMEOUT_MS = 5_000;

export interface LocalModelConnection extends LocalModelConnectionInput {
  connectionId: string;
  lastVerifiedAt?: string;
}

export interface LocalModelConnectionVerification {
  connectionId: string;
  status: 'usable' | 'unavailable' | 'incompatible';
  models: string[];
  message?: string;
}

/** Spec 036 local destination policy: the model service must run on this computer. */
export function localEndpointProblem(baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return 'baseUrl must be a valid URL';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return 'baseUrl must use http or https';
  if (url.username || url.password) return 'baseUrl must not contain credentials';
  if (!LOOPBACK_HOST.test(url.hostname.toLowerCase())) {
    return 'baseUrl must point at this computer (localhost, 127.0.0.1, or [::1])';
  }
  return null;
}

export async function readLocalModelConnection(
  env: Pick<Env, 'KV'>
): Promise<LocalModelConnection | null> {
  const raw = await env.KV.get(CONNECTION_KEY);
  if (!raw) return null;
  try {
    const parsed = v.safeParse(StoredLocalModelConnectionSchema, JSON.parse(raw) as unknown);
    return parsed.success ? parsed.output : null;
  } catch {
    return null;
  }
}

export async function writeLocalModelConnection(
  env: Pick<Env, 'KV'>,
  connection: LocalModelConnection
): Promise<LocalModelConnection> {
  await env.KV.put(CONNECTION_KEY, JSON.stringify(connection));
  return connection;
}

function listedModels(
  providerType: LocalModelConnection['providerType'],
  body: unknown
): string[] | null {
  const record = body as { models?: Array<{ name?: unknown }>; data?: Array<{ id?: unknown }> };
  const list: unknown = providerType === 'ollama' ? record?.models : record?.data;
  if (!Array.isArray(list)) return null;
  return list
    .map((m: { name?: unknown; id?: unknown } | null) =>
      providerType === 'ollama' ? m?.name : m?.id
    )
    .filter((name): name is string => typeof name === 'string');
}

/** Checks the service is reachable and reports the saved model; never changes any agent's mode. */
export async function verifyLocalModelConnection(
  connection: LocalModelConnection,
  fetcher: typeof fetch = fetch
): Promise<LocalModelConnectionVerification> {
  const { connectionId, baseUrl, modelId, providerType } = connection;
  const base = baseUrl.replace(/\/+$/, '');
  const url = providerType === 'ollama' ? `${base}/api/tags` : `${base}/models`;
  let response: Response;
  try {
    // Redirects are not followed: the saved address is the only destination that was checked.
    response = await fetcher(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch {
    return {
      connectionId,
      status: 'unavailable',
      models: [],
      message: `Could not reach the model service at ${baseUrl}. Check that it is running.`,
    };
  }
  const models = response.ok
    ? listedModels(providerType, await response.json().catch(() => null))
    : null;
  if (!models) {
    return {
      connectionId,
      status: 'incompatible',
      models: [],
      message: `The service at ${baseUrl} did not return a model list (HTTP ${response.status}). Check the provider type.`,
    };
  }
  if (!models.includes(modelId)) {
    const hint =
      providerType === 'ollama'
        ? ` Run "ollama pull ${modelId}", or choose an installed model.`
        : '';
    return {
      connectionId,
      status: 'incompatible',
      models,
      message: `Model "${modelId}" is not available from this service.${hint}`,
    };
  }
  return { connectionId, status: 'usable', models };
}
