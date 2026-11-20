/**
 * Spec 036 T035: in the desktop runtime, provider credentials are kept by the desktop app in
 * OS protected storage; the database holds only `sam-local-ref:<id>` references. This module
 * has no imports so `lib/secrets` and `services/encryption` can share it without cycles.
 */
export const LOCAL_SECRET_REF_PREFIX = 'sam-local-ref:';
export const LOCAL_SECRET_REF_IV = 'local-ref';

interface BrokerEnv {
  SAM_RUNTIME_MODE?: string;
  LOCAL_SECRET_BROKER_URL?: string;
  LOCAL_BOOTSTRAP_SECRET?: string;
}

interface Broker {
  url: string;
  token: string;
}

let broker: Broker | null = null;

const LOOPBACK_URL = /^http:\/\/(127(\.\d{1,3}){3}|localhost|\[::1\]):\d+$/;

/** Returns the desktop broker for this env, or null outside the desktop runtime. */
export function registerLocalSecretBroker(env: BrokerEnv): Broker | null {
  if (env.SAM_RUNTIME_MODE !== 'local') return null;
  const url = env.LOCAL_SECRET_BROKER_URL;
  if (!url || !LOOPBACK_URL.test(url) || !env.LOCAL_BOOTSTRAP_SECRET) return null;
  broker = { url, token: env.LOCAL_BOOTSTRAP_SECRET };
  return broker;
}

export function isLocalSecretRef(ciphertext: string): boolean {
  return ciphertext.startsWith(LOCAL_SECRET_REF_PREFIX);
}

export async function brokerRequest<T>(
  target: Broker | null,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const active = target ?? broker;
  if (!active)
    throw new Error('This credential is stored by the SAM desktop app, which is not available');
  const response = await fetch(`${active.url}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${active.token}`,
      'content-type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (!response.ok) throw new Error(`SAM desktop credential store returned ${response.status}`);
  return (await response.json()) as T;
}

/** Reads a referenced secret from the desktop credential store. */
export async function readLocalSecret(ciphertext: string): Promise<string> {
  const ref = ciphertext.slice(LOCAL_SECRET_REF_PREFIX.length);
  const body = await brokerRequest<{ value: string }>(null, `/secrets/${encodeURIComponent(ref)}`);
  return body.value;
}
