/**
 * Spec 036 T037 / FR-020: the local desktop additions leave hosted behavior unchanged.
 */
import { Hono } from 'hono';
import * as v from 'valibot';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import { sealCredential } from '../../src/local/local-secret-store';
import { isLocalRuntime, localRuntimeGuard } from '../../src/local/runtime-mode';
import { SaveAgentSettingsSchema } from '../../src/schemas/agent-settings';
import { decrypt, generateEncryptionKey } from '../../src/services/encryption';

const KEY = generateEncryptionKey();

describe('hosted behavior with the local desktop code present', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('treats an unset or non-local runtime mode as hosted', () => {
    expect(isLocalRuntime(undefined)).toBe(false);
    expect(isLocalRuntime({} as Env)).toBe(false);
    expect(isLocalRuntime({ SAM_RUNTIME_MODE: 'hosted' } as Env)).toBe(false);
  });

  it('keeps HTTPS-only OpenCode base URLs and allows leaving inference mode unset', () => {
    const http = v.safeParse(SaveAgentSettingsSchema, {
      opencodeBaseUrl: 'http://127.0.0.1:11434',
    });
    expect(http.success).toBe(false);
    const https = v.safeParse(SaveAgentSettingsSchema, {
      opencodeBaseUrl: 'https://models.example.com/v1',
      inferenceMode: null,
    });
    expect(https.success).toBe(true);
  });

  it('encrypts credentials with AES-GCM and never contacts a broker, even if one is configured', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const env = {
      ENCRYPTION_KEY: KEY,
      LOCAL_SECRET_BROKER_URL: 'http://127.0.0.1:45555',
      LOCAL_BOOTSTRAP_SECRET: 's'.repeat(43),
    } as unknown as Env;
    const sealed = await sealCredential(env, 'sk-hosted');
    expect(sealed.ciphertext.startsWith('sam-local-ref:')).toBe(false);
    await expect(decrypt(sealed.ciphertext, sealed.iv, KEY)).resolves.toBe('sk-hosted');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('lets hosted requests through the local runtime guard on any host', async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.use('*', localRuntimeGuard());
    app.get('/api/health', (c) => c.json({ ok: true }));
    const res = await app.request(
      'https://api.example.com/api/health',
      { headers: { host: 'api.example.com' } },
      {} as Env
    );
    expect(res.status).toBe(200);
  });
});
