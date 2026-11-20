import { describe, expect, it } from 'vitest';

import type { Env } from '../../../src/env';
import {
  readLocalPrerequisites,
  summarizeLocalHealth,
  writeLocalPrerequisites,
} from '../../../src/local/local-health';
import {
  localProjectPathKey,
  normalizeLocalProjectPath,
} from '../../../src/routes/projects/project-create';

function kvEnv() {
  const store = new Map<string, string>();
  return {
    store,
    env: {
      KV: {
        get: async (k: string) => store.get(k) ?? null,
        put: async (k: string, v: string) => void store.set(k, v),
      },
    } as unknown as Env,
  };
}

const okDb = { DATABASE: { prepare: () => ({ first: async () => null }) } } as unknown as Env;
const brokenDb = {
  DATABASE: {
    prepare: () => ({
      first: async () => {
        throw new Error('no such table');
      },
    }),
  },
} as unknown as Env;

describe('local health', () => {
  it('reports unknown prerequisites until the desktop supervisor reports them', async () => {
    const { env, store } = kvEnv();
    expect(await readLocalPrerequisites(env)).toMatchObject({
      dockerDesktop: 'unavailable',
      wsl2: 'unavailable',
      message: expect.stringMatching(/not reported/),
    });
    store.set('local-runtime:prerequisites', '{bad');
    expect((await readLocalPrerequisites(env)).dockerDesktop).toBe('unavailable');
    await writeLocalPrerequisites(env, { dockerDesktop: 'ready', wsl2: 'ready' });
    expect(await readLocalPrerequisites(env)).toEqual({ dockerDesktop: 'ready', wsl2: 'ready' });
  });

  it('summarizes ready, degraded, and unavailable states', async () => {
    expect(await summarizeLocalHealth(okDb, { dockerDesktop: 'ready', wsl2: 'ready' })).toEqual({
      status: 'ready',
      dockerDesktop: 'ready',
      wsl2: 'ready',
      dataStore: 'ready',
    });
    expect(
      await summarizeLocalHealth(okDb, {
        dockerDesktop: 'stopped',
        wsl2: 'ready',
        message: 'Start Docker Desktop',
      })
    ).toMatchObject({ status: 'degraded', message: 'Start Docker Desktop' });
    expect(
      await summarizeLocalHealth(brokenDb, { dockerDesktop: 'ready', wsl2: 'ready' })
    ).toMatchObject({ status: 'unavailable', dataStore: 'unavailable' });
  });
});

describe('normalizeLocalProjectPath', () => {
  it('accepts absolute Windows and POSIX folders and trims trailing separators', () => {
    expect(normalizeLocalProjectPath('C:\\Users\\me\\code\\demo\\')).toBe(
      'C:\\Users\\me\\code\\demo'
    );
    expect(normalizeLocalProjectPath('D:/work/app')).toBe('D:\\work\\app');
    expect(normalizeLocalProjectPath('c:/code//demo/')).toBe('C:\\code\\demo');
    expect(normalizeLocalProjectPath('/home//me/app')).toBe('/home/me/app');
    expect(localProjectPathKey(normalizeLocalProjectPath('C:\\Code\\Demo'))).toBe(
      localProjectPathKey(normalizeLocalProjectPath('c:/code/demo'))
    );
    expect(localProjectPathKey('/home/Me')).not.toBe(localProjectPathKey('/home/me'));
    // Rows saved before separator normalization still match.
    expect(localProjectPathKey('D:/work//app/')).toBe(localProjectPathKey('D:\\work\\app'));
    expect(localProjectPathKey('/home//me/app/')).toBe('/home/me/app');
    expect(normalizeLocalProjectPath(' /home/me/app/ ')).toBe('/home/me/app');
    expect(normalizeLocalProjectPath('C:\\')).toBe('C:\\');
    expect(normalizeLocalProjectPath('/')).toBe('/');
  });

  it('rejects relative, traversal, control-character, and missing paths', () => {
    for (const bad of [
      undefined,
      '',
      'code/app',
      '..\\x',
      'C:relative',
      'C:\\a\\..\\b',
      '/a/../b',
      '/a\u0000b',
    ]) {
      expect(() => normalizeLocalProjectPath(bad), String(bad)).toThrow();
    }
  });
});
