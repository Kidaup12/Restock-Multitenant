import { Queue, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { prismaForTenant, prismaService } from "@wezesha/db";
import { reconcilePurchaseOrders } from "@wezesha/quickbooks";

/**
 * Daily QuickBooks purchase-order reconciliation.
 *
 * Answers the three questions a shop has about its books: which orders it sent
 * reached them, which never did, and what is in them that this system did not
 * raise. Same fan-out shape as the cost-moved cron — one repeatable dispatch
 * into one job per connected tenant.
 *
 * **It writes evidence, never stock.** `qbConfirmedAt` / `qbDocRef` /
 * `qbSuggestion` / `needsAttention` are a parallel track by design; nothing here
 * changes what the buy list counts as on order, so a mismatch in the books can
 * never suppress a restock and take a shop out of stock.
 *
 * Only tenants with a live connection are dispatched. Enumerating every
 * workspace and discovering most have no QuickBooks would be one wasted job per
 * shop per day.
 */

export const QB_CRON_QUEUE = "quickbooks-crons";
export const QB_RECONCILE_SCHEDULER = "quickbooks-po-reconcile";
/** Daily 06:00 worker-local — after the overnight syncs, before the owner reads
 *  anything. Evidence, not a live figure, so a daily cadence is enough. */
export const QB_RECONCILE_PATTERN = "0 6 * * *";
export const QB_RECONCILE_DISPATCH_JOB = "quickbooks-reconcile-dispatch";
export const QB_RECONCILE_TENANT_JOB = "quickbooks-reconcile-tenant";

/** One bell per window, so a long-running mismatch does not ring every day. */
const NOTIFY_DEDUP_DAYS = 7;
const DAY_MS = 86_400_000;

export type QuickBooksCronJobData = { tenantId?: string };
export type QuickBooksCronQueue = Queue<QuickBooksCronJobData>;

export function createQuickBooksCronQueue(connection: Redis): QuickBooksCronQueue {
  return new Queue<QuickBooksCronJobData>(QB_CRON_QUEUE, { connection });
}

/** Idempotent: upserting the scheduler replaces any previous cadence. */
export async function registerQuickBooksCronSchedules(queue: QuickBooksCronQueue): Promise<void> {
  await queue.upsertJobScheduler(
    QB_RECONCILE_SCHEDULER,
    { pattern: QB_RECONCILE_PATTERN },
    { name: QB_RECONCILE_DISPATCH_JOB },
  );
}

/** Fan out to the tenants that actually have books connected. */
export async function dispatchQuickBooksReconciles(queue: QuickBooksCronQueue): Promise<number> {
  // eslint-disable-next-line tenant-safety/require-tenant-scope -- fan-out dispatch: finding which workspaces have a live connection IS the job, and the per-tenant work it queues is scoped.
  const connections = await prismaService.quickBooksConnection.findMany({
    where: { disconnectedAt: null, syncPausedAt: null },
    select: { tenantId: true },
  });
  if (connections.length > 0) {
    await queue.addBulk(
      connections.map((c) => ({ name: QB_RECONCILE_TENANT_JOB, data: { tenantId: c.tenantId } })),
    );
  }
  return connections.length;
}

/**
 * Reconcile one tenant and tell the owner only when there is something to do.
 *
 * A clean run is silent. Ringing the bell to say "everything matched" trains
 * people to ignore the bell, which costs the one notification that mattered.
 */
export async function reconcileTenantBooks(
  tenantId: string,
  now: Date = new Date(),
): Promise<{ confirmed: number; phantoms: number; external: number } | null> {
  const result = await reconcilePurchaseOrders({ tenantId, now });
  if (!result.ok) return null;

  const db = prismaForTenant(tenantId);
  const dedupSince = new Date(now.getTime() - NOTIFY_DEDUP_DAYS * DAY_MS);

  const notifyOnce = async (kind: string, title: string, body: string): Promise<void> => {
    const recent = await db.notification.findFirst({
      where: { kind, createdAt: { gte: dedupSince } },
      select: { id: true },
    });
    if (recent) return;
    await db.notification.create({ data: { tenantId, kind, title, body } });
  };

  if (result.phantoms > 0) {
    await notifyOnce(
      "qb_orders_missing_from_books",
      `${result.phantoms} sent order${result.phantoms === 1 ? "" : "s"} not in your books`,
      "We sent these to a supplier but cannot find them in QuickBooks. Check they were entered — " +
        "an order missing from the books is one nobody is expecting to pay.",
    );
  }

  if (result.external.length > 0) {
    const names = result.external
      .slice(0, 3)
      .map((d) => d.docNumber ?? d.id)
      .join(", ");
    await notifyOnce(
      "qb_orders_raised_elsewhere",
      `${result.external.length} purchase order${result.external.length === 1 ? "" : "s"} raised outside Wezesha`,
      `These are in QuickBooks but were not raised here (${names}). They are stock on its way that ` +
        "this system does not know about.",
    );
  }

  return {
    confirmed: result.confirmed,
    phantoms: result.phantoms,
    external: result.external.length,
  };
}

export function createQuickBooksCronWorker(options: {
  connection: Redis;
  queue: QuickBooksCronQueue;
}): Worker<QuickBooksCronJobData> {
  return new Worker<QuickBooksCronJobData>(
    QB_CRON_QUEUE,
    async (job: Job<QuickBooksCronJobData>) => {
      if (job.name === QB_RECONCILE_DISPATCH_JOB) {
        const count = await dispatchQuickBooksReconciles(options.queue);
        return { dispatched: count };
      }
      const tenantId = job.data.tenantId;
      if (!tenantId) return { skipped: "no tenant" };
      const result = await reconcileTenantBooks(tenantId);
      return result ?? { skipped: "not connected" };
    },
    { connection: options.connection },
  );
}
