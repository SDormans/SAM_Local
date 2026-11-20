import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertPrivateBindHost,
  type GatewayLogEvent,
  GatewayTokenStore,
  type LocalModelUpstream,
  type RunningModelGateway,
  startModelGateway,
} from '../../src/main/model-gateway';

interface UpstreamCall {
  method: string;
  url: string;
  authorization?: string;
  body: string;
}

let upstream: Server;
let upstreamUrl: string;
let calls: UpstreamCall[];
let gateway: RunningModelGateway | undefined;
let logs: GatewayLogEvent[];

function startUpstream(): Promise<void> {
  calls = [];
  upstream = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: req.headers.authorization,
        body,
      });
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'list',
            data: [
              { id: 'qwen', object: 'model' },
              { id: 'other', object: 'model' },
            ],
          })
        );
        return;
      }
      if (req.url === '/v1/chat/completions') {
        const parsed = JSON.parse(body) as { model: string; stream?: boolean };
        if (parsed.model === 'missing') {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'model "missing" not found' } }));
          return;
        }
        if (parsed.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: {"choices":[{"delta":{"content":"he"}}]}\n\n');
          setTimeout(() => {
            res.write('data: {"choices":[{"delta":{"content":"llo"}}]}\n\n');
            res.end('data: [DONE]\n\n');
          }, 20);
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hello' } }] })
        );
        return;
      }
      res.writeHead(500);
      res.end('unexpected');
    });
  });
  return new Promise((resolve) =>
    upstream.listen(0, '127.0.0.1', () => {
      upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
      resolve();
    })
  );
}

async function boot(
  tokens: GatewayTokenStore,
  overrides: Partial<LocalModelUpstream> | null = {},
  extra: { maxRequestBodyBytes?: number } = {}
): Promise<string> {
  logs = [];
  gateway = await startModelGateway({
    host: '127.0.0.1',
    tokens,
    log: (e) => logs.push(e),
    ...extra,
    resolveUpstream: async (connectionId) =>
      overrides === null ? null : { connectionId, baseUrl: upstreamUrl, ...overrides },
  });
  return `http://127.0.0.1:${gateway.port}/local-model/v1`;
}

beforeEach(startUpstream);
afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
  await new Promise<void>((r) => upstream.close(() => r()));
});

describe('GatewayTokenStore', () => {
  it('issues opaque prefixed tokens and resolves the scoped grant', () => {
    const store = new GatewayTokenStore();
    const { token, expiresAt } = store.issue('ws-1', 'conn-1', 1000);
    expect(token).toMatch(/^samgw_[A-Za-z0-9_-]{43}$/);
    expect(store.resolve(token)).toEqual({
      ok: true,
      grant: { workspaceId: 'ws-1', connectionId: 'conn-1', expiresAt },
    });
  });

  it('reports missing, invalid, and expired tokens and drops expired grants', () => {
    let now = 1_000;
    const store = new GatewayTokenStore(() => now);
    const { token } = store.issue('ws-1', 'conn-1', 10);
    expect(store.resolve(undefined)).toEqual({ ok: false, reason: 'missing' });
    expect(store.resolve('samgw_nope')).toEqual({ ok: false, reason: 'invalid' });
    now = 1_010;
    expect(store.resolve(token)).toEqual({ ok: false, reason: 'expired' });
    expect(store.size).toBe(0);
  });

  it('revokes only the given workspace tokens', () => {
    const store = new GatewayTokenStore();
    const a = store.issue('ws-a', 'c').token;
    store.issue('ws-a', 'c');
    const b = store.issue('ws-b', 'c').token;
    expect(store.revokeWorkspace('ws-a')).toBe(2);
    expect(store.resolve(a).ok).toBe(false);
    expect(store.resolve(b).ok).toBe(true);
  });

  it('rejects invalid issue arguments', () => {
    const store = new GatewayTokenStore();
    expect(() => store.issue('', 'c')).toThrow();
    expect(() => store.issue('w', 'c', 0)).toThrow();
  });
});

describe('model gateway', () => {
  it('binds only loopback or explicitly verified private network addresses', async () => {
    for (const host of [
      '0.0.0.0',
      '::',
      '[::]',
      '0',
      '',
      'localhost',
      '192.168.1.20',
      '10.0.0.5',
    ]) {
      expect(() => assertPrivateBindHost(host), host).toThrow(/Refusing to bind/);
    }
    expect(() => assertPrivateBindHost('127.0.0.1')).not.toThrow();
    expect(() => assertPrivateBindHost('::1')).not.toThrow();
    expect(() => assertPrivateBindHost('172.18.0.1', ['172.18.0.1'])).not.toThrow();
    expect(() => assertPrivateBindHost('192.168.1.20', ['172.18.0.1'])).toThrow();
    for (const wildcard of ['0.0.0.0', '::', '0:0:0:0:0:0:0:0', '::ffff:0.0.0.0']) {
      expect(() => assertPrivateBindHost(wildcard, [wildcard]), wildcard).toThrow(/wildcard/);
    }
    await expect(
      startModelGateway({
        host: '0',
        tokens: new GatewayTokenStore(),
        resolveUpstream: async () => null,
      })
    ).rejects.toThrow(/Refusing to bind/);
  });

  it('requires a valid token and never contacts the upstream otherwise', async () => {
    const tokens = new GatewayTokenStore();
    const base = await boot(tokens);
    const missing = await fetch(`${base}/models`);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({
      error: 'gateway_token_invalid',
      message: expect.any(String),
    });
    const bad = await fetch(`${base}/models`, {
      headers: { authorization: 'Bearer samgw_forged' },
    });
    expect(bad.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('reports expired tokens distinctly', async () => {
    let now = 0;
    const tokens = new GatewayTokenStore(() => now);
    const { token } = tokens.issue('ws', 'conn', 5);
    const base = await boot(tokens);
    now = 10;
    const res = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('gateway_token_expired');
  });

  it('lists only allowed models and replaces client credentials with the server-side one', async () => {
    const tokens = new GatewayTokenStore();
    const { token } = tokens.issue('ws', 'conn');
    const base = await boot(tokens, {
      allowedModelIds: ['qwen'],
      authorization: 'Bearer upstream-secret',
    });
    const res = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ object: 'list', data: [{ id: 'qwen', object: 'model' }] });
    expect(calls[0]?.authorization).toBe('Bearer upstream-secret');
  });

  it('does not forward the workspace token upstream', async () => {
    const tokens = new GatewayTokenStore();
    const { token } = tokens.issue('ws', 'conn');
    const base = await boot(tokens);
    await fetch(`${base}/models`, { headers: { authorization: `Bearer ${token}` } });
    expect(calls[0]?.authorization).toBeUndefined();
  });

  it('proxies non-streaming chat completions', async () => {
    const tokens = new GatewayTokenStore();
    const { token } = tokens.issue('ws', 'conn');
    const base = await boot(tokens);
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen',
        messages: [{ role: 'user', content: 'secret prompt' }],
      }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).choices[0].message.content).toBe('hello');
    expect(JSON.stringify(logs)).not.toContain('secret prompt');
    expect(JSON.stringify(logs)).not.toContain(token);
  });

  it('preserves the upstream SSE stream', async () => {
    const tokens = new GatewayTokenStore();
    const { token } = tokens.issue('ws', 'conn');
    const base = await boot(tokens);
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        model: 'qwen',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const text = await res.text();
    expect(text).toContain('"he"');
    expect(text).toContain('"llo"');
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
  });

  it('rejects models outside the token scope with 403', async () => {
    const tokens = new GatewayTokenStore();
    const { token } = tokens.issue('ws', 'conn');
    const base = await boot(tokens, { allowedModelIds: ['qwen'] });
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
    });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('validates the chat body', async () => {
    const tokens = new GatewayTokenStore();
    const { token } = tokens.issue('ws', 'conn');
    const base = await boot(tokens, {}, { maxRequestBodyBytes: 64 });
    const auth = { authorization: `Bearer ${token}` };
    const notJson = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: '{',
    });
    expect(notJson.status).toBe(400);
    const missing = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: '{"model":1}',
    });
    expect(missing.status).toBe(400);
    const big = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: 'x'.repeat(200),
    });
    expect(big.status).toBe(413);
    const chunks = ['x'.repeat(80), 'y'.repeat(80), 'z'.repeat(80)];
    const chunked = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: new ReadableStream({
        pull(controller) {
          const next = chunks.shift();
          if (next) controller.enqueue(new TextEncoder().encode(next));
          else controller.close();
        },
      }),
      duplex: 'half',
    } as RequestInit);
    expect(chunked.status).toBe(413);
    expect((await chunked.json()).error).toBe('request_too_large');
    expect(calls).toHaveLength(0);
  });

  it('only exposes the two contract routes and methods', async () => {
    const tokens = new GatewayTokenStore();
    const { token } = tokens.issue('ws', 'conn');
    const base = await boot(tokens);
    const auth = { authorization: `Bearer ${token}` };
    expect((await fetch(`${base}/embeddings`, { method: 'POST', headers: auth })).status).toBe(404);
    expect((await fetch(`${base}/../../api/tags`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${base}/models`, { method: 'DELETE', headers: auth })).status).toBe(405);
    expect((await fetch(`${base}/chat/completions`, { headers: auth })).status).toBe(405);
  });

  it('ignores client attempts to choose the upstream', async () => {
    const tokens = new GatewayTokenStore();
    const { token } = tokens.issue('ws', 'conn');
    const base = await boot(tokens);
    const res = await fetch(`${base}/models?baseUrl=http://evil.example&url=http://evil.example`, {
      headers: {
        authorization: `Bearer ${token}`,
        host: 'evil.example',
        'x-forwarded-host': 'evil.example',
      },
    });
    expect(res.status).toBe(200);
    expect(calls[0]?.url).toBe('/v1/models');
  });

  it('returns actionable 502 without fallback when the connection is not configured', async () => {
    const tokens = new GatewayTokenStore();
    const { token } = tokens.issue('ws', 'conn');
    const base = await boot(tokens, null);
    const res = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('local_model_not_configured');
    expect(body.message).toMatch(/does not fall back/);
  });

  it('returns actionable 502 when the local service is down', async () => {
    const tokens = new GatewayTokenStore();
    const { token } = tokens.issue('ws', 'conn');
    const base = await boot(tokens, { baseUrl: 'http://127.0.0.1:1' });
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: 'qwen', messages: [] }),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('local_model_unavailable');
    expect(body.message).toMatch(/does not fall back to a cloud provider/);
  });

  it('maps upstream errors to 502 incompatible with a bounded message', async () => {
    const tokens = new GatewayTokenStore();
    const { token } = tokens.issue('ws', 'conn');
    const base = await boot(tokens);
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: 'missing', messages: [] }),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('local_model_incompatible');
    expect(body.message).toContain('HTTP 404');
  });

  it('maps invalid upstream model-list JSON to 502', async () => {
    const tokens = new GatewayTokenStore();
    const { token } = tokens.issue('ws', 'conn');
    gateway = await startModelGateway({
      host: '127.0.0.1',
      tokens,
      resolveUpstream: async (connectionId) => ({ connectionId, baseUrl: upstreamUrl }),
      fetchImpl: async () => new Response('not json', { status: 200 }),
    });
    const res = await fetch(`http://127.0.0.1:${gateway.port}/local-model/v1/models`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(502);
  });

  it('reports a model list without a data array as incompatible', async () => {
    const tokens = new GatewayTokenStore();
    const { token } = tokens.issue('ws', 'conn');
    gateway = await startModelGateway({
      host: '127.0.0.1',
      tokens,
      resolveUpstream: async (connectionId) => ({ connectionId, baseUrl: upstreamUrl }),
      fetchImpl: async () => Response.json({ models: [] }),
    });
    const res = await fetch(`http://127.0.0.1:${gateway.port}/local-model/v1/models`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('local_model_incompatible');
  });

  it('redacts the upstream credential from upstream error text and bounds its length', async () => {
    const tokens = new GatewayTokenStore();
    const { token } = tokens.issue('ws', 'conn');
    gateway = await startModelGateway({
      host: '127.0.0.1',
      tokens,
      maxUpstreamErrorChars: 60,
      resolveUpstream: async (connectionId) => ({
        connectionId,
        baseUrl: upstreamUrl,
        authorization: 'Bearer sk-upstream-secret',
      }),
      fetchImpl: async () =>
        new Response(
          'invalid key sk-upstream-secret (Bearer sk-upstream-secret) ' + 'x'.repeat(200),
          {
            status: 401,
          }
        ),
    });
    const res = await fetch(`http://127.0.0.1:${gateway.port}/local-model/v1/models`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    expect(body.message).not.toContain('sk-upstream-secret');
    expect(body.message).toContain('[redacted]');
    expect(body.message).not.toContain('x'.repeat(61));
  });

  it('aborts the upstream request when the client disconnects before headers', async () => {
    const tokens = new GatewayTokenStore();
    const { token } = tokens.issue('ws', 'conn');
    let upstreamSignal: AbortSignal | undefined;
    let started!: () => void;
    const fetchStarted = new Promise<void>((r) => (started = r));
    gateway = await startModelGateway({
      host: '127.0.0.1',
      tokens,
      resolveUpstream: async (connectionId) => ({ connectionId, baseUrl: upstreamUrl }),
      fetchImpl: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          upstreamSignal = init?.signal ?? undefined;
          upstreamSignal?.addEventListener('abort', () => reject(new Error('aborted')));
          started();
        }),
    });
    const client = new AbortController();
    const pending = fetch(`http://127.0.0.1:${gateway.port}/local-model/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: 'qwen', messages: [] }),
      signal: client.signal,
    }).catch(() => undefined);
    await fetchStarted;
    client.abort();
    await pending;
    await expect.poll(() => upstreamSignal?.aborted).toBe(true);
  });

  it('rejects an upstream whose connection does not match the token grant', async () => {
    const tokens = new GatewayTokenStore();
    const { token } = tokens.issue('ws', 'conn');
    const base = await boot(tokens, { connectionId: 'someone-else' });
    const res = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(502);
    expect(calls).toHaveLength(0);
  });
});
