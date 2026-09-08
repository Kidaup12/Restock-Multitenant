import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { getDeadStockByMonth } from "../lib/data/insights";

/**
 * Dead stock month by month, against the local database.
 *
 * Two things carry the weight. The COST must be withheld from a money-blind
 * member while the counts stay — the pile is a fact about the shelf, what it
 * cost is a fact about money. And a product that HAS sold inside the window must
 * not be counted, which is the whole definition: this measure exists to name
 * stock nothing has moved, and a false positive sends someone to discount
 * something that is selling perfectly well.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const SLUG = "dead-month-test";
const DAY = 86_400_000;

/** A date `daysAgo` before today, at UTC midnight. */
function daysAgo(n: number): Date {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return new Date(d.getTime() - n * DAY);
}

describe.skipIf(!runnable)("dead stock by month (local db)", () => {
  let tenantId: string;

  beforeAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    const tenant = await prismaService.tenant.create({
      data: { name: "Dead Month Co", slug: SLUG },
    });
    tenantId = tenant.id;
    await prismaService.tenantConfig.create({
      data: { tenantId, deadStockWindowDays: 60 },
    });

    const stale = await prismaService.product.create({
      data: {
        tenantId,
        sku: "DM-STALE",
        title: "Nobody Wants This",
        priceKes: 900,
        costKes: 100,
        abcCategory: "C",
      },
    });
    const selling = await prismaService.product.create({
      data: {
        tenantId,
        sku: "DM-SELLING",
        title: "Moves Fine",
        priceKes: 900,
        costKes: 400,
        abcCategory: "A",
      },
    });

    // Both held on the shelf on the same recent day.
    const asOf = daysAgo(2);
    await prismaService.inventorySnapshot.createMany({
      data: [
        { tenantId, productId: stale.id, date: asOf, onHand: 7 },
        { tenantId, productId: selling.id, date: asOf, onHand: 3 },
      ],
    });
    // One sold last week; the other not for half a year.
    await prismaService.salesHistory.createMany({
      data: [
        {
          tenantId,
          productId: selling.id,
          date: daysAgo(7),
          quantity: 2,
          revenueKes: 1800,
        },
        {
          tenantId,
          productId: stale.id,
          date: daysAgo(180),
          quantity: 1,
          revenueKes: 900,
        },
      ],
    });
  });

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { id: tenantId } });
    await prismaService.$disconnect();
  });

  it("counts only what has not sold inside the window", async () => {
    const result = await getDeadStockByMonth(tenantId, { months: 6, canViewCosts: true });
    const latest = result.months.at(-1);
    expect(latest, "no month was measured").toBeDefined();
    expect(result.windowDays).toBe(60);

    // The product that sold a week ago is not dead, however slow it looks.
    expect(latest!.skus, "a product that sold inside the window was counted").toBe(1);
    // 7 units at 100.
    expect(latest!.costKes).toBe(700);
  });

  it("splits the pile by class, so dead A-class is visible", async () => {
    const result = await getDeadStockByMonth(tenantId, { months: 6, canViewCosts: true });
    const latest = result.months.at(-1)!;
    expect(latest.byClass.c, "the stale C-class product is missing from its class").toBe(1);
    expect(latest.byClass.a, "the selling A-class product was counted as dead").toBe(0);
    const summed =
      latest.byClass.a + latest.byClass.b + latest.byClass.c + latest.byClass.unrated;
    expect(summed, "the class split does not add up to the count above it").toBe(latest.skus);
  });

  it("withholds the money from a money-blind member but keeps the count", async () => {
    const member = await getDeadStockByMonth(tenantId, { months: 6, canViewCosts: false });
    const latest = member.months.at(-1)!;
    expect(latest.costKes, "cost leaked to a money-blind member").toBeNull();
    // The pile is a fact about the shelf; only what it cost is withheld.
    expect(latest.skus).toBe(1);
    expect(latest.byClass.c).toBe(1);
  });
});
