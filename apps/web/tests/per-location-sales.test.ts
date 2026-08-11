import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { runRate } from "@/lib/metrics";

/**
 * One product-day, two branches — through the database, not just the bucketer.
 *
 * The unique key used to be (productId, date, channel), so the second branch's
 * row could not exist and the sync collapsed the day to one unattributed row.
 * Widening it is only safe if the units still add up: a per-branch split that
 * double counts inflates the run rate, and the run rate sizes every order on the
 * buy list.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const SLUG = "per-location-sales";
const DAY = new Date("2026-06-04T00:00:00.000Z");

describe.skipIf(!runnable)("per-branch sales history (local db)", () => {
  let tenantId: string;
  let productId: string;
  let kilimani: string;
  let westlands: string;

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    await prismaService.$disconnect();
  });

  beforeEach(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    const tenant = await prismaService.tenant.create({
      data: { name: "Per Location", slug: SLUG, currency: "KES" },
    });
    tenantId = tenant.id;
    const product = await prismaService.product.create({
      data: { tenantId, sku: "PL-1", title: "Split", vendor: "House", priceKes: 100 },
    });
    productId = product.id;
    const a = await prismaService.location.create({
      data: { tenantId, name: "Kilimani", locationType: "branch", roleStatus: "confirmed" },
    });
    const b = await prismaService.location.create({
      data: { tenantId, name: "Westlands", locationType: "branch", roleStatus: "confirmed" },
    });
    kilimani = a.id;
    westlands = b.id;
  });

  it("stores the same product-day once per branch", async () => {
    await prismaService.salesHistory.createMany({
      data: [
        { tenantId, productId, date: DAY, quantity: 4, revenueKes: 400, channel: "shopify", locationId: kilimani },
        { tenantId, productId, date: DAY, quantity: 6, revenueKes: 600, channel: "shopify", locationId: westlands },
      ],
    });

    const rows = await prismaService.salesHistory.findMany({ where: { tenantId } });
    expect(rows).toHaveLength(2);
    expect(new Map(rows.map((r) => [r.locationId, r.quantity]))).toEqual(
      new Map([
        [kilimani, 4],
        [westlands, 6],
      ])
    );
  });

  it("still refuses a duplicate for the SAME branch", async () => {
    await prismaService.salesHistory.create({
      data: { tenantId, productId, date: DAY, quantity: 4, revenueKes: 400, channel: "shopify", locationId: kilimani },
    });
    await expect(
      prismaService.salesHistory.create({
        data: { tenantId, productId, date: DAY, quantity: 4, revenueKes: 400, channel: "shopify", locationId: kilimani },
      })
    ).rejects.toThrow();
  });

  it("does not double count: the blended rate reads the shop's true units", async () => {
    // The whole risk of this migration in one assertion. Ten units sold across
    // two branches must move the rate exactly as ten units sold at one.
    await prismaService.salesHistory.createMany({
      data: [
        { tenantId, productId, date: DAY, quantity: 4, revenueKes: 400, channel: "shopify", locationId: kilimani },
        { tenantId, productId, date: DAY, quantity: 6, revenueKes: 600, channel: "shopify", locationId: westlands },
      ],
    });
    const split = await prismaService.salesHistory.findMany({
      where: { tenantId },
      select: { date: true, quantity: true, revenueKes: true, channel: true },
    });

    const asOf = new Date("2026-06-05T00:00:00.000Z");
    const splitRate = runRate(split, asOf);
    const wholeRate = runRate(
      [{ date: DAY, quantity: 10, revenueKes: 1000, channel: "shopify" }],
      asOf
    );
    expect(splitRate).toBeCloseTo(wholeRate, 10);
    expect(split.reduce((s, r) => s + r.quantity, 0)).toBe(10);
  });
});
