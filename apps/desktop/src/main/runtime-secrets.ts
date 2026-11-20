/**
 * Per-installation runtime secrets for the local API (signing/encryption keys and the
 * bootstrap secret used to mint local sessions). Provider credentials are NOT stored here.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

export interface LocalRuntimeSecrets {
  ENCRYPTION_KEY: string;
  BETTER_AUTH_SECRET: string;
  JWT_PRIVATE_KEY: string;
  JWT_PUBLIC_KEY: string;
  LOCAL_BOOTSTRAP_SECRET: string;
}

const SECRET_NAMES: readonly (keyof LocalRuntimeSecrets)[] = [
  'ENCRYPTION_KEY',
  'BETTER_AUTH_SECRET',
  'JWT_PRIVATE_KEY',
  'JWT_PUBLIC_KEY',
  'LOCAL_BOOTSTRAP_SECRET',
];

/** OS user-protected encryption (Electron `safeStorage`: DPAPI on Windows). */
export interface SecretProtector {
  isAvailable(): boolean;
  encrypt(plaintext: string): Buffer;
  decrypt(ciphertext: Buffer): string;
}

function serialize(secrets: LocalRuntimeSecrets, protector?: SecretProtector): string {
  const json = JSON.stringify(secrets);
  return protector?.isAvailable()
    ? JSON.stringify({ protected: protector.encrypt(json).toString('base64') })
    : json;
}

function unwrap(raw: string, protector?: SecretProtector): { json: string; wasProtected: boolean } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { json: raw, wasProtected: false };
  }
  const sealed = (value as { protected?: unknown } | null)?.protected;
  if (typeof sealed !== 'string') return { json: raw, wasProtected: false };
  if (!protector?.isAvailable()) {
    throw new Error('Local runtime secrets are protected, but OS protected storage is unavailable');
  }
  return { json: protector.decrypt(Buffer.from(sealed, 'base64')), wasProtected: true };
}

export function generateRuntimeSecrets(): LocalRuntimeSecrets {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return {
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
    JWT_PRIVATE_KEY: privateKey,
    JWT_PUBLIC_KEY: publicKey,
    LOCAL_BOOTSTRAP_SECRET: randomBytes(32).toString('base64url'),
  };
}

function parseSecrets(raw: string): LocalRuntimeSecrets | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!SECRET_NAMES.every((name) => typeof record[name] === 'string' && record[name] !== '')) {
    return null;
  }
  return record as unknown as LocalRuntimeSecrets;
}

/**
 * Reads the installation secrets, creating them only when none exist yet. An unreadable file
 * is an error, never a reason to regenerate: credentials encrypted with the old
 * `ENCRYPTION_KEY` would become unreadable. Files are owner-only (0600) and, when OS
 * protected storage is available, encrypted with it.
 */
export async function loadOrCreateRuntimeSecrets(
  path: string,
  protector?: SecretProtector
): Promise<LocalRuntimeSecrets> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const secrets = generateRuntimeSecrets();
    await writeFile(path, serialize(secrets, protector), { mode: 0o600, flag: 'wx' });
    return secrets;
  }
  const { json, wasProtected } = unwrap(raw, protector);
  const existing = parseSecrets(json);
  if (!existing) {
    throw new Error(
      `Local runtime secrets at ${path} are unreadable; restore them from a backup instead of regenerating them`
    );
  }
  if (!wasProtected && protector?.isAvailable()) {
    // Upgrade an owner-only plaintext file from an earlier version to protected storage.
    await writeFile(path, serialize(existing, protector), { mode: 0o600 });
  }
  return existing;
}

/** Renders the `.dev.vars` file wrangler reads next to the generated config. */
export function renderDevVars(secrets: LocalRuntimeSecrets): string {
  return SECRET_NAMES.map((name) => `${name}=${JSON.stringify(secrets[name])}`).join('\n') + '\n';
}
