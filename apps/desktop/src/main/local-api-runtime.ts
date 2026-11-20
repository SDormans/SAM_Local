/**
 * Supervises the local `apps/api` Worker under workerd via `wrangler dev --local`
 * (spec 036, T001 runtime). The listener is bound to 127.0.0.1 only and no Cloudflare
 * credentials are passed to the child process.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';

import type { InstallationRecord, LocalDataStore } from './local-data.js';
import { buildLocalWranglerConfig } from './local-runtime-config.js';
import { type LocalRuntimeSecrets, renderDevVars } from './runtime-secrets.js';

export const LOCAL_API_HOST = '127.0.0.1';
export const LOCAL_API_DEFAULTS = { readyTimeoutMs: 120_000, stopTimeoutMs: 10_000 } as const;

export interface LocalApiRuntimeOptions {
  apiDir: string;
  store: LocalDataStore;
  installation: InstallationRecord;
  secrets: LocalRuntimeSecrets;
  port: number;
  wranglerBin?: string;
  readyTimeoutMs?: number;
  sessionTtlSeconds?: number;
  /** Built `apps/web` output to serve same-origin with the API. */
  webDistDir?: string;
  onOutput?: (chunk: string) => void;
}

export interface RunningLocalApi {
  url: string;
  /** Resolves when the runtime process exits for any reason. */
  exited: Promise<void>;
  stop(): Promise<void>;
}

/** Child environment without Cloudflare credentials or account selectors. */
export function localRuntimeEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith('CLOUDFLARE_') && !key.startsWith('CF_')) env[key] = value;
  }
  env.WRANGLER_SEND_METRICS = 'false';
  return env;
}

function wranglerBin(options: Pick<LocalApiRuntimeOptions, 'apiDir' | 'wranglerBin'>): string {
  return options.wranglerBin ?? join(options.apiDir, 'node_modules', '.bin', 'wrangler');
}

/** Writes the generated wrangler config and `.dev.vars` into the runtime directory. */
export async function writeLocalRuntimeFiles(
  options: Pick<
    LocalApiRuntimeOptions,
    'apiDir' | 'store' | 'installation' | 'secrets' | 'sessionTtlSeconds' | 'webDistDir'
  >
): Promise<string> {
  const source = await readFile(join(options.apiDir, 'wrangler.toml'), 'utf8');
  const configPath = join(options.store.runtimeDir, 'wrangler.toml');
  await writeFile(
    configPath,
    buildLocalWranglerConfig(source, {
      apiDir: options.apiDir,
      installationId: options.installation.installationId,
      sessionTtlSeconds: options.sessionTtlSeconds,
      webDistDir: options.webDistDir,
    })
  );
  await writeFile(join(options.store.runtimeDir, '.dev.vars'), renderDevVars(options.secrets), {
    mode: 0o600,
  });
  return configPath;
}

function run(
  bin: string,
  args: string[],
  cwd: string,
  onOutput?: (chunk: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env: localRuntimeEnv(), stdio: 'pipe' });
    let output = '';
    const collect = (chunk: Buffer): void => {
      output += chunk.toString();
      onOutput?.(chunk.toString());
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${args.slice(0, 3).join(' ')} exited ${code}: ${output.slice(-500)}`))
    );
  });
}

/** D1 bindings whose migration chains the local runtime applies (main and observability). */
export const LOCAL_D1_MIGRATION_BINDINGS = ['DATABASE', 'OBSERVABILITY_DATABASE'] as const;

/** Applies the API's D1 migrations to every local persisted database. */
export async function applyLocalMigrations(
  options: Pick<LocalApiRuntimeOptions, 'apiDir' | 'store' | 'wranglerBin' | 'onOutput'>,
  configPath: string
): Promise<void> {
  for (const binding of LOCAL_D1_MIGRATION_BINDINGS) {
    await applyDatabaseMigrations(options, configPath, binding);
  }
}

async function applyDatabaseMigrations(
  options: Pick<LocalApiRuntimeOptions, 'apiDir' | 'store' | 'wranglerBin' | 'onOutput'>,
  configPath: string,
  binding: string
): Promise<void> {
  await run(
    wranglerBin(options),
    [
      'd1',
      'migrations',
      'apply',
      binding,
      '--local',
      '--persist-to',
      options.store.stateDir,
      '--config',
      configPath,
    ],
    options.store.runtimeDir,
    options.onOutput
  );
}

export function isPortInUse(port: number, host: string = LOCAL_API_HOST): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    // wrangler starts workerd as a child; signal the whole process group.
    process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

export async function startLocalApi(options: LocalApiRuntimeOptions): Promise<RunningLocalApi> {
  if (await isPortInUse(options.port)) {
    throw new Error(`Local API port ${options.port} is already in use`);
  }
  const configPath = await writeLocalRuntimeFiles(options);
  const child = spawn(
    wranglerBin(options),
    [
      'dev',
      '--local',
      '--config',
      configPath,
      '--persist-to',
      options.store.stateDir,
      '--ip',
      LOCAL_API_HOST,
      '--port',
      String(options.port),
      '--inspector-port',
      '0',
      '--show-interactive-dev-session=false',
    ],
    {
      cwd: options.store.runtimeDir,
      env: localRuntimeEnv(),
      stdio: 'pipe',
      detached: process.platform !== 'win32',
    }
  );
  child.stdout?.on('data', (chunk: Buffer) => options.onOutput?.(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => options.onOutput?.(chunk.toString()));
  let spawnError: Error | undefined;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', (error) => {
      spawnError = error;
      resolve();
    });
  });

  const url = `http://${LOCAL_API_HOST}:${options.port}`;
  const stop = async (): Promise<void> => {
    killTree(child, 'SIGTERM');
    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), LOCAL_API_DEFAULTS.stopTimeoutMs).unref()
    );
    if ((await Promise.race([exited, timeout])) === 'timeout') {
      killTree(child, 'SIGKILL');
      await exited;
    }
  };

  const deadline = Date.now() + (options.readyTimeoutMs ?? LOCAL_API_DEFAULTS.readyTimeoutMs);
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`Local API could not start: ${spawnError.message}`);
    if (child.exitCode !== null) throw new Error(`Local API exited with code ${child.exitCode}`);
    const ok = await fetch(`${url}/health`).then(
      (r) => r.ok,
      () => false
    );
    if (ok) return { url, exited, stop };
    await new Promise((r) => setTimeout(r, 500));
  }
  await stop();
  throw new Error('Local API did not become ready');
}
