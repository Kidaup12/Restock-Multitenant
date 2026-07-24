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
