import { Queue, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { prismaService } from "@wezesha/db";
import { runForecast, runBacktest } from "@wezesha/forecast-run";

/**
 * Forecast crons — the freshness + accuracy backbone (spec §6).
 *
 *   nightly:  runForecast per tenant at ~02:00, so every screen opens on "the
 *             forecast from last night" instead of a manual re-run.
 *   monthly:  the walk-forward backtest per tenant — accuracy tracking, the
 *             champion/challenger audit, and the degradation alert.
 *
 * Same fan-out shape as the other crons (one dispatch job → one job per tenant,
 * so a slow tenant never blocks the rest) with a deterministic per-tenant jobId
 * so a run can never overlap itself. Registration is env-gated in index.ts
 * (FORECAST_CRON=1) so dev and CI runs stay quiet. Cron reads/writes are
 * single-tenant paths inside runForecast/runBacktest (RLS-enforced client);
 * tenant enumeration is the documented cross-tenant use of prismaService.
 */

export const FORECAST_CRON_QUEUE = "forecast-crons";

export const NIGHTLY_FORECAST_SCHEDULER = "nightly-forecast";
/** 02:00 worker-local — backs the spec's "forecast from last night 02:00". */
export const NIGHTLY_FORECAST_PATTERN = "0 2 * * *";

export const MONTHLY_BACKTEST_SCHEDULER = "monthly-backtest";
/** 03:00 on the 1st of each month — after the nightly run, before the day. */
export const MONTHLY_BACKTEST_PATTERN = "0 3 1 * *";

export const FORECAST_DISPATCH_JOB = "forecast-dispatch";
export const FORECAST_TENANT_JOB = "forecast-tenant";
export const BACKTEST_DISPATCH_JOB = "backtest-dispatch";
export const BACKTEST_TENANT_JOB = "backtest-tenant";

export type ForecastCronJobData = { tenantId?: string };
export type ForecastCronQueue = Queue<ForecastCronJobData>;

export function createForecastCronQueue(connection: Redis): ForecastCronQueue {
  return new Queue<ForecastCronJobData>(FORECAST_CRON_QUEUE, { connection });
}

/** Idempotent: upserting a scheduler replaces any previous cadence. */
export async function registerForecastCronSchedules(queue: ForecastCronQueue): Promise<void> {
  await queue.upsertJobScheduler(
    NIGHTLY_FORECAST_SCHEDULER,
    { pattern: NIGHTLY_FORECAST_PATTERN },
    { name: FORECAST_DISPATCH_JOB }
  );
  await queue.upsertJobScheduler(
    MONTHLY_BACKTEST_SCHEDULER,
    { pattern: MONTHLY_BACKTEST_PATTERN },
    { name: BACKTEST_DISPATCH_JOB }
  );
}

/** Per-tenant no-overlap job id: BullMQ dedups `add` on jobId, so one tenant
 *  can never have two forecast (or backtest) jobs for the same period at once. */
export function forecastJobId(tenantId: string, runKey: string): string {
  return `forecast:${tenantId}:${runKey}`;
}
export function backtestJobId(tenantId: string, runKey: string): string {
  return `backtest:${tenantId}:${runKey}`;
}

/** YYYY-MM-DD (nightly) / YYYY-MM (monthly) run keys, UTC. */
const dayKey = (d: Date): string => d.toISOString().slice(0, 10);
const monthKey = (d: Date): string => d.toISOString().slice(0, 7);

async function enqueuePerTenant(
  queue: ForecastCronQueue,
  jobName: string,
  jobId: (tenantId: string) => string
): Promise<number> {
  const tenants = await prismaService.tenant.findMany({ select: { id: true } });
  for (const tenant of tenants) {
    await queue.add(
      jobName,
      { tenantId: tenant.id },
      { jobId: jobId(tenant.id), removeOnComplete: true, removeOnFail: true }
    );
  }
  return tenants.length;
}

/** Fan the nightly dispatch out into one no-overlap job per tenant. */
export function dispatchForecasts(queue: ForecastCronQueue, now: Date = new Date()): Promise<number> {
  const key = dayKey(now);
  return enqueuePerTenant(queue, FORECAST_TENANT_JOB, (id) => forecastJobId(id, key));
}

/** Fan the monthly backtest dispatch out into one no-overlap job per tenant. */
export function dispatchBacktests(queue: ForecastCronQueue, now: Date = new Date()): Promise<number> {
  const key = monthKey(now);
  return enqueuePerTenant(queue, BACKTEST_TENANT_JOB, (id) => backtestJobId(id, key));
}

export interface ForecastCronWorkerOptions {
  /** BullMQ worker connection — must have maxRetriesPerRequest: null. */
  connection: Redis;
  /** Same-queue handle the dispatch jobs fan out through. */
  queue: ForecastCronQueue;
}

export function createForecastCronWorker(
  options: ForecastCronWorkerOptions
): Worker<ForecastCronJobData> {
  return new Worker<ForecastCronJobData>(
    FORECAST_CRON_QUEUE,
    async (job: Job<ForecastCronJobData>) => {
      if (job.name === FORECAST_DISPATCH_JOB) {
        await dispatchForecasts(options.queue);
        return;
      }
      if (job.name === BACKTEST_DISPATCH_JOB) {
        await dispatchBacktests(options.queue);
        return;
      }
      if (job.name === FORECAST_TENANT_JOB && job.data.tenantId) {
        await runForecast(job.data.tenantId);
        return;
      }
      if (job.name === BACKTEST_TENANT_JOB && job.data.tenantId) {
        await runBacktest(job.data.tenantId);
      }
    },
    { connection: options.connection }
  );
}
