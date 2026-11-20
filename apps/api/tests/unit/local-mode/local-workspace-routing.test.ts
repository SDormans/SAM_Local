import { describe, expect, it } from 'vitest';

import { getNodeBackendBaseUrl } from '../../../src/services/node-agent-readiness';
import { resolveWorkspaceGitSource } from '../../../src/services/workspace-git-source';

describe('local workspace routing (spec 036)', () => {
  it('routes the local node agent to loopback only in local mode', () => {
    expect(
      getNodeBackendBaseUrl('NODE1', {
        BASE_DOMAIN: 'sam.localhost',
        SAM_RUNTIME_MODE: 'local',
        LOCAL_VM_AGENT_PORT: '18443',
      })
    ).toBe('http://127.0.0.1:18443');
    expect(getNodeBackendBaseUrl('NODE1', { BASE_DOMAIN: 'example.com' })).toBe(
      'https://node1.vm.example.com:8443'
    );
  });

  it('mounts local folders instead of resolving a clone source', async () => {
    const db = {} as Parameters<typeof resolveWorkspaceGitSource>[0];
    await expect(
      resolveWorkspaceGitSource(db, { id: 'p1', repoProvider: 'local' })
    ).resolves.toEqual({
      repoProvider: 'local',
      cloneUrl: null,
      repositoryHost: null,
      repositoryPath: null,
    });
  });
});
