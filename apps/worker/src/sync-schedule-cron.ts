import { Queue, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { CUSTOMER_TENANTS_WHERE, prismaService } from "@wezesha/db";
import { enqueueSyncOnce, type SyncQueue } from "@wezesha/queue";

/**
 * Keeps every connected shop's Shopify data current without anyone pressing a
 * button.
 *
 * Until now a sync only ran when someone clicked "Sync now", when a webhook
 * arrived, or at install — so a shop that changed a price or received stock in
 * Shopify saw stale numbers on the buy list until it thought to refresh. Every
 * other scheduled job here is nightly; this is the one that has to be frequent,
 * because it feeds the two figures the shop is judged on.
 *
 * A tick does NOT queue work per tenant on this queue: it enqueues straight onto
 * the sync queue through enqueueSyncOnce, whose deterministic job id is already
 * the no-overlap guard. A tenant whose previous sync is still running is simply
 * skipped, so a slow shop falls back to one sync at a time rather than piling up.
 *
 * The daily job exists for a subtler reason — see markTenantsForFullSync.
 */

export const SYNC_SCHEDULE_QUEUE = "sync-schedule-crons";

export const SHOPIFY_SYNC_SCHEDULER = "shopify-sync-tick";
export const SHOPIFY_FULL_SYNC_SCHEDULER = "shopify-full-sync";

export const SHOPIFY_SYNC_TICK_JOB = "shopify-sync-tick";
export const SHOPIFY_FULL_SYNC_JOB = "shopify-full-sync";

/** Cadence, overridable per environment. Fifteen minutes rather than ten: a
 *  tick does a full inventory refresh, and the app treats a run whose progress
 *  has been quiet for ten minutes as stalled, so a ten-minute cadence would sit
 *  exactly on the line a healthy-but-slow shop crosses. */
export const DEFAULT_SYNC_PATTERN = "*/15 * * * *";

/** 03:00 worker-local — after the 02:00 forecast, before the 05:00 cost check. */
export const FULL_SYNC_PATTERN = "0 3 * * *";

/** Finished sync runs kept for the Connections screen's history. At four ticks
 *  an hour per shop this table is the fastest-growing thing the worker writes,
 *  and nothing else deletes from it. */
export const SYNC_RUN_RETENTION_DAYS = 14;

const DAY_MS = 86_400_000;

export function shopifySyncPattern(): string {
  return process.env.SHOPIFY_SYNC_PATTERN?.trim() || DEFAULT_SYNC_PATTERN;
}

export type SyncScheduleJobData = Record<string, never>;
export type SyncScheduleQueue = Queue<SyncScheduleJobData>;

export function createSyncScheduleQueue(connection: Redis): SyncScheduleQueue {
  return new Queue<SyncScheduleJobData>(SYNC_SCHEDULE_QUEUE, { connection });
}

/** Idempotent: upserting a scheduler replaces any previous cadence, so changing
 *  SHOPIFY_SYNC_PATTERN and restarting is all it takes to re-time this. */
export async function registerSyncSchedules(queue: SyncScheduleQueue): Promise<void> {
  await queue.upsertJobScheduler(
    SHOPIFY_SYNC_SCHEDULER,
    { pattern: shopifySyncPattern() },
    { name: SHOPIFY_SYNC_TICK_JOB }
  );
  await queue.upsertJobScheduler(
    SHOPIFY_FULL_SYNC_SCHEDULER,
    { pattern: FULL_SYNC_PATTERN },
    { name: SHOPIFY_FULL_SYNC_JOB }
  );
}

/** Customer workspaces with a Shopify connection that has not been uninstalled.
 *  Enumerating tenants is a cross-tenant system read — prismaService. */
async function connectedTenantIds(): Promise<string[]> {
  // eslint-disable-next-line tenant-safety/require-tenant-scope -- fan-out dispatch: enumerating every connected customer workspace is the job, and the per-tenant sync it queues is scoped.
  const rows = await prismaService.shopifyConnection.findMany({
    where: { uninstalledAt: null, tenant: CUSTOMER_TENANTS_WHERE },
    select: { tenantId: true },
  });
  return rows.map((r) => r.tenantId);
}

export type SyncTickResult = { considered: number; enqueued: number; alreadyRunning: number };

/**
 * One tick: ask for a sync for every connected shop.
 *
 * `alreadyRunning` is reported rather than treated as a failure — it is the
 * expected steady state for a shop whose catalogue takes longer than one tick,
 * and the number worth watching if ticks start being skipped every time.
 */
export async function dispatchShopifySyncs(syncQueue: SyncQueue): Promise<SyncTickResult> {
  const tenantIds = await connectedTenantIds();
  let enqueued = 0;
  for (const tenantId of tenantIds) {
    const result = await enqueueSyncOnce(syncQueue, { tenantId, source: "shopify" });
    if (result.enqueued) enqueued++;
  }
  return { considered: tenantIds.length, enqueued, alreadyRunning: tenantIds.length - enqueued };
}

/**
 * Drop the products cursor for every connected shop, so the next tick pulls the
 * whole catalogue instead of just what changed.
 *
 * This is what makes deleted and archived products detectable. The sweep that
 * stamps missingFromShopifyAt only runs on a full pull — an incremental one
 * legitimately sees a handful of products and would otherwise mark the rest of
 * the catalogue missing. Because the cursor is only ever absent on a shop's very
 * first sync, that sweep has in practice run once per shop, ever, and everything
 * removed from a store since has been invisible unless its delete webhook
 * happened to arrive. Once a day is enough: a product that vanished this morning
 * shows up as gone by tomorrow, at the cost of one full pull.
 */
export async function markTenantsForFullSync(): Promise<number> {
  const tenantIds = await connectedTenantIds();
  if (tenantIds.length === 0) return 0;
  const { count } = await prismaService.ingestCursor.deleteMany({
    where: { tenantId: { in: tenantIds }, source: "shopify", resource: "products" },
  });
  return count;
}

/** Drop finished sync runs past the retention window. Running rows are left
 *  alone whatever their age — a stuck run is something the Connections screen
 *  should keep showing, not something to tidy away. */
export async function pruneSyncRuns(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - SYNC_RUN_RETENTION_DAYS * DAY_MS);
  // eslint-disable-next-line tenant-safety/require-tenant-scope -- retention sweep across every workspace by design; the filter is age, and scoping it per tenant would only mean running the same delete N times.
  const { count } = await prismaService.syncRun.deleteMany({
    where: { finishedAt: { not: null, lt: cutoff } },
  });
  return count;
}

export interface SyncScheduleWorkerOptions {
  connection: Redis;
  /** The sync queue this cron produces onto — not the queue it consumes from. */
  syncQueue: SyncQueue;
}

export function createSyncScheduleWorker(
  options: SyncScheduleWorkerOptions
): Worker<SyncScheduleJobData> {
  return new Worker<SyncScheduleJobData>(
    SYNC_SCHEDULE_QUEUE,
    async (job: Job<SyncScheduleJobData>) => {
      if (job.name === SHOPIFY_SYNC_TICK_JOB) {
        const result = await dispatchShopifySyncs(options.syncQueue);
        if (result.considered > 0) {
          console.log(
            `worker: sync tick — ${result.enqueued} queued, ${result.alreadyRunning} already running`
          );
        }
        return;
      }
      if (job.name === SHOPIFY_FULL_SYNC_JOB) {
        const marked = await markTenantsForFullSync();
        const pruned = await pruneSyncRuns();
        console.log(`worker: full-sync mark — ${marked} cursors cleared, ${pruned} sync runs pruned`);
      }
    },
    { connection: options.connection }
  );
}
