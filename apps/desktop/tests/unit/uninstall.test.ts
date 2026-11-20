import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { parseUninstallArg, performUninstall } from '../../src/main/uninstall';

const report = { removed: ['container:a'], failed: [], complete: true };

async function dataDir() {
  const dir = await mkdtemp(join(tmpdir(), 'sam-data-'));
  await writeFile(join(dir, 'installation.json'), '{}');
  return dir;
}

describe('uninstall', () => {
  it('parses only explicit choices', () => {
    expect(parseUninstallArg(['sam'])).toBeNull();
    expect(parseUninstallArg(['--uninstall=retain'])).toBe('retain');
    expect(parseUninstallArg(['--uninstall=delete'])).toBe('delete');
    expect(() => parseUninstallArg(['--uninstall=yes'])).toThrow(/retain/);
  });

  it('retain removes containers and keeps local data', async () => {
    const dir = await dataDir();
    const removeContainers = vi.fn(async () => report);
    const result = await performUninstall({ choice: 'retain', dataDir: dir, removeContainers });
    expect(removeContainers).toHaveBeenCalled();
    expect(result).toEqual({ choice: 'retain', containers: report, dataDeleted: false });
    await expect(stat(join(dir, 'installation.json'))).resolves.toBeTruthy();
  });

  it('delete tolerates a data directory that is already gone', async () => {
    const dir = await dataDir();
    const result = await performUninstall({
      choice: 'delete',
      dataDir: join(dir, 'missing'),
      removeContainers: async () => {
        throw 'no docker';
      },
    });
    expect(result).toMatchObject({
      choice: 'delete',
      containers: { skipped: 'Docker is not available' },
    });
  });

  it('delete removes local data even when Docker is unavailable', async () => {
    const dir = await dataDir();
    const result = await performUninstall({
      choice: 'delete',
      dataDir: dir,
      removeContainers: async () => {
        throw new Error('Docker Desktop is not running');
      },
    });
    expect(result.dataDeleted).toBe(true);
    expect(result.containers).toEqual({ skipped: 'Docker Desktop is not running' });
    await expect(stat(dir)).rejects.toThrow();
  });

  it('delete keeps files SAM did not create in the data directory', async () => {
    const dir = await dataDir();
    await writeFile(join(dir, 'notes.txt'), 'mine');
    await performUninstall({
      choice: 'delete',
      dataDir: dir,
      removeContainers: async () => report,
    });
    await expect(stat(join(dir, 'notes.txt'))).resolves.toBeTruthy();
    await expect(stat(join(dir, 'installation.json'))).rejects.toThrow();
  });
});
