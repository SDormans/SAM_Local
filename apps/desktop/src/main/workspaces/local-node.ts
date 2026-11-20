/**
 * Starts the installation's local node agent (spec 036 US2).
 *
 * 1. Ensure the labeled private Docker network.
 * 2. Start the control relay where only that network can reach it.
 * 3. Register the node with the local API (bootstrap secret) to get its callback token.
 * 4. Run the node agent container with its port published on loopback only.
 */
import { statfs } from 'node:fs/promises';
import { homedir } from 'node:os';

import { type RunningControlRelay, startControlRelay } from '../control-relay.js';
import { LOCAL_BASE_DOMAIN } from '../local-runtime-config.js';
import { type RunningModelGateway, startModelGateway } from '../model-gateway.js';
import { type CleanupReport, type DockerDesktopDriver } from './docker-desktop.js';
import {
  createWorkspaceTokenAuthorizer,
  LOCAL_MODEL_CONNECTION_ID,
} from './workspace-token-authorizer.js';

export const NODE_AGENT_CONTAINER_PORT = 8443;
export const DEFAULT_LOCAL_NODE_IMAGE = 'sam-local-node:dev';
export const DEFAULT_MODEL_SERVICE_URL = 'http://127.0.0.1:11434';

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
  startGateway?: typeof startModelGateway;
  /** Host-local OpenAI-compatible model service (Ollama). Chosen here, never by workspaces. */
  modelServiceUrl?: string;
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

/**
 * Host path whose free space stands in for workspace disk capacity. On Windows the projects root
 * is a path inside Docker Desktop's Linux VM, so probe the user's profile drive instead.
 */
export function diskProbePath(platform: NodeJS.Platform, projectsRoot: string): string {
  return platform === 'win32' ? homedir() : projectsRoot;
}

/** Folder tree Docker Desktop exposes for local projects on this platform. */
export function defaultProjectsRoot(platform: NodeJS.Platform, home: string): string {
  return platform === 'win32' ? '/run/desktop/mnt/host' : home;
}

export class LocalNode {
  private relay?: RunningControlRelay;
  private gateway?: RunningModelGateway;
  nodeId?: string;

  constructor(readonly driver: DockerDesktopDriver) {}

  async start(options: LocalNodeOptions): Promise<{ nodeId: string; agentUrl: string }> {
    const platform = options.platform ?? process.platform;
    await this.driver.ensureNetwork();
    const gateway = await this.driver.networkGateway();
    const placement = relayPlacement(platform, gateway);
    const apiPort = Number(new URL(options.apiUrl).port);
    await this.relay?.close();
    await this.gateway?.close();
    const modelServiceUrl = options.modelServiceUrl ?? DEFAULT_MODEL_SERVICE_URL;
    // Loopback only: workspaces reach it through the relay, which forwards just the model paths.
    this.gateway = await (options.startGateway ?? startModelGateway)({
      host: '127.0.0.1',
      authorize: createWorkspaceTokenAuthorizer({
        apiUrl: options.apiUrl,
        fetchImpl: options.fetchImpl,
      }),
      resolveUpstream: async (connectionId) =>
        connectionId === LOCAL_MODEL_CONNECTION_ID
          ? { connectionId, baseUrl: modelServiceUrl }
          : null,
    });
    this.relay = await (options.startRelay ?? startControlRelay)({
      bindHost: placement.bindHost,
      privateNetworkHosts: [gateway],
      apiPort,
      modelGatewayPort: this.gateway.port,
    });
    const relayPort = new URL(this.relay.url).port;

    const engine = await this.driver.engineResources();
    const disk = await (options.statDisk ?? statfs)(diskProbePath(platform, options.projectsRoot));
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
    await this.gateway?.close();
    this.gateway = undefined;
  }

  async removeAll(): Promise<CleanupReport> {
    await this.stop();
    return this.driver.removeAll();
  }
}
