/**
 * Electron main process for the Windows-first local SAM desktop app (spec 036 T013/T016).
 * The renderer is sandboxed with context isolation, may only navigate within the local
 * loopback origin, and talks to the main process through the narrow preload bridge.
 */
import { homedir } from 'node:os';
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
  safeStorage,
  session,
  shell,
  Tray,
} from 'electron';

import { CLOSE_PROMPT, handleCloseRequest } from './lifecycle.js';
import { LocalDataStore, resolveDataDirectory } from './local-data.js';
import { probePrerequisites } from './prerequisites.js';
import { isTrustedSender, selectProjectFolder } from './project-dialog.js';
import { fetchKnownWorkspaces, reconcileWorkspaces } from './recovery.js';
import {
  type LocalSessionCookie,
  ServiceSupervisor,
  sessionRenewalDelayMs,
  sessionRenewalTimingFromEnv,
  type SupervisorStatus,
} from './service-supervisor.js';
import { parseUninstallArg, performUninstall, type UninstallChoice } from './uninstall.js';
import { DockerDesktopDriver } from './workspaces/docker-desktop.js';
import {
  DEFAULT_LOCAL_NODE_IMAGE,
  defaultProjectsRoot,
  LocalNode,
} from './workspaces/local-node.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const DEFAULT_PORT = 8790;
const DEFAULT_NODE_AGENT_PORT = 8791;

const port = Number(process.env.SAM_LOCAL_API_PORT ?? DEFAULT_PORT);
const nodeAgentPort = Number(process.env.SAM_LOCAL_NODE_AGENT_PORT ?? DEFAULT_NODE_AGENT_PORT);
const renewalTiming = sessionRenewalTimingFromEnv(process.env);
const supervisor = new ServiceSupervisor({
  apiDir: process.env.SAM_DESKTOP_API_DIR ?? join(repoRoot, 'apps/api'),
  webDistDir: process.env.SAM_DESKTOP_WEB_DIST ?? join(repoRoot, 'apps/web/dist'),
  dataDir: resolveDataDirectory(),
  port,
  nodeAgentPort,
  localDefaultModel: process.env.SAM_LOCAL_DEFAULT_MODEL,
  onOutput: (chunk: string) => process.stdout.write(chunk),
  probePrerequisites: () => probePrerequisites(),
  secretProtector: {
    isAvailable: () =>
      safeStorage.isEncryptionAvailable() &&
      (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    encrypt: (plaintext) => safeStorage.encryptString(plaintext),
    decrypt: (ciphertext) => safeStorage.decryptString(ciphertext),
  },
  startWorkspaceRuntime:
    process.env.SAM_LOCAL_WORKSPACES === 'off'
      ? undefined
      : async ({ apiUrl, bootstrapSecret, installationId }) => {
          const driver = new DockerDesktopDriver(installationId);
          const recovery = await reconcileWorkspaces(
            driver,
            await fetchKnownWorkspaces(apiUrl, bootstrapSecret)
          ).catch((error: unknown) => {
            console.warn('[recovery] startup reconciliation skipped:', (error as Error).message);
            return null;
          });
          if (recovery?.pending.length) {
            console.warn('[recovery] cleanup pending for', JSON.stringify(recovery.pending));
          }
          const node = new LocalNode(driver);
          await node.start({
            apiUrl,
            bootstrapSecret,
            image: process.env.SAM_LOCAL_NODE_IMAGE ?? DEFAULT_LOCAL_NODE_IMAGE,
            hostPort: nodeAgentPort,
            modelServiceUrl: process.env.SAM_LOCAL_MODEL_SERVICE_URL,
            projectsRoot:
              process.env.SAM_LOCAL_PROJECTS_ROOT ??
              defaultProjectsRoot(process.platform, homedir()),
          });
          return node;
        },
});
const appOrigin = `http://127.0.0.1:${port}`;

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;
let renewalTimer: NodeJS.Timeout | undefined;

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

async function installSessionCookie(cookie: LocalSessionCookie): Promise<void> {
  await session.defaultSession.cookies.set({
    url: appOrigin,
    name: cookie.name,
    value: cookie.value,
    httpOnly: true,
    sameSite: 'strict',
    expirationDate: Math.floor(cookie.expiresAt / 1000),
  });
  scheduleSessionRenewal(cookie.expiresAt);
}

/** Keeps the renderer signed in for as long as SAM runs; sessions are never renewed by the renderer. */
function scheduleSessionRenewal(expiresAt: number): void {
  clearTimeout(renewalTimer);
  renewalTimer = setTimeout(
    () => {
      if (supervisor.status.state !== 'running') return;
      supervisor
        .renewSession()
        .then(installSessionCookie)
        .catch(() => scheduleSessionRenewal(Date.now()));
    },
    sessionRenewalDelayMs(expiresAt, Date.now(), renewalTiming)
  );
  renewalTimer.unref();
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
  await installSessionCookie(cookie);
  const prerequisites = supervisor.lastPrerequisites;
  const ready = prerequisites?.dockerDesktop === 'ready' && prerequisites.wsl2 === 'ready';
  await mainWindow.loadURL(`${appOrigin}${ready ? '/projects/new' : '/setup'}`);
}

const uninstallChoice = parseUninstallArg(process.argv);

async function runUninstall(choice: UninstallChoice): Promise<void> {
  const dataDir = resolveDataDirectory();
  const installation = await new LocalDataStore(dataDir).readInstallation().catch(() => null);
  const result = await performUninstall({
    choice,
    dataDir,
    removeContainers: async () => {
      if (!installation) throw new Error('No SAM installation record found');
      return new DockerDesktopDriver(installation.installationId).removeAll();
    },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (uninstallChoice) {
  void runUninstall(uninstallChoice).then(
    () => app.exit(0),
    (error: unknown) => {
      process.stderr.write(`${(error as Error).message}\n`);
      app.exit(1);
    }
  );
} else if (!app.requestSingleInstanceLock()) {
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
