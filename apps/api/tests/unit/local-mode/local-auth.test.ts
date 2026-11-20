import { describe, expect, it } from 'vitest';

import type { Env } from '../../../src/env';
import {
  createLocalSession,
  ensureLocalPrincipal,
  isValidBootstrapSecret,
  localPrincipalId,
  localSessionTtlSeconds,
  resolveLocalSession,
  revokeLocalSession,
} from '../../../src/local/local-auth';

const SECRET = 'b'.repeat(43);

function fakeEnv(overrides: Partial<Env> = {}) {
  const kv = new Map<string, { value: string; ttl?: number }>();
  const users = new Map<string, Record<string, unknown>>();
  const env = {
    LOCAL_INSTALLATION_ID: 'inst-1',
    LOCAL_BOOTSTRAP_SECRET: SECRET,
    KV: {
      put: async (k: string, value: string, o?: { expirationTtl?: number }) =>
        void kv.set(k, { value, ttl: o?.expirationTtl }),
      get: async (k: string) => kv.get(k)?.value ?? null,
      delete: async (k: string) => void kv.delete(k),
    },
    DATABASE: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          run: async () => {
            const [id, email, name] = args as string[];
            if (!users.has(id!)) {
              users.set(id!, {
                id,
                email,
                name,
                avatar_url: null,
                role: 'superadmin',
                status: 'active',
              });
            }
            return { success: true, sql };
          },
          first: async () => users.get(args[0] as string) ?? null,
        }),
      }),
    },
    ...overrides,
  } as unknown as Env;
  return { env, kv, users };
}

describe('local bootstrap secret', () => {
  it('accepts only the exact bearer secret', async () => {
    const { env } = fakeEnv();
    expect(await isValidBootstrapSecret(env, `Bearer ${SECRET}`)).toBe(true);
    expect(await isValidBootstrapSecret(env, `Bearer ${SECRET}x`)).toBe(false);
    expect(await isValidBootstrapSecret(env, SECRET)).toBe(false);
    expect(await isValidBootstrapSecret(env, 'Bearer ')).toBe(false);
    expect(await isValidBootstrapSecret(env, undefined)).toBe(false);
  });

  it('fails closed when the secret is missing or weak', async () => {
    await expect(
      isValidBootstrapSecret(fakeEnv({ LOCAL_BOOTSTRAP_SECRET: 'short' }).env, 'Bearer short')
    ).rejects.toMatchObject({ error: 'LOCAL_RUNTIME_MISCONFIGURED' });
    await expect(
      isValidBootstrapSecret(fakeEnv({ LOCAL_BOOTSTRAP_SECRET: undefined }).env, 'Bearer x')
    ).rejects.toMatchObject({ statusCode: 500 });
  });
});

describe('local principal and session', () => {
  it('derives one principal from the installation', async () => {
    const { env, users } = fakeEnv();
    expect(await ensureLocalPrincipal(env)).toBe(localPrincipalId('inst-1'));
    await ensureLocalPrincipal(env);
    expect(users.size).toBe(1);
    await expect(
      ensureLocalPrincipal(fakeEnv({ LOCAL_INSTALLATION_ID: ' ' }).env)
    ).rejects.toMatchObject({ error: 'LOCAL_RUNTIME_MISCONFIGURED' });
  });

  it('stores only a hash of the session token and resolves it to the principal', async () => {
    const { env, kv } = fakeEnv();
    const session = await createLocalSession(env, 1_000);
    expect(session.token).toMatch(/^[0-9a-f]{64}$/);
    const [key, stored] = [...kv.entries()][0]!;
    expect(key).not.toContain(session.token);
    expect(stored.value).not.toContain(session.token);
    expect(stored.ttl).toBe(86_400);
    const auth = await resolveLocalSession(env, session.token, 2_000);
    expect(auth?.user).toMatchObject({ id: 'local-inst-1', role: 'superadmin', status: 'active' });
    expect(auth?.session.token).toBeNull();
  });

  it('rejects absent, unknown, expired, revoked, and cross-installation sessions', async () => {
    const { env, kv } = fakeEnv();
    const { token, expiresAt } = await createLocalSession(env, 1_000);
    expect(await resolveLocalSession(env, undefined)).toBeNull();
    expect(await resolveLocalSession(env, 'f'.repeat(64))).toBeNull();
    expect(await resolveLocalSession(env, token, expiresAt)).toBeNull();
    const other = { ...env, LOCAL_INSTALLATION_ID: 'inst-2' } as Env;
    expect(await resolveLocalSession(other, token, 2_000)).toBeNull();
    const [key] = [...kv.keys()];
    kv.set(key!, { value: '{not json' });
    expect(await resolveLocalSession(env, token, 2_000)).toBeNull();
    kv.set(key!, { value: JSON.stringify({ userId: 1 }) });
    expect(await resolveLocalSession(env, token, 2_000)).toBeNull();
    kv.set(key!, { value: 'null' });
    expect(await resolveLocalSession(env, token, 2_000)).toBeNull();
    kv.set(key!, {
      value: JSON.stringify({ userId: 'other-user', installationId: 'inst-1', expiresAt: 9e15 }),
    });
    expect(await resolveLocalSession(env, token, 2_000)).toBeNull();

    const fresh = await createLocalSession(env, 1_000);
    await revokeLocalSession(env, fresh.token);
    await revokeLocalSession(env, undefined);
    expect(await resolveLocalSession(env, fresh.token, 2_000)).toBeNull();
  });

  it('returns null when the principal row is gone', async () => {
    const { env, users } = fakeEnv();
    const { token } = await createLocalSession(env, 1_000);
    users.clear();
    expect(await resolveLocalSession(env, token, 2_000)).toBeNull();
  });

  it('bounds the configured TTL', () => {
    expect(localSessionTtlSeconds({ LOCAL_SESSION_TTL_SECONDS: '600' })).toBe(600);
    expect(localSessionTtlSeconds({ LOCAL_SESSION_TTL_SECONDS: '5' })).toBe(86_400);
    expect(localSessionTtlSeconds({ LOCAL_SESSION_TTL_SECONDS: 'x' })).toBe(86_400);
    expect(localSessionTtlSeconds({})).toBe(86_400);
  });
});
