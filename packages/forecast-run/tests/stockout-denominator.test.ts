import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { seedDev, type SeedResult } from "../../db/scripts/seed-dev";
import { runForecast } from "../src/run";

/**
 * The in-stock-day denominator end to end: nightly inventory snapshots in the
 * database → the forecast run's rate → the persisted prediction.
 *
 * The case that matters is the one gap inference cannot see — a product out of
 * stock for ten days SPLIT into two five-day stretches. No run is longer than a
 * week, so inference subtracts nothing and the rate divides by thirty calendar
 * days instead of twenty in-stock ones. Skips without a local database.
 */

const runnable = /localhost|127\.0\.0\.1/.test(process.env.SERVICE_DATABASE_URL ?? "");
const DAY_MS = 86_400_000;
/** How far back the synthetic snapshot history reaches — deliberately shorter
 *  than the 365-day window so the partial-coverage fallback is exercised too. */
const SNAPSHOT_DAYS = 60;

function utcDay(daysAgo: number): Date {
  const d = new Date(Date.now() - daysAgo * DAY_MS);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

let seeded: SeedResult;
let tenantId: string;
let productId: string;

describe.skipIf(!runnable)("in-stock-day denominator (seeded local db)", () => {
  beforeAll(async () => {
    delete process.env.REDIS_URL; // publish degrades to a no-op
    seeded = await seedDev();
    tenantId = seeded.tenantId;
    // A steady everyday seller: its rate is unambiguous, so any move is the
    // denominator and not noise.
    const product = await prismaService.product.findFirstOrThrow({
      where: { tenantId, sku: "CAN-SHE-340" },
      select: { id: true },
    });
    productId = product.id;
  }, 120_000);

  afterAll(async () => {
    await prismaService.$disconnect();
  });

  it("empty-shelf days leave the denominator and the forecast rises", async () => {
    await runForecast(tenantId);
    const before = await prismaService.prediction.findFirstOrThrow({
      where: { tenantId, productId },
    });

    // Two five-day empty stretches inside the last 30 days; every other
    // product-day in the window is snapshotted in stock.
    const emptyDays = new Set([7, 8, 9, 10, 11, 20, 21, 22, 23, 24]);
    const products = await prismaService.product.findMany({
      where: { tenantId },
      select: { id: true, currentStock: true },
    });
    const rows = [];
    for (let daysAgo = 1; daysAgo <= SNAPSHOT_DAYS; daysAgo++) {
      const date = utcDay(daysAgo);
      for (const p of products) {
        const empty = p.id === productId && emptyDays.has(daysAgo);
        rows.push({ tenantId, productId: p.id, date, onHand: empty ? 0 : Math.max(1, p.currentStock) });
      }
    }
    await prismaService.inventorySnapshot.createMany({ data: rows, skipDuplicates: true });

    await runForecast(tenantId);
    const after = await prismaService.prediction.findFirstOrThrow({
      where: { tenantId, productId },
    });

    // 30d window: the same units over 20 in-stock days instead of 30.
    expect(after.finalForecast30d).toBeGreaterThan(before.finalForecast30d * 1.15);
    expect(after.daysUntilStockout).toBeLessThanOrEqual(before.daysUntilStockout);
  }, 120_000);

  it("products the snapshots prove were in stock are not moved by the mask", async () => {
    const untouched = await prismaService.product.findFirstOrThrow({
      where: { tenantId, sku: "VAS-BS-250" },
      select: { id: true },
    });
    const rows = await prismaService.inventorySnapshot.findMany({
      where: { tenantId, productId: untouched.id, onHand: { lte: 0 } },
    });
    expect(rows).toHaveLength(0);
    const p = await prismaService.prediction.findFirstOrThrow({
      where: { tenantId, productId: untouched.id },
    });
    expect(p.finalForecast30d).toBeGreaterThan(0);
  });
});
