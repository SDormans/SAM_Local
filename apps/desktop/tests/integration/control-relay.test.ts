import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isRelayPathAllowed, startControlRelay } from '../../src/main/control-relay';

describe('control relay', () => {
  let seen: { url?: string; headers?: IncomingHttpHeaders; body?: string } = {};
  const api = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen = { url: req.url, headers: req.headers, body };
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'x=1' });
      res.end('{"ok":true}');
    });
  });
  let apiPort = 0;

  beforeAll(async () => {
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
    apiPort = (api.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => api.close(() => r())));

  it('allows only node and workspace callback paths', () => {
    expect(isRelayPathAllowed('/.well-known/jwks.json')).toBe(true);
    expect(isRelayPathAllowed('/api/nodes/N1/heartbeat')).toBe(true);
    expect(isRelayPathAllowed('/api/workspaces/W1/ready?x=1')).toBe(true);
    expect(isRelayPathAllowed('/api/local/session')).toBe(false);
    expect(isRelayPathAllowed('/api/projects')).toBe(false);
    expect(isRelayPathAllowed('/api/nodes/N1/../../local/session')).toBe(false);
    expect(isRelayPathAllowed('/api/credentials')).toBe(false);
  });

  it('refuses wildcard or unverified bind addresses', async () => {
    await expect(
      startControlRelay({ bindHost: '0.0.0.0', privateNetworkHosts: [], apiPort })
    ).rejects.toThrow(/wildcard/);
    await expect(
      startControlRelay({ bindHost: '192.168.1.20', privateNetworkHosts: [], apiPort })
    ).rejects.toThrow(/private workspace network/);
  });

  it('forwards allowed calls with a loopback Host and strips cookies both ways', async () => {
    const relay = await startControlRelay({
      bindHost: '127.0.0.1',
      privateNetworkHosts: [],
      apiPort,
    });
    try {
      const res = await fetch(`${relay.url}/api/nodes/N1/heartbeat`, {
        method: 'POST',
        headers: { authorization: 'Bearer cb', cookie: 'sam_local_session=steal' },
        body: '{"a":1}',
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(seen.url).toBe('/api/nodes/N1/heartbeat');
      expect(seen.headers?.host).toBe(`127.0.0.1:${apiPort}`);
      expect(seen.headers?.authorization).toBe('Bearer cb');
      expect(seen.headers?.cookie).toBeUndefined();
      expect(seen.body).toBe('{"a":1}');
      expect((await fetch(`${relay.url}/api/local/session`, { method: 'POST' })).status).toBe(404);
    } finally {
      await relay.close();
    }
  });

  it('reports an unavailable API as 502', async () => {
    const relay = await startControlRelay({
      bindHost: '127.0.0.1',
      privateNetworkHosts: [],
      apiPort: 1,
    });
    try {
      expect((await fetch(`${relay.url}/.well-known/jwks.json`)).status).toBe(502);
    } finally {
      await relay.close();
    }
  });
});
