import { readFile } from 'node:fs/promises';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { parse } from '@iarna/toml';
import { describe, expect, it } from 'vitest';

import { localRuntimeEnv } from '../../src/main/local-api-runtime';
import {
  buildLocalWranglerConfig,
  CLOUD_ONLY_CONFIG_KEYS,
} from '../../src/main/local-runtime-config';
import { loadOrCreateRuntimeSecrets, renderDevVars } from '../../src/main/runtime-secrets';

const apiDir = resolve(__dirname, '../../../api');

describe('buildLocalWranglerConfig', () => {
  it('strips cloud-only bindings from the real API config and marks local mode', async () => {
    const source = await readFile(join(apiDir, 'wrangler.toml'), 'utf8');
    const config = parse(
      buildLocalWranglerConfig(source, { apiDir, installationId: 'inst-1', sessionTtlSeconds: 600 })
    ) as Record<string, unknown>;
    for (const key of CLOUD_ONLY_CONFIG_KEYS) expect(config).not.toHaveProperty(key);
    expect(config.main).toBe(join(apiDir, 'src/index.ts'));
    const vars = config.vars as Record<string, string>;
    expect(vars).toMatchObject({
      SAM_RUNTIME_MODE: 'local',
      LOCAL_INSTALLATION_ID: 'inst-1',
      ARTIFACTS_ENABLED: 'false',
      LOCAL_SESSION_TTL_SECONDS: '600',
    });
    expect(vars.BASE_DOMAIN).toBe('sam-local.invalid');
    const d1 = config.d1_databases as Array<{ binding: string; migrations_dir: string }>;
    const database = d1.find((d) => d.binding === 'DATABASE');
    expect(database?.migrations_dir).toBe(join(apiDir, 'src/db/migrations'));
    expect((await stat(database!.migrations_dir)).isDirectory()).toBe(true);
    expect(config.durable_objects).toBeTruthy();
  });

  it('resolves default migration dirs and validates inputs', () => {
    const out = parse(
      buildLocalWranglerConfig('main = "x.ts"\n[[d1_databases]]\nbinding = "D"\n', {
        apiDir: '/api',
        installationId: 'i',
      })
    ) as { d1_databases: Array<{ migrations_dir: string }>; vars: Record<string, string> };
    expect(out.d1_databases[0]?.migrations_dir).toBe('/api/migrations');
    expect(out.vars).not.toHaveProperty('LOCAL_SESSION_TTL_SECONDS');
    expect(() =>
      buildLocalWranglerConfig('main = "x"', { apiDir: 'rel', installationId: 'i' })
    ).toThrow();
    expect(() =>
      buildLocalWranglerConfig('main = "x"', { apiDir: '/a', installationId: '' })
    ).toThrow();
    expect(() =>
      buildLocalWranglerConfig('name = "x"', { apiDir: '/a', installationId: 'i' })
    ).toThrow();
  });
});

describe('runtime secrets', () => {
  it('creates owner-only secrets once and renders .dev.vars', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sam-secrets-'));
    try {
      const path = join(dir, 'secrets.json');
      const first = await loadOrCreateRuntimeSecrets(path);
      expect(first.LOCAL_BOOTSTRAP_SECRET.length).toBeGreaterThanOrEqual(32);
      expect(first.JWT_PRIVATE_KEY).toContain('PRIVATE KEY');
      if (process.platform !== 'win32') expect((await stat(path)).mode & 0o077).toBe(0);
      expect(await loadOrCreateRuntimeSecrets(path)).toEqual(first);
      const vars = renderDevVars(first);
      expect(vars).toContain('LOCAL_BOOTSTRAP_SECRET="');
      expect(vars.split('\n').filter(Boolean)).toHaveLength(5);
      await writeFile(path, '{"ENCRYPTION_KEY":');
      await expect(loadOrCreateRuntimeSecrets(path)).rejects.toThrow(/unreadable/);
      expect(await readFile(path, 'utf8')).toBe('{"ENCRYPTION_KEY":');
      await expect(loadOrCreateRuntimeSecrets(dir)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('localRuntimeEnv', () => {
  it('drops Cloudflare credentials and account selectors', () => {
    const env = localRuntimeEnv({ CLOUDFLARE_API_TOKEN: 't', CF_ACCOUNT_ID: 'a', PATH: '/bin' });
    expect(env).toEqual({ PATH: '/bin', WRANGLER_SEND_METRICS: 'false' });
  });
});
