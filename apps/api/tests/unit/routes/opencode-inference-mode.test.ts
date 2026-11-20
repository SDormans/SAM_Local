/**
 * Spec 036 T024: in the desktop runtime, OpenCode's saved inference mode decides where model
 * requests go. 'local' uses the SAM model gateway; 'cloud' uses only a cloud credential.
 * Neither mode falls back to the other.
 */
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { workspacesRoutes } from '../../../src/routes/workspaces';
import { createAgentCredentialAttributionFixture } from '../../helpers/agent-credential-attribution-fixture';

vi.mock('drizzle-orm/d1');
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getUserId: () => 'test-user-id',
  getAuth: () => ({ userId: 'test-user-id' }),
}));
vi.mock('../../../src/services/jwt', () => ({
  verifyCallbackToken: vi
    .fn()
    .mockResolvedValue({ workspace: 'ws-123', type: 'callback', scope: 'workspace' }),
  signCallbackToken: vi.fn(),
}));
vi.mock('../../../src/services/encryption', () => ({
  encrypt: vi.fn(),
  decrypt: vi.fn(),
}));
vi.mock('../../../src/services/composable-credentials/resolve', () => ({
  resolveForConsumer: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../src/services/composable-credentials/lazy-backfill', () => ({
  lazyBackfillIfNeeded: vi.fn().mockResolvedValue(false),
}));

const { decrypt } = await import('../../../src/services/encryption');
const mockDecrypt = vi.mocked(decrypt);

describe('POST /workspaces/:id/agent-key — OpenCode inference mode', () => {
  let app: Hono<{ Bindings: Env }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockDB: any;
  let attribution: Awaited<ReturnType<typeof createAgentCredentialAttributionFixture>>;

  const mockEnv = {
    DATABASE: {} as D1Database,
    ENCRYPTION_KEY: 'test-key',
    JWT_PUBLIC_KEY: 'test-public-key',
    CALLBACK_TOKEN_AUDIENCE: 'test-audience',
    CALLBACK_TOKEN_ISSUER: 'test-issuer',
  } as unknown as Env;

  function postAgentKey(body: unknown): Promise<Response> {
    return app.request(
      '/api/workspaces/ws-123/agent-key',
      {
        method: 'POST',
        body: JSON.stringify(body),
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-callback-token',
        },
      },
      mockEnv
    );
  }

  // The workspace row carries no projectId, so the project-scoped credential
  // query is skipped. The user-scoped credential query consumes response #1
  // (after the workspace lookup) and the platform credential query consumes #2.
  function queueLimitResponses(...responses: unknown[][]): void {
    const queued = responses.slice(1); // Workspace identity reads use the real SQLite fixture.
    let workspaceRead = false;
    mockDB.select.mockImplementation((columns?: Record<string, unknown>) => {
      workspaceRead = Boolean(columns && 'workspaceId' in columns && 'nodeStatus' in columns);
      return mockDB;
    });
    mockDB.limit.mockImplementation(() =>
      workspaceRead
        ? [
            attribution.sqlite
              .prepare(
                `SELECT w.id AS workspaceId,w.user_id AS userId,w.project_id AS projectId,w.chat_session_id AS chatSessionId,w.status,w.node_id AS nodeId,n.status AS nodeStatus FROM workspaces w JOIN nodes n ON n.id=w.node_id WHERE w.id='ws-123'`
              )
              .get(),
          ]
        : (queued.shift() ?? [])
    );
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    mockDecrypt.mockReset();
    attribution = await createAgentCredentialAttributionFixture('ws-123', 'user-1');
    mockEnv.DATABASE = attribution.database;

    app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) => {
      const appError = err as {
        statusCode?: number;
        error?: string;
        message?: string;
      };
      if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
        return c.json(
          { error: appError.error, message: appError.message },
          appError.statusCode as 400 | 401 | 403 | 404 | 410 | 500
        );
      }
      return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
    });
    app.route('/api/workspaces', workspacesRoutes);

    mockDB = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn(),
    };
    vi.mocked(drizzle).mockReturnValue(mockDB as ReturnType<typeof drizzle>);
  });
  afterEach(() => attribution?.sqlite.close());

  const running = [
    { userId: 'user-1', status: 'running', nodeId: 'node-1', nodeStatus: 'running' },
  ];
  const noSavedConnection = { get: async () => null } as unknown as KVNamespace;
  const localEnv = {
    SAM_RUNTIME_MODE: 'local',
    LOCAL_DEFAULT_MODEL: 'qwen2.5:0.5b',
    KV: noSavedConnection,
  };

  afterEach(() => {
    for (const key of Object.keys(localEnv)) delete (mockEnv as Record<string, unknown>)[key];
  });

  it('routes local mode to the SAM model gateway', async () => {
    Object.assign(mockEnv, localEnv);
    queueLimitResponses(running, [{ inferenceMode: 'local' }]);
    const resp = await postAgentKey({ agentType: 'opencode' });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.providerMode).toBe('local-model-gateway');
    expect(body.inferenceConfig.model).toBe('qwen2.5:0.5b');
    expect(body.apiKey).toBe('');
  });

  it('fails local mode with an actionable error when no local model is configured', async () => {
    Object.assign(mockEnv, { SAM_RUNTIME_MODE: 'local', KV: noSavedConnection });
    queueLimitResponses(running, [{ inferenceMode: 'local' }]);
    const resp = await postAgentKey({ agentType: 'opencode' });
    expect(resp.status).toBe(400);
    expect((await resp.json()).message).toMatch(/no local model is configured/);
  });

  it('never falls back to the local model when cloud mode has no credential', async () => {
    Object.assign(mockEnv, localEnv);
    queueLimitResponses(running, [{ inferenceMode: 'cloud' }], [], []);
    const resp = await postAgentKey({ agentType: 'opencode' });
    expect(resp.status).toBe(404);
    const body = await resp.json();
    expect(body.providerMode).toBeUndefined();
    expect(body.message).toBe('Agent credential not found');
  });

  const cloudKey = [{ encryptedToken: 'enc', iv: 'iv', credentialKind: 'api-key', isActive: true }];

  it('cloud mode with a key returns only that key, never the gateway', async () => {
    Object.assign(mockEnv, localEnv);
    queueLimitResponses(running, [{ inferenceMode: 'cloud' }], cloudKey, running, running);
    mockDecrypt.mockResolvedValueOnce('cloud-opencode-key');
    const resp = await postAgentKey({ agentType: 'opencode' });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.apiKey).toBe('cloud-opencode-key');
    expect(body.providerMode).not.toBe('local-model-gateway');
    expect(body.inferenceConfig).toBeUndefined();
  });

  it('routes two agents to their own destinations in one installation', async () => {
    Object.assign(mockEnv, localEnv);
    queueLimitResponses(running, [{ inferenceMode: 'local' }]);
    const local = await (await postAgentKey({ agentType: 'opencode' })).json();
    expect(local.providerMode).toBe('local-model-gateway');
    expect(mockDecrypt).not.toHaveBeenCalled();

    queueLimitResponses(running, cloudKey, running, running);
    mockDecrypt.mockResolvedValueOnce('anthropic-key');
    const resp = await postAgentKey({ agentType: 'claude-code' });
    expect(resp.status).toBe(200);
    const cloud = await resp.json();
    expect(cloud.apiKey).toBe('anthropic-key');
    expect(cloud.providerMode).not.toBe('local-model-gateway');
    expect(cloud.inferenceConfig).toBeUndefined();
  });

  it('ignores inference mode in hosted mode', async () => {
    queueLimitResponses(running, [], []);
    const resp = await postAgentKey({ agentType: 'opencode' });
    expect(resp.status).toBe(404);
  });
});
