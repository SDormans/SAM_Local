/**
 * Local-folder project selection (spec 036 T015). Only returns a path the user picked in the
 * native dialog; it never runs git, clones, or contacts a remote.
 */
import { stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';

export interface SelectedProjectFolder {
  path: string;
  name: string;
}

export type ShowOpenDialog = (options: {
  title: string;
  properties: Array<'openDirectory' | 'createDirectory'>;
}) => Promise<{ canceled: boolean; filePaths: string[] }>;

export async function selectProjectFolder(
  showOpenDialog: ShowOpenDialog
): Promise<SelectedProjectFolder | null> {
  const result = await showOpenDialog({
    title: 'Choose a project folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  const path = result.filePaths[0];
  if (result.canceled || !path) return null;
  if (!isAbsolute(path) || !(await stat(path)).isDirectory()) {
    throw new Error('The selected project location is not a folder');
  }
  return { path, name: basename(path) || path };
}

/** IPC calls are honoured only from the SAM window's own local origin. */
export function isTrustedSender(senderUrl: string | undefined, appOrigin: string): boolean {
  if (!senderUrl) return false;
  try {
    return new URL(senderUrl).origin === appOrigin;
  } catch {
    return false;
  }
}
