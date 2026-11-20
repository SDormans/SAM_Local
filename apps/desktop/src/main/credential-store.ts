/**
 * Spec 036 T035: provider credentials for the local API, kept outside the database and sealed
 * with OS protected storage (Electron `safeStorage`, DPAPI on Windows). The local API reaches
 * this store over a loopback-only HTTP endpoint authenticated with the bootstrap secret, and
 * stores only opaque references.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { SecretProtector } from './runtime-secrets.js';

interface StoredEntry {
  sealed: string;
  protected: boolean;
  createdAt?: number;
}

const MAX_BODY_BYTES = 256 * 1024;
const REF_PATTERN = /^[0-9a-f-]{36}$/;

export class CredentialStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly protector?: SecretProtector,
    private readonly allowUnprotected = process.env.SAM_ALLOW_UNPROTECTED_CREDENTIALS === '1'
  ) {}

  /** Serializes read-modify-write cycles so concurrent saves cannot drop each other. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<Record<string, StoredEntry>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('Credential store file is malformed');
      }
      return parsed as Record<string, StoredEntry>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  private async save(entries: Record<string, StoredEntry>): Promise<void> {
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(entries), { mode: 0o600 });
    await rename(tmp, this.path);
  }

  put(value: string): Promise<string> {
    const protector = this.protector?.isAvailable() ? this.protector : undefined;
    const sealed = protector !== undefined;
    if (!sealed && !this.allowUnprotected) {
      return Promise.reject(
        new Error('OS protected storage is unavailable; the credential was not saved')
      );
    }
    return this.exclusive(async () => {
      const entries = await this.load();
      const ref = randomUUID();
      entries[ref] = {
        sealed: protector
          ? protector.encrypt(value).toString('base64')
          : Buffer.from(value).toString('base64'),
        protected: sealed,
        createdAt: Date.now(),
      };
      await this.save(entries);
      return ref;
    });
  }

  async get(ref: string): Promise<string | null> {
    const entry = (await this.load())[ref];
    if (!entry) return null;
    const bytes = Buffer.from(entry.sealed, 'base64');
    if (!entry.protected) return bytes.toString();
    if (!this.protector?.isAvailable()) throw new Error('OS protected storage is unavailable');
    return this.protector.decrypt(bytes);
  }

  /** References older than `minAgeMs`, so a sweep never races a save still being recorded. */
  async list(minAgeMs = 0): Promise<string[]> {
    const cutoff = Date.now() - minAgeMs;
    return Object.entries(await this.load())
      .filter(([, e]) => (e.createdAt ?? 0) <= cutoff)
      .map(([ref]) => ref);
  }

  remove(ref: string): Promise<boolean> {
    return this.exclusive(() => this.removeNow(ref));
  }

  private async removeNow(ref: string): Promise<boolean> {
    const entries = await this.load();
    if (!(ref in entries)) return false;
    delete entries[ref];
    await this.save(entries);
    return true;
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString();
}

function authorized(header: string | undefined, secret: string): boolean {
  const presented = Buffer.from(header?.startsWith('Bearer ') ? header.slice(7) : '');
  const expected = Buffer.from(secret);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

export interface RunningCredentialBroker {
  url: string;
  stop(): Promise<void>;
}

/** Serves the store on 127.0.0.1 only; every request needs the bootstrap secret. */
export async function startCredentialBroker(
  store: CredentialStore,
  bootstrapSecret: string
): Promise<RunningCredentialBroker> {
  const server: Server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    void (async () => {
      if (!authorized(req.headers.authorization, bootstrapSecret)) return send(401, {});
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (path === '/secrets' && req.method === 'GET') {
        const minAge = Number(
          new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('minAgeMs') ?? 0
        );
        return send(200, { refs: await store.list(Number.isFinite(minAge) ? minAge : 0) });
      }
      if (path === '/secrets' && req.method === 'POST') {
        const body: unknown = JSON.parse(await readBody(req));
        const value =
          typeof body === 'object' && body !== null
            ? (body as { value?: unknown }).value
            : undefined;
        if (typeof value !== 'string') return send(400, {});
        return send(201, { ref: await store.put(value) });
      }
      const ref = path.startsWith('/secrets/') ? decodeURIComponent(path.slice(9)) : '';
      if (!REF_PATTERN.test(ref)) return send(404, {});
      if (req.method === 'GET') {
        const value = await store.get(ref);
        return value === null ? send(404, {}) : send(200, { value });
      }
      if (req.method === 'DELETE') return send(200, { removed: await store.remove(ref) });
      return send(405, {});
    })().catch(() => send(500, {}));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
