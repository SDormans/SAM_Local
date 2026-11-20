import { describe, expect, it, vi } from 'vitest';

import { reconcileWorkspaces } from '../../src/main/recovery';

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
