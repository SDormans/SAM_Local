/**
 * Spec 036 T033: provider keys round-trip through the desktop credential store without
 * appearing in the database file or API responses, removal works, and uninstall with
 * "retain" keeps local data.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { closeMainWindow, desktopDir, launchDesktop } from './helpers';

const SECRET_1 = 'sk-e2e-retention-first-0123456789';
const SECRET_2 = 'sk-e2e-retention-second-9876543210';

async function filesContaining(dir: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    if ((await readFile(path)).includes(needle)) hits.push(path);
  }
  return hits;
}

test('provider keys stay out of the database and uninstall keeps data', async () => {
  test.setTimeout(600_000);
  const dataDir = await mkdtemp(join(tmpdir(), 'sam-retention-'));
  try {
    const { app, window } = await launchDesktop(dataDir, {
      SAM_ALLOW_UNPROTECTED_CREDENTIALS: '1',
    });
    const call = (method: string, path: string, body?: unknown) =>
      window.evaluate(
        async ([m, p, b]) => {
          const res = await fetch(p as string, {
            method: m as string,
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            ...(b ? { body: JSON.stringify(b) } : {}),
          });
          return { status: res.status, text: await res.text() };
        },
        [method, path, body] as const
      );

    for (const credential of [SECRET_1, SECRET_2]) {
      const saved = await call('PUT', '/api/credentials/agent', {
        agentType: 'opencode',
        credential,
      });
      expect(saved.status, saved.text).toBeLessThan(300);
      expect(saved.text).not.toContain(credential);
    }
    const listed = await call('GET', '/api/credentials/agent');
    expect(listed.status).toBe(200);
    expect(listed.text).not.toContain(SECRET_2);
    expect(await filesContaining(join(dataDir, 'state'), SECRET_2)).toEqual([]);
    expect(await filesContaining(join(dataDir, 'state'), 'sam-local-ref:')).not.toEqual([]);

    const removed = await call('DELETE', '/api/credentials/agent/opencode');
    expect(removed.status, removed.text).toBeLessThan(300);
    expect((await call('GET', '/api/credentials/agent')).text).not.toContain(
      'opencode-api-key-active'
    );

    await closeMainWindow(app);

    const electronBin = createRequire(join(desktopDir, 'package.json'))(
      'electron'
    ) as unknown as string;
    const retain = spawnSync(electronBin, [desktopDir, '--uninstall=retain'], {
      env: { ...process.env, SAM_LOCAL_DATA_DIR: dataDir },
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(retain.status, retain.stderr).toBe(0);
    expect(retain.stdout).toContain('"dataDeleted":false');
    await expect(stat(join(dataDir, 'installation.json'))).resolves.toBeTruthy();
    await expect(stat(join(dataDir, 'state'))).resolves.toBeTruthy();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
