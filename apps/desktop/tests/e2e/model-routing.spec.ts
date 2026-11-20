/**
 * Spec 036 T030: OpenCode reaches only the destination selected for it. Local gets a reply
 * from the local model, cloud without a key fails with an actionable error instead of using
 * the local model, an unreachable local service is reported, and nothing calls off-machine.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, type Page, test } from '@playwright/test';

import {
  closeMainWindow,
  launchDesktop,
  ORIGIN,
  stubCloseChoice,
  stubFolderDialog,
} from './helpers';

const MODEL = process.env.SAM_TEST_OLLAMA_MODEL ?? 'qwen2.5:0.5b';
const NODE_IMAGE = process.env.SAM_LOCAL_NODE_IMAGE ?? 'sam-local-node:dev';
const OLLAMA = process.env.SAM_TEST_OLLAMA_URL ?? 'http://127.0.0.1:11434';

function api(window: Page, method: string, path: string, body?: unknown) {
  return window.evaluate(
    async ({ origin, method, path, body }) => {
      const res = await fetch(`${origin}${path}`, {
        method,
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(30_000),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, text: await res.text() };
    },
    { origin: ORIGIN, method, path, body }
  );
}

async function startChat(window: Page, projectId: string, prompt: string): Promise<string> {
  await window.goto(`${ORIGIN}/projects/${projectId}/chat`);
  await window.waitForLoadState('networkidle');
  const composer = window.getByPlaceholder(/describe what you want the agent to do/i);
  await expect(composer).toBeVisible({ timeout: 60_000 });
  await composer.fill(prompt);
  await composer.press('Control+Enter');
  await window.waitForURL(/\/chat\/[0-9A-Za-z-]{20,}/, { timeout: 120_000 });
  return /\/chat\/([0-9A-Za-z-]{20,})/.exec(window.url())![1]!;
}

test('each OpenCode destination is used only when selected, with no fallback', async () => {
  test.setTimeout(1_800_000);
  const root = await mkdtemp(join(tmpdir(), 'sam-e2e-routing-'));
  const folder = join(root, 'routing-project');
  await mkdir(folder);
  const { app, window } = await launchDesktop(join(root, 'data'), {
    SAM_LOCAL_WORKSPACES: 'on',
    SAM_LOCAL_NODE_IMAGE: NODE_IMAGE,
    SAM_LOCAL_DEFAULT_MODEL: MODEL,
    SAM_LOCAL_PROJECTS_ROOT: root,
  });
  try {
    // Outage: an unreachable local model service is reported, not silently replaced.
    const down = await api(window, 'PUT', '/api/local/models/connection', {
      providerType: 'ollama',
      baseUrl: 'http://127.0.0.1:9',
      modelId: MODEL,
    });
    expect(down.status, down.text).toBeLessThan(300);
    const { connectionId } = JSON.parse(down.text) as { connectionId: string };
    const verify = await api(window, 'POST', '/api/local/models/connection/verify', {
      connectionId,
    });
    expect(verify.status).toBe(502);
    expect(JSON.parse(verify.text)).toMatchObject({ error: 'LOCAL_MODEL_UNAVAILABLE' });
    const up = await api(window, 'PUT', '/api/local/models/connection', {
      providerType: 'ollama',
      baseUrl: OLLAMA,
      modelId: MODEL,
    });
    expect(up.status, up.text).toBeLessThan(300);

    await stubFolderDialog(app, folder);
    await window.getByRole('button', { name: /choose folder/i }).click({ timeout: 120_000 });
    await window.getByRole('button', { name: /^create project$/i }).click();
    await window.waitForURL(/\/projects\/[0-9A-Z]{26}/, { timeout: 60_000 });
    const projectId = /\/projects\/([0-9A-Z]{26})/.exec(window.url())![1]!;
    await expect
      .poll(
        async () => {
          const res = await api(window, 'GET', '/api/nodes').catch(() => ({ text: '[]' }));
          const nodes = JSON.parse(res.text) as { status: string; lastMetrics?: unknown }[];
          return Array.isArray(nodes) && nodes.some((n) => n.status === 'running' && n.lastMetrics);
        },
        { timeout: 300_000, intervals: [3_000] }
      )
      .toBe(true);
    const profile = await api(window, 'POST', `/api/projects/${projectId}/agent-profiles`, {
      name: 'OpenCode',
      agentType: 'opencode',
    });
    expect(profile.status, profile.text).toBeLessThan(300);

    const messages = (sessionId: string) =>
      api(window, 'GET', `/api/projects/${projectId}/sessions/${sessionId}/messages`);

    // Local destination: the reply comes from the local model.
    const local = await api(window, 'PUT', '/api/agent-settings/opencode', {
      inferenceMode: 'local',
    });
    expect(local.status, local.text).toBeLessThan(300);
    const localSession = await startChat(window, projectId, 'Reply with the single word: pong');
    await expect
      .poll(async () => (await messages(localSession)).text.includes('"role":"assistant"'), {
        timeout: 600_000,
        intervals: [5_000],
      })
      .toBe(true);

    // Cloud destination without a key: an actionable failure, never the local model.
    const cloud = await api(window, 'PUT', '/api/agent-settings/opencode', {
      inferenceMode: 'cloud',
    });
    expect(cloud.status, cloud.text).toBeLessThan(300);
    // Without a cloud key the chat refuses to start and points at the fix.
    await window.goto(`${ORIGIN}/projects/${projectId}/chat`);
    await window.waitForLoadState('networkidle');
    await window
      .getByRole('button', { name: /new chat/i })
      .first()
      .click({ timeout: 60_000 });
    await expect(window.getByText(/add an agent to start chatting/i)).toBeVisible({
      timeout: 60_000,
    });
    await expect(window.getByRole('button', { name: 'Settings > Agents' })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Send' })).toBeDisabled();
    await window.screenshot({ path: 'test-results/model-routing-cloud-no-key.png' });

    const health = JSON.parse((await api(window, 'GET', '/api/local/health')).text) as {
      offMachineHosts?: string[];
    };
    expect(health.offMachineHosts ?? []).toEqual([]);
  } finally {
    await stubCloseChoice(app, 0).catch(() => undefined);
    await closeMainWindow(app).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
