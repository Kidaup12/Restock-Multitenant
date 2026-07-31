import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import type { Queue } from "bullmq";
import { CUSTOMER_TENANTS_WHERE } from "@wezesha/db/platform-tenant";

/**
 * Forecast crons against real Redis + the local database: both schedules
 * register idempotently, dispatch fans out one no-overlap job per tenant, and
 * the worker runs a nightly forecast and a monthly backtest end to end. Skips
 * without local infrastructure.
 */

const redisUrl = process.env.REDIS_URL;
const localDb = /localhost|127\.0\.0\.1/.test(process.env.SERVICE_DATABASE_URL ?? "");
const runnable = Boolean(redisUrl) && localDb;

const SLUG = "forecast-cron-test";
const utcDay = (daysAgo: number): Date => {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() - daysAgo));
};

describe.skipIf(!runnable)("forecast crons (real redis + db)", () => {
  let prismaService: typeof import("@wezesha/db").prismaService;
  let cron: typeof import("../src/forecast-cron");
  let connection: Redis;
  let queue: Queue;
  let tenantId: string;

  beforeAll(async () => {
    delete process.env.REDIS_URL; // runForecast's realtime publish stays a no-op
    ({ prismaService } = await import("@wezesha/db"));
    cron = await import("../src/forecast-cron");
    connection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    queue = cron.createForecastCronQueue(connection);
    await queue.obliterate({ force: true });

    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    const tenant = await prismaService.tenant.create({ data: { name: "Forecast Cron Test", slug: SLUG } });
    tenantId = tenant.id;

    // Three products with 120 days of steady sales — enough for ABC + a hold-out.
    const rates: Array<{ sku: string; rate: number }> = [
      { sku: "FC-A", rate: 6 },
      { sku: "FC-B", rate: 2 },
      { sku: "FC-C", rate: 1 },
    ];
    for (const { sku, rate } of rates) {
      const product = await prismaService.product.create({
        data: { tenantId, sku, title: `Product ${sku}`, priceKes: 1000, costKes: 600, currentStock: 20, shopifyCreatedAt: utcDay(200) },
      });
      const rows = [];
      for (let d = 120; d >= 0; d--) {
        rows.push({ tenantId, productId: product.id, date: utcDay(d), quantity: rate, revenueKes: rate * 1000, channel: "shopify" });
      }
      await prismaService.salesHistory.createMany({ data: rows });
    }
  }, 60_000);

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    await prismaService.$disconnect();
    await connection.quit();
  });

  it("registers the nightly + monthly schedules idempotently", async () => {
    await cron.registerForecastCronSchedules(queue);
    await cron.registerForecastCronSchedules(queue);
    const schedulers = await queue.getJobSchedulers();
    const nightly = schedulers.filter((s) => s.key === cron.NIGHTLY_FORECAST_SCHEDULER);
    const monthly = schedulers.filter((s) => s.key === cron.MONTHLY_BACKTEST_SCHEDULER);
    expect(nightly).toHaveLength(1);
    expect(monthly).toHaveLength(1);
    expect(nightly[0]!.pattern).toBe(cron.NIGHTLY_FORECAST_PATTERN);
    expect(monthly[0]!.pattern).toBe(cron.MONTHLY_BACKTEST_PATTERN);
    await queue.removeJobScheduler(cron.NIGHTLY_FORECAST_SCHEDULER);
    await queue.removeJobScheduler(cron.MONTHLY_BACKTEST_SCHEDULER);
  });

  it("dispatch fans out one no-overlap job per customer workspace", async () => {
    const now = new Date();
    const count = await cron.dispatchForecasts(queue, now);
    const expected = await prismaService.tenant.count({ where: CUSTOMER_TENANTS_WHERE });
    expect(count).toBe(expected);
    expect(count).toBeGreaterThan(0);
    // The platform workspace has no products to forecast and is not a customer.
    expect(await prismaService.tenant.count()).toBeGreaterThan(expected);

    // Dispatching again for the same day is a no-op per tenant (jobId dedup).
    await cron.dispatchForecasts(queue, now);
    const waiting = await queue.getJobs(["waiting", "prioritized"]);
    const fanned = waiting.filter((j) => j.name === cron.FORECAST_TENANT_JOB);
    expect(fanned).toHaveLength(count); // not doubled
    expect(fanned.map((j) => (j.data as { tenantId?: string }).tenantId)).toContain(tenantId);
    await queue.drain();
  });

  it("the worker runs a nightly forecast end to end", async () => {
    await prismaService.prediction.deleteMany({ where: { tenantId } });
    const worker = cron.createForecastCronWorker({ connection, queue });
    try {
      await queue.add(cron.FORECAST_TENANT_JOB, { tenantId });
      const deadline = Date.now() + 20_000;
      let predictions = 0;
      while (predictions < 3 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        predictions = await prismaService.prediction.count({ where: { tenantId } });
      }
      expect(predictions).toBe(3);
      const withWord = await prismaService.prediction.count({
        where: { tenantId, confidenceWord: { not: null } },
      });
      expect(withWord).toBe(3);
    } finally {
      await worker.close();
    }
  }, 30_000);

  it("the worker runs a monthly backtest end to end", async () => {
    await prismaService.backtestRun.deleteMany({ where: { tenantId } });
    const worker = cron.createForecastCronWorker({ connection, queue });
    try {
      await queue.add(cron.BACKTEST_TENANT_JOB, { tenantId });
      const deadline = Date.now() + 20_000;
      let rows = 0;
      while (rows === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        rows = await prismaService.backtestRun.count({ where: { tenantId, tag: "walkforward" } });
      }
      expect(rows).toBeGreaterThan(0);
      const config = await prismaService.tenantConfig.findUnique({ where: { tenantId } });
      expect(config?.forecastChampions).not.toBeNull();
    } finally {
      await worker.close();
    }
  }, 30_000);
});
