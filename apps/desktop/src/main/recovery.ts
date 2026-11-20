/**
 * Startup reconciliation (spec 036 T034). Removes containers this installation created for
 * workspaces SAM no longer has, touching nothing without this installation's labels.
 * Anything Docker does not confirm removed is reported as pending, never as done.
 */
import type { CleanupReport } from './workspaces/docker-desktop.js';

export interface RecoveryDriver {
  listWorkspaceIds(): Promise<string[]>;
  removeWorkspace(workspaceId: string): Promise<CleanupReport>;
}

export interface KnownWorkspace {
  id: string;
  status: string;
}

export interface RecoveryReport {
  removed: string[];
  pending: Array<{ workspaceId: string; resources: string[] }>;
}

const GONE = new Set(['deleted', 'deleting']);

export async function reconcileWorkspaces(
  driver: RecoveryDriver,
  known: KnownWorkspace[]
): Promise<RecoveryReport> {
  const status = new Map(known.map((w) => [w.id, w.status]));
  const report: RecoveryReport = { removed: [], pending: [] };
  for (const workspaceId of await driver.listWorkspaceIds()) {
    const current = status.get(workspaceId);
    if (current !== undefined && !GONE.has(current)) continue;
    const cleanup = await driver.removeWorkspace(workspaceId);
    if (cleanup.complete) report.removed.push(workspaceId);
    else report.pending.push({ workspaceId, resources: cleanup.failed.map((f) => f.resource) });
  }
  return report;
}

/** Reads the workspaces the local API knows about with the supervisor's bootstrap secret. */
export async function fetchKnownWorkspaces(
  apiUrl: string,
  bootstrapSecret: string,
  fetchImpl: typeof fetch = fetch
): Promise<KnownWorkspace[]> {
  const response = await fetchImpl(`${apiUrl}/api/local/workspaces`, {
    headers: { authorization: `Bearer ${bootstrapSecret}` },
  });
  if (!response.ok) throw new Error(`Could not read workspaces (HTTP ${response.status})`);
  const body = (await response.json()) as { workspaces?: KnownWorkspace[] };
  return body.workspaces ?? [];
}
