/**
 * Checks model-gateway bearer tokens against the local API (spec 036 US2, T023).
 *
 * Workspaces authenticate with their own workspace callback token. The gateway reads the
 * (untrusted) workspace claim only to know which workspace to ask about; the local API then
 * verifies the signature, expiry and workspace binding on a callback-authenticated route.
 */
import type { TokenResolution } from '../model-gateway.js';

export const LOCAL_MODEL_CONNECTION_ID = 'ollama';

interface CallbackClaims {
  workspace?: unknown;
  type?: unknown;
  exp?: unknown;
}

function decodeClaims(token: string): CallbackClaims | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as CallbackClaims) : null;
  } catch {
    return null;
  }
}

const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const LOOPBACK_HOST = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/;

/** The gateway only ever forwards to a model service on this computer. */
export function isLoopbackModelUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password &&
      LOOPBACK_HOST.test(url.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

export function createWorkspaceTokenAuthorizer(options: {
  apiUrl: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Receives the model service address saved in SAM settings, when the API reports one. */
  onLocalModel?: (baseUrl: string) => void;
}): (token: string | null) => Promise<TokenResolution> {
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  return async (token) => {
    if (!token) return { ok: false, reason: 'missing' };
    const claims = decodeClaims(token);
    const workspaceId = claims?.workspace;
    if (
      claims?.type !== 'callback' ||
      typeof workspaceId !== 'string' ||
      !WORKSPACE_ID.test(workspaceId)
    ) {
      return { ok: false, reason: 'invalid' };
    }
    const expiresAt = typeof claims.exp === 'number' ? claims.exp * 1000 : 0;
    if (expiresAt <= now()) return { ok: false, reason: 'expired' };
    const response = await doFetch(
      `${options.apiUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/runtime`,
      { headers: { authorization: `Bearer ${token}` } }
    ).catch(() => null);
    if (!response?.ok) return { ok: false, reason: 'invalid' };
    const runtime = (await response.json().catch(() => null)) as {
      localModel?: { baseUrl?: unknown };
    } | null;
    const savedUrl = runtime?.localModel?.baseUrl;
    if (isLoopbackModelUrl(savedUrl)) options.onLocalModel?.(savedUrl);
    return {
      ok: true,
      grant: { workspaceId, connectionId: LOCAL_MODEL_CONNECTION_ID, expiresAt },
    };
  };
}
