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
    if (result.status !== 'usable') {
      const error =
        result.status === 'unavailable' ? 'LOCAL_MODEL_UNAVAILABLE' : 'LOCAL_MODEL_INCOMPATIBLE';
      return c.json(
        { error, message: result.message ?? 'The local model is not usable', ...result },
        502
      );
    }
    // Only stamp the settings that were checked; a save during verification wins.
    const current = await readLocalModelConnection(c.env);
    if (
      current &&
      current.baseUrl === connection.baseUrl &&
      current.modelId === connection.modelId &&
      current.providerType === connection.providerType
    ) {
      await writeLocalModelConnection(c.env, {
        ...current,
        lastVerifiedAt: new Date().toISOString(),
      });
    }
    return c.json(result);
  }
);

export { localModelsRoutes };
