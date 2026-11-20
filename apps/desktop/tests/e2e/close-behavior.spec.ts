/** Spec 036 T012 / FR-022: the close choice with active work defaults to a graceful stop. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import {
  closeMainWindow,
  closePrompts,
  isListening,
  launchDesktop,
  runD1,
  stubCloseChoice,
} from './helpers';

async function seedActiveWorkspace(dataDir: string, userId: string): Promise<void> {
  await runD1(
    dataDir,
    `INSERT INTO workspaces (id, user_id, name, repository, status, vm_size, vm_location) VALUES ('ws-active', '${userId}', 'Active', 'C:/code/demo', 'running', 'small', 'local');`
  );
}

test('active work: background keeps SAM running and visible; stop is the default and verified', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sam-e2e-close-'));
  const dataDir = join(root, 'data');
  try {
    const { app, window } = await launchDesktop(dataDir);
    const userId = await window.evaluate(async () => {
      const response = await fetch('/api/local/session', { credentials: 'include' });
      return ((await response.json()) as { userId: string }).userId;
    });
    await seedActiveWorkspace(dataDir, userId);

    await stubCloseChoice(app, 1);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await expect.poll(async () => (await closePrompts(app)).length).toBe(1);
    const [prompt] = await closePrompts(app);
    expect(prompt?.buttons?.[prompt.defaultId ?? -1]).toMatch(/stop/i);
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())
      )
      .toBe(false);
    expect(await isListening()).toBe(true);

    await stubCloseChoice(app, 0);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show());
    await closeMainWindow(app);
    expect(await isListening()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('without active work, closing stops services and quits without a prompt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sam-e2e-close-idle-'));
  try {
    const { app } = await launchDesktop(join(root, 'data'));
    await stubCloseChoice(app, 2);
    await closeMainWindow(app);
    expect(await isListening()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
