import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyLocalMigrations,
  isPortInUse,
  startLocalApi,
  writeLocalRuntimeFiles,
} from '../../src/main/local-api-runtime';
import { LocalDataStore } from '../../src/main/local-data';
import { generateRuntimeSecrets } from '../../src/main/runtime-secrets';

const apiDir = resolve(__dirname, '../../../api');

// Stand-in for the wrangler CLI: `dev` serves /health on --port, `d1` exits per FAKE_D1_EXIT.
const FAKE_WRANGLER = `#!/usr/bin/env node
const args = process.argv.slice(2);
require('node:fs').writeFileSync(process.cwd() + '/args.json', JSON.stringify({ args, cf: Object.keys(process.env).filter(k => k.startsWith('CF_') || k.startsWith('CLOUDFLARE_')) }));
if (args[0] === 'd1') { console.error('migrating'); process.exit(Number(process.env.FAKE_D1_EXIT || 0)); }
if (process.env.FAKE_DEV_EXIT) process.exit(3);
const port = Number(args[args.indexOf('--port') + 1]);
const ready = !process.env.FAKE_DEV_NEVER_READY;
require('node:http').createServer((q, s) => { s.statusCode = ready ? 200 : 503; s.end('{}'); }).listen(port, '127.0.0.1', () => console.log('ready'));
if (process.env.FAKE_DEV_IGNORE_TERM) process.on('SIGTERM', () => {});
`;

let root: string;
let bin: string;
let store: LocalDataStore;
const saved = { ...process.env };

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

async function options() {
  const installation = await store.init();
  return {
    apiDir,
    store,
    installation,
    secrets: generateRuntimeSecrets(),
    port: await freePort(),
    wranglerBin: bin,
    readyTimeoutMs: 5_000,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sam-runtime-unit-'));
  bin = join(root, 'fake-wrangler');
  await writeFile(bin, FAKE_WRANGLER);
  await chmod(bin, 0o755);
  store = new LocalDataStore(join(root, 'data'));
  process.env.CLOUDFLARE_API_TOKEN = 'must-not-leak';
});

afterEach(async () => {
  process.env = { ...saved };
  await rm(root, { recursive: true, force: true });
});

describe('local API runtime supervisor', () => {
  it('writes the local config and owner-only .dev.vars', async () => {
    const opts = await options();
    const configPath = await writeLocalRuntimeFiles(opts);
    expect(await readFile(configPath, 'utf8')).toContain('SAM_RUNTIME_MODE = "local"');
    const devVars = join(store.runtimeDir, '.dev.vars');
    expect(await readFile(devVars, 'utf8')).toContain('LOCAL_BOOTSTRAP_SECRET=');
    if (process.platform !== 'win32') expect((await stat(devVars)).mode & 0o077).toBe(0);
  });

  it('starts on loopback without Cloudflare credentials and stops the process tree', async () => {
    const opts = await options();
    const output: string[] = [];
    const api = await startLocalApi({ ...opts, onOutput: (c) => output.push(c) });
    expect(api.url).toBe(`http://127.0.0.1:${opts.port}`);
    expect(await isPortInUse(opts.port)).toBe(true);
    const recorded = JSON.parse(await readFile(join(store.runtimeDir, 'args.json'), 'utf8'));
    expect(recorded.cf).toEqual([]);
    expect(recorded.args).toEqual(
      expect.arrayContaining([
        'dev',
        '--local',
        '--ip',
        '127.0.0.1',
        '--persist-to',
        store.stateDir,
      ])
    );
    expect(output.join('')).toContain('ready');
    await api.stop();
    expect(await isPortInUse(opts.port)).toBe(false);
  });

  it('refuses a port that is already in use', async () => {
    const opts = await options();
    const blocker: Server = createServer();
    await new Promise<void>((r) => blocker.listen(opts.port, '127.0.0.1', () => r()));
    try {
      await expect(startLocalApi(opts)).rejects.toThrow(/already in use/);
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });

  it('returns a startup error when the runtime binary cannot be executed', async () => {
    const opts = await options();
    await expect(startLocalApi({ ...opts, wranglerBin: join(root, 'missing') })).rejects.toThrow(
      /could not start/
    );
  });

  it('reports an early exit and a runtime that never becomes ready', async () => {
    process.env.FAKE_DEV_EXIT = '1';
    await expect(startLocalApi(await options())).rejects.toThrow(/exited with code 3/);
    delete process.env.FAKE_DEV_EXIT;
    process.env.FAKE_DEV_NEVER_READY = '1';
    const opts = await options();
    await expect(startLocalApi({ ...opts, readyTimeoutMs: 1_500 })).rejects.toThrow(
      /did not become ready/
    );
    expect(await isPortInUse(opts.port)).toBe(false);
  });

  it('applies migrations and surfaces migration failures', async () => {
    const opts = await options();
    const configPath = await writeLocalRuntimeFiles(opts);
    const output: string[] = [];
    await applyLocalMigrations({ ...opts, onOutput: (c) => output.push(c) }, configPath);
    expect(output.join('')).toContain('migrating');
    const recorded = JSON.parse(await readFile(join(store.runtimeDir, 'args.json'), 'utf8'));
    expect(recorded.args.slice(0, 5)).toEqual(['d1', 'migrations', 'apply', 'DATABASE', '--local']);
    process.env.FAKE_D1_EXIT = '2';
    await expect(applyLocalMigrations(opts, configPath)).rejects.toThrow(/exited 2: migrating/);
    await expect(
      applyLocalMigrations({ ...opts, wranglerBin: join(root, 'missing') }, configPath)
    ).rejects.toThrow();
  });
});
