import { describe, expect, it, vi } from 'vitest';

import { createWorkspaceTokenAuthorizer } from '../../src/main/workspaces/workspace-token-authorizer';

const NOW = 1_800_000_000_000;

function token(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part(claims)}.sig`;
}

const valid = token({ workspace: 'ws1', type: 'callback', exp: NOW / 1000 + 60 });

describe('createWorkspaceTokenAuthorizer', () => {
  it('asks the local API to verify the workspace token and grants the local model connection', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const authorize = createWorkspaceTokenAuthorizer({
      apiUrl: 'http://127.0.0.1:8790',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    await expect(authorize(valid)).resolves.toEqual({
      ok: true,
      grant: { workspaceId: 'ws1', connectionId: 'ollama', expiresAt: NOW + 60_000 },
    });
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8790/api/workspaces/ws1/runtime', {
      headers: { authorization: `Bearer ${valid}` },
    });
  });

  it('passes on a saved local model address only when it is on this computer', async () => {
    const seen: string[] = [];
    const respond = (baseUrl: string) =>
      createWorkspaceTokenAuthorizer({
        apiUrl: 'http://127.0.0.1:8790',
        fetchImpl: (async () =>
          new Response(JSON.stringify({ localModel: { baseUrl } }))) as unknown as typeof fetch,
        now: () => NOW,
        onLocalModel: (url) => seen.push(url),
      });
    await expect(respond('http://127.0.0.1:11500')(valid)).resolves.toMatchObject({ ok: true });
    await respond('http://192.168.1.20:11434')(valid);
    await respond('http://user:pw@localhost:11434')(valid);
    expect(seen).toEqual(['http://127.0.0.1:11500']);
  });

  it('rejects tokens the API does not accept', async () => {
    const authorize = createWorkspaceTokenAuthorizer({
      apiUrl: 'http://127.0.0.1:8790',
      fetchImpl: (async () => new Response('', { status: 401 })) as unknown as typeof fetch,
      now: () => NOW,
    });
    await expect(authorize(valid)).resolves.toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects missing, malformed, non-callback and expired tokens without calling the API', async () => {
    const fetchImpl = vi.fn();
    const authorize = createWorkspaceTokenAuthorizer({
      apiUrl: 'http://127.0.0.1:8790',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    await expect(authorize(null)).resolves.toEqual({ ok: false, reason: 'missing' });
    await expect(authorize('not-a-jwt')).resolves.toEqual({ ok: false, reason: 'invalid' });
    await expect(
      authorize(token({ workspace: 'ws1', type: 'node', exp: NOW / 1000 + 60 }))
    ).resolves.toEqual({ ok: false, reason: 'invalid' });
    await expect(
      authorize(token({ workspace: '../x', type: 'callback', exp: NOW / 1000 + 60 }))
    ).resolves.toEqual({ ok: false, reason: 'invalid' });
    await expect(
      authorize(token({ workspace: 'ws1', type: 'callback', exp: NOW / 1000 - 1 }))
    ).resolves.toEqual({ ok: false, reason: 'expired' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
