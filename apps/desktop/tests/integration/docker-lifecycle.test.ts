import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import {
  classifyDockerError,
  DockerDesktopDriver,
  execDocker,
  LABEL_INSTALLATION,
  LABEL_WORKSPACE,
} from '../../src/main/workspaces/docker-desktop';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    execFileSync('docker', ['image', 'inspect', 'alpine:latest'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('classifyDockerError', () => {
  it('maps Docker failures to actionable codes', () => {
    expect(classifyDockerError(new Error('spawn docker ENOENT')).code).toBe('docker-missing');
    expect(classifyDockerError(new Error('exec: "x": executable file not found')).code).toBe(
      'docker-failed'
    );
    expect(
      classifyDockerError(
        new Error('Cannot connect to the Docker daemon at unix:///var/run/docker.sock')
      ).code
    ).toBe('docker-stopped');
    expect(classifyDockerError(new Error('write /x: no space left on device')).code).toBe(
      'insufficient-disk'
    );
    const other = classifyDockerError('weird');
    expect(other.code).toBe('docker-failed');
    expect(classifyDockerError(other)).toBe(other);
  });

  it('rejects unsafe installation ids and reports failures through the driver', async () => {
    expect(() => new DockerDesktopDriver('bad id;rm')).toThrow(/Installation id/);
    const driver = new DockerDesktopDriver('abc', async () => {
      throw new Error('Cannot connect to the Docker daemon');
    });
    await expect(driver.nodeState()).rejects.toMatchObject({ code: 'docker-stopped' });
  });
});

describe.runIf(dockerAvailable())('DockerDesktopDriver (real Docker)', () => {
  const id = `t${randomBytes(4).toString('hex')}`;
  const driver = new DockerDesktopDriver(id);
  const unrelated = `unrelated-${id}`;
  const docker = (...args: string[]) => execDocker(args).then((out) => out.trim());

  afterAll(async () => {
    await driver.removeAll().catch(() => undefined);
    await docker('rm', '-f', unrelated).catch(() => undefined);
  });

  it('runs the node on a labeled private network with a loopback-only port', async () => {
    await driver.startNode({
      image: 'alpine:latest',
      hostPort: 0,
      agentPort: 8080,
      env: { NODE_ID: id },
      command: ['sleep', '300'],
    });
    expect(await driver.nodeState()).toBe('running');
    await driver.startNode({ image: 'alpine:latest', hostPort: 0, agentPort: 8080, env: {} });
    const ports = await docker('port', driver.nodeName, '8080/tcp');
    expect(ports.split('\n').every((line) => line.startsWith('127.0.0.1:'))).toBe(true);
    expect(
      await docker('inspect', driver.nodeName, '--format', '{{json .Config.Labels}}')
    ).toContain(`"${LABEL_INSTALLATION}":"${id}"`);
    expect(await driver.networkGateway()).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    const engine = await driver.engineResources();
    expect(engine.vcpuCount).toBeGreaterThan(0);
    expect(engine.memoryMb).toBeGreaterThan(0);
    await driver.stopNode();
    expect(await driver.nodeState()).toBe('stopped');
    await driver.startNode({ image: 'alpine:latest', hostPort: 0, agentPort: 8080, env: {} });
    expect(await driver.nodeState()).toBe('running');
  }, 60_000);

  it('removes only labeled workspace resources and reports cleanup truthfully', async () => {
    const ws = 'ws1';
    const labels = [
      '--label',
      `${LABEL_INSTALLATION}=${id}`,
      '--label',
      `${LABEL_WORKSPACE}=${ws}`,
    ];
    await docker('volume', 'create', ...labels, `sam-ws-${id}`);
    await docker('run', '-d', ...labels, '-v', `sam-ws-${id}:/w`, 'alpine:latest', 'sleep', '300');
    await docker('run', '-d', '--name', unrelated, 'alpine:latest', 'sleep', '300');

    const report = await driver.removeWorkspace(ws);
    expect(report).toMatchObject({ complete: true, failed: [] });
    expect(report.removed.some((r) => r.startsWith('container:'))).toBe(true);
    expect(report.removed).toContain(`volume:sam-ws-${id}`);
    expect(await driver.nodeState()).toBe('running');
    expect(await docker('inspect', unrelated, '--format', '{{.State.Running}}')).toBe('true');

    const all = await driver.removeAll();
    expect(all.complete).toBe(true);
    expect(all.removed).toContain(`network:${driver.network}`);
    expect(await driver.nodeState()).toBe('missing');
    expect(await docker('inspect', unrelated, '--format', '{{.State.Running}}')).toBe('true');
  }, 60_000);
});
