/**
 * The single local node of a desktop installation (spec 036 US2).
 *
 * The desktop supervisor runs the Go node agent in a Docker Desktop container and registers it
 * here. The row is `user-owned` with `transport = 'local-docker'`, so managed-node lifecycle,
 * billing, quota and cleanup guards for enrolled machines apply. The agent still proves itself
 * with its node callback token on `/api/nodes/:id/ready`.
 */
import { and, eq, notInArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import type { LocalNodeRegistration as LocalNodeHardware } from '../schemas/local';
import { signNodeCallbackToken } from '../services/jwt';
import { createNodeRecord } from '../services/nodes';
import { ensureLocalPrincipal } from './local-auth';

export const LOCAL_NODE_TRANSPORT = 'local-docker';
const LOCAL_NODE_HEARTBEAT_STALE_SECONDS = 180;
const RETIRED_STATUSES = ['deleted', 'error'] as const;

export interface LocalNodeRegistration {
  nodeId: string;
  callbackToken: string;
}

export async function ensureLocalNode(
  env: Env,
  hardware: LocalNodeHardware
): Promise<LocalNodeRegistration> {
  const userId = await ensureLocalPrincipal(env);
  const db = drizzle(env.DATABASE, { schema });
  const existing = await db
    .select({ id: schema.nodes.id })
    .from(schema.nodes)
    .where(
      and(
        eq(schema.nodes.userId, userId),
        eq(schema.nodes.transport, LOCAL_NODE_TRANSPORT),
        notInArray(schema.nodes.status, [...RETIRED_STATUSES])
      )
    )
    .limit(1);
  let nodeId = existing[0]?.id;
  if (!nodeId) {
    const node = await createNodeRecord(env, {
      userId,
      credentialAttributionSource: 'self-hosted',
      name: 'This computer',
      vmSize: 'local',
      vmLocation: 'local',
      heartbeatStaleAfterSeconds: LOCAL_NODE_HEARTBEAT_STALE_SECONDS,
      cloudProvider: 'local',
    });
    nodeId = node.id;
  }
  // Docker Desktop's resource limits can change between launches, so refresh them each time.
  await db
    .update(schema.nodes)
    .set({
      nodeClass: 'user-owned',
      transport: LOCAL_NODE_TRANSPORT,
      runtimeTerminationConfirmedAt: null,
      observedHardwareSource: 'observed',
      observedProviderInstanceVcpuCount: hardware.vcpuCount,
      observedProviderInstanceMemoryMb: hardware.memoryMb,
      observedProviderInstanceDiskGb: hardware.diskGb,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.nodes.id, nodeId));
  return { nodeId, callbackToken: await signNodeCallbackToken(nodeId, env) };
}
