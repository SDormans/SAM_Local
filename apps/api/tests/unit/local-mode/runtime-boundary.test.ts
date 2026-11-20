import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  createLocalOutboundFetch,
  hostnameOf,
  installLocalOutboundGuard,
  isBlockedLocalOutboundHost,
  isLocalRuntime,
  localRuntimeGuard,
  withLocalRuntimeBindings,
} from '../../../src/local/runtime-mode';
import { AppError } from '../../../src/middleware/error';

const localEnv = { SAM_RUNTIME_MODE: 'local' } as Env;

describe('local runtime boundary', () => {
  it('is enabled only by SAM_RUNTIME_MODE=local', () => {
    expect(isLocalRuntime(localEnv)).toBe(true);
    expect(isLocalRuntime({} as Env)).toBe(false);
    expect(isLocalRuntime({ SAM_RUNTIME_MODE: 'LOCAL' } as Env)).toBe(false);
    expect(isLocalRuntime(undefined)).toBe(false);
  });

  it('blocks Cloudflare and remote VM provider hosts but not explicit cloud inference', () => {
    for (const host of [
      'api.cloudflare.com',
      'API.Cloudflare.com.',
      'x.r2.cloudflarestorage.com',
      'api.hetzner.cloud',
      'api.scaleway.com',
      'compute.googleapis.com',
      'foo.workers.dev',
    ]) {
      expect(isBlockedLocalOutboundHost(host), host).toBe(true);
    }
    for (const host of ['api.openai.com', 'api.anthropic.com', 'github.com', 'notcloudflare.com']) {
      expect(isBlockedLocalOutboundHost(host), host).toBe(false);
    }
  });

  it('fails closed for blocked outbound requests and passes others through', async () => {
    const inner = vi.fn(async () => new Response('ok'));
    const guarded = createLocalOutboundFetch(inner as unknown as typeof fetch);
    await expect(guarded('https://api.cloudflare.com/client/v4/zones')).rejects.toBeInstanceOf(
      AppError
    );
    await expect(guarded(new URL('https://api.hetzner.cloud/v1/servers'))).rejects.toMatchObject({
      statusCode: 501,
      error: 'LOCAL_MODE_UNSUPPORTED',
    });
    await expect(guarded(new Request('https://api.vultr.com/v2'))).rejects.toBeInstanceOf(AppError);
    expect(inner).not.toHaveBeenCalled();
    await expect(guarded('https://api.openai.com/v1/models')).resolves.toBeInstanceOf(Response);
    await expect(guarded('not a url')).resolves.toBeInstanceOf(Response);
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it('installs the outbound guard once', async () => {
    const inner = vi.fn(async () => new Response('ok'));
    const target = { fetch: inner as unknown as typeof fetch };
    installLocalOutboundGuard(target);
    const first = target.fetch;
    installLocalOutboundGuard(target);
    expect(target.fetch).toBe(first);
    await expect(target.fetch('https://api.cloudflare.com')).rejects.toBeInstanceOf(AppError);
  });

  it('poisons Workers AI and removes Artifacts/Containers only in local mode', () => {
    const hostedEnv = { AI: { run: vi.fn() }, ARTIFACTS: {}, SANDBOX: {} } as unknown as Env;
    expect(withLocalRuntimeBindings(hostedEnv)).toBe(hostedEnv);

    const local = withLocalRuntimeBindings({ ...hostedEnv, SAM_RUNTIME_MODE: 'local' } as Env);
    expect(local.ARTIFACTS).toBeUndefined();
    expect(local.SANDBOX).toBeUndefined();
    expect(local.VM_AGENT_CONTAINER).toBeUndefined();
    expect(local.ARTIFACTS_ENABLED).toBe('false');
    expect(() => local.AI.run('@cf/x' as never, {} as never)).toThrow(/not available in a local/);
    expect((local.AI as unknown as { then?: unknown }).then).toBeUndefined();
  });

  it('parses Host headers', () => {
    expect(hostnameOf('127.0.0.1:8787')).toBe('127.0.0.1');
    expect(hostnameOf('LOCALHOST')).toBe('localhost');
    expect(hostnameOf('[::1]:80')).toBe('[::1]');
    expect(hostnameOf('evil.example')).toBe('evil.example');
  });

  it('rejects non-loopback Host headers in local mode and is inert when hosted', async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) =>
      err instanceof AppError
        ? c.json(err.toJSON(), err.statusCode as 403)
        : c.json({ error: 'x' }, 500)
    );
    app.use('*', localRuntimeGuard());
    app.get('/ok', (c) => c.text('ok'));
    const req = (host: string) => new Request('http://127.0.0.1/ok', { headers: { host } });

    expect((await app.fetch(req('127.0.0.1:8787'), localEnv)).status).toBe(200);
    expect((await app.fetch(req('localhost'), localEnv)).status).toBe(200);
    const rebound = await app.fetch(req('attacker.example'), localEnv);
    expect(rebound.status).toBe(403);
    expect(await rebound.json()).toMatchObject({ error: 'LOCAL_HOST_REJECTED' });
    expect((await app.fetch(req('api.example.com'), {} as Env)).status).toBe(200);
  });
});
