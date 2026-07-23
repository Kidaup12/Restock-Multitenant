import { Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { SYNC_QUEUE, syncBackoffDelay, type SyncJobData } from "@wezesha/queue";
import { createDemoSyncProcessor } from "./demo-sync";
import { createShopifySyncProcessor, handleSyncFailure } from "./shopify-sync";

/**
 * The one sync worker. Jobs are dispatched on `data.source`: "shopify" runs the
 * real sync; anything else runs the demo processor (kept for pipeline smoke
 * tests). Failed shopify attempts back off via syncBackoffDelay — which is what
 * makes a ShopifyRateLimitedError's Retry-After actually honored — and final
 * failures persist a Notification through handleSyncFailure.
 */

export interface SyncWorkerOptions {
  /** BullMQ worker connection — must have maxRetriesPerRequest: null. */
  connection: Redis;
  /** Plain connection for publishing realtime events. */
  publisher: Redis;
  phaseDelayMs?: number;
}

export function createSyncWorker(options: SyncWorkerOptions): Worker<SyncJobData> {
  const demo = createDemoSyncProcessor(options.publisher, options.phaseDelayMs);
  const shopify = createShopifySyncProcessor({ publisher: options.publisher });

  const worker = new Worker<SyncJobData>(
    SYNC_QUEUE,
    async (job: Job<SyncJobData>) => {
      if (job.data.source === "shopify") return shopify(job);
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
  });

  return worker;
}
