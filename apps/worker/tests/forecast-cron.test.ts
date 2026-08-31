import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import type { Queue } from "bullmq";
import { PLATFORM_TENANT_ID } from "@wezesha/db/platform-tenant";

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

/**
 * A sale's timestamp within its day. The ingest-health gate judges only
 * COMPLETED days, so the newest sale it can see is yesterday's last one, and it
 * holds the forecast past 36h. Stamping every row at UTC midnight made that
 * 24h plus however long today had run — under the limit all morning and over it
 * every afternoon, so this test passed or failed by the clock. Today keeps
 * midnight: it is excluded from the gate anyway, and an evening stamp would put
 * sales in the future for a run before 20:00.
 */
const saleAt = (daysAgo: number): Date =>
  daysAgo === 0 ? utcDay(0) : new Date(utcDay(daysAgo).getTime() + 20 * 3_600_000);

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
        rows.push({ tenantId, productId: product.id, date: saleAt(d), quantity: rate, revenueKes: rate * 1000, channel: "shopify" });
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

  it("forecasts every half hour, clear of the sync minutes", () => {
    // A once-a-night run meant the buy list was built before the day it was
    // trading in: sell out at 9am and the plan still said covered until 2am.
    const [minutes, hours] = cron.FORECAST_PATTERN.split(" ");
    expect(hours).toBe("*");
    const at = minutes!.split(",").map(Number);
    expect(at).toHaveLength(2);
    expect(at[1]! - at[0]!).toBe(30);
    // The Shopify sync ticks on :00/:15/:30/:45 — a forecast must not start in
    // the same minute as the catalogue pull it wants to read.
    for (const minute of at) expect(minute % 15).not.toBe(0);
  });
  it("registers the nightly + monthly schedules idempotently", async () => {
    await cron.registerForecastCronSchedules(queue);
    await cron.registerForecastCronSchedules(queue);
    const schedulers = await queue.getJobSchedulers();
    const nightly = schedulers.filter((s) => s.key === cron.NIGHTLY_FORECAST_SCHEDULER);
    const monthly = schedulers.filter((s) => s.key === cron.MONTHLY_BACKTEST_SCHEDULER);
    expect(nightly).toHaveLength(1);
    expect(monthly).toHaveLength(1);
    expect(nightly[0]!.pattern).toBe(cron.FORECAST_PATTERN);
    expect(monthly[0]!.pattern).toBe(cron.MONTHLY_BACKTEST_PATTERN);
    await queue.removeJobScheduler(cron.NIGHTLY_FORECAST_SCHEDULER);
    await queue.removeJobScheduler(cron.MONTHLY_BACKTEST_SCHEDULER);
  });

  it("schedules off the sync-tick minute", () => {
    // The Shopify sync ticks every 15 minutes from :00, and the monthly backtest
    // used to start in the same minute as the 03:00 full-sync cursor clear.
    for (const pattern of [cron.FORECAST_PATTERN, cron.MONTHLY_BACKTEST_PATTERN]) {
      expect(Number(pattern.split(" ")[0])).not.toBe(0);
    }
  });

  it("fans out jobs that retry and keep their failures", async () => {
    await queue.drain();
    await cron.dispatchForecasts(queue, new Date());
    const [job] = (await queue.getJobs(["waiting", "prioritized"])).filter(
      (j) => j.name === cron.FORECAST_TENANT_JOB
    );
    expect(job).toBeDefined();
    expect(job!.opts.attempts).toBe(3);
    expect(job!.opts.backoff).toMatchObject({ type: "exponential", delay: 300_000 });
    // Not `true`: deleting a failed job erased the only record of the outage.
    expect(job!.opts.removeOnFail).toMatchObject({ age: expect.any(Number) });
    await queue.drain();
  });

  it("raises a notice once the retries are spent, and not before", async () => {
    await prismaService.notification.deleteMany({ where: { tenantId, kind: "forecast_failed" } });
    const publisher = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const failed = (attemptsMade: number) =>
      ({
        name: cron.FORECAST_TENANT_JOB,
        data: { tenantId },
        opts: { attempts: 3 },
        attemptsMade,
      }) as unknown as Parameters<typeof cron.handleForecastFailure>[0];
    try {
      await cron.handleForecastFailure(failed(1), new Error("pool timeout"), publisher);
      expect(
        await prismaService.notification.count({ where: { tenantId, kind: "forecast_failed" } })
      ).toBe(0);

      await cron.handleForecastFailure(failed(3), new Error("pool timeout"), publisher);
      const notices = await prismaService.notification.findMany({
        where: { tenantId, kind: "forecast_failed" },
      });
      expect(notices).toHaveLength(1);
      expect(notices[0]!.body).toContain("pool timeout");

      // A run that keeps failing must not fill the bell with the same sentence.
      await cron.handleForecastFailure(failed(3), new Error("pool timeout"), publisher);
      expect(
        await prismaService.notification.count({ where: { tenantId, kind: "forecast_failed" } })
      ).toBe(1);
    } finally {
      await publisher.quit();
    }
  });

  it("dispatch fans out one no-overlap job per customer workspace", async () => {
    const now = new Date();
    const count = await cron.dispatchForecasts(queue, now);
    expect(count).toBeGreaterThan(0);

    // Asserted against THIS suite's tenant, never a live global count: sibling
    // worker suites create and delete tenants in the same database, so a second
    // census taken after the dispatch can legitimately disagree with it.
    const fannedTenantIds = async (): Promise<Array<string | undefined>> =>
      (await queue.getJobs(["waiting", "prioritized"]))
        .filter((j) => j.name === cron.FORECAST_TENANT_JOB)
        .map((j) => (j.data as { tenantId?: string }).tenantId);

    expect(await fannedTenantIds()).toContain(tenantId);
    // The platform workspace has no products to forecast and is not a customer.
    expect(await fannedTenantIds()).not.toContain(PLATFORM_TENANT_ID);

    // Dispatching again for the same day is a no-op per tenant (jobId dedup).
    await cron.dispatchForecasts(queue, now);
    const fanned = (await fannedTenantIds()).filter((id) => id === tenantId);
    expect(fanned).toHaveLength(1); // not doubled
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
