/**
 * Local runtime health (spec 036 `/api/local/health`). The Worker cannot probe Docker
 * Desktop or WSL2, so the desktop supervisor reports them; the data store is checked here.
 */
import * as v from 'valibot';

import type { Env } from '../env';
import { type LocalPrerequisites, LocalPrerequisitesSchema } from '../schemas/local';

const PREREQUISITES_KEY = 'local-runtime:prerequisites';

export interface LocalRuntimeHealth {
  status: 'ready' | 'degraded' | 'unavailable';
  dockerDesktop: LocalPrerequisites['dockerDesktop'];
  wsl2: LocalPrerequisites['wsl2'];
  dataStore: 'ready' | 'migrating' | 'recovery-required' | 'unavailable';
  message?: string;
}

export async function writeLocalPrerequisites(
  env: Pick<Env, 'KV'>,
  prerequisites: LocalPrerequisites
): Promise<void> {
  await env.KV.put(PREREQUISITES_KEY, JSON.stringify(prerequisites));
}

export async function readLocalPrerequisites(env: Pick<Env, 'KV'>): Promise<LocalPrerequisites> {
  const raw = await env.KV.get(PREREQUISITES_KEY);
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  const result = v.safeParse(LocalPrerequisitesSchema, parsed);
  return result.success
    ? result.output
    : {
        dockerDesktop: 'unavailable',
        wsl2: 'unavailable',
        message: 'The desktop app has not reported Docker Desktop or WSL2 status yet',
      };
}

async function dataStoreState(env: Pick<Env, 'DATABASE'>): Promise<LocalRuntimeHealth['dataStore']> {
  try {
    await env.DATABASE.prepare('SELECT 1 FROM users LIMIT 1').first();
    return 'ready';
  } catch {
    return 'unavailable';
  }
}

export async function summarizeLocalHealth(
  env: Pick<Env, 'DATABASE'>,
  prerequisites: LocalPrerequisites
): Promise<LocalRuntimeHealth> {
  const dataStore = await dataStoreState(env);
  const status: LocalRuntimeHealth['status'] =
    dataStore !== 'ready'
      ? 'unavailable'
      : prerequisites.dockerDesktop === 'ready' && prerequisites.wsl2 === 'ready'
        ? 'ready'
        : 'degraded';
  return {
    status,
    dockerDesktop: prerequisites.dockerDesktop,
    wsl2: prerequisites.wsl2,
    dataStore,
    ...(prerequisites.message ? { message: prerequisites.message } : {}),
  };
}
