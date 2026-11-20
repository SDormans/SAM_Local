/**
 * Secret key resolution helpers.
 *
 * Each helper returns the purpose-specific secret when set, falling back to
 * the shared ENCRYPTION_KEY for backwards compatibility with existing
 * deployments that only configure ENCRYPTION_KEY.
 *
 * Uses truthy checks (not nullish coalescing) so that empty strings from
 * misconfigured CI/CD pipelines also trigger the fallback.
 */

import { registerLocalSecretBroker } from '../local/local-secret-broker';

interface SecretsEnv {
  ENCRYPTION_KEY: string;
  SAM_RUNTIME_MODE?: string;
  LOCAL_SECRET_BROKER_URL?: string;
  LOCAL_BOOTSTRAP_SECRET?: string;
  BETTER_AUTH_SECRET?: string;
  CREDENTIAL_ENCRYPTION_KEY?: string;
}

/** Key used by BetterAuth for session signing/encryption. */
export function getBetterAuthSecret(env: SecretsEnv): string {
  return env.BETTER_AUTH_SECRET || env.ENCRYPTION_KEY;
}

/** Key used for AES-GCM encryption of user credentials (cloud tokens, etc.). */
export function getCredentialEncryptionKey(env: SecretsEnv): string {
  // Desktop runtime: lets decrypt() resolve credentials held by the desktop credential store.
  registerLocalSecretBroker(env);
  return env.CREDENTIAL_ENCRYPTION_KEY || env.ENCRYPTION_KEY;
}
