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

/** Reads the installation secrets, creating them on first run. Files are owner-only (0600). */
export async function loadOrCreateRuntimeSecrets(path: string): Promise<LocalRuntimeSecrets> {
  const existing = await readFile(path, 'utf8').then(parseSecrets, () => null);
  if (existing) return existing;
  const secrets = generateRuntimeSecrets();
  await writeFile(path, JSON.stringify(secrets), { mode: 0o600 });
  return secrets;
}

/** Renders the `.dev.vars` file wrangler reads next to the generated config. */
export function renderDevVars(secrets: LocalRuntimeSecrets): string {
  return SECRET_NAMES.map((name) => `${name}=${JSON.stringify(secrets[name])}`).join('\n') + '\n';
}
