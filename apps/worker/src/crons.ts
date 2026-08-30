import { Queue, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { CUSTOMER_TENANTS_WHERE, prismaService } from "@wezesha/db";
import { sendEmail, type SendEmail } from "./email";
import { alertRecipients } from "./incident";
import { buildOwnerReport } from "./owner-report";
import { renderReportEmail } from "./owner-report-email";

/**
 * Email cron scaffold. One repeatable dispatch job per cadence (BullMQ job
 * scheduler, cron pattern) fans out into one lightweight job per tenant, so a
 * slow or failing tenant report never blocks the others and retries stay
 * per-tenant. Two cadences share this one queue: the weekly summary and the
 * monthly owner report. Registration is env-gated in index.ts (EMAIL_CRONS=1)
 * so dev and CI runs stay quiet.
 */

export const EMAIL_CRON_QUEUE = "email-crons";
export const WEEKLY_SUMMARY_SCHEDULER = "weekly-summary";
/** Mondays 06:00, worker-local time. */
export const WEEKLY_SUMMARY_PATTERN = "0 6 * * 1";

export const DISPATCH_JOB = "weekly-summary-dispatch";
export const TENANT_JOB = "weekly-summary-tenant";

export const MONTHLY_REPORT_SCHEDULER = "monthly-report";
/** 1st of the month, 06:00 worker-local time. */
export const MONTHLY_REPORT_PATTERN = "0 6 1 * *";

export const MONTHLY_DISPATCH_JOB = "monthly-report-dispatch";
export const MONTHLY_TENANT_JOB = "monthly-report-tenant";

export type EmailCronJobData = { tenantId?: string };
export type EmailCronQueue = Queue<EmailCronJobData>;

export function createEmailCronQueue(connection: Redis): EmailCronQueue {
  return new Queue<EmailCronJobData>(EMAIL_CRON_QUEUE, { connection });
}

/** Idempotent: upserting each scheduler replaces any previous cadence. Both the
 *  weekly and monthly cadences live on this one queue. */
export async function registerEmailCronSchedules(queue: EmailCronQueue): Promise<void> {
  await queue.upsertJobScheduler(
    WEEKLY_SUMMARY_SCHEDULER,
    { pattern: WEEKLY_SUMMARY_PATTERN },
    { name: DISPATCH_JOB }
  );
  await queue.upsertJobScheduler(
    MONTHLY_REPORT_SCHEDULER,
    { pattern: MONTHLY_REPORT_PATTERN },
    { name: MONTHLY_DISPATCH_JOB }
  );
}

/** Fan a dispatch out into one job per tenant, under the given per-tenant job
 *  name. Returns the tenant count. Tenant enumeration is a cross-tenant system
 *  read — prismaService. */
async function fanOutToTenants(queue: EmailCronQueue, jobName: string): Promise<number> {
  // eslint-disable-next-line tenant-safety/require-tenant-scope -- fan-out dispatch: enumerating every customer workspace is the job, and the per-tenant work it queues is scoped.
  const tenants = await prismaService.tenant.findMany({
    where: CUSTOMER_TENANTS_WHERE,
    select: { id: true },
  });
  if (tenants.length > 0) {
    await queue.addBulk(
      tenants.map((tenant) => ({ name: jobName, data: { tenantId: tenant.id } }))
    );
  }
  return tenants.length;
}

/** Fan the weekly dispatch out into one job per tenant. Returns the tenant count. */
export async function dispatchWeeklySummaries(queue: EmailCronQueue): Promise<number> {
  return fanOutToTenants(queue, TENANT_JOB);
}

/** Fan the monthly dispatch out into one job per tenant. Returns the tenant count. */
export async function dispatchMonthlyReports(queue: EmailCronQueue): Promise<number> {
  return fanOutToTenants(queue, MONTHLY_TENANT_JOB);
}

/** Build, render, and send one tenant's owner report at the given cadence.
 *  False = nothing sent (tenant gone, nothing to say, or nobody left who wants
 *  it). The weekly and monthly paths share this — same rich trend body, they
 *  differ only in granularity, the opt-out kind, and the recipient preference. */
async function sendOwnerReport(
  tenantId: string,
  granularity: "week" | "month",
  kind: "weekly_summary" | "monthly_report",
  send: SendEmail
): Promise<boolean> {
  const recipients = await alertRecipients(tenantId, kind);
  if (!recipients) return false;
  const report = await buildOwnerReport(tenantId, granularity);
  if (!report) return false;
  // One copy each, in series: the same body, addressed to whoever still wants
  // it. Built once — the report is the workspace's, not the reader's.
  const { subject, text, html } = renderReportEmail(report);
  for (const to of recipients.emails) {
    await send({ to, subject, text, html, tenantId, kind });
  }
  return true;
}

/** Build, render, and send one tenant's weekly report (the rich week-by-week
 *  trend). False = nothing sent. */
export async function sendWeeklySummary(
  tenantId: string,
  send: SendEmail = sendEmail
): Promise<boolean> {
  return sendOwnerReport(tenantId, "week", "weekly_summary", send);
}

/** Build, render, and send one tenant's monthly owner report (month-by-month
 *  trend). False = nothing sent. */
export async function sendMonthlyReport(
  tenantId: string,
  send: SendEmail = sendEmail
): Promise<boolean> {
  return sendOwnerReport(tenantId, "month", "monthly_report", send);
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
      if (job.name === MONTHLY_DISPATCH_JOB) {
        await dispatchMonthlyReports(options.queue);
        return;
      }
      if (job.name === TENANT_JOB && job.data.tenantId) {
        await sendWeeklySummary(job.data.tenantId, options.send);
        return;
      }
      if (job.name === MONTHLY_TENANT_JOB && job.data.tenantId) {
        await sendMonthlyReport(job.data.tenantId, options.send);
      }
    },
    { connection: options.connection }
  );
}
