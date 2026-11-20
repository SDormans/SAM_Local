import { describe, expect, it, vi } from 'vitest';

import type { DockerDesktopDriver } from '../../src/main/workspaces/docker-desktop';
import {
  defaultProjectsRoot,
  diskProbePath,
  LocalNode,
  relayPlacement,
} from '../../src/main/workspaces/local-node';

describe('local node placement', () => {
  it('binds the relay to the private gateway on Linux and loopback on Docker Desktop', () => {
    expect(relayPlacement('linux', '172.20.0.1')).toEqual({
      bindHost: '172.20.0.1',
      containerHost: '172.20.0.1',
    });
    expect(relayPlacement('win32', '172.20.0.1')).toEqual({
      bindHost: '127.0.0.1',
      containerHost: 'host.docker.internal',
    });
    expect(defaultProjectsRoot('win32', 'C:\\Users\\me')).toBe('/run/desktop/mnt/host');
    expect(defaultProjectsRoot('linux', '/home/me')).toBe('/home/me');
  });
});

describe('LocalNode', () => {
  function fakes(response: Response) {
    const driver = {
      ensureNetwork: vi.fn(async () => undefined),
      networkGateway: vi.fn(async () => '172.20.0.1'),
      engineResources: vi.fn(async () => ({ vcpuCount: 8, memoryMb: 16000 })),
      startNode: vi.fn(async () => undefined),
      stopNode: vi.fn(async () => undefined),
      stopWorkspaces: vi.fn(async () => undefined),
      removeAll: vi.fn(async () => ({ removed: [], failed: [], complete: true })),
    };
    const relay = { url: 'http://172.20.0.1:40001', close: vi.fn(async () => undefined) };
    return {
      driver,
      relay,
      node: new LocalNode(driver as unknown as DockerDesktopDriver),
      options: {
        apiUrl: 'http://127.0.0.1:8790',
        bootstrapSecret: 's3cret',
        image: 'sam-local-node:test',
        hostPort: 18443,
        projectsRoot: '/home/me',
        platform: 'linux' as const,
        fetchImpl: vi.fn(async () => response) as unknown as typeof fetch,
        startRelay: vi.fn(async () => relay),
        startGateway: vi.fn(async () => ({
          host: '127.0.0.1',
          port: 9911,
          close: vi.fn(async () => {}),
        })),
        statDisk: vi.fn(async () => ({ bavail: 50 * 1024 ** 2, bsize: 4096 })),
      },
    };
  }

  it('registers the node and starts it with relay, token and loopback port', async () => {
    const { node, driver, relay, options } = fakes(
      new Response(JSON.stringify({ nodeId: 'N1', callbackToken: 'a.b.c' }))
    );
    await expect(node.start(options)).resolves.toEqual({
      nodeId: 'N1',
      agentUrl: 'http://127.0.0.1:18443',
    });
    expect(options.startRelay).toHaveBeenCalledWith({
      bindHost: '172.20.0.1',
      privateNetworkHosts: ['172.20.0.1'],
      apiPort: 8790,
      modelGatewayPort: 9911,
    });
    expect(options.startGateway).toHaveBeenCalledWith(
      expect.objectContaining({ host: '127.0.0.1' })
    );
    expect(options.fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8790/api/local/node', {
      method: 'PUT',
      headers: { authorization: 'Bearer s3cret', 'content-type': 'application/json' },
      body: JSON.stringify({ vcpuCount: 8, memoryMb: 16000, diskGb: 200 }),
    });
    expect(driver.startNode).toHaveBeenCalledWith(
      expect.objectContaining({
        hostPort: 18443,
        mounts: ['/home/me:/home/me'],
        env: expect.objectContaining({
          CONTROL_PLANE_URL: 'http://172.20.0.1:40001',
          NODE_ID: 'N1',
          CALLBACK_TOKEN: 'a.b.c',
          LOCAL_PROJECTS_ROOT: '/home/me',
          SAM_LOCAL_DESKTOP: 'true',
          JWT_ISSUER: 'https://api.sam.localhost',
        }),
      })
    );
    const report = await node.removeAll();
    expect(report.complete).toBe(true);
    expect(driver.stopNode).toHaveBeenCalled();
    expect(driver.stopWorkspaces).toHaveBeenCalled();
    expect(relay.close).toHaveBeenCalled();
  });

  it('fails with the API response when registration is refused', async () => {
    const { node, driver, options } = fakes(new Response('nope', { status: 401 }));
    await expect(node.start(options)).rejects.toThrow(/registration failed \(401\): nope/);
    expect(driver.startNode).not.toHaveBeenCalled();
  });
});

describe('diskProbePath', () => {
  it('probes the host profile drive on Windows, where the projects root lives in the Docker VM', () => {
    expect(diskProbePath('win32', '/run/desktop/mnt/host')).not.toBe('/run/desktop/mnt/host');
    expect(diskProbePath('linux', '/home/me')).toBe('/home/me');
  });
});
