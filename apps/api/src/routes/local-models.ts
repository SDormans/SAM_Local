import { Hono } from 'hono';

import type { Env } from '../env';
import {
  LOCAL_MODEL_CONNECTION_ID,
  localEndpointProblem,
  readLocalModelConnection,
  verifyLocalModelConnection,
  writeLocalModelConnection,
} from '../local/local-models';
import { isLocalRuntime } from '../local/runtime-mode';
import { requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { jsonValidator } from '../schemas';
import { LocalModelConnectionInputSchema, LocalModelVerifyRequestSchema } from '../schemas/local';

/** Spec 036 local model connection routes; not available in hosted deployments. */
const localModelsRoutes = new Hono<{ Bindings: Env }>();

localModelsRoutes.use('*', async (c, next) => {
  if (!isLocalRuntime(c.env)) throw errors.notFound('Route');
  await next();
});
localModelsRoutes.use('*', requireAuth());

localModelsRoutes.get('/connection', async (c) => {
  const connection = await readLocalModelConnection(c.env);
  if (!connection) throw errors.notFound('Local model connection');
  return c.json(connection);
});

localModelsRoutes.put('/connection', jsonValidator(LocalModelConnectionInputSchema), async (c) => {
  const input = c.req.valid('json');
  const problem = localEndpointProblem(input.baseUrl);
  if (problem) throw errors.badRequest(problem);
  const saved = await writeLocalModelConnection(c.env, {
    ...input,
    connectionId: LOCAL_MODEL_CONNECTION_ID,
  });
  return c.json(saved);
});

localModelsRoutes.post(
  '/connection/verify',
  jsonValidator(LocalModelVerifyRequestSchema),
  async (c) => {
    const { connectionId } = c.req.valid('json');
    const connection = await readLocalModelConnection(c.env);
    if (!connection || connection.connectionId !== connectionId) {
      throw errors.notFound('Local model connection');
    }
    const result = await verifyLocalModelConnection(connection);
    if (result.status !== 'usable') return c.json(result, 502);
    await writeLocalModelConnection(c.env, {
      ...connection,
      lastVerifiedAt: new Date().toISOString(),
    });
    return c.json(result);
  }
);

export { localModelsRoutes };
