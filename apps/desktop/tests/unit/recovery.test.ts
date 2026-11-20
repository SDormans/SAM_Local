import { describe, expect, it, vi } from 'vitest';

import { fetchKnownWorkspaces, reconcileWorkspaces } from '../../src/main/recovery';

function driver(ids: string[], incomplete: string[] = []) {
  return {
    listWorkspaceIds: vi.fn(async () => ids),
    removeWorkspace: vi.fn(async (id: string) =>
      incomplete.includes(id)
        ? { removed: [], failed: [{ resource: `container:${id}`, error: 'busy' }], complete: false }
        : { removed: [`container:${id}`], failed: [], complete: true }
    ),
  };
}

describe('reconcileWorkspaces', () => {
  it('keeps live workspaces and removes ones SAM deleted or no longer knows', async () => {
    const d = driver(['live', 'gone', 'unknown']);
    const report = await reconcileWorkspaces(d, [
      { id: 'live', status: 'running' },
      { id: 'gone', status: 'deleted' },
    ]);
    expect(d.removeWorkspace).not.toHaveBeenCalledWith('live');
    expect(report.removed).toEqual(['gone', 'unknown']);
    expect(report.pending).toEqual([]);
  });

  it('reports unconfirmed removals as pending', async () => {
    const report = await reconcileWorkspaces(driver(['stuck'], ['stuck']), []);
    expect(report.removed).toEqual([]);
    expect(report.pending).toEqual([{ workspaceId: 'stuck', resources: ['container:stuck'] }]);
  });
});

describe('fetchKnownWorkspaces', () => {
  it('reads workspaces with the bootstrap secret', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ workspaces: [{ id: 'w1', status: 'running' }] })
    ) as unknown as typeof fetch;
    await expect(fetchKnownWorkspaces('http://127.0.0.1:9', 'boot', fetchImpl)).resolves.toEqual([
      { id: 'w1', status: 'running' },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:9/api/local/workspaces', {
      headers: { authorization: 'Bearer boot' },
    });
  });

  it('treats a missing list as empty and fails on HTTP errors', async () => {
    const empty = vi.fn(async () => Response.json({})) as unknown as typeof fetch;
    await expect(fetchKnownWorkspaces('http://127.0.0.1:9', 'boot', empty)).resolves.toEqual([]);
    const denied = vi.fn(async () => new Response('', { status: 401 })) as unknown as typeof fetch;
    await expect(fetchKnownWorkspaces('http://127.0.0.1:9', 'bad', denied)).rejects.toThrow(
      /HTTP 401/
    );
  });
});
