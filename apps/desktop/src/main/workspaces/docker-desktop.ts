/**
 * Docker Desktop lifecycle adapter for local workspaces (spec 036 T020).
 *
 * Every container, volume and network SAM creates carries `sam.installation=<id>`, and
 * workspace resources also carry `sam.workspace=<id>`. Recovery and cleanup only touch
 * resources selected by those labels; unrelated Docker resources are never pruned.
 */
import { execFile } from 'node:child_process';

export const LABEL_INSTALLATION = 'sam.installation';
export const LABEL_WORKSPACE = 'sam.workspace';
export const LABEL_ROLE = 'sam.role';

export type DockerRunner = (args: string[]) => Promise<string>;

export type DockerErrorCode =
  'docker-missing' | 'docker-stopped' | 'insufficient-disk' | 'docker-failed';

export class DockerLifecycleError extends Error {
  constructor(
    readonly code: DockerErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'DockerLifecycleError';
  }
}

const FIX: Record<DockerErrorCode, string> = {
  'docker-missing': 'Install Docker Desktop with the WSL2 backend, then retry.',
  'docker-stopped': 'Start Docker Desktop, then retry.',
  'insufficient-disk': 'Free disk space for Docker Desktop (Settings > Resources), then retry.',
  'docker-failed': 'Check Docker Desktop, then retry.',
};

export function classifyDockerError(error: unknown): DockerLifecycleError {
  if (error instanceof DockerLifecycleError) return error;
  const text = error instanceof Error ? error.message : String(error);
  const code: DockerErrorCode =
    /spawn docker ENOENT|docker: (command )?not found|is not recognized/i.test(text)
      ? 'docker-missing'
      : /cannot connect to the docker daemon|docker daemon is not running|pipe.*docker_engine/i.test(
            text
          )
        ? 'docker-stopped'
        : /no space left on device|disk quota exceeded/i.test(text)
          ? 'insufficient-disk'
          : 'docker-failed';
  return new DockerLifecycleError(code, `${FIX[code]} (${text.trim().split('\n')[0]})`);
}

export function execDocker(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message}\n${stderr}`));
      else resolve(stdout);
    });
  });
}

export interface NodeContainerOptions {
  image: string;
  /** Loopback port on the host that maps to the node agent's port. */
  hostPort: number;
  agentPort: number;
  env: Record<string, string>;
  /** Extra bind mounts, `source:target[:mode]`. */
  mounts?: string[];
  /** Overrides the image's default command. */
  command?: string[];
}

export interface CleanupReport {
  removed: string[];
  failed: Array<{ resource: string; error: string }>;
  /** True only when every selected resource was confirmed removed. */
  complete: boolean;
}

export class DockerDesktopDriver {
  readonly network: string;
  readonly nodeName: string;

  constructor(
    readonly installationId: string,
    private readonly docker: DockerRunner = execDocker
  ) {
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(installationId)) {
      throw new Error('Installation id must be 1-64 letters, digits or dashes');
    }
    this.network = `sam-local-${installationId}`;
    this.nodeName = `sam-node-${installationId}`;
  }

  private async run(args: string[]): Promise<string> {
    try {
      return await this.docker(args);
    } catch (error) {
      throw classifyDockerError(error);
    }
  }

  private installationLabel(): string {
    return `${LABEL_INSTALLATION}=${this.installationId}`;
  }

  async ensureNetwork(): Promise<void> {
    const existing = await this.run([
      'network',
      'ls',
      '--filter',
      `label=${this.installationLabel()}`,
      '--format',
      '{{.Name}}',
    ]);
    if (existing.split('\n').includes(this.network)) return;
    await this.run([
      'network',
      'create',
      '--label',
      this.installationLabel(),
      '--label',
      `${LABEL_ROLE}=network`,
      this.network,
    ]);
  }

  /** Gateway address of the private network, where SAM-owned relays listen. */
  async networkGateway(): Promise<string> {
    const out = await this.run([
      'network',
      'inspect',
      this.network,
      '--format',
      '{{range .IPAM.Config}}{{.Gateway}} {{end}}',
    ]);
    const gateway = out
      .trim()
      .split(/\s+/)
      .find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
    if (!gateway) throw new DockerLifecycleError('docker-failed', 'Private network has no gateway');
    return gateway;
  }

  async nodeState(): Promise<'running' | 'stopped' | 'missing'> {
    const out = await this.run([
      'ps',
      '-a',
      '--filter',
      `label=${this.installationLabel()}`,
      '--filter',
      `label=${LABEL_ROLE}=node`,
      '--format',
      '{{.State}}',
    ]);
    const state = out.trim().split('\n')[0];
    if (!state) return 'missing';
    return state === 'running' ? 'running' : 'stopped';
  }

  /** Starts the node agent container; its port is published on loopback only. */
  async startNode(options: NodeContainerOptions): Promise<void> {
    await this.ensureNetwork();
    const state = await this.nodeState();
    if (state === 'running') return;
    if (state === 'stopped') {
      await this.run(['start', this.nodeName]);
      return;
    }
    const args = [
      'run',
      '-d',
      '--name',
      this.nodeName,
      '--label',
      this.installationLabel(),
      '--label',
      `${LABEL_ROLE}=node`,
      '--network',
      this.network,
      '--restart',
      'no',
      '-p',
      `127.0.0.1:${options.hostPort}:${options.agentPort}`,
      '-v',
      '/var/run/docker.sock:/var/run/docker.sock',
    ];
    for (const mount of options.mounts ?? []) args.push('-v', mount);
    for (const [key, value] of Object.entries(options.env)) args.push('-e', `${key}=${value}`);
    args.push(options.image, ...(options.command ?? []));
    await this.run(args);
  }

  async stopNode(): Promise<void> {
    if ((await this.nodeState()) === 'running') await this.run(['stop', this.nodeName]);
  }

  private async listIds(kind: 'container' | 'volume', labels: string[]): Promise<string[]> {
    const filters = labels.flatMap((label) => ['--filter', `label=${label}`]);
    const args =
      kind === 'container'
        ? ['ps', '-a', ...filters, '--format', '{{.ID}}']
        : ['volume', 'ls', ...filters, '--format', '{{.Name}}'];
    return (await this.run(args)).split('\n').filter(Boolean);
  }

  private async remove(selection: string[], includeNetwork: boolean): Promise<CleanupReport> {
    const report: CleanupReport = { removed: [], failed: [], complete: true };
    const attempt = async (resource: string, args: string[]) => {
      try {
        await this.run(args);
        report.removed.push(resource);
      } catch (error) {
        report.failed.push({ resource, error: (error as Error).message });
      }
    };
    for (const id of await this.listIds('container', selection)) {
      await attempt(`container:${id}`, ['rm', '-f', '-v', id]);
    }
    for (const name of await this.listIds('volume', selection)) {
      await attempt(`volume:${name}`, ['volume', 'rm', '-f', name]);
    }
    if (includeNetwork) {
      const networks = (
        await this.run([
          'network',
          'ls',
          '--filter',
          `label=${this.installationLabel()}`,
          '--format',
          '{{.Name}}',
        ])
      )
        .split('\n')
        .filter(Boolean);
      for (const name of networks) await attempt(`network:${name}`, ['network', 'rm', name]);
    }
    // Verify instead of trusting exit codes, so the report is truthful.
    const left = [
      ...(await this.listIds('container', selection)).map((id) => `container:${id}`),
      ...(await this.listIds('volume', selection)).map((name) => `volume:${name}`),
    ];
    for (const resource of left) {
      if (!report.failed.some((f) => f.resource === resource)) {
        report.failed.push({ resource, error: 'Still present after removal' });
      }
    }
    report.complete = report.failed.length === 0;
    return report;
  }

  /** Removes one workspace's containers and volumes. */
  removeWorkspace(workspaceId: string): Promise<CleanupReport> {
    return this.remove([this.installationLabel(), `${LABEL_WORKSPACE}=${workspaceId}`], false);
  }

  /** Removes everything this installation created (uninstall "delete" path). */
  removeAll(): Promise<CleanupReport> {
    return this.remove([this.installationLabel()], true);
  }
}
