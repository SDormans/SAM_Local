import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

import type { Env } from '../env';
import {
  createLocalSession,
  isValidBootstrapSecret,
  LOCAL_SESSION_COOKIE,
  revokeLocalSession,
} from '../local/local-auth';
import { isLocalRuntime } from '../local/runtime-mode';
import { requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';

/** Local desktop session routes (spec 036). Not mounted behaviour for hosted deployments. */
const localAuthRoutes = new Hono<{ Bindings: Env }>();

localAuthRoutes.use('*', async (c, next) => {
  if (!isLocalRuntime(c.env)) throw errors.notFound('Route');
  await next();
});

localAuthRoutes.post('/session', async (c) => {
  if (!(await isValidBootstrapSecret(c.env, c.req.header('authorization')))) {
    throw errors.unauthorized('Local bootstrap credential required');
  }
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

export { localAuthRoutes };
