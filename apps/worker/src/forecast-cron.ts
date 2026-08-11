import { Queue, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { CUSTOMER_TENANTS_WHERE, prismaService } from "@wezesha/db";
import { runForecast, runBacktest } from "@wezesha/forecast-run";
import { publishEvent } from "@wezesha/realtime";

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
/**
 * Every half hour, at :07 and :37.
 *
 * It ran once at 02:07 and the shop saw a buy list built before the day it was
 * trading in — sell out at 9am and the plan still said you were covered until
 * the next night. The offsets keep it clear of the Shopify sync on :00/:15/:30/
 * :45, so a run reads a catalogue pull that has finished rather than one in
 * flight.
 *
 * Safe to run this often because of two decisions already in place: the enqueue
 * guard gives one tenant at most one running forecast (no overlap), and the
 * append-only ForecastRecommendation history is keyed on the run DAY with
 * skipDuplicates — so re-running refines the live plan while the day's first ask
 * stands, and adherence figures computed last week cannot shift. The name stays
 * "nightly" only where it is a BullMQ scheduler id: changing that would orphan
 * the registered scheduler rather than replace it.
 */
export const FORECAST_PATTERN = "7,37 * * * *";

export const MONTHLY_BACKTEST_SCHEDULER = "monthly-backtest";
/** After the nightly run and clear of the 03:00 full-sync cursor clear, which it
 *  used to start alongside. */
export const MONTHLY_BACKTEST_PATTERN = "40 3 1 * *";

/** A missed night is a stale buy list the next morning, so the run retries rather
 *  than being dropped — and a failure is KEPT, because `removeOnFail` erased the
 *  only evidence the last outage left behind. Safe against the per-tenant jobId
 *  dedup: the id is day-keyed, so yesterday's retained failure cannot block today.
 *  Backoff is minutes, not the sync's seconds — this waits on our own database,
 *  not on a rate-limited external API. */
export const FORECAST_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 300_000 },
  removeOnComplete: true,
  removeOnFail: { age: 7 * 24 * 60 * 60 },
};

/** One notice per tenant per half-day: long enough not to fill the bell while a
 *  run keeps failing, short enough to resurface as something a human acts on. */
const FORECAST_FAILURE_NOTICE_DEDUP_MS = 12 * 60 * 60 * 1000;

export const FORECAST_DISPATCH_JOB = "forecast-dispatch";
export const FORECAST_TENANT_JOB = "forecast-tenant";
export const BACKTEST_DISPATCH_JOB = "backtest-dispatch";
export const BACKTEST_TENANT_JOB = "backtest-tenant";

export type ForecastCronJobData = { tenantId?: string };
export type ForecastCronQueue = Queue<ForecastCronJobData>;

export function createForecastCronQueue(connection: Redis): ForecastCronQueue {
  return new Queue<ForecastCronJobData>(FORECAST_CRON_QUEUE, { connection });
}

/** Idempotent: upserting a scheduler replaces any previous cadence. The dispatch
 *  jobs carry the same options as the per-tenant ones — a fan-out that fails
 *  silently loses the night for every tenant at once. */
export async function registerForecastCronSchedules(queue: ForecastCronQueue): Promise<void> {
  await queue.upsertJobScheduler(
    NIGHTLY_FORECAST_SCHEDULER,
    { pattern: FORECAST_PATTERN },
    { name: FORECAST_DISPATCH_JOB, opts: FORECAST_JOB_OPTIONS }
  );
  await queue.upsertJobScheduler(
    MONTHLY_BACKTEST_SCHEDULER,
    { pattern: MONTHLY_BACKTEST_PATTERN },
    { name: BACKTEST_DISPATCH_JOB, opts: FORECAST_JOB_OPTIONS }
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
  // eslint-disable-next-line tenant-safety/require-tenant-scope -- fan-out dispatch: enumerating every customer workspace is the job, and the per-tenant work it queues is scoped.
  const tenants = await prismaService.tenant.findMany({
    where: CUSTOMER_TENANTS_WHERE,
    select: { id: true },
  });
  for (const tenant of tenants) {
    await queue.add(
      jobName,
      { tenantId: tenant.id },
      { ...FORECAST_JOB_OPTIONS, jobId: jobId(tenant.id) }
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

/** Tell the shop its plan did not update, once the retries are spent.
 *
 *  Until this existed the run failed into a console line and a deleted job, so a
 *  stale buy list looked exactly like a fresh one — which is how two nights went
 *  unnoticed. Only the final attempt speaks; a retry that later succeeds is not
 *  news. */
export async function handleForecastFailure(
  job: Job<ForecastCronJobData> | undefined,
  err: Error,
  publisher: Redis
): Promise<void> {
  const tenantId = job?.data.tenantId;
  if (!job || !tenantId || job.name !== FORECAST_TENANT_JOB) return;
  const isFinal = err.name === "UnrecoverableError" || job.attemptsMade >= (job.opts.attempts ?? 1);
  if (!isFinal) return;

  const kind = "forecast_failed";
  const title = "Last night's plan did not update";
  try {
    const since = new Date(Date.now() - FORECAST_FAILURE_NOTICE_DEDUP_MS);
    const prior = await prismaService.notification.findFirst({
      where: { tenantId, kind, title, createdAt: { gte: since } },
      select: { id: true },
    });
    if (prior) return;

    await prismaService.notification.create({
      data: {
        tenantId,
        kind,
        title,
        body: `The overnight forecast did not finish, so the buy list still shows the previous run. It will be retried tonight; use Run forecast on Today to refresh it now. (${err.message.slice(0, 300)})`,
      },
    });
    await publishEvent(publisher, { type: "notification.new", data: { tenantId, kind, title } });
  } catch (persistErr) {
    // Never let the notice mask the failure it is reporting.
    console.error(`worker: could not persist forecast-failure notification for ${tenantId}`, persistErr);
  }
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
