import { Queue, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { isSellable, prismaService } from "@wezesha/db";
import { detectSalesGaps, tenantDayKey, type SalesGap } from "@wezesha/pos";
import { publishEvent } from "@wezesha/realtime";

/**
 * Daily sales-gap check, same shape as the limits cron: one repeatable dispatch
 * fans out into one job per tenant. For each tenant it asks the pure detector
 * (see @wezesha/pos gap.ts) which Sells branches recorded zero sales on a day
 * their siblings sold, and raises a bell Notification per new gap so the owner
 * is asked "closed, or feed problem?" within a day (spec §3). The live list on
 * the Sales screen recomputes the same gaps on read; this wave is the nudge.
 *
 * Queries run on prismaService WITH an explicit tenantId filter — the cron fires
 * with no session, the documented use of the BYPASSRLS client.
 */

export const POS_CRON_QUEUE = "pos-crons";
export const GAP_CHECK_SCHEDULER = "sales-gap-check";
/** Daily 06:00 worker-local time — after the night syncs, before the day opens. */
export const GAP_CHECK_PATTERN = "0 6 * * *";

export const GAP_DISPATCH_JOB = "sales-gap-dispatch";
export const GAP_TENANT_JOB = "sales-gap-tenant";

/** How many complete days back to evaluate each run. */
export const GAP_WINDOW_DAYS = 14;
const DAY_MS = 86_400_000;

export type PosCronJobData = { tenantId?: string };
export type PosCronQueue = Queue<PosCronJobData>;

export function createPosCronQueue(connection: Redis): PosCronQueue {
  return new Queue<PosCronJobData>(POS_CRON_QUEUE, { connection });
}

/** Idempotent: upserting the scheduler replaces any previous cadence. */
export async function registerPosCronSchedules(queue: PosCronQueue): Promise<void> {
  await queue.upsertJobScheduler(
    GAP_CHECK_SCHEDULER,
    { pattern: GAP_CHECK_PATTERN },
    { name: GAP_DISPATCH_JOB }
  );
}

/** Fan the dispatch out into one job per tenant. Returns the tenant count. */
export async function dispatchGapChecks(queue: PosCronQueue): Promise<number> {
  // eslint-disable-next-line tenant-safety/require-tenant-scope -- fan-out dispatch: enumerating every tenant is the job, and the per-tenant work it queues is scoped.
  const tenants = await prismaService.tenant.findMany({ select: { id: true } });
  if (tenants.length > 0) {
    await queue.addBulk(tenants.map((t) => ({ name: GAP_TENANT_JOB, data: { tenantId: t.id } })));
  }
  return tenants.length;
}

/** The last `n` COMPLETE tenant-local days (excludes today), most recent first. */
export function recentTenantDays(timezone: string, n: number, now: Date): string[] {
  const days: string[] = [];
  for (let i = 1; i <= n; i++) days.push(tenantDayKey(timezone, new Date(now.getTime() - i * DAY_MS)));
  return days;
}

export type GapCheckResult = { gaps: SalesGap[]; notified: number } | null;

/**
 * Evaluate one tenant: find this window's sales gaps and raise one bell
 * Notification per gap we haven't already flagged. Null = tenant gone.
 */
export async function checkTenantSalesGaps(
  tenantId: string,
  publisher: Redis | null = null,
  now: Date = new Date()
): Promise<GapCheckResult> {
  // eslint-disable-next-line tenant-safety/require-tenant-scope -- reads one tenant by the id the job already carries; the worker has no session, so there is no resolver to route through.
  const tenant = await prismaService.tenant.findUnique({
    where: { id: tenantId },
    select: { timezone: true },
  });
  if (!tenant) return null;

  const locations = await prismaService.location.findMany({
    where: { tenantId },
    select: { id: true, name: true, locationType: true },
  });
  const sells = locations.filter((l) => isSellable(l));
  if (sells.length < 2) return { gaps: [], notified: 0 }; // no siblings → no gaps
  const nameById = new Map(sells.map((l) => [l.id, l.name]));

  const days = recentTenantDays(tenant.timezone, GAP_WINDOW_DAYS, now);
  const oldest = new Date(`${days[days.length - 1]}T00:00:00.000Z`);

  const [rows, closures] = await Promise.all([
    prismaService.salesHistory.findMany({
      where: { tenantId, locationId: { not: null }, date: { gte: oldest } },
      select: { locationId: true, date: true },
    }),
    prismaService.locationClosure.findMany({
      where: { tenantId, date: { gte: oldest } },
      select: { locationId: true, date: true },
    }),
  ]);

  const soldOn = rows.map((r) => ({ locationId: r.locationId!, dayKey: r.date.toISOString().slice(0, 10) }));
  const closed = closures.map((c) => ({ locationId: c.locationId, dayKey: c.date.toISOString().slice(0, 10) }));

  const gaps = detectSalesGaps({
    sellsLocationIds: sells.map((l) => l.id),
    soldOn,
    days,
    closures: closed,
  });

  // De-dupe: one bell per (branch, day). The title is deterministic, so a prior
  // notification with the same title means we already asked.
  let notified = 0;
  const recentSince = new Date(now.getTime() - (GAP_WINDOW_DAYS + 7) * DAY_MS);
  const priorTitles = new Set(
    (
      await prismaService.notification.findMany({
        where: { tenantId, kind: "sales_gap", createdAt: { gte: recentSince } },
        select: { title: true },
      })
    ).map((n) => n.title)
  );

  for (const gap of gaps) {
    const title = gapTitle(nameById.get(gap.locationId) ?? "A branch", gap.dayKey);
    if (priorTitles.has(title)) continue;
    await prismaService.notification.create({
      data: {
        tenantId,
        kind: "sales_gap",
        title,
        body: "No sales were recorded here that day while other branches sold. Was the shop closed, or is the sales feed missing? Open Sales data to resolve it.",
      },
    });
    priorTitles.add(title);
    notified++;
    if (publisher) {
      await publishEvent(publisher, {
        type: "notification.new",
        data: { tenantId, kind: "sales_gap", title },
      }).catch(() => {});
    }
  }

  return { gaps, notified };
}

/** "Kilimani recorded zero sales on Tue 15 Jul". */
export function gapTitle(locationName: string, dayKey: string): string {
  const label = new Date(`${dayKey}T00:00:00.000Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
  return `${locationName} recorded zero sales on ${label}`;
}

export interface PosCronWorkerOptions {
  connection: Redis;
  queue: PosCronQueue;
  publisher?: Redis;
}

export function createPosCronWorker(options: PosCronWorkerOptions): Worker<PosCronJobData> {
  return new Worker<PosCronJobData>(
    POS_CRON_QUEUE,
    async (job: Job<PosCronJobData>) => {
      if (job.name === GAP_DISPATCH_JOB) {
        await dispatchGapChecks(options.queue);
        return;
      }
      if (job.name === GAP_TENANT_JOB && job.data.tenantId) {
        await checkTenantSalesGaps(job.data.tenantId, options.publisher ?? null);
      }
    },
    { connection: options.connection }
  );
}
