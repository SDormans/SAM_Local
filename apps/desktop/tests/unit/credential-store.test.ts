import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CredentialStore,
  type RunningCredentialBroker,
  startCredentialBroker,
} from '../../src/main/credential-store';
import type { SecretProtector } from '../../src/main/runtime-secrets';

const xor = (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x5a));
const protector: SecretProtector = {
  isAvailable: () => true,
  encrypt: (s) => xor(Buffer.from(s)),
  decrypt: (b) => xor(b).toString(),
};
const SECRET = 'b'.repeat(43);

async function store() {
  const path = join(await mkdtemp(join(tmpdir(), 'sam-creds-')), 'credentials.json');
  return { path, store: new CredentialStore(path, protector, false) };
}

describe('desktop credential store', () => {
  it('refuses to save without OS protection and keeps concurrent saves', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'sam-creds-')), 'c.json');
    await expect(
      new CredentialStore(path, { ...protector, isAvailable: () => false }, false).put('x')
    ).rejects.toThrow(/not saved/);
    const s = new CredentialStore(path, protector, false);
    const refs = await Promise.all(['a', 'b', 'c'].map((v) => s.put(v)));
    expect((await s.list()).sort()).toEqual([...refs].sort());
    expect(await s.list(60_000)).toEqual([]);
  });

  let broker: RunningCredentialBroker | undefined;
  afterEach(async () => {
    await broker?.stop();
    broker = undefined;
  });

  it('seals values on disk and removes them', async () => {
    const { path, store: s } = await store();
    const ref = await s.put('sk-live-123');
    expect(await readFile(path, 'utf8')).not.toContain('sk-live-123');
    expect(await s.get(ref)).toBe('sk-live-123');
    expect(await s.remove(ref)).toBe(true);
    expect(await s.get(ref)).toBeNull();
  });

  it('serves only loopback callers holding the bootstrap secret', async () => {
    broker = await startCredentialBroker((await store()).store, SECRET);
    expect(broker.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const auth = { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' };
    expect((await fetch(`${broker.url}/secrets`)).status).toBe(401);
    const created = await fetch(`${broker.url}/secrets`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ value: 'sk-abc' }),
    });
    expect(created.status).toBe(201);
    const { ref } = (await created.json()) as { ref: string };
    const read = await fetch(`${broker.url}/secrets/${ref}`, { headers: auth });
    expect(await read.json()).toEqual({ value: 'sk-abc' });
    expect(await (await fetch(`${broker.url}/secrets`, { headers: auth })).json()).toEqual({
      refs: [ref],
    });
    await fetch(`${broker.url}/secrets/${ref}`, { method: 'DELETE', headers: auth });
    expect((await fetch(`${broker.url}/secrets/${ref}`, { headers: auth })).status).toBe(404);
  });
});
