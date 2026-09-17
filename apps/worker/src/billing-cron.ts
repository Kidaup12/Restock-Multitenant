import { Queue, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { CUSTOMER_TENANTS_WHERE, prismaService } from "@wezesha/db";

/**
 * Daily billing-period enforcement, same shape as the limits cron: one
 * repeatable dispatch fans out into one job per tenant. For each tenant it reads
 * the operator-set planPeriodEnd/planStatus (from the console — there is no
 * self-serve billing yet) and, once the paid period has been over for longer
 * than the grace window, softens the workspace to past_due.
 *
 * Deliberately SOFT: past_due changes no capability and locks nobody out — it is
 * a flag support and the console read, and the trigger for a "your period has
 * lapsed" conversation. The mirror of the limits cron's grace anchor: there the
 * clock starts when usage goes over; here it is the period end itself, and the
 * grace window is the same idea — nothing happens the instant a period lapses.
 *
 * Only a currently-active/trialing tenant with a real period is touched. A
 * workspace already past_due or canceled is left alone (nothing to re-decide),
 * and one with no period kept has no billing to enforce. So the job is
 * idempotent and re-running it never re-fires on a tenant it already softened.
 *
 * Queries run on prismaService WITH an explicit tenantId filter — the cron fires
 * with no session, the documented use of the BYPASSRLS client.
 */

export const BILLING_CRON_QUEUE = "billing-crons";
export const BILLING_CHECK_SCHEDULER = "billing-check";
/** Daily 05:45 worker-local time — beside the limits check, after night syncs. */
export const BILLING_CHECK_PATTERN = "45 5 * * *";

export const BILLING_DISPATCH_JOB = "billing-check-dispatch";
export const BILLING_TENANT_JOB = "billing-check-tenant";

const DAY_MS = 86_400_000;
/** How long a lapsed period stays untouched before it softens to past_due. The
 *  mirror of the limits cron's 7-day grace: a lapse is a nudge, not a trap. */
export const BILLING_GRACE_DAYS = 7;

/** The statuses this cron will act on. A workspace already past_due or canceled
 *  has nothing left to re-decide; one with no status has no billing kept. */
const ENFORCEABLE_STATUSES = new Set(["active", "trialing"]);

export type BillingCronJobData = { tenantId?: string };
export type BillingCronQueue = Queue<BillingCronJobData>;

export function createBillingCronQueue(connection: Redis): BillingCronQueue {
  return new Queue<BillingCronJobData>(BILLING_CRON_QUEUE, { connection });
}

/** Idempotent: upserting the scheduler replaces any previous cadence. */
export async function registerBillingCronSchedules(queue: BillingCronQueue): Promise<void> {
  await queue.upsertJobScheduler(
    BILLING_CHECK_SCHEDULER,
    { pattern: BILLING_CHECK_PATTERN },
    { name: BILLING_DISPATCH_JOB }
  );
}

/** Fan the dispatch out into one job per tenant. Returns the tenant count. */
export async function dispatchBillingChecks(queue: BillingCronQueue): Promise<number> {
  // eslint-disable-next-line tenant-safety/require-tenant-scope -- fan-out dispatch: enumerating every customer workspace is the job, and the per-tenant work it queues is scoped.
  const tenants = await prismaService.tenant.findMany({
    where: CUSTOMER_TENANTS_WHERE,
    select: { id: true },
  });
  if (tenants.length > 0) {
    await queue.addBulk(
      tenants.map((tenant) => ({ name: BILLING_TENANT_JOB, data: { tenantId: tenant.id } }))
    );
  }
  return tenants.length;
}

export type BillingCheckResult = {
  /** True when this run flipped the tenant to past_due. */
  softened: boolean;
  /** The status after the run (unchanged when softened=false). */
  status: string | null;
} | null;

/**
 * Evaluate one tenant: if it is active/trialing with a period that lapsed more
 * than the grace window ago, soften it to past_due. Otherwise leave it exactly
 * as it is. Null = tenant gone.
 */
export async function checkTenantBilling(
  tenantId: string,
  now: Date = new Date()
): Promise<BillingCheckResult> {
  // eslint-disable-next-line tenant-safety/require-tenant-scope -- reads one tenant by the id the job already carries; the worker has no session, so there is no resolver to route through.
  const tenant = await prismaService.tenant.findUnique({
    where: { id: tenantId },
    select: { planPeriodEnd: true, planStatus: true },
  });
  if (!tenant) return null;

  const status = tenant.planStatus ?? null;
  const periodEnd = tenant.planPeriodEnd ?? null;

  // Nothing to enforce: no status we act on, or no period kept.
  if (!status || !ENFORCEABLE_STATUSES.has(status) || !periodEnd) {
    return { softened: false, status };
  }

  const lapsedFor = now.getTime() - periodEnd.getTime();
  if (lapsedFor <= BILLING_GRACE_DAYS * DAY_MS) {
    // Still inside the period, or inside grace — untouched.
    return { softened: false, status };
  }

  await prismaService.tenant.update({
    where: { id: tenantId },
    data: { planStatus: "past_due" },
  });
  return { softened: true, status: "past_due" };
}

export interface BillingCronWorkerOptions {
  /** BullMQ worker connection — must have maxRetriesPerRequest: null. */
  connection: Redis;
  /** Same-queue handle the dispatch job fans out through. */
  queue: BillingCronQueue;
}

export function createBillingCronWorker(
  options: BillingCronWorkerOptions
): Worker<BillingCronJobData> {
  return new Worker<BillingCronJobData>(
    BILLING_CRON_QUEUE,
    async (job: Job<BillingCronJobData>) => {
      if (job.name === BILLING_DISPATCH_JOB) {
        await dispatchBillingChecks(options.queue);
        return;
      }
      if (job.name === BILLING_TENANT_JOB && job.data.tenantId) {
        await checkTenantBilling(job.data.tenantId);
      }
    },
    { connection: options.connection }
  );
}
