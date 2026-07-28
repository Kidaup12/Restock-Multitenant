import { Queue, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { prismaService } from "@wezesha/db";

/**
 * Nightly inventory snapshot — the history behind the two numbers the shop is
 * measured by: stockout rate and dead stock, week over week. Nothing else in the
 * app records on-hand over time, so without a row per product per day those
 * trends can only ever start from "today". This runs from first deploy and lets
 * the history accrue.
 *
 * Same fan-out shape as the other crons (one dispatch job → one job per tenant,
 * so a slow tenant never blocks the rest) with a deterministic per-tenant,
 * per-day jobId so a run can never overlap itself. Registration is env-gated in
 * index.ts (SNAPSHOT_CRON=1) so dev and CI runs stay quiet. Queries run on
 * prismaService WITH an explicit tenantId filter — the cron fires with no
 * session, the documented use of the BYPASSRLS client.
 */

export const SNAPSHOT_CRON_QUEUE = "snapshot-crons";
export const INVENTORY_SNAPSHOT_SCHEDULER = "inventory-snapshot";
/** 01:00 worker-local, ahead of the 02:00 forecast: the shop is shut, so the row
 *  is the on-hand the owner opens Today on that morning. */
export const INVENTORY_SNAPSHOT_PATTERN = "0 1 * * *";

export const SNAPSHOT_DISPATCH_JOB = "inventory-snapshot-dispatch";
export const SNAPSHOT_TENANT_JOB = "inventory-snapshot-tenant";

/** ~13 months of history: every week keeps last year's matching week to compare
 *  against, and the table stays bounded at ~400 rows per product. */
export const SNAPSHOT_RETENTION_DAYS = 400;

/** Rows per createMany — same batching as the sales writer. */
const SNAPSHOT_CHUNK = 500;
const DAY_MS = 86_400_000;

export type SnapshotCronJobData = { tenantId?: string };
export type SnapshotCronQueue = Queue<SnapshotCronJobData>;

export function createSnapshotCronQueue(connection: Redis): SnapshotCronQueue {
  return new Queue<SnapshotCronJobData>(SNAPSHOT_CRON_QUEUE, { connection });
}

/** Idempotent: upserting the scheduler replaces any previous cadence. */
export async function registerSnapshotCronSchedules(queue: SnapshotCronQueue): Promise<void> {
  await queue.upsertJobScheduler(
    INVENTORY_SNAPSHOT_SCHEDULER,
    { pattern: INVENTORY_SNAPSHOT_PATTERN },
    { name: SNAPSHOT_DISPATCH_JOB }
  );
}

/** Per-tenant, per-day no-overlap job id: BullMQ dedups `add` on jobId, so one
 *  tenant can never have two snapshot jobs for the same day at once. */
export function snapshotJobId(tenantId: string, runKey: string): string {
  return `snapshot:${tenantId}:${runKey}`;
}

/** UTC midnight of the day `d` falls in — the snapshot's `date` key. */
export function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Fan the dispatch out into one no-overlap job per tenant. Returns the tenant
 *  count. Tenant enumeration is a cross-tenant system read — prismaService. */
export async function dispatchInventorySnapshots(
  queue: SnapshotCronQueue,
  now: Date = new Date()
): Promise<number> {
  const runKey = utcDayStart(now).toISOString().slice(0, 10);
  const tenants = await prismaService.tenant.findMany({ select: { id: true } });
  for (const tenant of tenants) {
    await queue.add(
      SNAPSHOT_TENANT_JOB,
      { tenantId: tenant.id },
      { jobId: snapshotJobId(tenant.id, runKey), removeOnComplete: true, removeOnFail: true }
    );
  }
  return tenants.length;
}

export type SnapshotResult = { written: number; pruned: number };

/**
 * Snapshot one tenant's on-hand for the UTC day `now` falls in, then drop rows
 * past the retention window. Day-set semantics, same as the sales writer: the
 * day is cleared and rewritten, so a retry or a manual re-run converges on the
 * current numbers instead of duplicating or freezing a bad first read.
 */
export async function snapshotTenantInventory(
  tenantId: string,
  now: Date = new Date()
): Promise<SnapshotResult> {
  const date = utcDayStart(now);

  // Deliberately broader than the buy list. Every other surface asks what the
  // shop still sells; this one writes history, and a reader can exclude later
  // by joining Product while no reader can recover a row that was never
  // written. Narrowing it would leave a hole in the stockout record of any
  // product that comes back from archived.
  const products = await prismaService.product.findMany({
    where: { tenantId, active: true },
    select: { id: true, currentStock: true },
  });

  // currentStock is the single on-hand source (the Sells-only rollup the sync
  // maintains) — never a second sum of InventoryLevel.
  const rows = products.map((p) => ({ tenantId, productId: p.id, date, onHand: p.currentStock }));

  await prismaService.inventorySnapshot.deleteMany({ where: { tenantId, date } });
  for (let i = 0; i < rows.length; i += SNAPSHOT_CHUNK) {
    await prismaService.inventorySnapshot.createMany({ data: rows.slice(i, i + SNAPSHOT_CHUNK) });
  }

  const cutoff = new Date(date.getTime() - SNAPSHOT_RETENTION_DAYS * DAY_MS);
  const { count: pruned } = await prismaService.inventorySnapshot.deleteMany({
    where: { tenantId, date: { lt: cutoff } },
  });

  return { written: rows.length, pruned };
}

export interface SnapshotCronWorkerOptions {
  /** BullMQ worker connection — must have maxRetriesPerRequest: null. */
  connection: Redis;
  /** Same-queue handle the dispatch job fans out through. */
  queue: SnapshotCronQueue;
}

export function createSnapshotCronWorker(
  options: SnapshotCronWorkerOptions
): Worker<SnapshotCronJobData> {
  return new Worker<SnapshotCronJobData>(
    SNAPSHOT_CRON_QUEUE,
    async (job: Job<SnapshotCronJobData>) => {
      if (job.name === SNAPSHOT_DISPATCH_JOB) {
        await dispatchInventorySnapshots(options.queue);
        return;
      }
      if (job.name === SNAPSHOT_TENANT_JOB && job.data.tenantId) {
        await snapshotTenantInventory(job.data.tenantId);
      }
    },
    { connection: options.connection }
  );
}
