import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import type { Queue } from "bullmq";
import { CUSTOMER_TENANTS_WHERE } from "@wezesha/db/platform-tenant";

/**
 * Inventory-snapshot cron. The writer suite runs against the local database:
 * one row per active product (stocked-out SKUs included — they are the whole
 * point of a stockout trend), inactive products excluded, a same-day re-run
 * rewrites rather than duplicates, the retention prune drops rows past the
 * window, and both the write and the prune stay inside one tenant. The queue
 * suite additionally needs real Redis. Each skips without its infrastructure.
 */

const redisUrl = process.env.REDIS_URL;
const localDb = /localhost|127\.0\.0\.1/.test(process.env.SERVICE_DATABASE_URL ?? "");
const runnable = Boolean(redisUrl) && localDb;

const SLUG = "snapshot-cron-test";
const OTHER_SLUG = "snapshot-cron-test-other";
const QUEUE_SLUG = "snapshot-cron-queue-test";

const NOW = new Date("2026-07-24T01:00:00Z");
const DAY_MS = 86_400_000;
const utcMidnight = (d: Date): Date =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const DAY = utcMidnight(NOW);
const daysBefore = (n: number): Date => new Date(DAY.getTime() - n * DAY_MS);

describe.skipIf(!localDb)("inventory snapshot writer (local db)", () => {
  let prismaService: typeof import("@wezesha/db").prismaService;
  let cron: typeof import("../src/snapshot-cron");
  let tenantId: string;
  let otherTenantId: string;
  let otherProductId: string;
  const ids = {} as Record<"ON" | "OUT" | "NFS" | "OFF", string>;

  async function makeProduct(key: keyof typeof ids, over: Record<string, unknown>) {
    const p = await prismaService.product.create({
      data: { tenantId, sku: key, title: `Product ${key}`, priceKes: 500, ...over },
    });
    ids[key] = p.id;
  }

  beforeAll(async () => {
    ({ prismaService } = await import("@wezesha/db"));
    cron = await import("../src/snapshot-cron");

    await prismaService.tenant.deleteMany({ where: { slug: { in: [SLUG, OTHER_SLUG] } } });
    const tenant = await prismaService.tenant.create({ data: { name: "Snapshot Test", slug: SLUG } });
    tenantId = tenant.id;

    await makeProduct("ON", { currentStock: 12 }); // in stock
    await makeProduct("OUT", { currentStock: 0 }); // stocked out — still gets a row
    await makeProduct("NFS", { currentStock: 5, notForSale: true }); // tester: still tracked
    await makeProduct("OFF", { currentStock: 7, active: false }); // inactive → excluded

    const other = await prismaService.tenant.create({
      data: { name: "Snapshot Test Other", slug: OTHER_SLUG },
    });
    otherTenantId = other.id;
    const otherProduct = await prismaService.product.create({
      data: { tenantId: otherTenantId, sku: "OTHER", title: "Other tenant product", priceKes: 500, currentStock: 99 },
    });
    otherProductId = otherProduct.id;
  });

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: { in: [SLUG, OTHER_SLUG] } } });
    await prismaService.$disconnect();
  });

  it("writes one row per active product, stocked-out SKUs included", async () => {
    const res = await cron.snapshotTenantInventory(tenantId, NOW);
    expect(res.written).toBe(3); // ON, OUT, NFS — OFF is inactive
    expect(res.pruned).toBe(0);

    const rows = await prismaService.inventorySnapshot.findMany({ where: { tenantId } });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.date.getTime() === DAY.getTime())).toBe(true);

    const byProduct = new Map(rows.map((r) => [r.productId, r.onHand]));
    expect(byProduct.get(ids.ON)).toBe(12);
    expect(byProduct.get(ids.OUT)).toBe(0); // the stockout the trend is built on
    expect(byProduct.get(ids.NFS)).toBe(5);
    expect(byProduct.has(ids.OFF)).toBe(false);
  });

  it("a same-day re-run neither duplicates nor freezes a stale number", async () => {
    await prismaService.product.update({ where: { id: ids.ON }, data: { currentStock: 4 } });

    const res = await cron.snapshotTenantInventory(tenantId, NOW);
    expect(res.written).toBe(3);

    const rows = await prismaService.inventorySnapshot.findMany({ where: { tenantId } });
    expect(rows).toHaveLength(3); // not doubled
    const row = rows.find((r) => r.productId === ids.ON);
    expect(row!.onHand).toBe(4); // converged on the current number

    // Any hour of the same UTC day keys to the same row.
    await cron.snapshotTenantInventory(tenantId, new Date("2026-07-24T23:59:59Z"));
    expect(await prismaService.inventorySnapshot.count({ where: { tenantId } })).toBe(3);
  });

  it("prunes rows past the retention window and keeps the rest", async () => {
    const stale = daysBefore(cron.SNAPSHOT_RETENTION_DAYS + 1);
    const keep = daysBefore(cron.SNAPSHOT_RETENTION_DAYS - 1);
    await prismaService.inventorySnapshot.createMany({
      data: [
        { tenantId, productId: ids.ON, date: stale, onHand: 1 },
        { tenantId, productId: ids.ON, date: keep, onHand: 2 },
      ],
    });

    const res = await cron.snapshotTenantInventory(tenantId, NOW);
    expect(res.pruned).toBe(1);

    const dates = (await prismaService.inventorySnapshot.findMany({ where: { tenantId } })).map((r) =>
      r.date.getTime()
    );
    expect(dates).not.toContain(stale.getTime());
    expect(dates).toContain(keep.getTime());
    expect(dates).toContain(DAY.getTime());
  });

  it("writes and prunes inside one tenant only", async () => {
    // The neighbour holds a row on the same day and one far past the window.
    const ancient = daysBefore(cron.SNAPSHOT_RETENTION_DAYS + 100);
    await prismaService.inventorySnapshot.createMany({
      data: [
        { tenantId: otherTenantId, productId: otherProductId, date: DAY, onHand: 99 },
        { tenantId: otherTenantId, productId: otherProductId, date: ancient, onHand: 88 },
      ],
    });

    await cron.snapshotTenantInventory(tenantId, NOW);

    // The neighbour's rows survive the day-set rewrite and the prune untouched.
    const otherRows = await prismaService.inventorySnapshot.findMany({
      where: { tenantId: otherTenantId },
      orderBy: { date: "asc" },
    });
    expect(otherRows).toHaveLength(2);
    expect(otherRows.map((r) => r.onHand)).toEqual([88, 99]);

    // And nothing was written for the neighbour's product under our tenant.
    expect(
      await prismaService.inventorySnapshot.count({ where: { tenantId, productId: otherProductId } })
    ).toBe(0);
  });
});

describe.skipIf(!runnable)("inventory snapshot cron (real redis + db)", () => {
  let prismaService: typeof import("@wezesha/db").prismaService;
  let cron: typeof import("../src/snapshot-cron");
  let connection: Redis;
  let queue: Queue;
  let tenantId: string;

  beforeAll(async () => {
    ({ prismaService } = await import("@wezesha/db"));
    cron = await import("../src/snapshot-cron");
    connection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    queue = cron.createSnapshotCronQueue(connection);
    await queue.obliterate({ force: true });

    await prismaService.tenant.deleteMany({ where: { slug: QUEUE_SLUG } });
    const tenant = await prismaService.tenant.create({
      data: { name: "Snapshot Queue Test", slug: QUEUE_SLUG },
    });
    tenantId = tenant.id;
    await prismaService.product.createMany({
      data: [
        { tenantId, sku: "Q-A", title: "Product Q-A", priceKes: 500, currentStock: 3 },
        { tenantId, sku: "Q-B", title: "Product Q-B", priceKes: 500, currentStock: 0 },
      ],
    });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
    await prismaService.tenant.deleteMany({ where: { slug: QUEUE_SLUG } });
    await prismaService.$disconnect();
    await connection.quit();
  });

  it("registers the nightly schedule idempotently", async () => {
    await cron.registerSnapshotCronSchedules(queue);
    await cron.registerSnapshotCronSchedules(queue);
    const schedulers = (await queue.getJobSchedulers()).filter(
      (s) => s.key === cron.INVENTORY_SNAPSHOT_SCHEDULER
    );
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]!.pattern).toBe(cron.INVENTORY_SNAPSHOT_PATTERN);
    await queue.removeJobScheduler(cron.INVENTORY_SNAPSHOT_SCHEDULER);
  });

  it("dispatch fans out one no-overlap job per customer workspace", async () => {
    const now = new Date();
    const count = await cron.dispatchInventorySnapshots(queue, now);
    const expected = await prismaService.tenant.count({ where: CUSTOMER_TENANTS_WHERE });
    expect(count).toBe(expected);
    expect(count).toBeGreaterThan(0);
    // The platform workspace holds no inventory to snapshot.
    expect(await prismaService.tenant.count()).toBeGreaterThan(expected);

    // Dispatching again for the same day is a no-op per tenant (jobId dedup).
    await cron.dispatchInventorySnapshots(queue, now);
    const fanned = (await queue.getJobs(["waiting", "prioritized"])).filter(
      (j) => j.name === cron.SNAPSHOT_TENANT_JOB
    );
    expect(fanned).toHaveLength(count); // not doubled
    expect(fanned.map((j) => (j.data as { tenantId?: string }).tenantId)).toContain(tenantId);
    await queue.drain();
  });

  it("the worker snapshots a tenant end to end", async () => {
    await prismaService.inventorySnapshot.deleteMany({ where: { tenantId } });
    const worker = cron.createSnapshotCronWorker({ connection, queue });
    try {
      await queue.add(cron.SNAPSHOT_TENANT_JOB, { tenantId });
      const deadline = Date.now() + 20_000;
      let rows = 0;
      while (rows < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        rows = await prismaService.inventorySnapshot.count({ where: { tenantId } });
      }
      expect(rows).toBe(2);
      const today = utcMidnight(new Date());
      expect(
        await prismaService.inventorySnapshot.count({ where: { tenantId, date: today } })
      ).toBe(2);
    } finally {
      await worker.close();
    }
  }, 30_000);
});
