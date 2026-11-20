/**
 * Starts the installation's local node agent (spec 036 US2).
 *
 * 1. Ensure the labeled private Docker network.
 * 2. Start the control relay where only that network can reach it.
 * 3. Register the node with the local API (bootstrap secret) to get its callback token.
 * 4. Run the node agent container with its port published on loopback only.
 */
import { statfs } from 'node:fs/promises';

import { type RunningControlRelay, startControlRelay } from '../control-relay.js';
import { LOCAL_BASE_DOMAIN } from '../local-runtime-config.js';
import { type CleanupReport, type DockerDesktopDriver } from './docker-desktop.js';

export const NODE_AGENT_CONTAINER_PORT = 8443;
export const DEFAULT_LOCAL_NODE_IMAGE = 'sam-local-node:dev';

export interface LocalNodeOptions {
  apiUrl: string;
  bootstrapSecret: string;
  image: string;
  /** Loopback host port for the node agent (the API's LOCAL_VM_AGENT_PORT). */
  hostPort: number;
  /** Folder tree that local projects may live in, as Docker sees it. */
  projectsRoot: string;
  platform?: NodeJS.Platform;
  fetchImpl?: typeof fetch;
  startRelay?: typeof startControlRelay;
  statDisk?: (path: string) => Promise<{ bavail: number; bsize: number }>;
}

/**
 * Docker Desktop (Windows/macOS) forwards `host.docker.internal` to host loopback, so the relay
 * stays on 127.0.0.1. On Linux the relay binds the private network's gateway address instead.
 */
export function relayPlacement(
  platform: NodeJS.Platform,
  gateway: string
): { bindHost: string; containerHost: string } {
  return platform === 'linux'
    ? { bindHost: gateway, containerHost: gateway }
    : { bindHost: '127.0.0.1', containerHost: 'host.docker.internal' };
}

/** Folder tree Docker Desktop exposes for local projects on this platform. */
export function defaultProjectsRoot(platform: NodeJS.Platform, home: string): string {
  return platform === 'win32' ? '/run/desktop/mnt/host' : home;
}

export class LocalNode {
  private relay?: RunningControlRelay;
  nodeId?: string;

  constructor(readonly driver: DockerDesktopDriver) {}

  async start(options: LocalNodeOptions): Promise<{ nodeId: string; agentUrl: string }> {
    const platform = options.platform ?? process.platform;
    await this.driver.ensureNetwork();
    const gateway = await this.driver.networkGateway();
    const placement = relayPlacement(platform, gateway);
    const apiPort = Number(new URL(options.apiUrl).port);
    await this.relay?.close();
    this.relay = await (options.startRelay ?? startControlRelay)({
      bindHost: placement.bindHost,
      privateNetworkHosts: [gateway],
      apiPort,
    });
    const relayPort = new URL(this.relay.url).port;

    const engine = await this.driver.engineResources();
    const disk = await (options.statDisk ?? statfs)(options.projectsRoot);
    const diskGb = Math.max(1, Math.floor((disk.bavail * disk.bsize) / 1024 ** 3));
    const response = await (options.fetchImpl ?? fetch)(`${options.apiUrl}/api/local/node`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${options.bootstrapSecret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...engine, diskGb }),
    });
    if (!response.ok) {
      throw new Error(
        `Local node registration failed (${response.status}): ${await response.text()}`
      );
    }
    const { nodeId, callbackToken } = (await response.json()) as {
      nodeId: string;
      callbackToken: string;
    };
    this.nodeId = nodeId;

    await this.driver.startNode({
      image: options.image,
      hostPort: options.hostPort,
      agentPort: NODE_AGENT_CONTAINER_PORT,
      mounts: [`${options.projectsRoot}:${options.projectsRoot}`],
      env: {
        CONTROL_PLANE_URL: `http://${placement.containerHost}:${relayPort}`,
        NODE_ID: nodeId,
        CALLBACK_TOKEN: callbackToken,
        LOCAL_PROJECTS_ROOT: options.projectsRoot,
        VM_AGENT_PORT: String(NODE_AGENT_CONTAINER_PORT),
        // The relay is plain http on a private network; the agent only allows that when opted in.
        SAM_LOCAL_DESKTOP: 'true',
        SAM_CONTAINER_LABELS: `sam.installation=${this.driver.installationId}`,
        JWT_ISSUER: `https://api.${LOCAL_BASE_DOMAIN}`,
      },
    });
    return { nodeId, agentUrl: `http://127.0.0.1:${options.hostPort}` };
  }

  /** Stops the node and relay; workspaces stay so they can be resumed. */
  async stop(): Promise<void> {
    await this.driver.stopNode().catch(() => undefined);
    await this.relay?.close();
    this.relay = undefined;
  }

  async removeAll(): Promise<CleanupReport> {
    await this.stop();
    return this.driver.removeAll();
  }
}
