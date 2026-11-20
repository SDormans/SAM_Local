/** Spec 036 T025/T027: the desktop OpenCode local/cloud choice is saved and restored by the real API. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { closeMainWindow, launchDesktop, ORIGIN } from './helpers';

const SHOTS = fileURLToPath(
  new URL('../../../../.codex/tmp/playwright-screenshots/', import.meta.url)
);

test('OpenCode inference mode is chosen explicitly and survives a reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sam-e2e-inference-'));
  try {
    const { app, window } = await launchDesktop(join(root, 'data'));
    await expect(window).toHaveURL(`${ORIGIN}/projects/new`, { timeout: 60_000 });
    await window.goto(`${ORIGIN}/setup`);
    const connection = window.getByTestId('local-model-connection');
    await expect(connection).toBeVisible({ timeout: 30_000 });
    await connection
      .getByPlaceholder(/qwen2.5-coder/)
      .fill(process.env.SAM_E2E_LOCAL_MODEL ?? 'qwen2.5:0.5b');
    await connection.getByRole('button', { name: /save and check/i }).click();
    await expect(connection.getByText(/Connected\. \d+ model/)).toBeVisible({ timeout: 30_000 });
    await window.setViewportSize({ width: 375, height: 667 });
    await connection.scrollIntoViewIfNeeded();
    await window.screenshot({ path: join(SHOTS, 'local-model-mobile.png') });
    await window.setViewportSize({ width: 1280, height: 800 });
    await connection.scrollIntoViewIfNeeded();
    await window.screenshot({ path: join(SHOTS, 'local-model-desktop.png') });

    await window.goto(`${ORIGIN}/settings/agents`);

    const mode = window.getByTestId('inference-mode');
    if (!(await mode.isVisible().catch(() => false))) {
      await window.getByText('OpenCode', { exact: true }).first().click();
    }
    await expect(mode).toBeVisible({ timeout: 30_000 });
    await expect(window.getByTestId('inference-mode-summary')).toContainText('Not chosen yet');

    await window.getByTestId('inference-mode-local').check();
    await expect(window.getByTestId('opencode-provider-select')).toBeHidden();
    await window.setViewportSize({ width: 375, height: 667 });
    await mode.scrollIntoViewIfNeeded();
    await window.screenshot({ path: join(SHOTS, 'inference-mode-mobile.png') });
    await window.setViewportSize({ width: 1280, height: 800 });
    await mode.scrollIntoViewIfNeeded();
    await window.screenshot({ path: join(SHOTS, 'inference-mode-desktop.png') });

    await window.getByTestId('save-settings-opencode').click();
    await expect(window.getByText('Settings saved')).toBeVisible();

    await window.reload();
    const restored = window.getByTestId('inference-mode');
    if (!(await restored.isVisible().catch(() => false))) {
      await window.getByText('OpenCode', { exact: true }).first().click();
    }
    await expect(window.getByTestId('inference-mode-local')).toBeChecked({ timeout: 30_000 });

    await closeMainWindow(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
