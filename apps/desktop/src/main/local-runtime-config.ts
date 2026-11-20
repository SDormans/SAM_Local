/**
 * Builds the local-only wrangler config for `apps/api` (spec 036, T001 finding): Workers AI,
 * Artifacts, Containers, cron triggers and deploy-only sections are removed, and the runtime
 * is marked `SAM_RUNTIME_MODE=local`.
 */
import { isAbsolute, resolve } from 'node:path';

import { type JsonMap, parse, stringify } from '@iarna/toml';

export const CLOUD_ONLY_CONFIG_KEYS = [
  'ai',
  'artifacts',
  'containers',
  'triggers',
  'env',
  'routes',
  'route',
  'tail_consumers',
  'workers_dev',
  'build',
] as const;

export const LOCAL_BASE_DOMAIN = 'sam.localhost';

export interface LocalWranglerConfigOptions {
  /** Absolute path of `apps/api`; relative paths in its wrangler.toml resolve from here. */
  apiDir: string;
  installationId: string;
  sessionTtlSeconds?: number;
}

function asTables(value: unknown): JsonMap[] {
  return Array.isArray(value) ? (value as JsonMap[]) : [];
}

export function buildLocalWranglerConfig(
  sourceToml: string,
  options: LocalWranglerConfigOptions
): string {
  if (!isAbsolute(options.apiDir)) throw new Error('apiDir must be absolute');
  if (!options.installationId) throw new Error('installationId is required');
  const config = parse(sourceToml);
  for (const key of CLOUD_ONLY_CONFIG_KEYS) delete config[key];
  config.name = 'sam-local';
  if (typeof config.main !== 'string') throw new Error('wrangler config has no main entry');
  config.main = resolve(options.apiDir, config.main);
  for (const database of asTables(config.d1_databases)) {
    const dir =
      typeof database.migrations_dir === 'string' ? database.migrations_dir : 'migrations';
    database.migrations_dir = resolve(options.apiDir, dir);
  }
  const vars = (config.vars ?? {}) as JsonMap;
  config.vars = {
    ...vars,
    SAM_RUNTIME_MODE: 'local',
    LOCAL_INSTALLATION_ID: options.installationId,
    // Must not equal a loopback hostname (the API redirects the apex to www.*), but must be
    // a `.localhost` name so credentialed CORS still accepts loopback origins.
    BASE_DOMAIN: LOCAL_BASE_DOMAIN,
    ARTIFACTS_ENABLED: 'false',
    ...(options.sessionTtlSeconds
      ? { LOCAL_SESSION_TTL_SECONDS: String(options.sessionTtlSeconds) }
      : {}),
  };
  return stringify(config);
}
