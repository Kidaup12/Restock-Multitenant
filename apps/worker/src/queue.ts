import { Queue } from "bullmq";
import type { Redis } from "ioredis";

export const SYNC_QUEUE = "sync";

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

export type EnqueueResult =
  | { enqueued: true; jobId: string }
  | { enqueued: false; jobId: string; state: string };

/**
 * Enqueue a sync unless one is already queued or running for this
 * tenant+source. The atomic guarantee is Redis-side (jobId dedup — a losing
 * racer's add is a no-op); the returned flag is accurate reporting for the
 * caller. Jobs are removed on completion/failure so the id frees up for the
 * next run.
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
  await queue.add("sync", data, { jobId, removeOnComplete: true, removeOnFail: true });
  return { enqueued: true, jobId };
}
