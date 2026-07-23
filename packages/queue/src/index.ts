import { Queue } from "bullmq";
import type { Redis } from "ioredis";

export const SYNC_QUEUE = "sync";

/** Retry budget for a sync job. Rate-limited attempts re-queue with the
 *  provider's Retry-After delay (see syncBackoffDelay); anything else backs off
 *  exponentially. */
export const SYNC_ATTEMPTS = 6;

export interface SyncJobData {
  tenantId: string;
  source: string;
}

export type SyncQueue = Queue<SyncJobData>;

export function createSyncQueue(connection: Redis): SyncQueue {
  return new Queue<SyncJobData>(SYNC_QUEUE, { connection });
}

/**
 * Deterministic per-tenant job id. BullMQ deduplicates `add` on jobId
 * atomically in Redis, so one tenant+source can never have two sync jobs
 * queued or running at once — the contract's no-overlap requirement.
 */
export function syncJobId({ tenantId, source }: SyncJobData): string {
  return `sync:${tenantId}:${source}`;
}

/**
 * Backoff for failed sync attempts, wired into the worker as the "custom"
 * BullMQ backoff strategy. A provider rate limit (any error carrying a numeric
 * `retryAfterMs`, e.g. ShopifyRateLimitedError) is respected verbatim;
 * everything else waits 2^attempt seconds capped at one minute.
 */
export function syncBackoffDelay(attemptsMade: number, err: unknown): number {
  const retryAfterMs = (err as { retryAfterMs?: unknown } | undefined)?.retryAfterMs;
  if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.ceil(retryAfterMs);
  }
  return Math.min(60_000, 2 ** attemptsMade * 1000);
}

export type EnqueueResult =
  | { enqueued: true; jobId: string }
  | { enqueued: false; jobId: string; state: string };

/**
 * Enqueue a sync unless one is already queued or running for this
 * tenant+source. The atomic guarantee is Redis-side (jobId dedup — a losing
 * racer's add is a no-op); the returned flag is accurate reporting for the
 * caller. Jobs are removed on completion/failure so the id frees up for the
 * next run. Retries stay under the same jobId, so a job waiting out a backoff
 * still blocks duplicates.
 */
export async function enqueueSyncOnce(queue: SyncQueue, data: SyncJobData): Promise<EnqueueResult> {
  const jobId = syncJobId(data);
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "completed" || state === "failed") {
      // Finished but not yet auto-removed — clear it so the id is reusable.
      await existing.remove();
    } else {
      return { enqueued: false, jobId, state };
    }
  }
  await queue.add("sync", data, {
    jobId,
    removeOnComplete: true,
    removeOnFail: true,
    attempts: SYNC_ATTEMPTS,
    backoff: { type: "custom" },
  });
  return { enqueued: true, jobId };
}
