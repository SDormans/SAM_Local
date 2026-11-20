/**
 * Spec 036 T007/T009: the real apps/api Worker under local workerd with the generated
 * local config. Proves restart persistence, versioned upgrade with backup, loopback-only
 * access, and server-validated local sessions with ownership isolation.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  applyLocalMigrations,
  localRuntimeEnv,
  type RunningLocalApi,
  startLocalApi,
  writeLocalRuntimeFiles,
} from '../../src/main/local-api-runtime';
import { latestMigrationVersion, LocalDataStore } from '../../src/main/local-data';
import {
  loadOrCreateRuntimeSecrets,
  type LocalRuntimeSecrets,
} from '../../src/main/runtime-secrets';

const apiDir = resolve(__dirname, '../../../api');
const PORT = Number(process.env.SAM_LOCAL_RUNTIME_TEST_PORT ?? 8911);

let root: string;
let store: LocalDataStore;
let secrets: LocalRuntimeSecrets;
let api: RunningLocalApi | undefined;
let configPath: string;

async function boot(): Promise<RunningLocalApi> {
  const installation = await store.init();
  api = await startLocalApi({ apiDir, store, installation, secrets, port: PORT });
  return api;
}

async function login(base: string): Promise<string> {
  const res = await fetch(`${base}/api/local/session`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secrets.LOCAL_BOOTSTRAP_SECRET}` },
  });
  expect(res.status).toBe(200);
  const cookie = res.headers.get('set-cookie') ?? '';
  expect(cookie).toMatch(/^sam_local_session=[0-9a-f]{64};/);
  expect(cookie).toMatch(/HttpOnly/i);
  expect(cookie).toMatch(/SameSite=Strict/i);
  return cookie.split(';')[0]!;
}

function d1(sql: string): Promise<void> {
  return new Promise((ok, fail) => {
    const child = spawn(
      join(apiDir, 'node_modules', '.bin', 'wrangler'),
      [
        'd1',
        'execute',
        'DATABASE',
        '--local',
        '--persist-to',
        store.stateDir,
        '--config',
        configPath,
        '--command',
        sql,
      ],
      { cwd: store.runtimeDir, env: localRuntimeEnv(), stdio: 'pipe' }
    );
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c));
    child.stderr.on('data', (c: Buffer) => (out += c));
    child.on('exit', (code) =>
      code === 0 ? ok() : fail(new Error(`d1 execute exited ${code}: ${out.slice(-2500)}`))
    );
  });
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'sam-local-runtime-'));
  store = new LocalDataStore(root);
  const installation = await store.init();
  secrets = await loadOrCreateRuntimeSecrets(join(store.runtimeDir, 'secrets.json'));
  configPath = await writeLocalRuntimeFiles({ apiDir, store, installation, secrets });
  const target = await latestMigrationVersion(join(apiDir, 'src/db/migrations'));
  const result = await store.upgrade(target, () =>
    applyLocalMigrations({ apiDir, store }, configPath)
  );
  expect(result).toMatchObject({ from: 0, to: target });
  expect(result.backupPath).toBeTruthy();
});

afterAll(async () => {
  await api?.stop();
  await rm(root, { recursive: true, force: true });
});

describe('local API runtime', () => {
  it('serves health on loopback and rejects non-loopback Host headers', async () => {
    const { url } = await boot();
    expect((await fetch(`${url}/health`)).status).toBe(200);
    // fetch() cannot override Host, so send requests with node:http.
    const withHost = (host: string) =>
      new Promise<{ status: number; body: string }>((ok, fail) => {
        const req = request(
          { host: '127.0.0.1', port: PORT, path: '/health', headers: { host } },
          (res) => {
            let body = '';
            res.on('data', (c: Buffer) => (body += c));
            res.on('end', () => ok({ status: res.statusCode ?? 0, body }));
          }
        );
        req.on('error', fail);
        req.end();
      });
    expect((await withHost(`localhost:${PORT}`)).status).toBe(200);
    expect((await withHost(`[::1]:${PORT}`)).status).toBe(200);
    const rebound = await withHost('attacker.example');
    expect(rebound.status).toBe(403);
    expect(JSON.parse(rebound.body).error).toBe('LOCAL_HOST_REJECTED');
  });

  it('issues a local session only to the bootstrap credential holder', async () => {
    const base = api!.url;
    expect((await fetch(`${base}/api/local/session`, { method: 'POST' })).status).toBe(401);
    const wrong = await fetch(`${base}/api/local/session`, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + 'x'.repeat(43) },
    });
    expect(wrong.status).toBe(401);
    const cookie = await login(base);
    const me = await fetch(`${base}/api/local/session`, { headers: { cookie } });
    expect(me.status).toBe(200);
    const { userId } = await me.json();
    const installation = await store.readInstallation();
    expect(userId).toBe(`local-${installation!.installationId}`);
  });

  it('ignores renderer-supplied identities and BetterAuth cookies', async () => {
    const base = api!.url;
    for (const headers of [
      { cookie: 'sam_local_session=' + '0'.repeat(64) },
      { cookie: 'better-auth.session_token=forged' },
      { 'x-user-id': 'someone-else' },
      { authorization: 'Bearer forged' },
    ]) {
      expect(
        (await fetch(`${base}/api/projects`, { headers })).status,
        JSON.stringify(headers)
      ).toBe(401);
    }
  });

  it('enforces project ownership for the local principal', async () => {
    const base = api!.url;
    const cookie = await login(base);
    await d1(
      "INSERT INTO users (id, email, name, role, status) VALUES ('other-user', 'o@example.invalid', 'Other', 'user', 'active');" +
        "INSERT INTO github_installations (id, user_id, installation_id, account_type, account_name) VALUES ('gi-other', 'other-user', '1', 'User', 'other');" +
        "INSERT INTO projects (id, user_id, created_by, name, normalized_name, installation_id, repository, default_branch) VALUES ('foreign-project', 'other-user', 'other-user', 'Foreign', 'foreign', 'gi-other', 'other/repo', 'main');"
    );
    const list = await fetch(`${base}/api/projects`, { headers: { cookie } });
    expect(list.status).toBe(200);
    expect(JSON.stringify(await list.json())).not.toContain('foreign-project');
    const direct = await fetch(`${base}/api/projects/foreign-project`, { headers: { cookie } });
    expect(direct.status).toBe(404);
  });

  it('answers the web app session calls from the local session', async () => {
    const base = api!.url;
    const anonymous = await fetch(`${base}/api/auth/get-session`);
    expect(anonymous.status).toBe(200);
    expect(await anonymous.json()).toBeNull();
    const cookie = await login(base);
    const session = await (
      await fetch(`${base}/api/auth/get-session`, { headers: { cookie } })
    ).json();
    expect(session.user).toMatchObject({ role: 'superadmin', status: 'active' });
    expect(session.user.id).toMatch(/^local-/);
    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
    expect((await me.json()).id).toBe(session.user.id);
    expect(
      (await fetch(`${base}/api/auth/sign-out`, { method: 'POST', headers: { cookie } })).status
    ).toBe(200);
    expect(
      await (await fetch(`${base}/api/auth/get-session`, { headers: { cookie } })).json()
    ).toBeNull();
  });

  it('reports health from supervisor-provided prerequisites and the data store', async () => {
    const base = api!.url;
    const cookie = await login(base);
    expect((await fetch(`${base}/api/local/health`)).status).toBe(401);
    const unreported = await (
      await fetch(`${base}/api/local/health`, { headers: { cookie } })
    ).json();
    expect(unreported).toMatchObject({
      status: 'degraded',
      dataStore: 'ready',
      dockerDesktop: 'unavailable',
    });
    const body = JSON.stringify({ dockerDesktop: 'ready', wsl2: 'ready' });
    const put = (authorization?: string) =>
      fetch(`${base}/api/local/health/prerequisites`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          ...(authorization ? { authorization } : {}),
        },
        body,
      });
    expect((await put()).status).toBe(401);
    expect((await put(`Bearer ${secrets.LOCAL_BOOTSTRAP_SECRET}`)).status).toBe(200);
    const ready = await (await fetch(`${base}/api/local/health`, { headers: { cookie } })).json();
    expect(ready).toEqual({
      status: 'ready',
      dockerDesktop: 'ready',
      wsl2: 'ready',
      dataStore: 'ready',
    });
  });

  it('creates a local-folder project without cloning and rejects unsafe paths', async () => {
    const base = api!.url;
    const cookie = await login(base);
    const create = (payload: Record<string, unknown>) =>
      fetch(`${base}/api/projects`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    const created = await create({
      name: 'Demo',
      repoProvider: 'local',
      localPath: 'C:\\code\\demo\\',
    });
    expect(created.status).toBe(201);
    const project = await created.json();
    expect(project).toMatchObject({ repoProvider: 'local', repository: 'C:\\code\\demo' });
    expect(
      (await create({ name: 'Again', repoProvider: 'local', localPath: 'C:\\code\\demo' })).status
    ).toBe(409);
    expect(
      (await create({ name: 'Rel', repoProvider: 'local', localPath: 'code/demo' })).status
    ).toBe(400);
    const list = await (await fetch(`${base}/api/projects`, { headers: { cookie } })).json();
    expect(JSON.stringify(list)).toContain(project.id);
    const renamed = await fetch(`${base}/api/projects/${project.id}`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Demo renamed' }),
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ name: 'Demo renamed', repoProvider: 'local' });
  });

  it('keeps the principal and session across a full runtime restart', async () => {
    const cookie = await login(api!.url);
    await api!.stop();
    api = undefined;
    const { url } = await boot();
    const me = await fetch(`${url}/api/local/session`, { headers: { cookie } });
    expect(me.status).toBe(200);
    await fetch(`${url}/api/local/session`, { method: 'DELETE', headers: { cookie } });
    expect((await fetch(`${url}/api/local/session`, { headers: { cookie } })).status).toBe(401);
  });
});
