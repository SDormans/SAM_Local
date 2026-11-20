/**
 * Spec 036 T032: upgrading to a newer packaged version keeps projects and agent choices.
 * The older install is simulated by an installation record one schema version behind; the
 * upgrade then backs up local state, applies pending migrations, and restarts the real API.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  applyLocalMigrations,
  type RunningLocalApi,
  startLocalApi,
  writeLocalRuntimeFiles,
} from '../../src/main/local-api-runtime';
import { latestMigrationVersion, LocalDataStore } from '../../src/main/local-data';
import { loadOrCreateRuntimeSecrets } from '../../src/main/runtime-secrets';

const apiDir = resolve(__dirname, '../../../api');
const PORT = Number(process.env.SAM_LOCAL_UPGRADE_TEST_PORT ?? 8913);
let root: string | undefined;
let api: RunningLocalApi | undefined;

afterAll(async () => {
  await api?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('local packaged-version upgrade', () => {
  it('keeps projects and agent choices across an upgrade with a backup', async () => {
    root = await mkdtemp(join(tmpdir(), 'sam-local-upgrade-'));
    const store = new LocalDataStore(root);
    const installation = await store.init();
    const secrets = await loadOrCreateRuntimeSecrets(join(store.runtimeDir, 'secrets.json'));
    const configPath = await writeLocalRuntimeFiles({ apiDir, store, installation, secrets });
    const target = await latestMigrationVersion(join(apiDir, 'src/db/migrations'));
    const migrate = () => applyLocalMigrations({ apiDir, store }, configPath);
    await store.upgrade(target, migrate);

    const boot = async () => {
      api = await startLocalApi({
        apiDir,
        store,
        installation: (await store.readInstallation())!,
        secrets,
        port: PORT,
      });
      const res = await fetch(`${api.url}/api/local/session`, {
        method: 'POST',
        headers: { authorization: `Bearer ${secrets.LOCAL_BOOTSTRAP_SECRET}` },
      });
      expect(res.status).toBe(200);
      return { url: api.url, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0]! };
    };

    const before = await boot();
    const json = { cookie: before.cookie, 'content-type': 'application/json' };
    const created = await fetch(`${before.url}/api/projects`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ name: 'Kept', repoProvider: 'local', localPath: '/home/dev/kept' }),
    });
    expect(created.status).toBe(201);
    const project = (await created.json()) as { id: string };
    const saved = await fetch(`${before.url}/api/agent-settings/opencode`, {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ inferenceMode: 'local' }),
    });
    expect(saved.ok).toBe(true);
    await api!.stop();
    api = undefined;

    // Simulate the previous packaged version's schema record, then upgrade.
    const record = JSON.parse(await readFile(store.installationFile, 'utf8')) as Record<
      string,
      unknown
    >;
    await writeFile(
      store.installationFile,
      JSON.stringify({ ...record, schemaVersion: target - 1 })
    );
    const upgrade = await store.upgrade(target, migrate);
    expect(upgrade).toMatchObject({ from: target - 1, to: target });
    expect(upgrade.backupPath).toBeTruthy();

    const after = await boot();
    const headers = { cookie: after.cookie };
    const projects = (await (await fetch(`${after.url}/api/projects`, { headers })).json()) as {
      projects?: Array<{ id: string }>;
    };
    expect(JSON.stringify(projects)).toContain(project.id);
    const settings = (await (
      await fetch(`${after.url}/api/agent-settings/opencode`, { headers })
    ).json()) as { inferenceMode?: string };
    expect(settings.inferenceMode).toBe('local');
  });
});
