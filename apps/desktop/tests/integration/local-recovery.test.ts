import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { reconcileWorkspaces } from '../../src/main/recovery';
import {
  DockerDesktopDriver,
  LABEL_INSTALLATION,
  LABEL_WORKSPACE,
} from '../../src/main/workspaces/docker-desktop';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    execFileSync('docker', ['image', 'inspect', 'alpine:latest'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const installation = `rec${randomBytes(4).toString('hex')}`;
const other = `oth${randomBytes(4).toString('hex')}`;

function container(installationId: string, workspaceId: string): string {
  return execFileSync(
    'docker',
    [
      'create',
      '--label',
      `${LABEL_INSTALLATION}=${installationId}`,
      '--label',
      `${LABEL_WORKSPACE}=${workspaceId}`,
      'alpine:latest',
      'true',
    ],
    { encoding: 'utf8' }
  ).trim();
}

function exists(id: string): boolean {
  try {
    execFileSync('docker', ['inspect', id], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!dockerAvailable())('startup recovery with Docker', () => {
  const created: string[] = [];
  afterAll(() => {
    for (const id of created) execFileSync('docker', ['rm', '-f', id], { stdio: 'ignore' });
  });

  it('removes only this installation’s containers for workspaces SAM no longer has', async () => {
    const live = container(installation, 'ws-live');
    const orphan = container(installation, 'ws-orphan');
    const deleted = container(installation, 'ws-deleted');
    const foreign = container(other, 'ws-orphan');
    created.push(live, orphan, deleted, foreign);

    const report = await reconcileWorkspaces(new DockerDesktopDriver(installation), [
      { id: 'ws-live', status: 'running' },
      { id: 'ws-deleted', status: 'deleted' },
    ]);

    expect(report.removed.sort()).toEqual(['ws-deleted', 'ws-orphan']);
    expect(report.pending).toEqual([]);
    expect(exists(live)).toBe(true);
    expect(exists(foreign)).toBe(true);
    expect(exists(orphan)).toBe(false);
    expect(exists(deleted)).toBe(false);
  });
});
