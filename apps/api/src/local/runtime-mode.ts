/**
 * Local desktop runtime boundary (spec 036). Hosted deployments never set
 * `SAM_RUNTIME_MODE`, so every function here is a no-op for them.
 */
import type { MiddlewareHandler } from 'hono';

import type { Env } from '../env';
import { AppError } from '../middleware/error';

export const LOCAL_RUNTIME_MODE = 'local';

export function isLocalRuntime(env: Pick<Env, 'SAM_RUNTIME_MODE'> | undefined): boolean {
  return env?.SAM_RUNTIME_MODE === LOCAL_RUNTIME_MODE;
}

export function localModeUnsupported(capability: string): AppError {
  return new AppError(
    501,
    'LOCAL_MODE_UNSUPPORTED',
    `${capability} is not available in a local SAM installation`
  );
}

/** Cloudflare and remote-VM provider APIs that a local installation must never call. */
const BLOCKED_OUTBOUND_HOSTS = [
  'cloudflare.com',
  'cloudflarestorage.com',
  'workers.dev',
  'api.hetzner.cloud',
  'api.scaleway.com',
  'api.digitalocean.com',
  'api.vultr.com',
  'api.upcloud.com',
  'api.pub1.infomaniak.cloud',
  'compute.googleapis.com',
] as const;

export function isBlockedLocalOutboundHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return BLOCKED_OUTBOUND_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
}

function requestHostname(input: RequestInfo | URL): string | null {
  try {
    if (input instanceof URL) return input.hostname;
    if (typeof input === 'string') return new URL(input).hostname;
    return new URL(input.url).hostname;
  } catch {
    return null;
  }
}

const LOCAL_OUTBOUND_HOST =
  /^(localhost|127(\.\d{1,3}){3}|\[::1\]|host\.docker\.internal)$|\.localhost$/;
const offMachineHosts = new Set<string>();

/** Hosts off this computer that the local API tried to reach (spec 036 zero-cloud check). */
export function localOffMachineHosts(): string[] {
  return [...offMachineHosts].sort();
}

export function createLocalOutboundFetch(inner: typeof fetch): typeof fetch {
  const guarded = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const host = requestHostname(input);
    const normalized = host?.toLowerCase().replace(/\.$/, '');
    if (normalized && !LOCAL_OUTBOUND_HOST.test(normalized)) offMachineHosts.add(normalized);
    if (host && isBlockedLocalOutboundHost(host)) {
      return Promise.reject(localModeUnsupported(`Outbound access to ${host}`));
    }
    return inner(input, init);
  };
  return guarded as typeof fetch;
}

const GUARD_INSTALLED = Symbol.for('sam.localOutboundGuard');

/** Replaces the isolate's global fetch so cloud-only code paths fail closed in local mode. */
export function installLocalOutboundGuard(target: { fetch: typeof fetch } = globalThis): void {
  const current = target.fetch as typeof fetch & { [GUARD_INSTALLED]?: true };
  if (current[GUARD_INSTALLED]) return;
  const guarded = createLocalOutboundFetch(current.bind(target)) as typeof fetch & {
    [GUARD_INSTALLED]?: true;
  };
  guarded[GUARD_INSTALLED] = true;
  target.fetch = guarded;
}

function unsupportedBinding(name: string): never {
  throw localModeUnsupported(`The ${name} binding`);
}

/** Any use of a Cloudflare-only binding throws instead of reaching a remote service. */
function poisonedBinding(name: string): unknown {
  return new Proxy(
    {},
    {
      get: (_target, property) => (property === 'then' ? undefined : unsupportedBinding(name)),
    }
  );
}

/**
 * Returns the env handed to request handlers in local mode: Workers AI is poisoned and
 * Artifacts/Containers are absent, so optional features report themselves disabled.
 */
export function withLocalRuntimeBindings<T extends Env>(env: T): T {
  if (!isLocalRuntime(env)) return env;
  return {
    ...env,
    AI: poisonedBinding('Workers AI') as Env['AI'],
    ARTIFACTS: undefined,
    ARTIFACTS_ENABLED: 'false',
    SANDBOX: undefined,
    VM_AGENT_CONTAINER: undefined,
  };
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function hostnameOf(hostHeader: string): string {
  const host = hostHeader.trim().toLowerCase();
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1);
  return host.split(':')[0] ?? '';
}

/**
 * Local mode only: rejects requests whose Host is not loopback (DNS-rebinding defence)
 * and installs the outbound guard before any handler runs.
 */
export function localRuntimeGuard(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    if (!isLocalRuntime(c.env)) return next();
    installLocalOutboundGuard();
    // wrangler/workerd rewrites the request URL, so the client-sent Host header is authoritative.
    const host = c.req.header('host') ?? new URL(c.req.url).host;
    if (!LOOPBACK_HOSTNAMES.has(hostnameOf(host))) {
      throw new AppError(403, 'LOCAL_HOST_REJECTED', 'Local SAM only accepts loopback requests');
    }
    return next();
  };
}
