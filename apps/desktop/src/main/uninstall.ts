/**
 * Uninstall data handling (spec 036 T035). The packaged uninstaller runs SAM with
 * `--uninstall=retain` or `--uninstall=delete` after asking the user. Workspace containers
 * this installation created are always removed; projects, conversations and settings are
 * deleted only for an explicit `delete`. Project folders on disk are never touched.
 */
import { rm } from 'node:fs/promises';

import type { CleanupReport } from './workspaces/docker-desktop.js';

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
  await rm(options.dataDir, { recursive: true, force: true });
  return { choice: 'delete', containers, dataDeleted: true };
}
