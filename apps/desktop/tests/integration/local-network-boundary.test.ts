/**
 * Spec 036 T038: desktop listeners stay on loopback, refuse unauthenticated or expired callers,
 * and never log prompt or credential values.
 */
import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { type AddressInfo,connect } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CredentialStore, startCredentialBroker } from '../../src/main/credential-store';
import {
  type GatewayLogEvent,
  GatewayTokenStore,
  startModelGateway,
} from '../../src/main/model-gateway';
import type { SecretProtector } from '../../src/main/runtime-secrets';

const BOOTSTRAP = 'k'.repeat(43);
const PROMPT = 'summarize the private roadmap';
const UPSTREAM_KEY = 'Bearer sk-local-upstream-secret';
const protector: SecretProtector = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(s).reverse(),
  decrypt: (b) => Buffer.from(b).reverse().toString(),
};

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (stops.length) await stops.pop()?.();
});

function lanAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return undefined;
}

function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 1000 });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function startUpstream(): Promise<string> {
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  stops.push(() => new Promise((r) => server.close(() => r())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('local network boundary', () => {
  it('credential broker listens on loopback only and needs the bootstrap secret', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sam-boundary-'));
    const broker = await startCredentialBroker(
      new CredentialStore(join(dir, 'c.json'), protector, false),
      BOOTSTRAP
    );
    stops.push(() => broker.stop());
    const port = Number(new URL(broker.url).port);
    expect(new URL(broker.url).hostname).toBe('127.0.0.1');
    const lan = lanAddress();
    if (lan) expect(await reachable(lan, port)).toBe(false);
    expect((await fetch(`${broker.url}/secrets`)).status).toBe(401);
    const wrong = await fetch(`${broker.url}/secrets`, {
      headers: { authorization: `Bearer ${'x'.repeat(43)}` },
    });
    expect(wrong.status).toBe(401);
  });

  it('model gateway is loopback-only, rejects expired tokens, and logs no prompts or keys', async () => {
    let now = 1_000;
    const tokens = new GatewayTokenStore(() => now);
    const logs: GatewayLogEvent[] = [];
    const baseUrl = await startUpstream();
    const gateway = await startModelGateway({
      host: '127.0.0.1',
      tokens,
      log: (e) => logs.push(e),
      resolveUpstream: async (connectionId) => ({
        connectionId,
        baseUrl,
        authorization: UPSTREAM_KEY,
      }),
    });
    stops.push(() => gateway.close());
    const lan = lanAddress();
    if (lan) expect(await reachable(lan, gateway.port)).toBe(false);

    const { token } = tokens.issue('ws-1', 'conn-1', 60_000);
    const url = `http://127.0.0.1:${gateway.port}/local-model/v1/chat/completions`;
    const body = JSON.stringify({ model: 'qwen', messages: [{ role: 'user', content: PROMPT }] });
    const ok = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body,
    });
    expect(ok.status).toBe(200);

    now += 120_000;
    const expired = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body,
    });
    expect(expired.status).toBe(401);

    const logged = JSON.stringify(logs);
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of [PROMPT, UPSTREAM_KEY, token]) expect(logged).not.toContain(secret);
  });
});
