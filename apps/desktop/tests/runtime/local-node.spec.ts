/**
 * Spec 036 US2: the real local API plus the real node agent image under Docker. Proves the
 * node registers, reaches the API only through the private-network relay, and reports ready.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  applyLocalMigrations,
  type RunningLocalApi,
  startLocalApi,
  writeLocalRuntimeFiles,
} from '../../src/main/local-api-runtime';
import { latestMigrationVersion, LocalDataStore } from '../../src/main/local-data';
import {
  loadOrCreateRuntimeSecrets,
  type LocalRuntimeSecrets,
} from '../../src/main/runtime-secrets';
import { DockerDesktopDriver } from '../../src/main/workspaces/docker-desktop';
import { DEFAULT_LOCAL_NODE_IMAGE, LocalNode } from '../../src/main/workspaces/local-node';

const apiDir = resolve(__dirname, '../../../api');
const PORT = Number(process.env.SAM_LOCAL_RUNTIME_TEST_PORT ?? 8912);
const NODE_PORT = Number(process.env.SAM_LOCAL_NODE_TEST_PORT ?? 18943);
const image = process.env.SAM_LOCAL_NODE_IMAGE ?? DEFAULT_LOCAL_NODE_IMAGE;

function imageAvailable(): boolean {
  try {
    execFileSync('docker', ['image', 'inspect', image], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

let root: string;
let secrets: LocalRuntimeSecrets;
let api: RunningLocalApi | undefined;
let node: LocalNode | undefined;

describe.runIf(imageAvailable())('local node agent', () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'sam-local-node-'));
    const store = new LocalDataStore(root);
    const installation = await store.init();
    secrets = await loadOrCreateRuntimeSecrets(join(store.runtimeDir, 'secrets.json'));
    const runtime = { apiDir, store, installation, secrets, port: PORT, nodeAgentPort: NODE_PORT };
    const configPath = await writeLocalRuntimeFiles(runtime);
    const target = await latestMigrationVersion(join(apiDir, 'src/db/migrations'));
    await store.upgrade(target, () => applyLocalMigrations(runtime, configPath));
    api = await startLocalApi(runtime);
    node = new LocalNode(new DockerDesktopDriver(`rt${randomBytes(4).toString('hex')}`));
  });

  afterAll(async () => {
    const report = await node?.removeAll();
    expect(report?.complete).toBe(true);
    await api?.stop();
    await rm(root, { recursive: true, force: true });
  });

  it('registers, reaches the API through the relay and reports ready', async () => {
    const started = await node!.start({
      apiUrl: api!.url,
      bootstrapSecret: secrets.LOCAL_BOOTSTRAP_SECRET,
      image,
      hostPort: NODE_PORT,
      projectsRoot: root,
    });
    const login = await fetch(`${api!.url}/api/local/session`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secrets.LOCAL_BOOTSTRAP_SECRET}` },
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;

    let nodeRow: { status?: string; lastHeartbeatAt?: string | null } = {};
    for (let i = 0; i < 60; i++) {
      const res = await fetch(`${api!.url}/api/nodes/${started.nodeId}`, { headers: { cookie } });
      if (res.ok) nodeRow = await res.json();
      if (nodeRow.status === 'running' && nodeRow.lastHeartbeatAt) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(nodeRow).toMatchObject({ status: 'running' });
    expect(nodeRow.lastHeartbeatAt).toBeTruthy();

    const health = await fetch(`${started.agentUrl}/health`);
    expect(health.status).toBe(200);
    const ports = execFileSync('docker', ['port', node!.driver.nodeName]).toString().trim();
    expect(ports.split('\n').every((line) => line.includes('127.0.0.1:'))).toBe(true);
  });
});
