import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { getImpact } from "../lib/data/insights";

/**
 * The impact figures against a hand-built history: two complete weeks of nightly
 * snapshots, one purchase order to start the clock, and sales chosen so the
 * dead-stock count is known by hand. Covers the three states the card can be in
 * (nothing ordered yet, too early, measurable) and that a number which went the
 * wrong way is reported as a regression rather than dropped.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const DAY = 86_400_000;
const SLUG = "impact-card-tenant";
const WINDOW_DAYS = 30;

/** Monday (UTC) of the week a date falls in — the same bucketing the getter uses. */
function weekStartOf(d: Date): Date {
  const day = d.getUTCDay();
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((day + 6) % 7));
  return monday;
}

describe.skipIf(!runnable)("impact figures (local db)", () => {
  let tenantId: string;
  let productIds: string[] = [];
  /** Monday of the older and newer measured weeks. */
  let weekA: Date;
  let weekB: Date;

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    await prismaService.$disconnect();
  });

  beforeEach(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    const tenant = await prismaService.tenant.create({
      data: { name: "Impact Card", slug: SLUG, currency: "KES" },
    });
    tenantId = tenant.id;
    await prismaService.tenantConfig.create({
      data: { tenantId, deadStockWindowDays: WINDOW_DAYS },
    });

    productIds = [];
    for (const sku of ["P1", "P2", "P3", "P4"]) {
      const p = await prismaService.product.create({
        data: { tenantId, sku, title: `Product ${sku}`, vendor: "House" },
      });
      productIds.push(p.id);
    }

    // Two complete weeks back from the current one, so both are in the past.
    const thisWeek = weekStartOf(new Date());
    weekB = new Date(thisWeek.getTime() - 7 * DAY);
    weekA = new Date(thisWeek.getTime() - 14 * DAY);
  });

  /** Five nightly snapshots (Mon–Fri) for one week; onHand per product index. */
  async function snapshotWeek(weekStart: Date, onHand: number[]) {
    const rows = [];
    for (let day = 0; day < 5; day++) {
      const date = new Date(weekStart.getTime() + day * DAY);
      for (const [i, id] of productIds.entries()) {
        rows.push({ tenantId, productId: id, date, onHand: onHand[i]! });
      }
    }
    await prismaService.inventorySnapshot.createMany({ data: rows });
  }

  async function firstOrder(at: Date) {
    await prismaService.purchaseOrder.create({
      data: { tenantId, poNumber: "PO-0001", status: "sent", createdAt: at, sentAt: at },
    });
  }

  it("says there is nothing to measure until the shop has ordered", async () => {
    await snapshotWeek(weekA, [0, 5, 5, 5]);
    await snapshotWeek(weekB, [5, 5, 5, 5]);

    const impact = await getImpact(tenantId);
    expect(impact.reason).toBe("no_order_yet");
    expect(impact.since).toBeNull();
    expect(impact.emptyShelfPct).toBeNull();
  });

  it("holds off until two full weeks are on record", async () => {
    await firstOrder(new Date(weekA.getTime() - DAY));
    await snapshotWeek(weekB, [5, 5, 5, 5]);

    const impact = await getImpact(tenantId);
    expect(impact.reason).toBe("too_early");
    expect(impact.trackingSince).not.toBeNull();
  });

  it("compares the first measured week with the latest, and shows a regression as one", async () => {
    await firstOrder(new Date(weekA.getTime() - DAY));
    // Week A: P1's shelf is empty all week — 5 of 20 product-days.
    await snapshotWeek(weekA, [0, 5, 5, 5]);
    // Week B: nothing empty, but P1 now sits there unsold.
    await snapshotWeek(weekB, [5, 5, 5, 5]);
    // Only P2 has sold, and recently enough to count in both weeks.
    await prismaService.salesHistory.create({
      data: {
        tenantId,
        productId: productIds[1]!,
        date: new Date(weekA.getTime() - 2 * DAY),
        quantity: 3,
        revenueKes: 300,
        channel: "shopify",
      },
    });

    const impact = await getImpact(tenantId);
    expect(impact.reason).toBeNull();
    expect(impact.deadStockWindowDays).toBe(WINDOW_DAYS);

    expect(impact.emptyShelfPct).toMatchObject({ start: 25, now: 0, change: -25 });
    // Week A: P2 sold, P3 and P4 never did. Week B adds P1, which now has stock
    // and no sale — the count going UP is the honest answer.
    expect(impact.deadStockSkus).toMatchObject({ start: 2, now: 3, change: 1 });
  });

  it("ignores an empty shelf when counting dead stock — the same test Today applies", async () => {
    await firstOrder(new Date(weekA.getTime() - DAY));
    await snapshotWeek(weekA, [0, 0, 5, 5]);
    await snapshotWeek(weekB, [0, 0, 5, 5]);

    const impact = await getImpact(tenantId);
    // P1 and P2 are empty, so only P3 and P4 can be dead stock.
    expect(impact.deadStockSkus).toMatchObject({ start: 2, now: 2, change: 0 });
  });

  it("counts a product that sold inside the window as alive", async () => {
    await firstOrder(new Date(weekA.getTime() - DAY));
    await snapshotWeek(weekA, [5, 5, 5, 5]);
    await snapshotWeek(weekB, [5, 5, 5, 5]);
    for (const id of productIds) {
      await prismaService.salesHistory.create({
        data: {
          tenantId,
          productId: id,
          date: new Date(weekA.getTime() - DAY),
          quantity: 1,
          revenueKes: 100,
          channel: "shopify",
        },
      });
    }

    const impact = await getImpact(tenantId);
    expect(impact.deadStockSkus).toMatchObject({ start: 0, now: 0 });
  });

  it("treats a sale older than the window as no sale at all", async () => {
    await firstOrder(new Date(weekA.getTime() - DAY));
    await snapshotWeek(weekA, [5, 5, 5, 5]);
    await snapshotWeek(weekB, [5, 5, 5, 5]);
    for (const id of productIds) {
      await prismaService.salesHistory.create({
        data: {
          tenantId,
          productId: id,
          date: new Date(weekA.getTime() - (WINDOW_DAYS + 10) * DAY),
          quantity: 1,
          revenueKes: 100,
          channel: "shopify",
        },
      });
    }

    const impact = await getImpact(tenantId);
    expect(impact.deadStockSkus).toMatchObject({ start: 4, now: 4 });
  });
});
