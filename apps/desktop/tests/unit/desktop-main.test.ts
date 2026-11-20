import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { choiceFromResponse, CLOSE_PROMPT, handleCloseRequest } from '../../src/main/lifecycle';
import type { RunningLocalApi } from '../../src/main/local-api-runtime';
import { probePrerequisites, type RunCommand, runCommand } from '../../src/main/prerequisites';
import { isTrustedSender, selectProjectFolder } from '../../src/main/project-dialog';
import {
  ServiceSupervisor,
  sessionRenewalDelayMs,
  sessionRenewalTimingFromEnv,
} from '../../src/main/service-supervisor';

const apiDir = resolve(__dirname, '../../../api');
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sam-desktop-main-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('probePrerequisites', () => {
  const runner =
    (
      results: Record<string, { code: number | null; stdout?: string; missing?: boolean }>
    ): RunCommand =>
    async (command) => ({ stdout: '', missing: false, code: 0, ...results[command] });

  it('reports ready Docker Desktop with Linux containers and WSL2', async () => {
    expect(
      await probePrerequisites({
        platform: 'win32',
        run: runner({ docker: { code: 0, stdout: 'linux\n' } }),
      })
    ).toEqual({ dockerDesktop: 'ready', wsl2: 'ready' });
  });

  it('distinguishes missing, stopped, Windows-container, and WSL2 problems', async () => {
    const missing = await probePrerequisites({
      platform: 'win32',
      run: runner({ docker: { code: null, missing: true }, 'wsl.exe': { code: 1 } }),
    });
    expect(missing).toMatchObject({ dockerDesktop: 'unavailable', wsl2: 'unavailable' });
    expect(missing.message).toMatch(/wsl --install/);
    expect(missing.message).toMatch(/not installed/);
    expect(
      await probePrerequisites({ platform: 'win32', run: runner({ docker: { code: 1 } }) })
    ).toMatchObject({ dockerDesktop: 'stopped', message: expect.stringMatching(/not running/) });
    expect(
      await probePrerequisites({
        platform: 'win32',
        run: runner({ docker: { code: 0, stdout: 'windows' } }),
      })
    ).toMatchObject({
      dockerDesktop: 'stopped',
      message: expect.stringMatching(/Linux containers/),
    });
  });

  it('skips the WSL2 probe off Windows', async () => {
    const run = vi.fn(runner({ docker: { code: 0, stdout: 'linux' } }));
    expect(await probePrerequisites({ platform: 'linux', run })).toEqual({
      dockerDesktop: 'ready',
      wsl2: 'ready',
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runs real commands and reports missing binaries', async () => {
    expect(await runCommand('node', ['-e', 'process.stdout.write("ok")'])).toEqual({
      code: 0,
      stdout: 'ok',
      missing: false,
    });
    expect((await runCommand(join(root, 'nope'), [])).missing).toBe(true);
  });
});

describe('project folder selection', () => {
  it('returns the chosen folder and never inspects git', async () => {
    const folder = join(root, 'My Project');
    await import('node:fs/promises').then((fs) => fs.mkdir(folder));
    const dialog = vi.fn(async () => ({ canceled: false, filePaths: [folder] }));
    expect(await selectProjectFolder(dialog)).toEqual({ path: folder, name: 'My Project' });
    expect(dialog.mock.calls[0]?.[0]).toMatchObject({
      properties: ['openDirectory', 'createDirectory'],
    });
  });

  it('handles cancel and rejects non-folders', async () => {
    expect(await selectProjectFolder(async () => ({ canceled: true, filePaths: [] }))).toBeNull();
    const file = join(root, 'file.txt');
    await writeFile(file, 'x');
    await expect(
      selectProjectFolder(async () => ({ canceled: false, filePaths: [file] }))
    ).rejects.toThrow(/not a folder/);
  });

  it('trusts only the local app origin', () => {
    const origin = 'http://127.0.0.1:8790';
    expect(isTrustedSender('http://127.0.0.1:8790/projects/new', origin)).toBe(true);
    expect(isTrustedSender('http://localhost:8790/', origin)).toBe(false);
    expect(isTrustedSender('https://evil.example/', origin)).toBe(false);
    expect(isTrustedSender('not a url', origin)).toBe(false);
    expect(isTrustedSender(undefined, origin)).toBe(false);
  });
});

describe('close decision', () => {
  function context(overrides: Partial<Parameters<typeof handleCloseRequest>[0]> = {}) {
    return {
      activeWorkCount: vi.fn(async () => 1),
      ask: vi.fn(async () => CLOSE_PROMPT.defaultId),
      stopServices: vi.fn(async () => ({ state: 'stopped' as const })),
      enterBackground: vi.fn(),
      quit: vi.fn(),
      showError: vi.fn(),
      ...overrides,
    };
  }

  it('defaults to a graceful stop and quits only after a verified stop', async () => {
    expect(CLOSE_PROMPT.buttons[CLOSE_PROMPT.defaultId]).toMatch(/Stop/);
    const ctx = context();
    expect(await handleCloseRequest(ctx)).toEqual({ choice: 'stop', finalState: 'stopped' });
    expect(ctx.stopServices).toHaveBeenCalled();
    expect(ctx.quit).toHaveBeenCalled();
  });

  it('keeps running only on explicit background choice', async () => {
    const ctx = context({ ask: vi.fn(async () => 1) });
    expect(await handleCloseRequest(ctx)).toEqual({ choice: 'background', finalState: 'running' });
    expect(ctx.enterBackground).toHaveBeenCalled();
    expect(ctx.stopServices).not.toHaveBeenCalled();
    expect(ctx.quit).not.toHaveBeenCalled();
  });

  it('cancels without side effects', async () => {
    const ctx = context({ ask: vi.fn(async () => CLOSE_PROMPT.cancelId) });
    expect(await handleCloseRequest(ctx)).toEqual({ choice: 'cancel' });
    expect(ctx.quit).not.toHaveBeenCalled();
    expect(ctx.stopServices).not.toHaveBeenCalled();
  });

  it('does not ask without active work, and treats unknown work as active', async () => {
    const idle = context({ activeWorkCount: vi.fn(async () => 0) });
    await handleCloseRequest(idle);
    expect(idle.ask).not.toHaveBeenCalled();
    const unknown = context({
      activeWorkCount: vi.fn(async () => {
        throw new Error('down');
      }),
    });
    await handleCloseRequest(unknown);
    expect(unknown.ask).toHaveBeenCalled();
  });

  it('reports a stop that did not complete instead of quitting', async () => {
    const ctx = context({
      stopServices: vi.fn(async () => ({ state: 'failed' as const, error: 'still up' })),
    });
    expect(await handleCloseRequest(ctx)).toEqual({ choice: 'stop', finalState: 'failed' });
    expect(ctx.showError).toHaveBeenCalledWith('still up');
    expect(ctx.quit).not.toHaveBeenCalled();
    const noMessage = context({
      stopServices: vi.fn(async () => ({ state: 'stopping' as const })),
    });
    await handleCloseRequest(noMessage);
    expect(noMessage.showError).toHaveBeenCalledWith(expect.stringMatching(/may still be running/));
  });

  it('maps dialog responses', () => {
    expect(choiceFromResponse(0)).toBe('stop');
    expect(choiceFromResponse(1)).toBe('background');
    expect(choiceFromResponse(2)).toBe('cancel');
    expect(choiceFromResponse(-1)).toBe('stop');
  });
});

describe('ServiceSupervisor', () => {
  const COOKIE = 'a'.repeat(64);
  let dataDirs = 0;

  function fakeApi() {
    let exit!: () => void;
    const exited = new Promise<void>((r) => (exit = r));
    const api: RunningLocalApi & { crash: () => void } = {
      url: 'http://127.0.0.1:9',
      exited,
      stop: vi.fn(async () => exit()),
      crash: () => exit(),
    };
    return api;
  }

  function fetchStub(workspaces: unknown = []) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/local/session')) {
        return new Response('{}', {
          headers: { 'set-cookie': `sam_local_session=${COOKIE}; Max-Age=600; Path=/; HttpOnly` },
        });
      }
      if (url.endsWith('/api/local/health/prerequisites')) {
        expect(init?.method).toBe('PUT');
        return new Response('{}');
      }
      if (url.endsWith('/api/workspaces')) {
        expect(new Headers(init?.headers).get('cookie')).toBe(`sam_local_session=${COOKIE}`);
        return Response.json(workspaces);
      }
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;
  }

  function supervisor(overrides: Partial<ConstructorParameters<typeof ServiceSupervisor>[0]> = {}) {
    const api = fakeApi();
    const sup = new ServiceSupervisor({
      apiDir,
      dataDir: join(root, `data-${++dataDirs}`),
      port: 9,
      probePrerequisites: async () => ({ dockerDesktop: 'ready', wsl2: 'ready' }),
      startApi: async () => api,
      migrate: async () => undefined,
      fetchImpl: fetchStub([
        { status: 'running' },
        { status: 'stopped' },
        { status: 'creating' },
        1,
      ]),
      ...overrides,
    });
    return { sup, api };
  }

  it('starts local workspaces when Docker becomes ready on a recheck', async () => {
    let docker: 'stopped' | 'ready' = 'stopped';
    const runtime = { stop: vi.fn(async () => undefined) };
    const startWorkspaceRuntime = vi.fn(async () => {
      if (docker !== 'ready') throw new Error('Docker Desktop is not running');
      return runtime;
    });
    const { sup } = supervisor({
      probePrerequisites: async () => ({ dockerDesktop: docker, wsl2: 'ready' }),
      startWorkspaceRuntime,
    });
    expect((await sup.start()).workspaceRuntimeError).toMatch(/unavailable/);
    docker = 'ready';
    await sup.reportPrerequisites();
    expect(startWorkspaceRuntime).toHaveBeenCalledTimes(2);
    expect(sup.status).toMatchObject({ state: 'running' });
    expect(sup.status.workspaceRuntimeError).toBeUndefined();
    await sup.reportPrerequisites();
    expect(startWorkspaceRuntime).toHaveBeenCalledTimes(2);
    await sup.stop();
    expect(runtime.stop).toHaveBeenCalledTimes(1);
  });

  it('stops local workspaces on quit even after the API crashed', async () => {
    const runtime = { stop: vi.fn(async () => undefined) };
    const { sup, api } = supervisor({ startWorkspaceRuntime: async () => runtime });
    await sup.start();
    api.crash();
    await api.exited;
    await new Promise((r) => setTimeout(r, 0));
    expect(sup.status.state).toBe('failed');
    expect((await sup.stop()).state).toBe('stopped');
    expect(runtime.stop).toHaveBeenCalledTimes(1);
  });

  it('starts, issues the local session, reports prerequisites, and counts active work', async () => {
    const { sup } = supervisor();
    const states: string[] = [];
    sup.on('status', (s: { state: string }) => states.push(s.state));
    const status = await sup.start();
    expect(status).toMatchObject({ state: 'running', url: 'http://127.0.0.1:9' });
    expect(states).toEqual(['starting', 'running']);
    expect(sup.session).toMatchObject({ name: 'sam_local_session', value: COOKIE });
    expect(await sup.start()).toMatchObject({ state: 'running' });
    expect(await sup.activeWorkCount()).toBe(2);
    expect((await sup.store.readInstallation())?.schemaVersion).toBeGreaterThan(200);
    expect(await sup.stop()).toMatchObject({ state: 'stopped' });
    expect(sup.session).toBeUndefined();
    expect(await sup.activeWorkCount()).toBe(0);
    expect(await sup.stop()).toMatchObject({ state: 'stopped' });
  });

  it('starts and stops the local workspace runtime with the service', async () => {
    const runtime = { stop: vi.fn(async () => undefined) };
    const startWorkspaceRuntime = vi.fn(async () => runtime);
    const { sup } = supervisor({ startWorkspaceRuntime, nodeAgentPort: 8791 });
    const status = await sup.start();
    expect(status.workspaceRuntimeError).toBeUndefined();
    expect(startWorkspaceRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ apiUrl: 'http://127.0.0.1:9', bootstrapSecret: expect.any(String) })
    );
    await sup.stop();
    expect(runtime.stop).toHaveBeenCalledTimes(1);
  });

  it('keeps the service running and reports why local workspaces are unavailable', async () => {
    const output: string[] = [];
    const { sup } = supervisor({
      startWorkspaceRuntime: async () => {
        throw new Error('Start Docker Desktop, then retry.');
      },
      onOutput: (chunk) => output.push(chunk),
    });
    const status = await sup.start();
    expect(status).toMatchObject({
      state: 'running',
      workspaceRuntimeError: 'Local workspaces are unavailable: Start Docker Desktop, then retry.',
    });
    expect(output.join('')).toContain('Local workspaces unavailable');
    expect(await sup.stop()).toMatchObject({ state: 'stopped' });
  });

  it('logs but tolerates a failing node stop', async () => {
    const output: string[] = [];
    const { sup } = supervisor({
      startWorkspaceRuntime: async () => ({
        stop: async () => {
          throw new Error('docker gone');
        },
      }),
      onOutput: (chunk) => output.push(chunk),
    });
    await sup.start();
    expect(await sup.stop()).toMatchObject({ state: 'stopped' });
    expect(output.join('')).toContain('Local node stop failed');
  });

  it('reports an unexpected runtime exit as failed', async () => {
    const { sup, api } = supervisor();
    await sup.start();
    api.crash();
    await new Promise((r) => setTimeout(r, 0));
    expect(sup.status).toMatchObject({ state: 'failed', error: /unexpectedly/ });
  });

  it('reports failed startup steps truthfully and stops a half-started runtime', async () => {
    const api = fakeApi();
    const { sup } = supervisor({
      startApi: async () => api,
      fetchImpl: (async () => new Response('', { status: 401 })) as unknown as typeof fetch,
    });
    expect(await sup.start()).toMatchObject({ state: 'failed', error: /HTTP 401/ });
    expect(api.stop).toHaveBeenCalled();
    // Nothing is running after a failed start, so quitting must be possible.
    expect(await sup.stop()).toMatchObject({ state: 'stopped' });

    const noCookie = supervisor({
      fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch,
    }).sup;
    expect(await noCookie.start()).toMatchObject({ error: /did not issue/ });

    const migrationFails = supervisor({
      migrate: async () => {
        throw new Error('bad migration');
      },
    }).sup;
    expect(await migrationFails.start()).toMatchObject({ state: 'failed', error: /bad migration/ });
  });

  it('waits for an in-flight startup on stop so its process is not orphaned', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { sup, api } = supervisor({
      probePrerequisites: async () => {
        await gate;
        return { dockerDesktop: 'ready', wsl2: 'ready' };
      },
    });
    const starting = sup.start();
    const again = sup.start();
    await new Promise((r) => setTimeout(r, 20));
    const stopping = sup.stop();
    release();
    expect((await starting).state).toBe((await again).state);
    expect(await stopping).toMatchObject({ state: 'stopped' });
    expect(api.stop).toHaveBeenCalled();
  });

  it('renews the local session only while running', async () => {
    const { sup } = supervisor();
    await expect(sup.renewSession()).rejects.toThrow(/not running/);
    await sup.start();
    expect(await sup.renewSession()).toMatchObject({ name: 'sam_local_session', value: COOKIE });
    expect(sessionRenewalDelayMs(1_000_000, 0)).toBe(1_000_000 - 600_000);
    expect(sessionRenewalDelayMs(0, 0)).toBe(60_000);
    expect(sessionRenewalDelayMs(Number.MAX_SAFE_INTEGER, 0)).toBe(2_147_483_647);
    expect(sessionRenewalDelayMs(100_000, 0, { marginMs: 30_000, minMs: 5_000 })).toBe(70_000);
    expect(sessionRenewalDelayMs(0, 0, { minMs: 5_000 })).toBe(5_000);
    expect(
      sessionRenewalTimingFromEnv({
        SAM_LOCAL_SESSION_RENEW_MARGIN_MS: '30000',
        SAM_LOCAL_SESSION_RENEW_MIN_MS: 'bad',
      })
    ).toEqual({ marginMs: 30_000, minMs: 60_000 });
  });

  it('reports a crash during startup instead of running', async () => {
    const api = fakeApi();
    const { sup } = supervisor({
      startApi: async () => api,
      probePrerequisites: async () => {
        api.crash();
        await new Promise((r) => setTimeout(r, 0));
        return { dockerDesktop: 'ready', wsl2: 'ready' };
      },
    });
    expect(await sup.start()).toMatchObject({ state: 'failed', error: /unexpectedly/ });
  });

  it('reports a stop that fails and an active-work read that fails', async () => {
    const api = fakeApi();
    api.stop = vi.fn(async () => {
      throw new Error('hung');
    });
    const { sup } = supervisor({ startApi: async () => api });
    await sup.start();
    expect(await sup.stop()).toMatchObject({ state: 'failed', error: /could not stop.*hung/ });

    const broken = supervisor({
      fetchImpl: vi.fn(async (url: string) =>
        url.endsWith('/api/workspaces')
          ? new Response('', { status: 500 })
          : url.endsWith('/api/local/session')
            ? new Response('{}', { headers: { 'set-cookie': `sam_local_session=${COOKIE};` } })
            : new Response('{}')
      ) as unknown as typeof fetch,
    }).sup;
    await broken.start();
    await expect(broken.activeWorkCount()).rejects.toThrow(/HTTP 500/);
  });

  it('surfaces prerequisite report failures', async () => {
    const { sup } = supervisor({
      fetchImpl: vi.fn(async (url: string) =>
        url.endsWith('/api/local/session')
          ? new Response('{}', { headers: { 'set-cookie': `sam_local_session=${COOKIE};` } })
          : new Response('', { status: 500 })
      ) as unknown as typeof fetch,
    });
    expect(await sup.start()).toMatchObject({ state: 'failed', error: /Prerequisite report/ });
    expect(await sup.reportPrerequisites()).toEqual({ dockerDesktop: 'ready', wsl2: 'ready' });
  });
});
