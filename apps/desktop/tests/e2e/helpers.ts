import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

export const desktopDir = resolve(import.meta.dirname, '../..');
export const apiDir = resolve(desktopDir, '../api');
export const PORT = 8790;
export const ORIGIN = `http://127.0.0.1:${PORT}`;

function envWithoutCloudflare(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('CLOUDFLARE_') && !key.startsWith('CF_')) {
      env[key] = value;
    }
  }
  return { ...env, ...extra };
}

export async function launchDesktop(
  dataDir: string
): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await electron.launch({
    args: [desktopDir],
    env: envWithoutCloudflare({
      SAM_LOCAL_DATA_DIR: dataDir,
      SAM_LOCAL_API_PORT: String(PORT),
      SAM_LOCAL_WORKSPACES: 'off',
    }),
    timeout: 120_000,
  });
  const window = await app.firstWindow();
  await window.waitForURL(`${ORIGIN}/**`, { timeout: 300_000 });
  return { app, window };
}

/** Closes the main window through the real close handler and waits for the process to exit. */
export async function closeMainWindow(app: ElectronApplication): Promise<void> {
  const exited = new Promise<void>((resolveExit) =>
    app.process().once('exit', () => resolveExit())
  );
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await exited;
}

export async function stubFolderDialog(app: ElectronApplication, folder: string): Promise<void> {
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as never;
  }, folder);
}

export async function stubCloseChoice(app: ElectronApplication, response: number): Promise<void> {
  await app.evaluate(({ dialog }, choice) => {
    const calls: unknown[] = [];
    (globalThis as { __closePrompts?: unknown[] }).__closePrompts = calls;
    dialog.showMessageBox = (async (...args: unknown[]) => {
      calls.push(args[args.length - 1]);
      return { response: choice, checkboxChecked: false };
    }) as never;
  }, response);
}

export function closePrompts(
  app: ElectronApplication
): Promise<Array<{ defaultId?: number; buttons?: string[] }>> {
  return app.evaluate(() => (globalThis as { __closePrompts?: never[] }).__closePrompts ?? []);
}

export function runD1(dataDir: string, sql: string): Promise<void> {
  return new Promise((ok, fail) => {
    const child = spawn(
      join(apiDir, 'node_modules', '.bin', 'wrangler'),
      [
        'd1',
        'execute',
        'DATABASE',
        '--local',
        '--persist-to',
        join(dataDir, 'state'),
        '--config',
        join(dataDir, 'runtime', 'wrangler.toml'),
        '--command',
        sql,
      ],
      { cwd: join(dataDir, 'runtime'), stdio: 'ignore', env: envWithoutCloudflare({}) }
    );
    child.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`d1 execute exited ${code}`))));
  });
}

export async function isListening(): Promise<boolean> {
  return fetch(`${ORIGIN}/health`).then(
    () => true,
    () => false
  );
}
