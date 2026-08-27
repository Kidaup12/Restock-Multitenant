import { Redis } from "ioredis";
import {
  createSyncQueue,
  enqueueSyncOnce,
  type EnqueueResult,
  type SyncQueue,
} from "@wezesha/queue";
import { publishEvent } from "@wezesha/realtime";
import { intakeConfigured, intakeEnqueue, intakePublish } from "@/lib/worker-intake";
import type { RealtimeEvent } from "@wezesha/realtime";

/**
 * Web-side handle on the sync queue. One Redis connection + one Queue per
 * process, cached on globalThis so Next's dev-mode module reloads don't leak
 * connections (same pattern as the Prisma clients).
 */

const globalForQueue = globalThis as unknown as {
  wezeshaRedis?: Redis;
  wezeshaSyncQueue?: SyncQueue;
};

function getRedis(): Redis {
  if (!globalForQueue.wezeshaRedis) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL is not set (sync queue + realtime publishing)");
    globalForQueue.wezeshaRedis = new Redis(url, { maxRetriesPerRequest: null });
  }
  return globalForQueue.wezeshaRedis;
}

function getSyncQueue(): SyncQueue {
  if (!globalForQueue.wezeshaSyncQueue) {
    globalForQueue.wezeshaSyncQueue = createSyncQueue(getRedis());
  }
  return globalForQueue.wezeshaSyncQueue;
}

/** Enqueue a Shopify sync for the tenant unless one is already queued/running.
 *  Goes over HTTPS when the worker is hosted apart from this app, so Redis
 *  never has to be reachable from the internet — see lib/worker-intake. */
export function enqueueShopifySync(tenantId: string): Promise<EnqueueResult> {
  const data = { tenantId, source: "shopify" } as const;
  return intakeConfigured() ? intakeEnqueue(data) : enqueueSyncOnce(getSyncQueue(), data);
}

/** Publish a realtime event from a request path (best-effort callers catch). */
export function publishRealtime(event: RealtimeEvent): Promise<number> {
  return intakeConfigured() ? intakePublish(event) : publishEvent(getRedis(), event);
}
