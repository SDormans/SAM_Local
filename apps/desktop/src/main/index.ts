/**
 * Electron main process for the Windows-first local SAM desktop app (spec 036 T013/T016).
 * The renderer is sandboxed with context isolation, may only navigate within the local
 * loopback origin, and talks to the main process through the narrow preload bridge.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  Menu,
  nativeImage,
  session,
  shell,
  Tray,
} from 'electron';

import { CLOSE_PROMPT, handleCloseRequest } from './lifecycle.js';
import { resolveDataDirectory } from './local-data.js';
import { probePrerequisites } from './prerequisites.js';
import { isTrustedSender, selectProjectFolder } from './project-dialog.js';
import { ServiceSupervisor, type SupervisorStatus } from './service-supervisor.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const DEFAULT_PORT = 8790;

const port = Number(process.env.SAM_LOCAL_API_PORT ?? DEFAULT_PORT);
const supervisor = new ServiceSupervisor({
  apiDir: process.env.SAM_DESKTOP_API_DIR ?? join(repoRoot, 'apps/api'),
  webDistDir: process.env.SAM_DESKTOP_WEB_DIST ?? join(repoRoot, 'apps/web/dist'),
  dataDir: resolveDataDirectory(),
  port,
  probePrerequisites: () => probePrerequisites(),
});
const appOrigin = `http://127.0.0.1:${port}`;

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function statusPage(status: SupervisorStatus): string {
  const body =
    status.state === 'failed'
      ? `<h1>SAM could not start</h1><p>${escapeHtml(status.error ?? 'Unknown error')}</p>`
      : `<h1>Starting SAM…</h1><p>Preparing local data and services.</p>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(
    `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><body style="font-family:system-ui;padding:2rem">${body}</body>`
  )}`;
}

function trusted(event: IpcMainInvokeEvent): void {
  if (!isTrustedSender(event.senderFrame?.url, appOrigin)) {
    throw new Error('Request rejected: not from the local SAM window');
  }
}

function publicStatus(status: SupervisorStatus): SupervisorStatus {
  return { state: status.state, url: status.url, error: status.error };
}

function registerIpc(): void {
  ipcMain.handle('sam:select-project-folder', async (event) => {
    trusted(event);
    return selectProjectFolder((options) =>
      mainWindow ? dialog.showOpenDialog(mainWindow, options) : dialog.showOpenDialog(options)
    );
  });
  ipcMain.handle('sam:runtime-status', (event) => {
    trusted(event);
    return publicStatus(supervisor.status);
  });
  ipcMain.handle('sam:refresh-prerequisites', async (event) => {
    trusted(event);
    return supervisor.reportPrerequisites();
  });
}

function lockDownSession(): void {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false)
  );
}

function openExternalIfHttps(url: string): void {
  if (url.startsWith('https://')) void shell.openExternal(url);
}

function showBackgroundIndicator(): void {
  if (!tray) {
    tray = new Tray(nativeImage.createEmpty());
    tray.on('click', () => mainWindow?.show());
  }
  tray.setToolTip('SAM is running in the background');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'SAM is running in the background', enabled: false },
      { label: 'Open SAM', click: () => mainWindow?.show() },
      { label: 'Stop SAM and quit', click: () => void stopAndQuit() },
    ])
  );
}

async function stopAndQuit(): Promise<void> {
  const status = await supervisor.stop();
  if (status.state !== 'stopped') {
    dialog.showErrorBox(
      'SAM',
      status.error ?? 'SAM could not confirm that local services stopped.'
    );
    return;
  }
  quitting = true;
  tray?.destroy();
  app.quit();
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'SAM',
    show: true,
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfHttps(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('data:')) return;
    if (new URL(url).origin !== appOrigin) {
      event.preventDefault();
      openExternalIfHttps(url);
    }
  });
  window.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    void handleCloseRequest({
      activeWorkCount: () => supervisor.activeWorkCount(),
      ask: () =>
        dialog
          .showMessageBox(window, {
            type: 'question',
            ...CLOSE_PROMPT,
            buttons: [...CLOSE_PROMPT.buttons],
          })
          .then((result) => result.response),
      stopServices: () => supervisor.stop(),
      enterBackground: () => {
        window.hide();
        showBackgroundIndicator();
      },
      quit: () => {
        quitting = true;
        tray?.destroy();
        app.quit();
      },
      showError: (message) => dialog.showErrorBox('SAM', message),
    });
  });
  return window;
}

async function launch(): Promise<void> {
  lockDownSession();
  registerIpc();
  mainWindow = createWindow();
  await mainWindow.loadURL(statusPage({ state: 'starting' }));
  supervisor.on('status', (status: SupervisorStatus) =>
    mainWindow?.webContents.send('sam:runtime-status', publicStatus(status))
  );
  const status = await supervisor.start();
  const cookie = supervisor.session;
  if (status.state !== 'running' || !status.url || !cookie) {
    await mainWindow.loadURL(statusPage(status));
    return;
  }
  await session.defaultSession.cookies.set({
    url: appOrigin,
    name: cookie.name,
    value: cookie.value,
    httpOnly: true,
    sameSite: 'strict',
    expirationDate: Math.floor(cookie.expiresAt / 1000),
  });
  const prerequisites = supervisor.lastPrerequisites;
  const ready = prerequisites?.dockerDesktop === 'ready' && prerequisites.wsl2 === 'ready';
  await mainWindow.loadURL(`${appOrigin}${ready ? '/projects/new' : '/setup'}`);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
  app.on('window-all-closed', () => {
    // Lifecycle is driven by the close decision above, not by window count.
  });
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    void stopAndQuit();
  });
  void app.whenReady().then(launch);
}
