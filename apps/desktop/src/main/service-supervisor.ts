/**
 * Supervises the local SAM services (spec 036 T013): data directory, migrations with backup,
 * the local API runtime, the local session, and prerequisite reporting. The reported state
 * always follows the supervised process, never an assumption that a step succeeded.
 */
import { EventEmitter } from 'node:events';
import { join } from 'node:path';

import {
  CredentialStore,
  type RunningCredentialBroker,
  startCredentialBroker,
} from './credential-store.js';
import {
  applyLocalMigrations,
  type LocalApiRuntimeOptions,
  type RunningLocalApi,
  startLocalApi,
  writeLocalRuntimeFiles,
} from './local-api-runtime.js';
import { type InstallationRecord, latestMigrationVersion, LocalDataStore } from './local-data.js';
import type { LocalPrerequisites } from './prerequisites.js';
import {
  loadOrCreateRuntimeSecrets,
  type LocalRuntimeSecrets,
  type SecretProtector,
} from './runtime-secrets.js';

export type ServiceState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';

export interface SupervisorStatus {
  state: ServiceState;
  url?: string;
  installationId?: string;
  error?: string;
  /** Set when the service runs but local workspaces cannot start (for example Docker is down). */
  workspaceRuntimeError?: string;
}

export interface WorkspaceRuntimeContext {
  apiUrl: string;
  bootstrapSecret: string;
  installationId: string;
}

export interface RunningWorkspaceRuntime {
  stop(): Promise<void>;
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
  /** Loopback port the local node agent publishes (passed to the API as LOCAL_VM_AGENT_PORT). */
  nodeAgentPort?: number;
  localDefaultModel?: string;
  webDistDir?: string;
  wranglerBin?: string;
  probePrerequisites: () => Promise<LocalPrerequisites>;
  secretProtector?: SecretProtector;
  startApi?: (options: LocalApiRuntimeOptions) => Promise<RunningLocalApi>;
  migrate?: typeof applyLocalMigrations;
  fetchImpl?: typeof fetch;
  onOutput?: (chunk: string) => void;
  /** Starts the local node agent once the API is running; failures leave the API running. */
  startWorkspaceRuntime?: (context: WorkspaceRuntimeContext) => Promise<RunningWorkspaceRuntime>;
}

export const DEFAULT_SESSION_RENEW_MARGIN_MS = 10 * 60_000;
export const DEFAULT_SESSION_RENEW_MIN_MS = 60_000;
const MAX_TIMER_MS = 2_147_483_647;

export interface SessionRenewalTiming {
  /** Renew this long before expiry (env: SAM_LOCAL_SESSION_RENEW_MARGIN_MS). */
  marginMs?: number;
  /** Shortest wait, also the retry delay after a failed renewal (env: SAM_LOCAL_SESSION_RENEW_MIN_MS). */
  minMs?: number;
}

function positiveMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Reads renewal timing overrides from the environment. */
export function sessionRenewalTimingFromEnv(
  env: NodeJS.ProcessEnv
): Required<SessionRenewalTiming> {
  return {
    marginMs: positiveMs(env.SAM_LOCAL_SESSION_RENEW_MARGIN_MS, DEFAULT_SESSION_RENEW_MARGIN_MS),
    minMs: positiveMs(env.SAM_LOCAL_SESSION_RENEW_MIN_MS, DEFAULT_SESSION_RENEW_MIN_MS),
  };
}

/** How long to wait before renewing a local session that expires at `expiresAt`. */
export function sessionRenewalDelayMs(
  expiresAt: number,
  now: number = Date.now(),
  timing: SessionRenewalTiming = {}
): number {
  const marginMs = timing.marginMs ?? DEFAULT_SESSION_RENEW_MARGIN_MS;
  const minMs = timing.minMs ?? DEFAULT_SESSION_RENEW_MIN_MS;
  return Math.min(MAX_TIMER_MS, Math.max(minMs, expiresAt - now - marginMs));
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
  private credentialBroker: RunningCredentialBroker | undefined;
  private workspaceRuntime: RunningWorkspaceRuntime | undefined;
  private startup: Promise<SupervisorStatus> | undefined;
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
    if (this.current.state === 'running') return this.status;
    this.startup ??= this.runStartup().finally(() => {
      this.startup = undefined;
    });
    return this.startup;
  }

  private async runStartup(): Promise<SupervisorStatus> {
    this.setStatus({ state: 'starting' });
    let installation: InstallationRecord | undefined;
    try {
      installation = await this.store.init();
      const secrets = await loadOrCreateRuntimeSecrets(
        join(this.store.runtimeDir, 'secrets.json'),
        this.options.secretProtector
      );
      this.secrets = secrets;
      await this.credentialBroker?.stop();
      this.credentialBroker = await startCredentialBroker(
        new CredentialStore(
          join(this.store.runtimeDir, 'credentials.json'),
          this.options.secretProtector
        ),
        secrets.LOCAL_BOOTSTRAP_SECRET
      );
      const runtime: LocalApiRuntimeOptions = {
        apiDir: this.options.apiDir,
        store: this.store,
        installation,
        secrets,
        port: this.options.port,
        nodeAgentPort: this.options.nodeAgentPort,
        localDefaultModel: this.options.localDefaultModel,
        secretBrokerUrl: this.credentialBroker.url,
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
      if (this.api !== api) throw new Error('The local SAM service stopped unexpectedly');
      const workspaceRuntimeError = await this.startWorkspaceRuntime(
        api.url,
        secrets,
        installation.installationId
      );
      if (this.api !== api) throw new Error('The local SAM service stopped unexpectedly');
      this.setStatus({
        state: 'running',
        url: api.url,
        installationId: installation.installationId,
        ...(workspaceRuntimeError ? { workspaceRuntimeError } : {}),
      });
    } catch (error) {
      await this.stopWorkspaceRuntime();
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

  private async startWorkspaceRuntime(
    apiUrl: string,
    secrets: LocalRuntimeSecrets,
    installationId: string
  ): Promise<string | undefined> {
    if (!this.options.startWorkspaceRuntime) return undefined;
    try {
      this.workspaceRuntime = await this.options.startWorkspaceRuntime({
        apiUrl,
        bootstrapSecret: secrets.LOCAL_BOOTSTRAP_SECRET,
        installationId,
      });
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.onOutput?.(`Local workspaces unavailable: ${message}\n`);
      return `Local workspaces are unavailable: ${message}`;
    }
  }

  private async stopWorkspaceRuntime(): Promise<void> {
    const runtime = this.workspaceRuntime;
    this.workspaceRuntime = undefined;
    await runtime?.stop().catch((error: unknown) => {
      this.options.onOutput?.(`Local node stop failed: ${String(error)}\n`);
    });
  }

  /** Issues a fresh local session before the current one expires. */
  async renewSession(): Promise<LocalSessionCookie> {
    const api = this.api;
    if (!api || !this.secrets || this.current.state !== 'running') {
      throw new Error('The local SAM service is not running');
    }
    this.sessionCookie = await this.bootstrapSession(api.url, this.secrets);
    return this.sessionCookie;
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
    // "Check again" after Docker starts: bring up local workspaces without a restart.
    const installationId = this.current.installationId;
    if (
      prerequisites.dockerDesktop === 'ready' &&
      this.current.state === 'running' &&
      !this.workspaceRuntime &&
      url &&
      this.secrets &&
      installationId
    ) {
      const workspaceRuntimeError = await this.startWorkspaceRuntime(
        url,
        this.secrets,
        installationId
      );
      const next = { ...this.current };
      delete next.workspaceRuntimeError;
      this.setStatus(workspaceRuntimeError ? { ...next, workspaceRuntimeError } : next);
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
    // Let an in-flight startup settle so the process it spawns is stopped, not orphaned.
    if (this.startup) await this.startup;
    const api = this.api;
    if (!api) {
      // The API may have crashed; workspace containers can still be running.
      await this.stopWorkspaceRuntime();
      this.sessionCookie = undefined;
      this.setStatus({ state: 'stopped', installationId: this.current.installationId });
      return this.status;
    }
    this.setStatus({ ...this.current, state: 'stopping' });
    try {
      await this.stopWorkspaceRuntime();
      await api.stop();
      this.api = undefined;
      await this.credentialBroker?.stop();
      this.credentialBroker = undefined;
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
