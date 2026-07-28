import { Queue, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { BUYABLE_PRODUCT_WHERE, computeLimitState, prismaService, resolvePlanLimits, type LimitState } from "@wezesha/db";

/**
 * Daily plan-limit check, same shape as the email crons: one repeatable
 * dispatch job fans out into one job per tenant. A tenant over any limit gets
 * a bell Notification (kind "limit_warning", deduped to one per week) and the
 * grace clock starts. This job never blocks anything itself — it owns the
 * grace anchor that the web app's enforcement points (checkLimit) read when
 * they decide whether an action still fits.
 *
 * Queries run on prismaService WITH an explicit tenantId filter — the cron
 * fires with no session, the documented use of the BYPASSRLS client.
 */

export const OPS_CRON_QUEUE = "ops-crons";
export const LIMITS_CHECK_SCHEDULER = "limits-check";
/** Daily 05:30, worker-local time — before the working day, after night syncs. */
export const LIMITS_CHECK_PATTERN = "30 5 * * *";

export const LIMITS_DISPATCH_JOB = "limits-check-dispatch";
export const LIMITS_TENANT_JOB = "limits-check-tenant";

/** One warning per tenant per rolling week. */
export const WARNING_DEDUP_DAYS = 7;

const DAY_MS = 86_400_000;

export type OpsCronJobData = { tenantId?: string };
export type OpsCronQueue = Queue<OpsCronJobData>;

export function createOpsCronQueue(connection: Redis): OpsCronQueue {
  return new Queue<OpsCronJobData>(OPS_CRON_QUEUE, { connection });
}

/** Idempotent: upserting the scheduler replaces any previous cadence. */
export async function registerOpsCronSchedules(queue: OpsCronQueue): Promise<void> {
  await queue.upsertJobScheduler(
    LIMITS_CHECK_SCHEDULER,
    { pattern: LIMITS_CHECK_PATTERN },
    { name: LIMITS_DISPATCH_JOB }
  );
}

/** Fan the dispatch out into one job per tenant. Returns the tenant count. */
export async function dispatchLimitsChecks(queue: OpsCronQueue): Promise<number> {
  const tenants = await prismaService.tenant.findMany({ select: { id: true } });
  if (tenants.length > 0) {
    await queue.addBulk(
      tenants.map((tenant) => ({ name: LIMITS_TENANT_JOB, data: { tenantId: tenant.id } }))
    );
  }
  return tenants.length;
}

export type LimitsCheckResult = {
  state: LimitState;
  /** True when this run wrote a limit_warning Notification. */
  warned: boolean;
} | null;

/**
 * Evaluate one tenant: count usage, keep the TenantConfig.limitsExceededAt
 * grace anchor honest (set on first-over, cleared on recovery), and warn the
 * bell once per week while over. Null = tenant gone.
 */
export async function checkTenantLimits(
  tenantId: string,
  now: Date = new Date()
): Promise<LimitsCheckResult> {
  const tenant = await prismaService.tenant.findUnique({
    where: { id: tenantId },
    select: { plan: true, planLimits: true },
  });
  if (!tenant) return null;

  const since = new Date(now.getTime() - 30 * DAY_MS);
  const [products, members, orders30d, config] = await Promise.all([
    prismaService.product.count({ where: { tenantId, ...BUYABLE_PRODUCT_WHERE } }),
    prismaService.membership.count({ where: { tenantId } }),
    prismaService.salesHistory.count({ where: { tenantId, date: { gte: since } } }),
    prismaService.tenantConfig.findUnique({
      where: { tenantId },
      select: { limitsExceededAt: true },
    }),
  ]);

  const limits = resolvePlanLimits(tenant);
  let anchor = config?.limitsExceededAt ?? null;
  const preliminary = computeLimitState({ products, members, orders30d }, limits, anchor, now);

  if (preliminary.anyOver && !anchor) {
    // First time over: start the grace clock.
    anchor = now;
    await prismaService.tenantConfig.upsert({
      where: { tenantId },
      create: { tenantId, limitsExceededAt: now },
      update: { limitsExceededAt: now },
    });
  } else if (!preliminary.anyOver && anchor) {
    // Recovered: clear the clock so the next incident restarts grace in full.
    anchor = null;
    await prismaService.tenantConfig.updateMany({
      where: { tenantId },
      data: { limitsExceededAt: null },
    });
  }
  const state = computeLimitState({ products, members, orders30d }, limits, anchor, now);

  let warned = false;
  if (state.anyOver) {
    const dedupSince = new Date(now.getTime() - WARNING_DEDUP_DAYS * DAY_MS);
    const recent = await prismaService.notification.findFirst({
      where: { tenantId, kind: "limit_warning", createdAt: { gte: dedupSince } },
      select: { id: true },
    });
    if (!recent) {
      await prismaService.notification.create({
        data: {
          tenantId,
          kind: "limit_warning",
          title: "Plan limit reached",
          body: limitWarningBody(state),
        },
      });
      warned = true;
    }
  }

  return { state, warned };
}

/** Plain-language warning: which limits are over, and what happens next. */
export function limitWarningBody(state: LimitState): string {
  const over: string[] = [];
  if (state.products.over) over.push(`products (${state.products.used} of ${state.products.max})`);
  if (state.members.over) over.push(`team members (${state.members.used} of ${state.members.max})`);
  if (state.orders30d.over)
    over.push(`sales activity in the last 30 days (${state.orders30d.used} of ${state.orders30d.max})`);

  const grace =
    state.graceLeftDays !== null && state.graceLeftDays > 0
      ? `Everything keeps working for now — after ${state.graceLeftDays} more day${state.graceLeftDays === 1 ? "" : "s"}, adding more may be limited.`
      : "The grace period has ended, so adding more may be limited.";

  return `This workspace is over its plan limit for ${over.join(", ")}. ${grace} Contact support to move to a bigger plan.`;
}

export interface OpsCronWorkerOptions {
  /** BullMQ worker connection — must have maxRetriesPerRequest: null. */
  connection: Redis;
  /** Same-queue handle the dispatch job fans out through. */
  queue: OpsCronQueue;
}

export function createOpsCronWorker(options: OpsCronWorkerOptions): Worker<OpsCronJobData> {
  return new Worker<OpsCronJobData>(
    OPS_CRON_QUEUE,
    async (job: Job<OpsCronJobData>) => {
      if (job.name === LIMITS_DISPATCH_JOB) {
        await dispatchLimitsChecks(options.queue);
        return;
      }
      if (job.name === LIMITS_TENANT_JOB && job.data.tenantId) {
        await checkTenantLimits(job.data.tenantId);
      }
    },
    { connection: options.connection }
  );
}
