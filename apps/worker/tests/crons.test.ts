import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import type { Queue } from "bullmq";
import type { EmailMessage } from "../src/email";

/**
 * Email cron scaffold against real Redis + the local database: schedule
 * registration is idempotent, dispatch fans out one job per tenant, and the
 * per-tenant summary renders + sends through the seam. Skips without local
 * infrastructure.
 */

const redisUrl = process.env.REDIS_URL;
const localDb = /localhost|127\.0\.0\.1/.test(process.env.SERVICE_DATABASE_URL ?? "");
const runnable = Boolean(redisUrl) && localDb;

const SLUG = "crons-test";
const ALERT_EMAIL = "crons-test@example.test";
const DAY_MS = 86_400_000;

describe.skipIf(!runnable)("email crons (real redis + db)", () => {
  let prismaService: typeof import("@wezesha/db").prismaService;
  let crons: typeof import("../src/crons");
  let connection: Redis;
  let queue: Queue;
  let tenantId: string;

  beforeAll(async () => {
    ({ prismaService } = await import("@wezesha/db"));
    crons = await import("../src/crons");
    connection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    queue = crons.createEmailCronQueue(connection);
    await queue.obliterate({ force: true });

    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    const tenant = await prismaService.tenant.create({
      data: {
        name: "Crons Test",
        slug: SLUG,
        tenantConfig: { create: { alertEmail: ALERT_EMAIL } },
      },
    });
    tenantId = tenant.id;

    const inStock = await prismaService.product.create({
      data: { tenantId, sku: "CRON-1", title: "Marula Oil 50ml", priceKes: 1000, costKes: 600 },
    });
    const stockedOut = await prismaService.product.create({
      data: { tenantId, sku: "CRON-2", title: "Baobab Butter 200g", priceKes: 800, costKes: 500 },
    });
    const location = await prismaService.location.create({
      data: { tenantId, name: "Cron Shop", isPrimary: true },
    });
    await prismaService.inventoryLevel.createMany({
      data: [
        { tenantId, locationId: location.id, productId: inStock.id, onHand: 12 },
        { tenantId, locationId: location.id, productId: stockedOut.id, onHand: 0 },
      ],
    });
    await prismaService.salesHistory.createMany({
      data: [
        {
          tenantId,
          productId: inStock.id,
          date: new Date(Date.now() - 2 * DAY_MS),
          quantity: 7,
          revenueKes: 7000,
        },
        {
          tenantId,
          productId: stockedOut.id,
          date: new Date(Date.now() - 3 * DAY_MS),
          quantity: 2,
          revenueKes: 1600,
        },
      ],
    });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    await prismaService.$disconnect();
    await connection.quit();
  });

  it("registers the weekly schedule idempotently", async () => {
    await crons.registerEmailCronSchedules(queue);
    await crons.registerEmailCronSchedules(queue);
    const schedulers = await queue.getJobSchedulers();
    const weekly = schedulers.filter((s) => s.key === crons.WEEKLY_SUMMARY_SCHEDULER);
    expect(weekly).toHaveLength(1);
    expect(weekly[0]!.pattern).toBe(crons.WEEKLY_SUMMARY_PATTERN);
    await queue.removeJobScheduler(crons.WEEKLY_SUMMARY_SCHEDULER);
  });

  it("dispatch fans out one job per tenant", async () => {
    const count = await crons.dispatchWeeklySummaries(queue);
    const expected = await prismaService.tenant.count();
    expect(count).toBe(expected);
    expect(count).toBeGreaterThan(0);

    const waiting = await queue.getJobs(["waiting", "prioritized"]);
    const fanned = waiting.filter((j) => j.name === crons.TENANT_JOB);
    expect(fanned).toHaveLength(count);
    expect(fanned.map((j) => (j.data as { tenantId?: string }).tenantId)).toContain(tenantId);
    await queue.drain();
  });

  it("builds and sends one tenant's summary through the seam", async () => {
    const built = (await import("../src/weekly-summary")).buildWeeklySummary;
    const numbers = await built(tenantId);
    expect(numbers).not.toBeNull();
    expect(numbers!.revenue30dKes).toBe(8600);
    expect(numbers!.unitsSold30d).toBe(9);
    expect(numbers!.stockouts).toBe(1);
    expect(numbers!.topMovers[0]).toEqual({ title: "Marula Oil 50ml", units: 7 });

    const sent: EmailMessage[] = [];
    const send = async (message: EmailMessage) => {
      sent.push(message);
    };
    await expect(crons.sendWeeklySummary(tenantId, send)).resolves.toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(ALERT_EMAIL);
    expect(sent[0]!.subject).toBe("Weekly stock summary — Crons Test");
    expect(sent[0]!.text).toContain("Revenue, last 30 days: KES 8,600");
    expect(sent[0]!.text).toContain("Products stocked out right now: 1");
    expect(sent[0]!.text).toContain("Marula Oil 50ml");
  });

  it("sends nothing for a tenant without a recipient or a vanished tenant", async () => {
    const bare = await prismaService.tenant.create({
      data: { name: "Crons Bare", slug: `${SLUG}-bare` },
    });
    const sent: EmailMessage[] = [];
    const send = async (message: EmailMessage) => {
      sent.push(message);
    };
    try {
      await expect(crons.sendWeeklySummary(bare.id, send)).resolves.toBe(false);
      await expect(crons.sendWeeklySummary("no-such-tenant", send)).resolves.toBe(false);
      expect(sent).toHaveLength(0);
    } finally {
      await prismaService.tenant.delete({ where: { id: bare.id } });
    }
  });

  it("the cron worker processes a per-tenant job end to end", async () => {
    const sent: EmailMessage[] = [];
    const send = async (message: EmailMessage) => {
      sent.push(message);
    };
    const worker = crons.createEmailCronWorker({ connection, queue, send });
    try {
      await queue.add(crons.TENANT_JOB, { tenantId });
      const deadline = Date.now() + 15_000;
      while (sent.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(sent).toHaveLength(1);
      expect(sent[0]!.to).toBe(ALERT_EMAIL);
    } finally {
      await worker.close();
    }
  });
});
