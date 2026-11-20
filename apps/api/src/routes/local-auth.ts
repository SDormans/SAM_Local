import { drizzle } from 'drizzle-orm/d1';
import { type Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

import * as schema from '../db/schema';
import type { Env } from '../env';
import {
  createLocalSession,
  isValidBootstrapSecret,
  LOCAL_SESSION_COOKIE,
  revokeLocalSession,
} from '../local/local-auth';
import {
  readLocalPrerequisites,
  summarizeLocalHealth,
  writeLocalPrerequisites,
} from '../local/local-health';
import { ensureLocalNode } from '../local/local-node';
import { isLocalRuntime } from '../local/runtime-mode';
import { requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { jsonValidator } from '../schemas';
import { LocalNodeRegistrationSchema, LocalPrerequisitesSchema } from '../schemas/local';

/** Local desktop session routes (spec 036). Not mounted behaviour for hosted deployments. */
const localAuthRoutes = new Hono<{ Bindings: Env }>();

localAuthRoutes.use('*', async (c, next) => {
  if (!isLocalRuntime(c.env)) throw errors.notFound('Route');
  await next();
});

async function requireBootstrap(c: Context<{ Bindings: Env }>): Promise<void> {
  if (!(await isValidBootstrapSecret(c.env, c.req.header('authorization')))) {
    throw errors.unauthorized('Local bootstrap credential required');
  }
}

localAuthRoutes.post('/session', async (c) => {
  await requireBootstrap(c);
  const session = await createLocalSession(c.env);
  setCookie(c, LOCAL_SESSION_COOKIE, session.token, {
    httpOnly: true,
    sameSite: 'Strict',
    path: '/',
    maxAge: session.maxAgeSeconds,
  });
  return c.json({ userId: session.userId, expiresAt: new Date(session.expiresAt).toISOString() });
});

localAuthRoutes.get('/session', requireAuth(), (c) => {
  const auth = c.get('auth');
  return c.json({ userId: auth.user.id, expiresAt: auth.session.expiresAt.toISOString() });
});

localAuthRoutes.delete('/session', async (c) => {
  await revokeLocalSession(c.env, getCookie(c, LOCAL_SESSION_COOKIE));
  deleteCookie(c, LOCAL_SESSION_COOKIE, { path: '/' });
  return c.json({ success: true });
});

/** Desktop supervisor reports Docker Desktop/WSL2 state, which the Worker cannot probe. */
localAuthRoutes.put('/health/prerequisites', jsonValidator(LocalPrerequisitesSchema), async (c) => {
  await requireBootstrap(c);
  await writeLocalPrerequisites(c.env, c.req.valid('json'));
  return c.json({ success: true });
});

localAuthRoutes.get('/health', requireAuth(), async (c) => {
  return c.json(await summarizeLocalHealth(c.env, await readLocalPrerequisites(c.env)));
});

/** Desktop supervisor registers the local node agent before launching its container. */
localAuthRoutes.put('/node', jsonValidator(LocalNodeRegistrationSchema), async (c) => {
  await requireBootstrap(c);
  return c.json(await ensureLocalNode(c.env, c.req.valid('json')));
});

/** Desktop startup reconciliation (spec 036 T034): which workspaces SAM still knows about. */
localAuthRoutes.get('/workspaces', async (c) => {
  await requireBootstrap(c);
  const db = drizzle(c.env.DATABASE, { schema });
  const rows = await db
    .select({ id: schema.workspaces.id, status: schema.workspaces.status })
    .from(schema.workspaces);
  return c.json({ workspaces: rows });
});

export { localAuthRoutes };
