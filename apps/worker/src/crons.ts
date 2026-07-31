import { Queue, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { CUSTOMER_TENANTS_WHERE, prismaService } from "@wezesha/db";
import { sendEmail, type SendEmail } from "./email";
import { alertRecipient } from "./incident";
import { buildWeeklySummary, renderWeeklySummary } from "./weekly-summary";

/**
 * Email cron scaffold. One repeatable dispatch job (BullMQ job scheduler, cron
 * pattern) fans out into one lightweight job per tenant, so a slow or failing
 * tenant summary never blocks the others and retries stay per-tenant.
 * Registration is env-gated in index.ts (EMAIL_CRONS=1) so dev and CI runs
 * stay quiet.
 */

export const EMAIL_CRON_QUEUE = "email-crons";
export const WEEKLY_SUMMARY_SCHEDULER = "weekly-summary";
/** Mondays 06:00, worker-local time. */
export const WEEKLY_SUMMARY_PATTERN = "0 6 * * 1";

export const DISPATCH_JOB = "weekly-summary-dispatch";
export const TENANT_JOB = "weekly-summary-tenant";

export type EmailCronJobData = { tenantId?: string };
export type EmailCronQueue = Queue<EmailCronJobData>;

export function createEmailCronQueue(connection: Redis): EmailCronQueue {
  return new Queue<EmailCronJobData>(EMAIL_CRON_QUEUE, { connection });
}

/** Idempotent: upserting the scheduler replaces any previous cadence. */
export async function registerEmailCronSchedules(queue: EmailCronQueue): Promise<void> {
  await queue.upsertJobScheduler(
    WEEKLY_SUMMARY_SCHEDULER,
    { pattern: WEEKLY_SUMMARY_PATTERN },
    { name: DISPATCH_JOB }
  );
}

/** Fan the dispatch out into one job per tenant. Returns the tenant count.
 *  Tenant enumeration is a cross-tenant system read — prismaService. */
export async function dispatchWeeklySummaries(queue: EmailCronQueue): Promise<number> {
  // eslint-disable-next-line tenant-safety/require-tenant-scope -- fan-out dispatch: enumerating every customer workspace is the job, and the per-tenant work it queues is scoped.
  const tenants = await prismaService.tenant.findMany({
    where: CUSTOMER_TENANTS_WHERE,
    select: { id: true },
  });
  if (tenants.length > 0) {
    await queue.addBulk(
      tenants.map((tenant) => ({ name: TENANT_JOB, data: { tenantId: tenant.id } }))
    );
  }
  return tenants.length;
}

/** Build, render, and send one tenant's summary. False = nothing sent (tenant
 *  gone or no alert recipient configured). */
export async function sendWeeklySummary(
  tenantId: string,
  send: SendEmail = sendEmail
): Promise<boolean> {
  const recipient = await alertRecipient(tenantId);
  if (!recipient) return false;
  const summary = await buildWeeklySummary(tenantId);
  if (!summary) return false;
  await send({
    to: recipient.email,
    subject: `Weekly stock summary — ${summary.tenantName}`,
    text: renderWeeklySummary(summary),
  });
  return true;
}

export interface EmailCronWorkerOptions {
  /** BullMQ worker connection — must have maxRetriesPerRequest: null. */
  connection: Redis;
  /** Same-queue handle the dispatch job fans out through. */
  queue: EmailCronQueue;
  send?: SendEmail;
}

export function createEmailCronWorker(options: EmailCronWorkerOptions): Worker<EmailCronJobData> {
  return new Worker<EmailCronJobData>(
    EMAIL_CRON_QUEUE,
    async (job: Job<EmailCronJobData>) => {
      if (job.name === DISPATCH_JOB) {
        await dispatchWeeklySummaries(options.queue);
        return;
      }
      if (job.name === TENANT_JOB && job.data.tenantId) {
        await sendWeeklySummary(job.data.tenantId, options.send);
      }
    },
    { connection: options.connection }
  );
}
