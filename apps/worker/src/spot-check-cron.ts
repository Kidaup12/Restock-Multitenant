import { Queue, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { BUYABLE_PRODUCT_WHERE, CUSTOMER_TENANTS_WHERE, prismaService } from "@wezesha/db";
import { selectSpotChecks, type SpotCandidate } from "@wezesha/forecast";

/**
 * Weekly spot-check cron, same shape as the sales-gap cron: one repeatable
 * dispatch fans out into one job per tenant. Each week it prompts the owner to
 * physically COUNT the handful of SKUs where shelf-vs-system drift costs the
 * most, so theft/breakage/miscounts surface within a week instead of never (the
 * pure picker is @wezesha/forecast spot-check.ts). Per tenant it builds the
 * candidate set from the latest forecast run's predictions joined to the
 * product, asks the picker for the top few, and writes one SpotCheck row per
 * picked SKU (systemQty = current believed on-hand, countedQty null). The web
 * app renders this week's rows and records the count.
 *
 * In-app only: the SpotCheck rows ARE the nudge — the web card lists them and
 * takes the count. No email path, so no new notify-prefs kind is needed.
 *
 * Idempotent per week: a run that finds SpotCheck rows already written for this
 * (tenant, weekKey) leaves them alone rather than writing a second set, so a
 * re-fire (or a manual replay) never doubles the prompts or moves the systemQty
 * out from under a count in progress.
 *
 * Queries run on prismaService WITH an explicit tenantId filter — the cron fires
 * with no session, the documented use of the BYPASSRLS client (same pattern as
 * pos-gap-cron.ts / owner-report.ts).
 */

export const SPOT_CHECK_QUEUE = "spot-check-crons";
export const SPOT_CHECK_SCHEDULER = "weekly-spot-check";
/** Mondays 06:00, worker-local time — same slot as the weekly summary. */
export const SPOT_CHECK_PATTERN = "0 6 * * 1";

export const SPOT_CHECK_DISPATCH_JOB = "spot-check-dispatch";
export const SPOT_CHECK_TENANT_JOB = "spot-check-tenant";

export type SpotCheckJobData = { tenantId?: string };
export type SpotCheckQueue = Queue<SpotCheckJobData>;

export function createSpotCheckQueue(connection: Redis): SpotCheckQueue {
  return new Queue<SpotCheckJobData>(SPOT_CHECK_QUEUE, { connection });
}

/** Idempotent: upserting the scheduler replaces any previous cadence. */
export async function registerSpotCheckSchedules(queue: SpotCheckQueue): Promise<void> {
  await queue.upsertJobScheduler(
    SPOT_CHECK_SCHEDULER,
    { pattern: SPOT_CHECK_PATTERN },
    { name: SPOT_CHECK_DISPATCH_JOB }
  );
}

/** Fan the dispatch out into one job per tenant. Returns the tenant count. */
export async function dispatchSpotChecks(queue: SpotCheckQueue): Promise<number> {
  // eslint-disable-next-line tenant-safety/require-tenant-scope -- fan-out dispatch: enumerating every customer workspace is the job, and the per-tenant work it queues is scoped.
  const tenants = await prismaService.tenant.findMany({
    where: CUSTOMER_TENANTS_WHERE,
    select: { id: true },
  });
  if (tenants.length > 0) {
    await queue.addBulk(
      tenants.map((t) => ({ name: SPOT_CHECK_TENANT_JOB, data: { tenantId: t.id } }))
    );
  }
  return tenants.length;
}

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");

/** ISO-8601 week key ("YYYY-Www"), identical to Postgres to_char(date,
 *  'IYYY-"W"IW') and to the SpotCheck.weekKey the web reader groups on. Inlined
 *  the same way owner-report.ts does — the worker cannot import apps/web. */
export function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7; // Mon=1..Sun=7
  t.setUTCDate(t.getUTCDate() + 4 - day); // the Thursday decides the ISO year
  const isoYear = t.getUTCFullYear();
  const jan1 = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((t.getTime() - jan1.getTime()) / DAY + 1) / 7);
  return `${isoYear}-W${pad(week)}`;
}

/** The latest forecast run's date for a tenant — the run we read run rates from.
 *  null when the tenant has never forecast. */
async function latestRunDate(tenantId: string): Promise<Date | null> {
  const latest = await prismaService.prediction.findFirst({
    where: { tenantId },
    orderBy: { runDate: "desc" },
    select: { runDate: true },
  });
  return latest?.runDate ?? null;
}

export type SpotCheckResult = { weekKey: string; picked: number; skipped: boolean } | null;

/**
 * Evaluate one tenant: pick this week's SKUs to count and write a SpotCheck row
 * for each. `skipped` = rows already existed for this (tenant, weekKey), so we
 * left them; null = tenant gone. now defaults to real time; injectable for tests.
 */
export async function runTenantSpotCheck(
  tenantId: string,
  now: Date = new Date()
): Promise<SpotCheckResult> {
  const weekKey = isoWeekKey(now);

  // Idempotency: one set of prompts per week. If we've already written for this
  // week, do nothing — a re-fire must not double the prompts or overwrite a
  // systemQty a count is already comparing against.
  const existing = await prismaService.spotCheck.count({ where: { tenantId, weekKey } });
  if (existing > 0) return { weekKey, picked: 0, skipped: true };

  // eslint-disable-next-line tenant-safety/require-tenant-scope -- reads one tenant by the id the job already carries; the worker has no session, so there is no resolver to route through.
  const tenant = await prismaService.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true },
  });
  if (!tenant) return null;

  // Run rate comes from the latest forecast run's predictions (finalForecast30d
  // / 30) joined to the product for on-hand + shelf value. No run yet → nothing
  // to rank on, so nothing to prompt.
  const runDate = await latestRunDate(tenantId);
  if (!runDate) return { weekKey, picked: 0, skipped: false };

  const preds = await prismaService.prediction.findMany({
    where: {
      tenantId,
      runDate,
      product: { ...BUYABLE_PRODUCT_WHERE },
    },
    select: {
      productId: true,
      finalForecast30d: true,
      product: { select: { currentStock: true, costKes: true, priceKes: true } },
    },
  });

  // One candidate per product. Value = capital at risk on the shelf: stock ×
  // cost, falling back to price when no cost is recorded (so a cost-blind SKU
  // still competes on what it would fetch). The picker skips dead/empty SKUs.
  const candidates: SpotCandidate[] = preds.map((p) => {
    const unitValue = p.product.costKes > 0 ? p.product.costKes : p.product.priceKes;
    return {
      id: p.productId,
      runRate: p.finalForecast30d / 30,
      currentStock: p.product.currentStock,
      valueKes: p.product.currentStock * unitValue,
    };
  });

  const picked = selectSpotChecks(candidates);
  if (picked.length === 0) return { weekKey, picked: 0, skipped: false };

  // Snapshot the believed on-hand into each row now — the count is compared to
  // what the app thought at prompt time, not to a moving current stock.
  const stockById = new Map(preds.map((p) => [p.productId, p.product.currentStock]));
  await prismaService.spotCheck.createMany({
    data: picked.map((c) => ({
      tenantId,
      productId: c.id,
      weekKey,
      systemQty: stockById.get(c.id) ?? c.currentStock,
    })),
  });

  return { weekKey, picked: picked.length, skipped: false };
}

export interface SpotCheckWorkerOptions {
  connection: Redis;
  queue: SpotCheckQueue;
}

export function createSpotCheckWorker(options: SpotCheckWorkerOptions): Worker<SpotCheckJobData> {
  return new Worker<SpotCheckJobData>(
    SPOT_CHECK_QUEUE,
    async (job: Job<SpotCheckJobData>) => {
      if (job.name === SPOT_CHECK_DISPATCH_JOB) {
        await dispatchSpotChecks(options.queue);
        return;
      }
      if (job.name === SPOT_CHECK_TENANT_JOB && job.data.tenantId) {
        await runTenantSpotCheck(job.data.tenantId);
      }
    },
    { connection: options.connection }
  );
}
