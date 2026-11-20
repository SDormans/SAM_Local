import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  generateRuntimeSecrets,
  loadOrCreateRuntimeSecrets,
  type SecretProtector,
} from '../../src/main/runtime-secrets';

const xor = (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x5a));
const protector: SecretProtector = {
  isAvailable: () => true,
  encrypt: (s) => xor(Buffer.from(s)),
  decrypt: (b) => xor(b).toString(),
};

async function tempFile() {
  return join(await mkdtemp(join(tmpdir(), 'sam-secrets-')), 'secrets.json');
}

describe('runtime secrets protection', () => {
  it('writes protected secrets and reads them back', async () => {
    const path = await tempFile();
    const created = await loadOrCreateRuntimeSecrets(path, protector);
    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain(created.ENCRYPTION_KEY);
    expect(JSON.parse(raw)).toHaveProperty('protected');
    await expect(loadOrCreateRuntimeSecrets(path, protector)).resolves.toEqual(created);
  });

  it('upgrades an earlier plaintext file without changing the keys', async () => {
    const path = await tempFile();
    const legacy = generateRuntimeSecrets();
    await writeFile(path, JSON.stringify(legacy));
    await expect(loadOrCreateRuntimeSecrets(path, protector)).resolves.toEqual(legacy);
    expect(await readFile(path, 'utf8')).not.toContain(legacy.ENCRYPTION_KEY);
  });

  it('refuses to regenerate when protected storage is unavailable', async () => {
    const path = await tempFile();
    await loadOrCreateRuntimeSecrets(path, protector);
    await expect(
      loadOrCreateRuntimeSecrets(path, { ...protector, isAvailable: () => false })
    ).rejects.toThrow(/protected storage is unavailable/);
  });
});
