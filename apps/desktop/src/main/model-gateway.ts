import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo, isIP } from 'node:net';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

export const MODEL_GATEWAY_DEFAULTS = {
  tokenTtlMs: 60 * 60 * 1000,
  upstreamHeadersTimeoutMs: 30_000,
  maxRequestBodyBytes: 4 * 1024 * 1024,
  maxUpstreamErrorChars: 300,
} as const;

export const GATEWAY_PATH_PREFIX = '/local-model/v1';
const TOKEN_PREFIX = 'samgw_';

export interface GatewayGrant {
  workspaceId: string;
  connectionId: string;
  expiresAt: number;
}

export type TokenResolution =
  { ok: true; grant: GatewayGrant } | { ok: false; reason: 'missing' | 'invalid' | 'expired' };

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** In-memory store of short-lived workspace-scoped gateway tokens. Only token hashes are kept. */
export class GatewayTokenStore {
  private readonly grants = new Map<string, GatewayGrant>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(
    workspaceId: string,
    connectionId: string,
    ttlMs: number = MODEL_GATEWAY_DEFAULTS.tokenTtlMs
  ): { token: string; expiresAt: number } {
    if (!workspaceId || !connectionId) throw new Error('workspaceId and connectionId are required');
    if (!(ttlMs > 0)) throw new Error('ttlMs must be positive');
    const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const expiresAt = this.now() + ttlMs;
    this.grants.set(hashToken(token), { workspaceId, connectionId, expiresAt });
    return { token, expiresAt };
  }

  resolve(token: string | null | undefined): TokenResolution {
    if (!token) return { ok: false, reason: 'missing' };
    const key = hashToken(token);
    const grant = this.grants.get(key);
    if (!grant) return { ok: false, reason: 'invalid' };
    if (grant.expiresAt <= this.now()) {
      this.grants.delete(key);
      return { ok: false, reason: 'expired' };
    }
    return { ok: true, grant };
  }

  revokeWorkspace(workspaceId: string): number {
    let removed = 0;
    for (const [key, grant] of this.grants) {
      if (grant.workspaceId === workspaceId) {
        this.grants.delete(key);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.grants.size;
  }
}

/** Server-side resolved upstream for one local model connection. Never supplied by clients. */
export interface LocalModelUpstream {
  connectionId: string;
  /** Base URL of the OpenAI-compatible service, without the `/v1` suffix (e.g. `http://127.0.0.1:11434`). */
  baseUrl: string;
  /** When set, requests for other models are rejected. */
  allowedModelIds?: readonly string[];
  /** Authorization header value resolved from protected storage by the trusted process. */
  authorization?: string;
}

export interface GatewayLogEvent {
  event: string;
  method?: string;
  path?: string;
  status?: number;
  workspaceId?: string;
  connectionId?: string;
}

export interface ModelGatewayOptions {
  /** IP literal to bind: loopback, or an address listed in `privateNetworkHosts`. */
  host: string;
  /**
   * Non-loopback addresses the trusted caller has verified belong to the private SAM workspace
   * network (for example the SAM Docker network gateway). LAN-facing addresses must never be listed.
   */
  privateNetworkHosts?: readonly string[];
  port?: number;
  tokens: GatewayTokenStore;
  resolveUpstream: (connectionId: string) => Promise<LocalModelUpstream | null>;
  upstreamHeadersTimeoutMs?: number;
  maxRequestBodyBytes?: number;
  maxUpstreamErrorChars?: number;
  log?: (event: GatewayLogEvent) => void;
  fetchImpl?: typeof fetch;
}

export interface RunningModelGateway {
  host: string;
  port: number;
  close(): Promise<void>;
}

class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function isUnspecified(host: string): boolean {
  return host === '0.0.0.0' || /^[0:]+$/.test(host) || /^::ffff:0\.0\.0\.0$/i.test(host);
}

function isLoopback(host: string): boolean {
  return (isIP(host) === 4 && host.startsWith('127.')) || host === '::1';
}

export function assertPrivateBindHost(
  host: string,
  privateNetworkHosts: readonly string[] = []
): void {
  if (isIP(host) === 0) {
    throw new Error(`Refusing to bind the model gateway to "${host}"; an IP literal is required`);
  }
  if (isUnspecified(host)) {
    throw new Error(`Refusing to bind the model gateway to wildcard address "${host}"`);
  }
  if (isLoopback(host) || privateNetworkHosts.includes(host)) return;
  throw new Error(
    `Refusing to bind the model gateway to "${host}"; use loopback or a verified private workspace network address`
  );
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1] ?? null;
}

function tooLarge(): GatewayError {
  return new GatewayError(413, 'request_too_large', 'Request body is too large');
}

/** Reads at most `limit` bytes; an oversized body is drained (not destroyed) so the 413 can be sent. */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let exceeded = Number(req.headers['content-length'] ?? '0') > limit;
    req.on('data', (chunk: Buffer) => {
      if (exceeded) return;
      size += chunk.length;
      if (size > limit) {
        exceeded = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => (exceeded ? reject(tooLarge()) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

function unavailable(): GatewayError {
  return new GatewayError(
    502,
    'local_model_unavailable',
    'The configured local model service is not reachable. Start it (for example, Ollama) and retry. SAM does not fall back to a cloud provider.'
  );
}

function sanitizeUpstreamMessage(text: string, maxChars: number, authorization?: string): string {
  let out = text;
  if (authorization) {
    const secrets = [authorization, authorization.replace(/^\S+\s+/, '')].filter(
      (v) => v.length >= 4
    );
    for (const secret of secrets) out = out.split(secret).join('[redacted]');
  }
  return out.replace(/\s+/g, ' ').slice(0, maxChars);
}

export async function startModelGateway(
  options: ModelGatewayOptions
): Promise<RunningModelGateway> {
  assertPrivateBindHost(options.host, options.privateNetworkHosts);
  const maxErrorChars =
    options.maxUpstreamErrorChars ?? MODEL_GATEWAY_DEFAULTS.maxUpstreamErrorChars;
  const headersTimeoutMs =
    options.upstreamHeadersTimeoutMs ?? MODEL_GATEWAY_DEFAULTS.upstreamHeadersTimeoutMs;
  const maxBody = options.maxRequestBodyBytes ?? MODEL_GATEWAY_DEFAULTS.maxRequestBodyBytes;
  const doFetch = options.fetchImpl ?? fetch;
  const log = options.log ?? (() => {});

  async function forward(
    res: ServerResponse,
    upstream: LocalModelUpstream,
    upstreamPath: string,
    init: { method: string; body?: Buffer },
    transformJson?: (body: unknown) => unknown
  ): Promise<number> {
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    const timer = setTimeout(() => controller.abort(), headersTimeoutMs);
    const headers: Record<string, string> = { accept: 'application/json, text/event-stream' };
    if (init.body) headers['content-type'] = 'application/json';
    if (upstream.authorization) headers.authorization = upstream.authorization;
    let response: Response;
    try {
      response = await doFetch(new URL(upstreamPath, upstream.baseUrl.replace(/\/+$/, '') + '/'), {
        method: init.method,
        headers,
        body: init.body,
        signal: controller.signal,
        redirect: 'error',
      });
    } catch {
      throw unavailable();
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const text = sanitizeUpstreamMessage(
        await response.text().catch(() => ''),
        maxErrorChars,
        upstream.authorization
      );
      throw new GatewayError(
        502,
        'local_model_incompatible',
        `The local model service rejected the request (HTTP ${response.status})${text ? `: ${text}` : ''}`
      );
    }
    if (transformJson) {
      const json: unknown = await response.json().catch(() => {
        throw new GatewayError(
          502,
          'local_model_incompatible',
          'The local model service returned invalid JSON'
        );
      });
      sendJson(res, 200, transformJson(json));
      return 200;
    }
    const contentType = response.headers.get('content-type') ?? 'application/json';
    res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
    if (response.body) {
      const stream = Readable.fromWeb(response.body as unknown as NodeReadableStream);
      res.on('close', () => stream.destroy());
      await new Promise<void>((resolve) => {
        stream.on('error', () => {
          res.destroy();
          resolve();
        });
        stream.on('end', resolve);
        stream.pipe(res);
      });
    } else {
      res.end();
    }
    return 200;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<number> {
    const path = new URL(req.url ?? '/', 'http://gateway.invalid').pathname;
    const isModels = path === `${GATEWAY_PATH_PREFIX}/models`;
    const isChat = path === `${GATEWAY_PATH_PREFIX}/chat/completions`;
    if (!isModels && !isChat) throw new GatewayError(404, 'not_found', 'Unknown gateway route');
    if ((isModels && req.method !== 'GET') || (isChat && req.method !== 'POST')) {
      throw new GatewayError(405, 'method_not_allowed', 'Method not allowed');
    }

    const resolution = options.tokens.resolve(bearerToken(req));
    if (!resolution.ok) {
      throw new GatewayError(
        401,
        resolution.reason === 'expired' ? 'gateway_token_expired' : 'gateway_token_invalid',
        resolution.reason === 'expired'
          ? 'The workspace gateway token has expired; restart the agent session'
          : 'A valid workspace gateway token is required'
      );
    }
    const { grant } = resolution;
    const upstream = await options.resolveUpstream(grant.connectionId);
    if (!upstream || upstream.connectionId !== grant.connectionId) {
      throw new GatewayError(
        502,
        'local_model_not_configured',
        'No local model connection is configured for this workspace. SAM does not fall back to a cloud provider.'
      );
    }
    const allowed = upstream.allowedModelIds;

    if (isModels) {
      log({
        event: 'gateway.models',
        workspaceId: grant.workspaceId,
        connectionId: grant.connectionId,
      });
      return forward(res, upstream, 'v1/models', { method: 'GET' }, (json) => {
        const raw = (json as { data?: unknown } | null)?.data;
        if (!Array.isArray(raw)) {
          throw new GatewayError(
            502,
            'local_model_incompatible',
            'The local model service did not return an OpenAI-compatible model list'
          );
        }
        const data = raw as Array<{ id?: unknown }>;
        return {
          object: 'list',
          data: allowed
            ? data.filter((m) => typeof m.id === 'string' && allowed.includes(m.id))
            : data,
        };
      });
    }

    const body = await readBody(req, maxBody);
    let parsed: { model?: unknown; messages?: unknown };
    try {
      parsed = JSON.parse(body.toString('utf8')) as typeof parsed;
    } catch {
      throw new GatewayError(400, 'invalid_request', 'Request body must be JSON');
    }
    if (typeof parsed?.model !== 'string' || !Array.isArray(parsed.messages)) {
      throw new GatewayError(
        400,
        'invalid_request',
        'model (string) and messages (array) are required'
      );
    }
    if (allowed && !allowed.includes(parsed.model)) {
      throw new GatewayError(
        403,
        'model_not_allowed',
        'This workspace token is not scoped to the requested model'
      );
    }
    log({
      event: 'gateway.chat',
      workspaceId: grant.workspaceId,
      connectionId: grant.connectionId,
    });
    return forward(res, upstream, 'v1/chat/completions', { method: 'POST', body });
  }

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    handle(req, res)
      .then((status) => log({ event: 'gateway.request', method: req.method, path, status }))
      .catch((err: unknown) => {
        const error =
          err instanceof GatewayError
            ? err
            : new GatewayError(500, 'internal_error', 'Model gateway internal error');
        log({ event: 'gateway.request', method: req.method, path, status: error.status });
        if (res.headersSent) {
          res.destroy();
          return;
        }
        sendJson(res, error.status, { error: error.code, message: error.message });
      });
  });
  server.requestTimeout = 0;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    host: options.host,
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
