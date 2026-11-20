import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { sealCredential, sweepLocalSecrets } from '../../../src/local/local-secret-store';
import { decrypt, generateEncryptionKey } from '../../../src/services/encryption';

const KEY = generateEncryptionKey();
const localEnv = {
  ENCRYPTION_KEY: KEY,
  SAM_RUNTIME_MODE: 'local',
  LOCAL_SECRET_BROKER_URL: 'http://127.0.0.1:45555',
  LOCAL_BOOTSTRAP_SECRET: 's'.repeat(43),
} as unknown as Env;

function fakeBroker() {
  const secrets = new Map<string, string>();
  let next = 0;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (
      init?.headers &&
      (init.headers as Record<string, string>).authorization !== `Bearer ${'s'.repeat(43)}`
    ) {
      return new Response('{}', { status: 401 });
    }
    const ref = decodeURIComponent(url.pathname.replace('/secrets/', ''));
    if (url.pathname === '/secrets' && init?.method === 'POST') {
      const id = `ref-${next++}`;
      secrets.set(id, (JSON.parse(String(init.body)) as { value: string }).value);
      return Response.json({ ref: id }, { status: 201 });
    }
    if (url.pathname === '/secrets') return Response.json({ refs: [...secrets.keys()] });
    if (init?.method === 'DELETE') return Response.json({ removed: secrets.delete(ref) });
    const value = secrets.get(ref);
    return value === undefined ? new Response('{}', { status: 404 }) : Response.json({ value });
  });
}

describe('local secret store', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('stores a reference, not the secret, in the desktop runtime', async () => {
    vi.stubGlobal('fetch', fakeBroker());
    const sealed = await sealCredential(localEnv, 'sk-secret');
    expect(sealed.ciphertext).toMatch(/^sam-local-ref:ref-0$/);
    expect(sealed.ciphertext).not.toContain('sk-secret');
    await expect(decrypt(sealed.ciphertext, sealed.iv, KEY)).resolves.toBe('sk-secret');
  });

  it('keeps AES-GCM encryption outside the desktop runtime', async () => {
    const hosted = { ENCRYPTION_KEY: KEY } as unknown as Env;
    const sealed = await sealCredential(hosted, 'sk-secret');
    expect(sealed.ciphertext.startsWith('sam-local-ref:')).toBe(false);
    await expect(decrypt(sealed.ciphertext, sealed.iv, KEY)).resolves.toBe('sk-secret');
  });

  it('rejects a broker address that is not on this computer', async () => {
    const lan = { ...localEnv, LOCAL_SECRET_BROKER_URL: 'http://192.168.1.5:4000' } as Env;
    const sealed = await sealCredential(lan, 'sk-secret');
    expect(sealed.ciphertext.startsWith('sam-local-ref:')).toBe(false);
  });

  it('sweeps secrets no credential row references', async () => {
    const broker = fakeBroker();
    vi.stubGlobal('fetch', broker);
    const kept = await sealCredential(localEnv, 'kept');
    await sealCredential(localEnv, 'orphan');
    const db = {
      prepare: (sql: string) => ({
        bind: () => ({
          all: async () => ({
            results: sql.includes('FROM credentials') ? [{ token: kept.ciphertext }] : [],
          }),
        }),
      }),
    };
    const removed = await sweepLocalSecrets({ ...localEnv, DATABASE: db } as unknown as Env);
    expect(removed).toBe(1);
    await expect(decrypt(kept.ciphertext, kept.iv, KEY)).resolves.toBe('kept');
  });
});
