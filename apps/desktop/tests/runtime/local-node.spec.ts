/**
 * Spec 036 US2: the real local API plus the real node agent image under Docker. Proves the
 * node registers, reaches the API only through the private-network relay, and reports ready.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const MODEL = process.env.SAM_TEST_OLLAMA_MODEL ?? 'qwen2.5:0.5b';

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
let nodeId = '';
let sessionCookie = '';
let localProjectId = '';
let demoWorkspaceId = '';
let localNodeId = '';

describe.runIf(imageAvailable())('local node agent', () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'sam-local-node-'));
    const store = new LocalDataStore(root);
    const installation = await store.init();
    secrets = await loadOrCreateRuntimeSecrets(join(store.runtimeDir, 'secrets.json'));
    const runtime = {
      apiDir,
      store,
      installation,
      secrets,
      port: PORT,
      nodeAgentPort: NODE_PORT,
      localDefaultModel: MODEL,
    };
    const configPath = await writeLocalRuntimeFiles(runtime);
    const target = await latestMigrationVersion(join(apiDir, 'src/db/migrations'));
    await store.upgrade(target, () => applyLocalMigrations(runtime, configPath));
    api = await startLocalApi(runtime);
    node = new LocalNode(new DockerDesktopDriver(`rt${randomBytes(4).toString('hex')}`));
  });

  afterAll(async () => {
    const report = await node?.removeAll();
    expect(report?.complete).toBe(true);
    // Workspace containers created by the devcontainer CLI must carry the installation label.
    const stray = execFileSync('docker', [
      'ps',
      '-a',
      '--filter',
      'label=devcontainer.local_folder',
      '--format',
      '{{.Label "devcontainer.local_folder"}}',
    ])
      .toString()
      .split('\n')
      .filter((folder) => folder.startsWith(root));
    expect(stray).toEqual([]);
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
    nodeId = started.nodeId;
    sessionCookie = cookie;
  });

  it('creates a workspace for a local folder on the local node', async () => {
    const folder = join(root, 'demo');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'README.md'), '# demo\n');
    const headers = { cookie: sessionCookie, 'content-type': 'application/json' };
    const project = await fetch(`${api!.url}/api/projects`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'demo', repoProvider: 'local', localPath: folder }),
    });
    expect(project.status).toBe(201);
    const { id: projectId } = await project.json();
    localProjectId = projectId;
    localNodeId = nodeId;
    const created = await fetch(`${api!.url}/api/workspaces`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'demo-ws', projectId, nodeId }),
    });
    const createdBody = await created.text();
    expect(created.status, createdBody).toBeLessThan(300);
    const workspaceId = JSON.parse(createdBody).id as string;
    demoWorkspaceId = workspaceId;

    let ws: { status?: string; errorMessage?: string | null } = {};
    for (let i = 0; i < 150; i++) {
      const res = await fetch(`${api!.url}/api/workspaces/${workspaceId}`, { headers });
      if (res.ok) ws = await res.json();
      if (ws.status === 'running' || ws.status === 'error') break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(ws, JSON.stringify(ws)).toMatchObject({ status: 'running' });
  });

  it('runs an OpenCode task on the local model through the SAM gateway', async () => {
    const headers = { cookie: sessionCookie, 'content-type': 'application/json' };
    for (let i = 0; i < 45; i++) {
      const res = await fetch(`${api!.url}/api/nodes/${localNodeId}`, { headers });
      if (res.ok && (await res.json()).lastMetrics) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    const submittedAt = Date.now();
    const submitted = await fetch(`${api!.url}/api/projects/${localProjectId}/tasks/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        message: 'Reply with the single word: pong',
        // No nodeId: local-runtime tasks default to this computer's node.
        agentType: 'opencode',
        taskMode: 'conversation',
      }),
    });
    const submittedBody = await submitted.text();
    expect(submitted.status, submittedBody).toBeLessThan(300);
    const { taskId, sessionId } = JSON.parse(submittedBody) as {
      taskId: string;
      sessionId: string;
    };

    let transcript = '';
    let task: { status?: string; errorMessage?: string | null } = {};
    for (let i = 0; i < 180; i++) {
      const messages = await fetch(
        `${api!.url}/api/projects/${localProjectId}/sessions/${sessionId}/messages`,
        { headers }
      );
      if (messages.ok) transcript = await messages.text();
      if (transcript.includes('"role":"assistant"')) break;
      const taskRes = await fetch(`${api!.url}/api/projects/${localProjectId}/tasks/${taskId}`, {
        headers,
      });
      if (taskRes.ok) task = await taskRes.json();
      if (task.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    const node = await (await fetch(`${api!.url}/api/nodes/${localNodeId}`, { headers })).text();
    const nodeLogs = execFileSync('sh', [
      '-c',
      'docker logs --tail 60 $(docker ps -aq --filter label=sam.role=node | head -1) 2>&1 | grep -iE "heartbeat|metric|error" | tail -20',
    ]).toString();
    expect(transcript, `${task.errorMessage ?? task.status}\n${node}\n${nodeLogs}`).toContain(
      '"role":"assistant"'
    );
    // The reply came from the host-local Ollama model, reached only through SAM's gateway.
    const ps = (await (await fetch('http://127.0.0.1:11434/api/ps')).json()) as {
      models: { name: string; expires_at: string }[];
    };
    const loaded = ps.models.find((m) => m.name === MODEL);
    expect(loaded, JSON.stringify(ps)).toBeDefined();
    expect(Date.parse(loaded!.expires_at)).toBeGreaterThan(submittedAt);
  });

  it('runs Docker inside a repository devcontainer that asks for it (nested Docker)', async () => {
    // Free the first workspace's reservation: each local workspace reserves disk on this host.
    const headersDel = { cookie: sessionCookie };
    const deleted = await fetch(`${api!.url}/api/workspaces/${demoWorkspaceId}`, {
      method: 'DELETE',
      headers: headersDel,
    });
    expect(deleted.status, await deleted.text()).toBeLessThan(300);
    for (let i = 0; i < 60; i++) {
      const res = await fetch(`${api!.url}/api/workspaces/${demoWorkspaceId}`, {
        headers: headersDel,
      });
      if (res.status === 404 || ['deleted', 'stopped'].includes((await res.json()).status)) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    const folder = join(root, 'nested');
    await mkdir(join(folder, '.devcontainer'), { recursive: true });
    await writeFile(
      join(folder, '.devcontainer', 'devcontainer.json'),
      JSON.stringify({
        image: 'mcr.microsoft.com/devcontainers/base:ubuntu',
        features: { 'ghcr.io/devcontainers/features/docker-in-docker:2': { moby: false } },
      })
    );
    const headers = { cookie: sessionCookie, 'content-type': 'application/json' };
    const project = await fetch(`${api!.url}/api/projects`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'nested', repoProvider: 'local', localPath: folder }),
    });
    expect(project.status).toBe(201);
    const { id: projectId } = await project.json();
    const created = await fetch(`${api!.url}/api/workspaces`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'nested-ws', projectId, nodeId }),
    });
    const createdBody = await created.text();
    expect(created.status, createdBody).toBeLessThan(300);
    const workspaceId = JSON.parse(createdBody).id as string;

    let ws: { status?: string; errorMessage?: string | null } = {};
    for (let i = 0; i < 300; i++) {
      const res = await fetch(`${api!.url}/api/workspaces/${workspaceId}`, { headers });
      if (res.ok) ws = await res.json();
      if (['running', 'error', 'recovery'].includes(ws.status ?? '')) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    const nestedLogs =
      ws.status === 'running'
        ? ''
        : execFileSync('sh', [
            '-c',
            `docker logs $(docker ps -aq --filter label=sam.role=node | head -1) 2>&1 | grep -iE "error|fail|devcontainer" | tail -25`,
          ]).toString();
    expect(ws.status, nestedLogs).toBe('running');
    const container = execFileSync('docker', [
      'ps',
      '-q',
      '--filter',
      `label=sam.workspace=${workspaceId}`,
    ])
      .toString()
      .trim()
      .split('\n')[0]!;
    expect(container).not.toBe('');
    const out = execFileSync(
      'docker',
      ['exec', container, 'sh', '-c', 'docker run --rm alpine echo nested-ok'],
      { timeout: 300_000 }
    ).toString();
    expect(out).toContain('nested-ok');
  }, 900_000);
});
