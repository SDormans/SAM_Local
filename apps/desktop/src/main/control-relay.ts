/**
 * Node-agent control relay (spec 036 US2).
 *
 * The local API only accepts loopback Host values, but the node agent runs in a Docker
 * container. This relay listens on the private workspace network's gateway address and
 * forwards only the node/workspace callback paths to the loopback API. Callers still need
 * their own callback tokens; the relay adds no credentials and strips cookies.
 */
import { createServer, type IncomingMessage, request, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { assertPrivateBindHost } from './model-gateway.js';

export const RELAY_ALLOWED_PATHS: readonly RegExp[] = [
  /^\/\.well-known\/jwks\.json$/,
  /^\/api\/bootstrap\/[^/]+$/,
  /^\/api\/nodes\/[^/]+\/[a-z0-9/-]+$/i,
  /^\/api\/workspaces\/[^/]+\/[a-z0-9/-]+$/i,
  /^\/api\/projects\/[^/]+\/(tasks|acp-sessions|sessions)\/[a-z0-9/-]+$/i,
];

export function isRelayPathAllowed(rawUrl: string): boolean {
  const path = rawUrl.split('?')[0] ?? '';
  if (path.includes('..') || path.includes('//')) return false;
  return RELAY_ALLOWED_PATHS.some((pattern) => pattern.test(path));
}

export interface ControlRelayOptions {
  bindHost: string;
  /** Addresses verified to belong to SAM's private workspace network. */
  privateNetworkHosts: readonly string[];
  port?: number;
  apiPort: number;
}

export interface RunningControlRelay {
  url: string;
  close(): Promise<void>;
}

const HOP_HEADERS = ['cookie', 'host', 'connection', 'proxy-authorization', 'x-forwarded-for'];

export async function startControlRelay(
  options: ControlRelayOptions
): Promise<RunningControlRelay> {
  assertPrivateBindHost(options.bindHost, options.privateNetworkHosts);
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!req.url || !isRelayPathAllowed(req.url)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'NOT_FOUND', message: 'Not available through the relay' }));
      return;
    }
    const headers = { ...req.headers };
    for (const name of HOP_HEADERS) delete headers[name];
    const upstream = request(
      {
        host: '127.0.0.1',
        port: options.apiPort,
        method: req.method,
        path: req.url,
        headers: { ...headers, host: `127.0.0.1:${options.apiPort}` },
      },
      (upstreamRes) => {
        const out = { ...upstreamRes.headers };
        delete out['set-cookie'];
        res.writeHead(upstreamRes.statusCode ?? 502, out);
        upstreamRes.pipe(res);
      }
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'BAD_GATEWAY', message: 'Local SAM API is unavailable' }));
    });
    req.pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.bindHost, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${options.bindHost}:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
