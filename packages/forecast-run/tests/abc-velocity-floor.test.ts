import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { MIN_RUN_RATE_FOR_A, MIN_RUN_RATE_FOR_B, anchorToday, runRateDaily } from "@wezesha/forecast";
import { runForecast } from "../src/run";

/**
 * The velocity floor, proven where it lands rather than where it is computed:
 * a run against a real database, with the class read back out of Product and
 * compared against the run rate the catalogue shows for the same product.
 *
 * The shop that prompted this had class A on lines selling a tenth of a unit a
 * day. Ranking by value alone let a pricey slow-mover ride its price tag into A,
 * where the ABC rate floor then served it at 0.4/day — four times what it
 * actually sold. Skips without a local database.
 */

const runnable = /localhost|127\.0\.0\.1/.test(process.env.SERVICE_DATABASE_URL ?? "");

const SLUG = "abc-velocity-floor";
const DAY_MS = 86_400_000;

let tenantId: string;
let slowId: string;
let fastId: string;

/** A day marker at UTC midnight, `daysAgo` before today — the grain the sync writes. */
function day(daysAgo: number): Date {
  const d = new Date(Date.now() - daysAgo * DAY_MS);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

describe.skipIf(!runnable)("ABC velocity floor (seeded local db)", () => {
  beforeAll(async () => {
    delete process.env.REDIS_URL; // publish degrades to a no-op

    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    const tenant = await prismaService.tenant.create({
      data: { name: "ABC Floor", slug: SLUG },
    });
    tenantId = tenant.id;

    const product = (sku: string, title: string, priceKes: number) =>
      prismaService.product.create({
        data: {
          tenantId,
          sku,
          title,
          priceKes,
          costKes: priceKes / 2,
          costSource: "manual",
          currentStock: 20,
          shopifyCreatedAt: day(400),
        },
        select: { id: true },
      });

    // Sells one unit every five days at 50,000 — about 0.2/day, well under the
    // A floor, and the shop's biggest earner over the window all the same.
    const slow = await product("PRICEY-SLOW", "Pricey slow mover", 50_000);
    slowId = slow.id;
    // Three a day at 5,000 — a genuine bestseller that also earns more.
    const fast = await product("FAST-EARNER", "Fast earner", 5_000);
    fastId = fast.id;

    const rows: { productId: string; date: Date; quantity: number; revenueKes: number }[] = [];
    for (let d = 1; d <= 365; d++) {
      if (d % 5 === 0) rows.push({ productId: slowId, date: day(d), quantity: 1, revenueKes: 50_000 });
      rows.push({ productId: fastId, date: day(d), quantity: 3, revenueKes: 15_000 });
    }
    await prismaService.salesHistory.createMany({
      data: rows.map((r) => ({ ...r, tenantId, channel: "shopify" })),
    });
  }, 120_000);

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    await prismaService.$disconnect();
  });

  it("keeps a pricey slow mover out of A however much it earned", async () => {
    await runForecast(tenantId);

    const [slow, fast] = await Promise.all([
      prismaService.product.findUniqueOrThrow({
        where: { id: slowId },
        select: { abcCategory: true },
      }),
      prismaService.product.findUniqueOrThrow({
        where: { id: fastId },
        select: { abcCategory: true },
      }),
    ]);

    // It out-earns everything in the shop, so the value cut alone would make it A.
    expect(slow.abcCategory).not.toBe("A");
    expect(fast.abcCategory).toBe("A");
  });

  it("no product is ranked above a class its selling rate cannot support", async () => {
    await runForecast(tenantId);

    const products = await prismaService.product.findMany({
      where: { tenantId },
      select: { id: true, sku: true, abcCategory: true },
    });
    const sales = await prismaService.salesHistory.findMany({
      where: { tenantId },
      select: { productId: true, date: true, quantity: true, revenueKes: true },
    });
    const byProduct = new Map<string, typeof sales>();
    for (const row of sales) {
      const list = byProduct.get(row.productId) ?? [];
      list.push(row);
      byProduct.set(row.productId, list);
    }

    // The rate recomputed here is the one the catalogue prints as sells/day. The
    // class in the column has to be one that rate can carry, or the screen shows
    // a letter that contradicts the number beside it.
    const now = new Date();
    for (const p of products) {
      const rate = runRateDaily(byProduct.get(p.id) ?? [], now);
      const floor =
        p.abcCategory === "A" ? MIN_RUN_RATE_FOR_A : p.abcCategory === "B" ? MIN_RUN_RATE_FOR_B : 0;
      expect(
        rate,
        `${p.sku} is class ${p.abcCategory} at ${rate.toFixed(3)}/day, under the ${floor}/day floor`
      ).toBeGreaterThanOrEqual(floor);
    }
  });

  it("orders the slow mover at the rate it really sells, not at the class-A floor", async () => {
    await runForecast(tenantId);

    const prediction = await prismaService.prediction.findFirstOrThrow({
      where: { tenantId, productId: slowId },
      select: { layer1Forecast30d: true },
    });
    const sales = await prismaService.salesHistory.findMany({
      where: { tenantId, productId: slowId },
      select: { date: true, quantity: true, revenueKes: true },
    });
    // Anchored the way the run anchors, so the comparison is against the same
    // day boundary the engine used rather than the clock this test ran at.
    const rate = runRateDaily(sales, anchorToday(new Date().toISOString().slice(0, 10)));

    // While it was class A the rate floor lifted this to 0.4/day — 12 units a
    // month for a line that sells about six. The forecast now tracks the shelf.
    expect(prediction.layer1Forecast30d / 30).toBeCloseTo(rate, 2);
    expect(prediction.layer1Forecast30d).toBeLessThan(MIN_RUN_RATE_FOR_A * 30);
  });
});
