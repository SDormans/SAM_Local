/** Spec 036 T035: sealing and cleanup for credentials kept in the desktop credential store. */
import type { Env } from '../env';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { encrypt } from '../services/encryption';
import {
  brokerRequest,
  LOCAL_SECRET_REF_IV,
  LOCAL_SECRET_REF_PREFIX,
  registerLocalSecretBroker,
} from './local-secret-broker';

type SealEnv = Pick<
  Env,
  | 'ENCRYPTION_KEY'
  | 'CREDENTIAL_ENCRYPTION_KEY'
  | 'SAM_RUNTIME_MODE'
  | 'LOCAL_SECRET_BROKER_URL'
  | 'LOCAL_BOOTSTRAP_SECRET'
>;

/**
 * Encrypts a provider credential for the `credentials`/`cc_credentials` tables. In the desktop
 * runtime the secret goes to the desktop store and only a reference is returned; elsewhere
 * this is the existing AES-GCM encryption.
 */
export async function sealCredential(
  env: SealEnv,
  plaintext: string
): Promise<{ ciphertext: string; iv: string }> {
  const broker = registerLocalSecretBroker(env);
  if (!broker) return encrypt(plaintext, getCredentialEncryptionKey(env));
  const { ref } = await brokerRequest<{ ref: string }>(broker, '/secrets', {
    method: 'POST',
    body: JSON.stringify({ value: plaintext }),
  });
  return { ciphertext: `${LOCAL_SECRET_REF_PREFIX}${ref}`, iv: LOCAL_SECRET_REF_IV };
}

/** Entries younger than this may belong to a save whose row is not written yet. */
const SWEEP_MIN_AGE_MS = 10 * 60 * 1000;

/** References to desktop-stored secrets that credential rows currently hold. */
export async function referencedLocalSecrets(env: Env): Promise<Set<string>> {
  const referenced = new Set<string>();
  for (const table of ['credentials', 'cc_credentials']) {
    const { results } = await env.DATABASE.prepare(
      `SELECT encrypted_token AS token FROM ${table} WHERE encrypted_token LIKE ?`
    )
      .bind(`${LOCAL_SECRET_REF_PREFIX}%`)
      .all<{ token: string }>();
    for (const row of results) referenced.add(row.token.slice(LOCAL_SECRET_REF_PREFIX.length));
  }
  return referenced;
}

/**
 * Deletes desktop-stored secrets that no credential row references any more. Secrets that were
 * referenced before this request (`referencedBefore`) and are not now were removed by it, so
 * they go regardless of age; other unreferenced entries must be older than the save window.
 */
export async function sweepLocalSecrets(
  env: Env,
  referencedBefore?: ReadonlySet<string>
): Promise<number> {
  const broker = registerLocalSecretBroker(env);
  if (!broker) return 0;
  const referenced = await referencedLocalSecrets(env);
  const { refs } = await brokerRequest<{ refs: string[] }>(
    broker,
    `/secrets?minAgeMs=${SWEEP_MIN_AGE_MS}`
  );
  const stale = new Set(refs.filter((ref) => !referenced.has(ref)));
  for (const ref of referencedBefore ?? []) if (!referenced.has(ref)) stale.add(ref);
  for (const ref of stale) {
    await brokerRequest(broker, `/secrets/${encodeURIComponent(ref)}`, { method: 'DELETE' });
  }
  return stale.size;
}
