/**
 * Uninstall data handling (spec 036 T035). The packaged uninstaller runs SAM with
 * `--uninstall=retain` or `--uninstall=delete` after asking the user. Workspace containers
 * this installation created are always removed; projects, conversations and settings are
 * deleted only for an explicit `delete`. Project folders on disk are never touched.
 */
import { readdir, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { CleanupReport } from './workspaces/docker-desktop.js';

/** Entries SAM creates in its data directory; nothing else there is deleted. */
const SAM_DATA_ENTRIES = ['installation.json', 'state', 'backups', 'runtime'];

export type UninstallChoice = 'retain' | 'delete';

export interface UninstallResult {
  choice: UninstallChoice;
  containers: CleanupReport | { skipped: string };
  dataDeleted: boolean;
}

export function parseUninstallArg(argv: readonly string[]): UninstallChoice | null {
  const arg = argv.find((a) => a.startsWith('--uninstall='));
  if (!arg) return null;
  const value = arg.slice('--uninstall='.length);
  if (value !== 'retain' && value !== 'delete') {
    throw new Error('--uninstall must be "retain" or "delete"');
  }
  return value;
}

export async function performUninstall(options: {
  choice: UninstallChoice;
  dataDir: string;
  removeContainers: () => Promise<CleanupReport>;
}): Promise<UninstallResult> {
  const containers = await options.removeContainers().catch((error: unknown) => ({
    skipped: error instanceof Error ? error.message : 'Docker is not available',
  }));
  if (options.choice === 'retain') return { choice: 'retain', containers, dataDeleted: false };
  for (const entry of SAM_DATA_ENTRIES) {
    await rm(join(options.dataDir, entry), { recursive: true, force: true });
  }
  const left = await readdir(options.dataDir).catch(() => null);
  if (left && left.length === 0) await rmdir(options.dataDir);
  return { choice: 'delete', containers, dataDeleted: true };
}
