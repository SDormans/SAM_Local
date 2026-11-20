/**
 * Supervises the local SAM services (spec 036 T013): data directory, migrations with backup,
 * the local API runtime, the local session, and prerequisite reporting. The reported state
 * always follows the supervised process, never an assumption that a step succeeded.
 */
import { EventEmitter } from 'node:events';
import { join } from 'node:path';

import {
  applyLocalMigrations,
  type LocalApiRuntimeOptions,
  type RunningLocalApi,
  startLocalApi,
  writeLocalRuntimeFiles,
} from './local-api-runtime.js';
import { type InstallationRecord, latestMigrationVersion, LocalDataStore } from './local-data.js';
import type { LocalPrerequisites } from './prerequisites.js';
import { loadOrCreateRuntimeSecrets, type LocalRuntimeSecrets } from './runtime-secrets.js';

export type ServiceState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';

export interface SupervisorStatus {
  state: ServiceState;
  url?: string;
  installationId?: string;
  error?: string;
}

export interface LocalSessionCookie {
  name: string;
  value: string;
  expiresAt: number;
}

export interface ServiceSupervisorOptions {
  apiDir: string;
  dataDir: string;
  port: number;
  webDistDir?: string;
  wranglerBin?: string;
  probePrerequisites: () => Promise<LocalPrerequisites>;
  startApi?: (options: LocalApiRuntimeOptions) => Promise<RunningLocalApi>;
  migrate?: typeof applyLocalMigrations;
  fetchImpl?: typeof fetch;
  onOutput?: (chunk: string) => void;
}

const ACTIVE_WORKSPACE_STATES = new Set(['pending', 'creating', 'running', 'recovery', 'stopping']);

function parseSessionCookie(setCookie: string | null): LocalSessionCookie {
  const match = /^sam_local_session=([0-9a-f]{64});/.exec(setCookie ?? '');
  const maxAge = /Max-Age=(\d+)/i.exec(setCookie ?? '');
  if (!match?.[1]) throw new Error('Local API did not issue a local session');
  return {
    name: 'sam_local_session',
    value: match[1],
    expiresAt: Date.now() + Number(maxAge?.[1] ?? 0) * 1000,
  };
}

export class ServiceSupervisor extends EventEmitter {
  private current: SupervisorStatus = { state: 'stopped' };
  private api: RunningLocalApi | undefined;
  private secrets: LocalRuntimeSecrets | undefined;
  private sessionCookie: LocalSessionCookie | undefined;
  private prerequisites: LocalPrerequisites | undefined;
  readonly store: LocalDataStore;

  constructor(private readonly options: ServiceSupervisorOptions) {
    super();
    this.store = new LocalDataStore(options.dataDir);
  }

  get status(): SupervisorStatus {
    return { ...this.current };
  }

  get session(): LocalSessionCookie | undefined {
    return this.sessionCookie;
  }

  /** Last prerequisite probe result, used to route first run to setup. */
  get lastPrerequisites(): LocalPrerequisites | undefined {
    return this.prerequisites;
  }

  private setStatus(status: SupervisorStatus): void {
    this.current = status;
    this.emit('status', this.status);
  }

  private fetch(input: string, init?: RequestInit): Promise<Response> {
    return (this.options.fetchImpl ?? fetch)(input, init);
  }

  async start(): Promise<SupervisorStatus> {
    if (this.current.state === 'running' || this.current.state === 'starting') return this.status;
    this.setStatus({ state: 'starting' });
    let installation: InstallationRecord | undefined;
    try {
      installation = await this.store.init();
      const secrets = await loadOrCreateRuntimeSecrets(join(this.store.runtimeDir, 'secrets.json'));
      this.secrets = secrets;
      const runtime: LocalApiRuntimeOptions = {
        apiDir: this.options.apiDir,
        store: this.store,
        installation,
        secrets,
        port: this.options.port,
        wranglerBin: this.options.wranglerBin,
        webDistDir: this.options.webDistDir,
        onOutput: this.options.onOutput,
      };
      const configPath = await writeLocalRuntimeFiles(runtime);
      const target = await latestMigrationVersion(join(this.options.apiDir, 'src/db/migrations'));
      const migrate = this.options.migrate ?? applyLocalMigrations;
      await this.store.upgrade(target, () => migrate(runtime, configPath));
      const api = await (this.options.startApi ?? startLocalApi)(runtime);
      this.api = api;
      void api.exited.then(() => this.onApiExit(api));
      this.sessionCookie = await this.bootstrapSession(api.url, secrets);
      await this.reportPrerequisites();
      this.setStatus({
        state: 'running',
        url: api.url,
        installationId: installation.installationId,
      });
    } catch (error) {
      await this.api?.stop().catch(() => undefined);
      this.api = undefined;
      this.setStatus({
        state: 'failed',
        installationId: installation?.installationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return this.status;
  }

  private onApiExit(api: RunningLocalApi): void {
    if (this.api !== api) return;
    this.api = undefined;
    if (this.current.state === 'stopping') return;
    this.setStatus({
      state: 'failed',
      installationId: this.current.installationId,
      error: 'The local SAM service stopped unexpectedly',
    });
  }

  private async bootstrapSession(
    url: string,
    secrets: LocalRuntimeSecrets
  ): Promise<LocalSessionCookie> {
    const response = await this.fetch(`${url}/api/local/session`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secrets.LOCAL_BOOTSTRAP_SECRET}` },
    });
    if (!response.ok) throw new Error(`Local session bootstrap failed (HTTP ${response.status})`);
    return parseSessionCookie(response.headers.get('set-cookie'));
  }

  /** Probes Docker Desktop/WSL2 and reports the result to the local API. */
  async reportPrerequisites(): Promise<LocalPrerequisites> {
    const prerequisites = await this.options.probePrerequisites();
    this.prerequisites = prerequisites;
    const url = this.api?.url;
    if (url && this.secrets) {
      const response = await this.fetch(`${url}/api/local/health/prerequisites`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${this.secrets.LOCAL_BOOTSTRAP_SECRET}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(prerequisites),
      });
      if (!response.ok) throw new Error(`Prerequisite report failed (HTTP ${response.status})`);
    }
    return prerequisites;
  }

  /** Number of workspaces the local API reports as active (used for the close decision). */
  async activeWorkCount(): Promise<number> {
    const url = this.api?.url;
    if (!url || !this.sessionCookie) return 0;
    const response = await this.fetch(`${url}/api/workspaces`, {
      headers: { cookie: `${this.sessionCookie.name}=${this.sessionCookie.value}` },
    });
    if (!response.ok) throw new Error(`Could not read active work (HTTP ${response.status})`);
    const body: unknown = await response.json();
    const list = Array.isArray(body) ? body : [];
    return list.filter(
      (w) =>
        typeof w === 'object' &&
        w !== null &&
        ACTIVE_WORKSPACE_STATES.has(String((w as { status?: unknown }).status))
    ).length;
  }

  async stop(): Promise<SupervisorStatus> {
    const api = this.api;
    if (!api) {
      if (this.current.state !== 'failed') this.setStatus({ state: 'stopped' });
      return this.status;
    }
    this.setStatus({ ...this.current, state: 'stopping' });
    try {
      await api.stop();
      this.api = undefined;
      this.sessionCookie = undefined;
      this.setStatus({ state: 'stopped', installationId: this.current.installationId });
    } catch (error) {
      this.setStatus({
        state: 'failed',
        installationId: this.current.installationId,
        url: api.url,
        error: `SAM could not stop the local service: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    return this.status;
  }
}
