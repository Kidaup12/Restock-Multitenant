import { Redis } from "ioredis";
import { createSyncQueue, enqueueSyncOnce, type EnqueueResult, type SyncQueue } from "@wezesha/queue";
import { intakeConfigured, intakeEnqueue } from "@/lib/worker-intake";

/**
 * Web-side POS-sync enqueue — the "feed issue, re-pull that day" action on a
 * sales gap. Shares the single cached Redis + sync Queue with lib/shopify/queue
 * (same globalThis keys), so one connection serves every source. The pull is a
 * full idempotent re-ingest of the tenant's feed window, which covers the
 * flagged day; the no-overlap jobId keeps a manual re-pull from stacking on a
 * scheduled one.
 */

const globalForQueue = globalThis as unknown as {
  wezeshaRedis?: Redis;
  wezeshaSyncQueue?: SyncQueue;
};

function getRedis(): Redis {
  if (!globalForQueue.wezeshaRedis) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL is not set (sync queue)");
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

/** Enqueue a POS re-pull for the tenant unless one is already queued/running.
 *  Same transport choice as lib/shopify/queue. */
export function enqueuePosSync(tenantId: string): Promise<EnqueueResult> {
  const data = { tenantId, source: "pos" } as const;
  return intakeConfigured() ? intakeEnqueue(data) : enqueueSyncOnce(getSyncQueue(), data);
}
