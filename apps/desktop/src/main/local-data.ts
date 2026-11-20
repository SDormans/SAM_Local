/**
 * App-owned, versioned local data directory (spec 036, T008). The location is derived from
 * the per-user application data path, never from a repository or working directory.
 */
import { randomUUID } from 'node:crypto';
import {
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export const LOCAL_DATA_DEFAULTS = {
  keepBackups: 3,
  diskReserveBytes: 64 * 1024 * 1024,
} as const;

export interface DataDirectoryInput {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  homedir?: string;
}

export function resolveDataDirectory(input: DataDirectoryInput = {}): string {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const home = input.homedir ?? osHomedir();
  const override = env.SAM_LOCAL_DATA_DIR;
  if (override) {
    if (!isAbsolute(override)) throw new Error('SAM_LOCAL_DATA_DIR must be an absolute path');
    return override;
  }
  if (platform === 'win32') {
    return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'SAM', 'data');
  }
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'SAM', 'data');
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'sam-local', 'data');
}

export interface InstallationRecord {
  installationId: string;
  schemaVersion: number;
  runtimeMode: 'local';
  createdAt: string;
}

export type LocalDataErrorCode = 'disk_full' | 'migration_failed' | 'corrupt_installation';

export class LocalDataError extends Error {
  constructor(
    public readonly code: LocalDataErrorCode,
    message: string,
    public readonly backupPath?: string
  ) {
    super(message);
    this.name = 'LocalDataError';
  }
}

function isRecord(value: unknown): value is InstallationRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.installationId === 'string' &&
    Number.isInteger(r.schemaVersion) &&
    r.runtimeMode === 'local' &&
    typeof r.createdAt === 'string'
  );
}

async function directorySize(path: string): Promise<number> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const entry of entries) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? await directorySize(child) : (await stat(child)).size;
  }
  return total;
}

function isNoSpace(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOSPC';
}

/** Highest numeric prefix among `NNNN_*.sql` D1 migrations; the target schema version. */
export async function latestMigrationVersion(migrationsDir: string): Promise<number> {
  const names = await readdir(migrationsDir);
  return names.reduce((max, name) => {
    const match = /^(\d+)_.*\.sql$/.exec(name);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
}

export interface UpgradeOptions {
  keepBackups?: number;
  diskReserveBytes?: number;
  /** Test seam; defaults to `statfs` on the data directory. */
  freeBytes?: () => Promise<number>;
  now?: () => Date;
}

export interface UpgradeResult {
  from: number;
  to: number;
  backupPath?: string;
}

export class LocalDataStore {
  readonly installationFile: string;
  readonly stateDir: string;
  readonly backupsDir: string;
  readonly runtimeDir: string;

  constructor(readonly root: string) {
    if (!isAbsolute(root)) throw new Error('data directory must be absolute');
    this.installationFile = join(root, 'installation.json');
    this.stateDir = join(root, 'state');
    this.backupsDir = join(root, 'backups');
    this.runtimeDir = join(root, 'runtime');
  }

  async readInstallation(): Promise<InstallationRecord | null> {
    const raw = await readFile(this.installationFile, 'utf8').catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (!isRecord(parsed)) {
      throw new LocalDataError('corrupt_installation', `Unreadable ${this.installationFile}`);
    }
    return parsed;
  }

  private async writeInstallation(record: InstallationRecord): Promise<void> {
    const tmp = `${this.installationFile}.tmp`;
    await writeFile(tmp, JSON.stringify(record, null, 2));
    await rename(tmp, this.installationFile);
  }

  /** Creates the directory layout and installation identity on first run. */
  async init(now: Date = new Date()): Promise<InstallationRecord> {
    for (const dir of [this.root, this.stateDir, this.backupsDir, this.runtimeDir]) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    }
    const existing = await this.readInstallation();
    if (existing) return existing;
    const record: InstallationRecord = {
      installationId: randomUUID(),
      schemaVersion: 0,
      runtimeMode: 'local',
      createdAt: now.toISOString(),
    };
    await this.writeInstallation(record);
    return record;
  }

  private async freeBytes(): Promise<number> {
    const fs = await statfs(this.root);
    return fs.bavail * fs.bsize;
  }

  /**
   * Backs up the state directory, runs `migrate`, and records the new schema version.
   * A failed migration restores the backup; insufficient disk space aborts before any change.
   */
  async upgrade(
    targetVersion: number,
    migrate: () => Promise<void>,
    options: UpgradeOptions = {}
  ): Promise<UpgradeResult> {
    const record = await this.init();
    const from = record.schemaVersion;
    if (from >= targetVersion) return { from, to: from };

    const reserve = options.diskReserveBytes ?? LOCAL_DATA_DEFAULTS.diskReserveBytes;
    const required = (await directorySize(this.stateDir)) + reserve;
    const free = await (options.freeBytes ?? (() => this.freeBytes()))();
    if (free < required) {
      throw new LocalDataError(
        'disk_full',
        `Not enough free disk space to back up local data before upgrading (need ${required} bytes, have ${free})`
      );
    }

    const stamp = (options.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-');
    const backupPath = join(this.backupsDir, `${stamp}-v${from}`);
    try {
      await cp(this.stateDir, backupPath, { recursive: true, errorOnExist: true });
    } catch (error) {
      await rm(backupPath, { recursive: true, force: true });
      if (isNoSpace(error)) {
        throw new LocalDataError('disk_full', 'Disk filled while backing up local data');
      }
      throw error;
    }

    try {
      await migrate();
    } catch (error) {
      await rm(this.stateDir, { recursive: true, force: true });
      await cp(backupPath, this.stateDir, { recursive: true });
      throw new LocalDataError(
        isNoSpace(error) ? 'disk_full' : 'migration_failed',
        `Local data upgrade from v${from} to v${targetVersion} failed; the previous data was restored (${
          error instanceof Error ? error.message : String(error)
        })`,
        backupPath
      );
    }

    await this.writeInstallation({ ...record, schemaVersion: targetVersion });
    await this.pruneBackups(options.keepBackups ?? LOCAL_DATA_DEFAULTS.keepBackups);
    return { from, to: targetVersion, backupPath };
  }

  async listBackups(): Promise<string[]> {
    const names = await readdir(this.backupsDir).catch(() => []);
    return names.sort();
  }

  private async pruneBackups(keep: number): Promise<void> {
    const names = await this.listBackups();
    for (const name of names.slice(0, Math.max(0, names.length - keep))) {
      await rm(join(this.backupsDir, name), { recursive: true, force: true });
    }
  }
}
