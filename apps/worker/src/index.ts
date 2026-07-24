import { Redis } from "ioredis";
import type { Worker } from "bullmq";
import { captureError, initObservability } from "@wezesha/observability";
import {
  createEmailCronQueue,
  createEmailCronWorker,
  registerEmailCronSchedules,
  type EmailCronQueue,
} from "./crons";
import { startHeartbeat } from "./heartbeat";
import {
  OPS_CRON_QUEUE,
  createOpsCronQueue,
  createOpsCronWorker,
  registerOpsCronSchedules,
  type OpsCronQueue,
} from "./limits-cron";
import {
  POS_CRON_QUEUE,
  createPosCronQueue,
  createPosCronWorker,
  registerPosCronSchedules,
  type PosCronQueue,
} from "./pos-gap-cron";
import {
  FORECAST_CRON_QUEUE,
  createForecastCronQueue,
  createForecastCronWorker,
  registerForecastCronSchedules,
  type ForecastCronQueue,
} from "./forecast-cron";
import {
  COST_CRON_QUEUE,
  createCostCronQueue,
  createCostCronWorker,
  registerCostCronSchedules,
  type CostCronQueue,
} from "./cost-moved-cron";
import { createSyncWorker } from "./worker";

/**
 * Entrypoint. Env:
 *   REDIS_URL             — queues + event publishing (default redis://localhost:6380)
 *   DATABASE_URL          — RLS-enforced Prisma connection (client construction)
 *   SERVICE_DATABASE_URL  — BYPASSRLS connection: the sync's writes
 *   TOKEN_ENCRYPTION_KEY  — decrypts stored Shopify tokens (32 bytes, base64)
 *   SHOPIFY_APP_URL       — public web origin; registers webhook callbacks when set
 *   EMAIL_CRONS           — "1" registers + runs the email cron schedules
 *                           (weekly summaries); unset keeps dev/CI quiet
 *   OPS_CRONS             — "1" registers + runs the ops cron schedules
 *                           (daily plan-limit checks); unset keeps dev/CI quiet
 *   POS_CRONS             — "1" registers + runs the POS cron schedules
 *                           (daily sales-gap checks); unset keeps dev/CI quiet
 *   FORECAST_CRON         — "1" registers + runs the forecast crons (nightly
 *                           forecast run + monthly backtest); unset keeps dev/CI quiet
 *   COST_CRONS            — "1" registers + runs the cost cron schedules
 *                           (nightly cost-moved checks); unset keeps dev/CI quiet
 *   POS_FEED_SECRET       — bearer token for the POS feed fetch (per-provider)
 *   SENTRY_DSN            — error tracking; unset = tracking disabled (no-op)
 */
async function main(): Promise<void> {
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6380";

  await initObservability("worker");

  // BullMQ workers block on BRPOPLPUSH — retries must not cap out mid-wait.
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const publisher = new Redis(redisUrl);

  // Liveness beacon: uptime monitoring alerts when this key stops refreshing.
  const stopHeartbeat = startHeartbeat(publisher);

  const worker = createSyncWorker({ connection, publisher });
  worker.on("completed", (job) => console.log(`worker: ${job.id} completed`));
  worker.on("failed", (job, err) => {
    console.error(`worker: ${job?.id} failed`, err);
    captureError(err, { tenantId: job?.data.tenantId, jobId: job?.id, queue: "sync" });
  });
  console.log("worker: listening on queue \"sync\"");

  let cronQueue: EmailCronQueue | null = null;
  let cronWorker: Worker | null = null;
  if (process.env.EMAIL_CRONS === "1") {
    cronQueue = createEmailCronQueue(connection);
    await registerEmailCronSchedules(cronQueue);
    cronWorker = createEmailCronWorker({ connection, queue: cronQueue });
    cronWorker.on("failed", (job, err) => {
      console.error(`worker: cron ${job?.id} failed`, err);
      captureError(err, { tenantId: job?.data?.tenantId, jobId: job?.id, queue: "email-crons" });
    });
    console.log("worker: email crons registered (weekly summary)");
  }

  let opsQueue: OpsCronQueue | null = null;
  let opsWorker: Worker | null = null;
  if (process.env.OPS_CRONS === "1") {
    opsQueue = createOpsCronQueue(connection);
    await registerOpsCronSchedules(opsQueue);
    opsWorker = createOpsCronWorker({ connection, queue: opsQueue });
    opsWorker.on("failed", (job, err) => {
      console.error(`worker: ops cron ${job?.id} failed`, err);
      captureError(err, { tenantId: job?.data?.tenantId, jobId: job?.id, queue: OPS_CRON_QUEUE });
    });
    console.log("worker: ops crons registered (limits check)");
  }

  let posQueue: PosCronQueue | null = null;
  let posWorker: Worker | null = null;
  if (process.env.POS_CRONS === "1") {
    posQueue = createPosCronQueue(connection);
    await registerPosCronSchedules(posQueue);
    posWorker = createPosCronWorker({ connection, queue: posQueue, publisher });
    posWorker.on("failed", (job, err) => {
      console.error(`worker: pos cron ${job?.id} failed`, err);
      captureError(err, { tenantId: job?.data?.tenantId, jobId: job?.id, queue: POS_CRON_QUEUE });
    });
    console.log("worker: pos crons registered (sales-gap check)");
  }

  let forecastQueue: ForecastCronQueue | null = null;
  let forecastWorker: Worker | null = null;
  if (process.env.FORECAST_CRON === "1") {
    forecastQueue = createForecastCronQueue(connection);
    await registerForecastCronSchedules(forecastQueue);
    forecastWorker = createForecastCronWorker({ connection, queue: forecastQueue });
    forecastWorker.on("failed", (job, err) => {
      console.error(`worker: forecast cron ${job?.id} failed`, err);
      captureError(err, { tenantId: job?.data?.tenantId, jobId: job?.id, queue: FORECAST_CRON_QUEUE });
    });
    console.log("worker: forecast crons registered (nightly forecast + monthly backtest)");
  }

  let costQueue: CostCronQueue | null = null;
  let costWorker: Worker | null = null;
  if (process.env.COST_CRONS === "1") {
    costQueue = createCostCronQueue(connection);
    await registerCostCronSchedules(costQueue);
    costWorker = createCostCronWorker({ connection, queue: costQueue, publisher });
    costWorker.on("failed", (job, err) => {
      console.error(`worker: cost cron ${job?.id} failed`, err);
      captureError(err, { tenantId: job?.data?.tenantId, jobId: job?.id, queue: COST_CRON_QUEUE });
    });
    console.log("worker: cost crons registered (cost-moved check)");
  }

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`worker: ${signal} received, shutting down`);
    stopHeartbeat();
    void Promise.all([
      worker.close(), // waits for the in-flight job before releasing it
      cronWorker?.close(),
      cronQueue?.close(),
      opsWorker?.close(),
      opsQueue?.close(),
      posWorker?.close(),
      posQueue?.close(),
      forecastWorker?.close(),
      forecastQueue?.close(),
      costWorker?.close(),
      costQueue?.close(),
    ])
      .then(() => Promise.all([connection.quit(), publisher.quit()]))
      .then(
        () => process.exit(0),
        (err) => {
          console.error("worker: shutdown error", err);
          process.exit(1);
        }
      );
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("worker: fatal", err);
  process.exit(1);
});
