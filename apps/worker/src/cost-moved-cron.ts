import { Queue, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { BUYABLE_PRODUCT_WHERE, CUSTOMER_TENANTS_WHERE, prismaService } from "@wezesha/db";
import { publishEvent } from "@wezesha/realtime";

/**
 * Nightly cost-moved check (spec §4 "Cost moved sharply"): for each tenant, a
 * SYNCED cost (shopify/qb) that jumped more than ~20% versus the value the last
 * check saw raises an attention row on the product (costMovedPct/costMovedAt) and
 * a bell Notification — so an FX swing on an import never rewrites margins
 * silently. Manual pins are the owner's own number and are never "moved" by a
 * sync, so they are excluded; not-for-sale products go quiet.
 *
 * Same shape as the pos-gap cron: one repeatable dispatch fans out into one job
 * per tenant. The stored `lastSyncedCostKes` is the prior-cost signal — the check
 * re-baselines it to the current cost each run, so it compares last night's cost
 * to tonight's and a sharp jump fires once (the alert then persists until the
 * owner dismisses it on the Costs screen). Queries run on prismaService with an
 * explicit tenantId — the cron fires with no session, the documented use of the
 * BYPASSRLS client.
 *
 * The threshold + percentage rule are the same as the UI/spec detector in
 * apps/web/lib/cost/moved.ts (detectCostMove); kept in step by the worker test.
 */

export const COST_CRON_QUEUE = "cost-crons";
export const COST_MOVED_SCHEDULER = "cost-moved-check";
/** Nightly 05:00 worker-local — after the overnight syncs land new costs. */
export const COST_MOVED_PATTERN = "0 5 * * *";
export const COST_MOVED_DISPATCH_JOB = "cost-moved-dispatch";
export const COST_MOVED_TENANT_JOB = "cost-moved-tenant";

/** Flag a jump beyond this magnitude (percent). */
export const COST_MOVE_THRESHOLD_PCT = 20;

export type CostCronJobData = { tenantId?: string };
export type CostCronQueue = Queue<CostCronJobData>;

export function createCostCronQueue(connection: Redis): CostCronQueue {
  return new Queue<CostCronJobData>(COST_CRON_QUEUE, { connection });
}

/** Idempotent: upserting the scheduler replaces any previous cadence. */
export async function registerCostCronSchedules(queue: CostCronQueue): Promise<void> {
  await queue.upsertJobScheduler(
    COST_MOVED_SCHEDULER,
    { pattern: COST_MOVED_PATTERN },
    { name: COST_MOVED_DISPATCH_JOB },
  );
}

/** Fan the dispatch out into one job per tenant. Returns the tenant count. */
export async function dispatchCostMovedChecks(queue: CostCronQueue): Promise<number> {
  // eslint-disable-next-line tenant-safety/require-tenant-scope -- fan-out dispatch: enumerating every customer workspace is the job, and the per-tenant work it queues is scoped.
  const tenants = await prismaService.tenant.findMany({
    where: CUSTOMER_TENANTS_WHERE,
    select: { id: true },
  });
  if (tenants.length > 0) {
    await queue.addBulk(tenants.map((t) => ({ name: COST_MOVED_TENANT_JOB, data: { tenantId: t.id } })));
  }
  return tenants.length;
}

export type CostMovedResult = { flagged: number; rebaselined: number };

const DAY_MS = 86_400_000;

/**
 * Evaluate one tenant: compare each synced cost to its stored baseline, flag a
 * >20% jump, and re-baseline to the current cost. Returns how many products were
 * flagged / re-baselined.
 */
export async function checkTenantCostMoves(
  tenantId: string,
  publisher: Redis | null = null,
  now: Date = new Date(),
): Promise<CostMovedResult> {
  const products = await prismaService.product.findMany({
    where: { tenantId, ...BUYABLE_PRODUCT_WHERE, costSource: { in: ["shopify", "qb"] } },
    select: { id: true, title: true, costKes: true, lastSyncedCostKes: true },
  });

  // De-dupe bell notifications: one per (product) within a window. The title is
  // the product name and nothing else, so a prior cost_moved notif means we asked
  // already — a second move inside the window re-flags the product but does not
  // ring the bell again.
  const recentSince = new Date(now.getTime() - 30 * DAY_MS);
  const priorTitles = new Set(
    (
      await prismaService.notification.findMany({
        where: { tenantId, kind: "cost_moved", createdAt: { gte: recentSince } },
        select: { title: true },
      })
    ).map((n) => n.title),
  );

  let flagged = 0;
  let rebaselined = 0;

  for (const p of products) {
    if (!(p.costKes > 0)) continue; // missing → nothing to compare
    const baseline = p.lastSyncedCostKes;

    // First observation: establish the baseline, never alert on it.
    if (baseline == null || !(baseline > 0)) {
      await prismaService.product.update({ where: { id: p.id }, data: { lastSyncedCostKes: p.costKes } });
      rebaselined++;
      continue;
    }

    const pct = ((p.costKes - baseline) / baseline) * 100;
    if (Math.abs(pct) > COST_MOVE_THRESHOLD_PCT) {
      const rounded = Math.round(pct);
      await prismaService.product.update({
        where: { id: p.id },
        data: { costMovedPct: rounded, costMovedAt: now, lastSyncedCostKes: p.costKes },
      });
      flagged++;

      const title = costMovedTitle(p.title);
      if (!priorTitles.has(title)) {
        await prismaService.notification.create({
          data: {
            tenantId,
            kind: "cost_moved",
            title,
            body: "A synced cost jumped sharply — margins were recalculated. Check the selling price on the Costs screen.",
          },
        });
        priorTitles.add(title);
        if (publisher) {
          await publishEvent(publisher, { type: "notification.new", data: { tenantId, kind: "cost_moved", title } }).catch(() => {});
        }
      }
      continue;
    }

    // No sharp move — drift the baseline to the current cost.
    if (p.costKes !== baseline) {
      await prismaService.product.update({ where: { id: p.id }, data: { lastSyncedCostKes: p.costKes } });
      rebaselined++;
    }
  }

  return { flagged, rebaselined };
}

/**
 * "COSRX Serum — cost needs a look". Deliberately carries no percentage and no
 * direction: a notification row is read back by paths that do not know the
 * reader's permissions, and the size (or even the sign) of a buying-price move
 * is a cost figure. The number lives on the product's attention row, which the
 * Costs screen only hands to a cost viewer.
 */
export function costMovedTitle(productTitle: string): string {
  return `${productTitle} — cost needs a look`;
}

export interface CostCronWorkerOptions {
  connection: Redis;
  queue: CostCronQueue;
  publisher?: Redis;
}

export function createCostCronWorker(options: CostCronWorkerOptions): Worker<CostCronJobData> {
  return new Worker<CostCronJobData>(
    COST_CRON_QUEUE,
    async (job: Job<CostCronJobData>) => {
      if (job.name === COST_MOVED_DISPATCH_JOB) {
        await dispatchCostMovedChecks(options.queue);
        return;
      }
      if (job.name === COST_MOVED_TENANT_JOB && job.data.tenantId) {
        await checkTenantCostMoves(job.data.tenantId, options.publisher ?? null);
      }
    },
    { connection: options.connection },
  );
}
