/**
 * Local desktop principal and session (spec 036). The desktop supervisor proves possession
 * of `LOCAL_BOOTSTRAP_SECRET`; the API then issues an HttpOnly `sam_local_session` cookie.
 * The renderer never chooses or asserts the principal identity.
 */
import type { UserRole, UserStatus } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import type { AuthContext } from '../middleware/auth';
import { AppError } from '../middleware/error';

export const LOCAL_SESSION_COOKIE = 'sam_local_session';
const SESSION_KEY_PREFIX = 'local-session:';
const DEFAULT_SESSION_TTL_SECONDS = 24 * 60 * 60;
const MIN_KV_TTL_SECONDS = 60;
const MIN_BOOTSTRAP_SECRET_LENGTH = 32;

type LocalEnv = Pick<
  Env,
  | 'DATABASE'
  | 'KV'
  | 'LOCAL_INSTALLATION_ID'
  | 'LOCAL_BOOTSTRAP_SECRET'
  | 'LOCAL_SESSION_TTL_SECONDS'
>;

interface StoredLocalSession {
  userId: string;
  installationId: string;
  expiresAt: number;
}

function misconfigured(detail: string): AppError {
  return new AppError(500, 'LOCAL_RUNTIME_MISCONFIGURED', detail);
}

function installationId(env: LocalEnv): string {
  const id = env.LOCAL_INSTALLATION_ID?.trim();
  if (!id) throw misconfigured('LOCAL_INSTALLATION_ID is not configured');
  return id;
}

export function localPrincipalId(id: string): string {
  return `local-${id}`;
}

export function localSessionTtlSeconds(env: Pick<Env, 'LOCAL_SESSION_TTL_SECONDS'>): number {
  const parsed = Number(env.LOCAL_SESSION_TTL_SECONDS);
  return Number.isFinite(parsed) && parsed >= MIN_KV_TTL_SECONDS
    ? Math.floor(parsed)
    : DEFAULT_SESSION_TTL_SECONDS;
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time comparison of the presented bootstrap secret against the configured one. */
export async function isValidBootstrapSecret(
  env: Pick<Env, 'LOCAL_BOOTSTRAP_SECRET'>,
  authorization: string | undefined
): Promise<boolean> {
  const expected = env.LOCAL_BOOTSTRAP_SECRET ?? '';
  if (expected.length < MIN_BOOTSTRAP_SECRET_LENGTH) {
    throw misconfigured('LOCAL_BOOTSTRAP_SECRET is missing or too short');
  }
  const presented = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  const [a, b] = await Promise.all([sha256(expected), sha256(presented)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0 && presented.length > 0;
}

/** Creates the single local user row once; later calls leave it untouched. */
export async function ensureLocalPrincipal(env: LocalEnv): Promise<string> {
  const userId = localPrincipalId(installationId(env));
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO users (id, email, email_verified, name, role, status)
     VALUES (?, ?, 0, ?, 'superadmin', 'active')`
  )
    .bind(userId, `${userId}@localhost.invalid`, 'Local user')
    .run();
  return userId;
}

export async function createLocalSession(
  env: LocalEnv,
  now: number = Date.now()
): Promise<{ token: string; userId: string; expiresAt: number; maxAgeSeconds: number }> {
  const userId = await ensureLocalPrincipal(env);
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = toHex(tokenBytes);
  const maxAgeSeconds = localSessionTtlSeconds(env);
  const expiresAt = now + maxAgeSeconds * 1000;
  const stored: StoredLocalSession = { userId, installationId: installationId(env), expiresAt };
  await env.KV.put(SESSION_KEY_PREFIX + toHex(await sha256(token)), JSON.stringify(stored), {
    expirationTtl: maxAgeSeconds,
  });
  return { token, userId, expiresAt, maxAgeSeconds };
}

function parseStoredSession(raw: string | null): StoredLocalSession | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.userId !== 'string' ||
    typeof record.installationId !== 'string' ||
    typeof record.expiresAt !== 'number'
  ) {
    return null;
  }
  return {
    userId: record.userId,
    installationId: record.installationId,
    expiresAt: record.expiresAt,
  };
}

interface LocalUserRow {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  role: string;
  status: string;
}

/** Resolves a cookie token to the local principal, or null when absent, unknown, or expired. */
export async function resolveLocalSession(
  env: LocalEnv,
  token: string | undefined,
  now: number = Date.now()
): Promise<AuthContext | null> {
  if (!token) return null;
  const keyHash = toHex(await sha256(token));
  const stored = parseStoredSession(await env.KV.get(SESSION_KEY_PREFIX + keyHash));
  const expectedInstallation = installationId(env);
  if (
    !stored ||
    stored.expiresAt <= now ||
    stored.installationId !== expectedInstallation ||
    stored.userId !== localPrincipalId(expectedInstallation)
  ) {
    return null;
  }
  const row = await env.DATABASE.prepare(
    'SELECT id, email, name, avatar_url, role, status FROM users WHERE id = ?'
  )
    .bind(stored.userId)
    .first<LocalUserRow>();
  if (!row) return null;
  return {
    user: {
      id: row.id,
      email: row.email,
      name: row.name,
      avatarUrl: row.avatar_url,
      role: row.role as UserRole,
      status: row.status as UserStatus,
    },
    session: {
      id: `local:${keyHash.slice(0, 16)}`,
      token: null,
      expiresAt: new Date(stored.expiresAt),
    },
  };
}

export async function revokeLocalSession(
  env: Pick<Env, 'KV'>,
  token: string | undefined
): Promise<void> {
  if (!token) return;
  await env.KV.delete(SESSION_KEY_PREFIX + toHex(await sha256(token)));
}
