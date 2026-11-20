/** Spec 036 T011: first run without a cloud account, local-folder project, restart persistence. */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { closeMainWindow, isListening, launchDesktop, ORIGIN, stubFolderDialog } from './helpers';

test('first run creates a local-folder project that survives a full restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sam-e2e-first-run-'));
  const dataDir = join(root, 'data');
  const folder = join(root, 'demo-project');
  await mkdir(folder);
  try {
    const started = Date.now();
    let { app, window } = await launchDesktop(dataDir);
    await expect(window).toHaveURL(`${ORIGIN}/projects/new`);
    await expect(
      window.getByRole('heading', { name: /use a folder on this computer/i })
    ).toBeVisible({
      timeout: 60_000,
    });
    expect(await window.evaluate(() => typeof (window as { require?: unknown }).require)).toBe(
      'undefined'
    );

    await stubFolderDialog(app, folder);
    await window.getByRole('button', { name: /choose folder/i }).click();
    await expect(window.getByTestId('local-folder-path')).toHaveText(folder);
    await window.getByRole('button', { name: /^create project$/i }).click();
    await window.waitForURL(/\/projects\/[0-9A-Z]{26}/, { timeout: 60_000 });
    const projectUrl = window.url();
    expect(Date.now() - started).toBeLessThan(5 * 60_000);

    await closeMainWindow(app);
    expect(await isListening()).toBe(false);

    ({ app, window } = await launchDesktop(dataDir));
    await window.goto(projectUrl);
    await expect(window.getByText('demo-project').first()).toBeVisible({ timeout: 60_000 });
    const projects = await window.evaluate(async (origin) => {
      const response = await fetch(`${origin}/api/projects`, { credentials: 'include' });
      return response.json();
    }, ORIGIN);
    expect(JSON.stringify(projects)).toContain('demo-project');
    await closeMainWindow(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
