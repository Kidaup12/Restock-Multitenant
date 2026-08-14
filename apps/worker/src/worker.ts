import { Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { SYNC_QUEUE, syncBackoffDelay, type SyncJobData } from "@wezesha/queue";
import { createDemoSyncProcessor } from "./demo-sync";
import { createPosSyncProcessor, handlePosSyncFailure, type PosFeedLoader } from "./pos-sync";
import { createShopifySyncProcessor, handleSyncFailure } from "./shopify-sync";

/**
 * The one sync worker. Jobs are dispatched on `data.source`: "shopify" runs the
 * real Shopify sync, "pos" pulls the physical-shop sales feed, anything else
 * runs the demo processor (kept for pipeline smoke tests). Failed attempts back
 * off via syncBackoffDelay — which is what makes a ShopifyRateLimitedError's
 * Retry-After actually honored — and final failures persist a Notification
 * through the per-source failure hooks.
 */

/** How long a held job stays locked without a renewal before the stalled sweep
 *  may hand it to another worker. The lock renews on a timer, so what matters
 *  is the worst renewal delay, not the ~3min run length — and this process
 *  shares its event loop with seven cron workers. BullMQ's 30s default lets a
 *  moment of contention re-deliver a running sync, giving one tenant two
 *  concurrent writers. */
export const SYNC_LOCK_DURATION_MS = 120_000;

/** How often the sweep looks for expired locks. BullMQ's default, pinned so a
 *  library change can't silently widen it: four checks fit inside one lock
 *  window, so a crashed worker is noticed promptly and a healthy one is never
 *  swept by a scan that ran at the wrong moment. */
export const SYNC_STALLED_INTERVAL_MS = 30_000;

/** How many times a job may be recovered from stalled before it is failed.
 *  BullMQ's default, kept deliberately: one recovery covers the real case (a
 *  redeploy killed the process mid-sync), and a job that stalls repeatedly is
 *  a job that keeps duplicating tenant writes — failing it routes the operator
 *  a Notification through the failure hooks instead. */
export const SYNC_MAX_STALLED_COUNT = 1;

export interface SyncWorkerOptions {
  /** BullMQ worker connection — must have maxRetriesPerRequest: null. */
  connection: Redis;
  /** Plain connection for publishing realtime events. */
  publisher: Redis;
  phaseDelayMs?: number;
  /** Injectable POS feed fetch for tests; defaults to the real HTTP fetch. */
  loadPosFeed?: PosFeedLoader;
}

export function createSyncWorker(options: SyncWorkerOptions): Worker<SyncJobData> {
  const demo = createDemoSyncProcessor(options.publisher, options.phaseDelayMs);
  const shopify = createShopifySyncProcessor({ publisher: options.publisher });
  const pos = createPosSyncProcessor({ publisher: options.publisher, loadFeed: options.loadPosFeed });

  const worker = new Worker<SyncJobData>(
    SYNC_QUEUE,
    async (job: Job<SyncJobData>) => {
      if (job.data.source === "shopify") return shopify(job);
      if (job.data.source === "pos") return pos(job);
      return demo(job);
    },
    {
      connection: options.connection,
      lockDuration: SYNC_LOCK_DURATION_MS,
      stalledInterval: SYNC_STALLED_INTERVAL_MS,
      maxStalledCount: SYNC_MAX_STALLED_COUNT,
      settings: {
        backoffStrategy: (attemptsMade: number, _type, err) => syncBackoffDelay(attemptsMade, err),
      },
    }
  );

  worker.on("failed", (job, err) => {
    void handleSyncFailure(job, err, options.publisher).catch((hookErr) =>
      console.error("worker: sync-failure hook error", hookErr)
    );
    void handlePosSyncFailure(job, err, options.publisher).catch((hookErr) =>
      console.error("worker: pos sync-failure hook error", hookErr)
    );
  });

  return worker;
}
