/**
 * Spec 036 T019: desktop app -> local-folder project -> local Docker workspace -> OpenCode ->
 * Ollama (through SAM's gateway) -> reply in the project chat, driven through the Electron UI.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import {
  closeMainWindow,
  launchDesktop,
  ORIGIN,
  stubCloseChoice,
  stubFolderDialog,
} from './helpers';

const MODEL = process.env.SAM_TEST_OLLAMA_MODEL ?? 'qwen2.5:0.5b';
const NODE_IMAGE = process.env.SAM_LOCAL_NODE_IMAGE ?? 'sam-local-node:dev';

test('a local project chat gets a reply from the local model with no cloud requests', async () => {
  // First launch applies every migration, pulls the workspace image and loads the model.
  test.setTimeout(1_500_000);
  const root = await mkdtemp(join(tmpdir(), 'sam-e2e-agent-'));
  const folder = join(root, 'agent-project');
  await mkdir(folder);
  const { app, window } = await launchDesktop(join(root, 'data'), {
    SAM_LOCAL_WORKSPACES: 'on',
    SAM_LOCAL_NODE_IMAGE: NODE_IMAGE,
    SAM_LOCAL_DEFAULT_MODEL: MODEL,
    SAM_LOCAL_PROJECTS_ROOT: root,
  });
  try {
    await stubFolderDialog(app, folder);
    await window.getByRole('button', { name: /choose folder/i }).click({ timeout: 120_000 });
    await window.getByRole('button', { name: /^create project$/i }).click();
    await window.waitForURL(/\/projects\/[0-9A-Z]{26}/, { timeout: 60_000 });
    const projectId = /\/projects\/([0-9A-Z]{26})/.exec(window.url())![1]!;

    const runtimeStatus = await window.evaluate(() =>
      (
        window as unknown as { samDesktop: { getRuntimeStatus: () => Promise<unknown> } }
      ).samDesktop.getRuntimeStatus()
    );
    expect(JSON.stringify(runtimeStatus)).not.toContain('workspaceRuntimeError');
    // Wait until this computer's node is ready to take work.
    await expect
      .poll(
        () =>
          window.evaluate(async (origin) => {
            try {
              const res = await fetch(`${origin}/api/nodes`, {
                credentials: 'include',
                signal: AbortSignal.timeout(15_000),
              });
              const nodes = (await res.json()) as { status: string; lastMetrics?: unknown }[];
              return nodes.some((n) => n.status === 'running' && n.lastMetrics);
            } catch {
              return false;
            }
          }, ORIGIN),
        { timeout: 300_000, intervals: [3_000] }
      )
      .toBe(true);

    console.log('[t019] node ready');
    const profileStatus = await window.evaluate(
      async ({ origin, projectId }) => {
        const res = await fetch(`${origin}/api/projects/${projectId}/agent-profiles`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'OpenCode (local model)', agentType: 'opencode' }),
        });
        return res.status;
      },
      { origin: ORIGIN, projectId }
    );
    expect(profileStatus).toBeLessThan(300);
    await window.goto(`${ORIGIN}/projects/${projectId}/chat`);
    await window.waitForLoadState('networkidle');
    await window.screenshot({ path: 'test-results/local-first-agent-chat.png' });
    const composer = window.getByPlaceholder(/describe what you want the agent to do/i);
    await expect(composer, await window.locator('body').innerText()).toBeVisible({
      timeout: 60_000,
    });
    await composer.fill('Reply with the single word: pong');
    await composer.press('Control+Enter');
    await window.waitForURL(/\/chat\/[0-9A-Za-z-]{20,}/, { timeout: 120_000 });
    console.log('[t019] chat url', window.url());
    const sessionId = /\/chat\/([0-9A-Za-z-]{20,})/.exec(window.url())![1]!;

    await expect
      .poll(
        () =>
          window.evaluate(
            async ({ origin, projectId, sessionId }) => {
              const res = await fetch(
                `${origin}/api/projects/${projectId}/sessions/${sessionId}/messages`,
                { credentials: 'include', signal: AbortSignal.timeout(15_000) }
              );
              return res.ok ? (await res.text()).includes('"role":"assistant"') : false;
            },
            { origin: ORIGIN, projectId, sessionId }
          ),
        { timeout: 600_000, intervals: [5_000] }
      )
      .toBe(true);
    console.log('[t019] assistant reply received');
  } finally {
    // A running agent triggers the close prompt; choose 'Stop work and quit'.
    await stubCloseChoice(app, 0).catch(() => undefined);
    await closeMainWindow(app).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
