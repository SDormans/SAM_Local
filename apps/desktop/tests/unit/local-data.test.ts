import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  latestMigrationVersion,
  LocalDataError,
  LocalDataStore,
  resolveDataDirectory,
} from '../../src/main/local-data';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sam-local-data-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('resolveDataDirectory', () => {
  it('uses the per-user application data path, never the working directory', () => {
    expect(
      resolveDataDirectory({
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' },
        homedir: 'C:\\Users\\a',
      })
    ).toContain(join('SAM', 'data'));
    expect(resolveDataDirectory({ platform: 'win32', env: {}, homedir: '/h' })).toBe(
      join('/h', 'AppData', 'Local', 'SAM', 'data')
    );
    expect(resolveDataDirectory({ platform: 'linux', env: {}, homedir: '/h' })).toBe(
      '/h/.local/share/sam-local/data'
    );
    expect(
      resolveDataDirectory({ platform: 'linux', env: { XDG_DATA_HOME: '/x' }, homedir: '/h' })
    ).toBe('/x/sam-local/data');
    expect(resolveDataDirectory({ platform: 'darwin', env: {}, homedir: '/h' })).toBe(
      '/h/Library/Application Support/SAM/data'
    );
    expect(resolveDataDirectory({ env: { SAM_LOCAL_DATA_DIR: '/abs' } })).toBe('/abs');
    expect(() => resolveDataDirectory({ env: { SAM_LOCAL_DATA_DIR: 'rel' } })).toThrow();
  });
});

describe('LocalDataStore', () => {
  it('rejects relative roots', () => {
    expect(() => new LocalDataStore('rel')).toThrow();
  });

  it('creates a stable installation identity once', async () => {
    const store = new LocalDataStore(root);
    const first = await store.init();
    expect(first).toMatchObject({ schemaVersion: 0, runtimeMode: 'local' });
    expect((await store.init()).installationId).toBe(first.installationId);
  });

  it('reports a corrupt installation record instead of silently replacing it', async () => {
    const store = new LocalDataStore(root);
    await writeFile(store.installationFile, '{nope');
    await expect(store.readInstallation()).rejects.toMatchObject({ code: 'corrupt_installation' });
  });

  it('backs up before migrating, records the version, and prunes old backups', async () => {
    const store = new LocalDataStore(root);
    await store.init();
    await writeFile(join(store.stateDir, 'db.sqlite'), 'v0');
    let n = 0;
    const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, n++));
    for (const target of [1, 2, 3, 4]) {
      const result = await store.upgrade(
        target,
        async () => writeFile(join(store.stateDir, 'db.sqlite'), `v${target}`),
        { now, freeBytes: async () => Number.MAX_SAFE_INTEGER, keepBackups: 2 }
      );
      expect(result).toMatchObject({ from: target - 1, to: target });
      expect(await readFile(join(result.backupPath!, 'db.sqlite'), 'utf8')).toBe(`v${target - 1}`);
    }
    expect((await store.readInstallation())?.schemaVersion).toBe(4);
    expect(await store.listBackups()).toHaveLength(2);
    expect(
      await store.upgrade(4, async () => {
        throw new Error('must not run');
      })
    ).toEqual({ from: 4, to: 4 });
  });

  it('restores the previous data when a migration fails', async () => {
    const store = new LocalDataStore(root);
    await store.init();
    await writeFile(join(store.stateDir, 'db.sqlite'), 'good');
    const error = await store
      .upgrade(
        5,
        async () => {
          await writeFile(join(store.stateDir, 'db.sqlite'), 'half-migrated');
          throw new Error('boom');
        },
        { freeBytes: async () => Number.MAX_SAFE_INTEGER }
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LocalDataError);
    expect((error as LocalDataError).code).toBe('migration_failed');
    expect((error as LocalDataError).backupPath).toBeTruthy();
    expect(await readFile(join(store.stateDir, 'db.sqlite'), 'utf8')).toBe('good');
    expect((await store.readInstallation())?.schemaVersion).toBe(0);
  });

  it('reports disk-full during migration and keeps the prior data', async () => {
    const store = new LocalDataStore(root);
    await store.init();
    await writeFile(join(store.stateDir, 'db.sqlite'), 'good');
    const error = await store
      .upgrade(
        1,
        async () => {
          throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
        },
        { freeBytes: async () => Number.MAX_SAFE_INTEGER }
      )
      .catch((e: unknown) => e);
    expect((error as LocalDataError).code).toBe('disk_full');
    expect(await readFile(join(store.stateDir, 'db.sqlite'), 'utf8')).toBe('good');
  });

  it('refuses to upgrade without room for a backup and changes nothing', async () => {
    const store = new LocalDataStore(root);
    await store.init();
    await writeFile(join(store.stateDir, 'db.sqlite'), 'x'.repeat(1000));
    let migrated = false;
    await expect(
      store.upgrade(1, async () => void (migrated = true), {
        freeBytes: async () => 500,
        diskReserveBytes: 0,
      })
    ).rejects.toMatchObject({ code: 'disk_full' });
    expect(migrated).toBe(false);
    expect(await store.listBackups()).toEqual([]);
  });

  it('measures free space on the real filesystem by default', async () => {
    const store = new LocalDataStore(root);
    await store.init();
    await expect(
      store.upgrade(1, async () => undefined, { diskReserveBytes: 0 })
    ).resolves.toMatchObject({ to: 1 });
  });
});

describe('latestMigrationVersion', () => {
  it('returns the highest numbered SQL migration', async () => {
    const dir = join(root, 'm');
    await mkdir(dir);
    for (const name of ['0000_a.sql', '0012_b.sql', '0003_c.sql', 'README.md']) {
      await writeFile(join(dir, name), '');
    }
    expect(await latestMigrationVersion(dir)).toBe(12);
  });
});
