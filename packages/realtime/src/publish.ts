import type { Redis } from "ioredis";
import { encodeEnvelope, tenantChannel, type RealtimeEvent } from "./events";

/**
 * Publish one event onto its tenant's channel. Fire-and-forget from the
 * publisher's point of view — the gateway fans it out to connected sockets.
 * Callers own the connection (publishing works on a normal client; only
 * subscribers need a dedicated one). Returns the Redis receiver count.
 */
export async function publishEvent(redis: Redis, event: RealtimeEvent): Promise<number> {
  return redis.publish(tenantChannel(event.data.tenantId), encodeEnvelope(event));
}
