/**
 * T003 feasibility gate: workspace container -> SAM model gateway -> host-local Ollama,
 * with Ollama bound to loopback only and the gateway bound to a private interface.
 *
 * Requires: Docker engine, Ollama listening on 127.0.0.1:11434 with SAM_FEASIBILITY_MODEL pulled.
 * On Linux the private interface is the SAM Docker network gateway address. On Windows Docker
 * Desktop/WSL2 the gateway binds 127.0.0.1 and workspaces reach it via `host-gateway`; that
 * variant and the second-LAN-device check must be run on Windows (see quickstart.md).
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  GatewayTokenStore,
  type RunningModelGateway,
  startModelGateway,
} from '../../src/main/model-gateway';

const run = promisify(execFile);
const OLLAMA = process.env.SAM_FEASIBILITY_OLLAMA_URL ?? 'http://127.0.0.1:11434';
const MODEL = process.env.SAM_FEASIBILITY_MODEL ?? 'qwen2.5:0.5b';
const IMAGE = process.env.SAM_FEASIBILITY_IMAGE ?? 'alpine:3.20';
const DIND_IMAGE =
  process.env.SAM_FEASIBILITY_DIND_IMAGE ?? 'public.ecr.aws/docker/library/docker:dind';
const suffix = randomBytes(4).toString('hex');
const NETWORK = `sam-feasibility-${suffix}`;
const LABEL = `sam.feasibility=${suffix}`;

let gateway: RunningModelGateway;
let gatewayIp: string;
let tokens: GatewayTokenStore;
let token: string;

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await run('docker', args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

/** Runs a shell snippet in a throwaway workspace-like container on the SAM network. */
async function inWorkspace(script: string): Promise<{ code: number; out: string }> {
  try {
    const out = await docker(
      'run',
      '--rm',
      '--label',
      LABEL,
      '--network',
      NETWORK,
      '--add-host',
      `sam-model-gateway:${gatewayIp}`,
      IMAGE,
      'sh',
      '-c',
      script
    );
    return { code: 0, out };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      out: `${e.stdout ?? ''}${e.stderr ?? ''}`,
    };
  }
}

function lanAddresses(): string[] {
  return Object.entries(networkInterfaces())
    .filter(([name]) => !/^(lo|docker|br-|veth)/.test(name))
    .flatMap(([, addrs]) => addrs ?? [])
    .filter((a) => a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 1500 });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

beforeAll(async () => {
  const tags = (await (await fetch(`${OLLAMA}/api/tags`)).json()) as {
    models: Array<{ name: string }>;
  };
  expect(tags.models.map((m) => m.name)).toContain(MODEL);
  await docker('network', 'create', '--label', LABEL, NETWORK);
  gatewayIp = await docker(
    'network',
    'inspect',
    NETWORK,
    '-f',
    '{{(index .IPAM.Config 0).Gateway}}'
  );
  tokens = new GatewayTokenStore();
  token = tokens.issue('ws-feasibility', 'conn-ollama', 10 * 60 * 1000).token;
  gateway = await startModelGateway({
    host: gatewayIp,
    tokens,
    resolveUpstream: async (connectionId) =>
      connectionId === 'conn-ollama'
        ? { connectionId, baseUrl: OLLAMA, allowedModelIds: [MODEL] }
        : null,
  });
});

afterAll(async () => {
  await gateway?.close();
  const ids = await docker('ps', '-aq', '--filter', `label=${LABEL}`).catch(() => '');
  if (ids) await docker('rm', '-f', ...ids.split('\n')).catch(() => '');
  await docker('network', 'rm', NETWORK).catch(() => '');
});

describe('T003 private workspace -> gateway -> Ollama path', () => {
  it('Ollama itself listens on loopback only', async () => {
    for (const ip of [...lanAddresses(), gatewayIp]) {
      expect(await canConnect(ip, 11434)).toBe(false);
    }
  });

  it('workspace lists the scoped model through the gateway', async () => {
    const r = await inWorkspace(
      `wget -qO- --header "Authorization: Bearer ${token}" http://sam-model-gateway:${gateway.port}/local-model/v1/models`
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).data.map((m: { id: string }) => m.id)).toEqual([MODEL]);
  });

  it('workspace receives a streamed completion from Ollama through the gateway', async () => {
    const body = JSON.stringify({
      model: MODEL,
      stream: true,
      messages: [{ role: 'user', content: 'Reply with the word ready.' }],
    });
    const r = await inWorkspace(
      `wget -qO- --header "Authorization: Bearer ${token}" --header "Content-Type: application/json" --post-data '${body}' http://sam-model-gateway:${gateway.port}/local-model/v1/chat/completions`
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain('data: ');
    expect(r.out).toContain('[DONE]');
  });

  it('workspace without a token is rejected', async () => {
    const r = await inWorkspace(
      `wget -qO- http://sam-model-gateway:${gateway.port}/local-model/v1/models; echo "exit=$?"`
    );
    expect(r.out).toMatch(/401|exit=1/);
  });

  it('workspace cannot reach Ollama directly on the host', async () => {
    const r = await inWorkspace(
      `wget -T 3 -qO- http://sam-model-gateway:11434/api/tags && echo REACHED || echo BLOCKED`
    );
    expect(r.out).toContain('BLOCKED');
  });

  it('gateway is not reachable on LAN-facing addresses', async () => {
    const lan = lanAddresses();
    expect(lan.length).toBeGreaterThan(0);
    for (const ip of lan) expect(await canConnect(ip, gateway.port)).toBe(false);
    expect(await canConnect('127.0.0.1', gateway.port)).toBe(false);
  });

  it('nested Docker (docker:dind) inside a workspace can reach the gateway without a published Docker API', async () => {
    const present = await docker('image', 'inspect', DIND_IMAGE).then(
      () => true,
      () => false
    );
    if (!present) {
      console.warn(`skipping nested-Docker check; image ${DIND_IMAGE} not present`);
      return;
    }
    const name = `sam-feasibility-dind-${suffix}`;
    await docker(
      'run',
      '-d',
      '--privileged',
      '--name',
      name,
      '--label',
      LABEL,
      '--network',
      NETWORK,
      '--add-host',
      `sam-model-gateway:${gatewayIp}`,
      '-e',
      'DOCKER_TLS_CERTDIR=',
      DIND_IMAGE
    );
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (
        await docker('exec', name, 'docker', 'info').then(
          () => true,
          () => false
        )
      )
        break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    // Inner daemon socket stays inside the workspace container; nothing is published on the host.
    expect(await docker('port', name)).toBe('');
    const out = await docker(
      'exec',
      name,
      'sh',
      '-c',
      `wget -qO- --header "Authorization: Bearer ${token}" http://sam-model-gateway:${gateway.port}/local-model/v1/models`
    );
    expect(JSON.parse(out).data[0].id).toBe(MODEL);
  });
});
