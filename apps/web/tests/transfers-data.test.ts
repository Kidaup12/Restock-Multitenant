import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { seedDev, type SeedResult } from "../../../packages/db/scripts/seed-dev";
import {
  finaliseDistributionPlan,
  getDistributionPlan,
  getDistributionProposal,
  getTransferLocations,
  listDistributionPlans,
  saveDistributionPlan,
} from "../lib/data/transfers";

/**
 * Transfers data module against the seeded local database. The module runs on
 * the RLS-enforced tenant client; every expectation is recomputed independently
 * on the service client with an explicit tenant filter, so a wrong (or leaking)
 * query shows up as a mismatch.
 *
 * The seeded demo has one selling branch, so the second suite builds the case
 * the feature exists for — two branches selling at different rates — and proves
 * the plan lands them on the same days of cover. Skips without a local database.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const OTHER_SLUG = "transfers-other-tenant";

let seeded: SeedResult;
let tenantId: string;
let warehouseId: string;
let shopId: string;

describe.skipIf(!runnable)("transfers data module (seeded local db)", () => {
  beforeAll(async () => {
    seeded = await seedDev();
    tenantId = seeded.tenantId;
    const locations = await prismaService.location.findMany({
      where: { tenantId },
      select: { id: true, locationType: true },
    });
    warehouseId = locations.find((l) => l.locationType === "warehouse")!.id;
    shopId = locations.find((l) => l.locationType === "branch")!.id;
  }, 120_000);

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: OTHER_SLUG } });
    await prismaService.$disconnect();
  });

  it("offers holding locations first, with the units they actually hold", async () => {
    const locations = await getTransferLocations(tenantId);
    expect(locations[0]!.role).toBe("holds");
    expect(locations[0]!.locationId).toBe(warehouseId);
    expect(locations.map((l) => l.locationId).sort()).toEqual([shopId, warehouseId].sort());

    const held = await prismaService.inventoryLevel.aggregate({
      where: { tenantId, locationId: warehouseId, onHand: { gt: 0 } },
      _sum: { onHand: true },
    });
    expect(locations[0]!.unitsOnHand).toBe(held._sum.onHand ?? 0);
  });

  it("never proposes more than the source holds, and never a fraction of a unit", async () => {
    const proposal = await getDistributionProposal(tenantId, {
      fromLocationId: warehouseId,
      canViewCosts: true,
    });
    expect(proposal).not.toBeNull();
    expect(proposal!.fromLocationId).toBe(warehouseId);

    const sourceLevels = new Map(
      (
        await prismaService.inventoryLevel.findMany({
          where: { tenantId, locationId: warehouseId },
          select: { productId: true, onHand: true },
        })
      ).map((l) => [l.productId, l.onHand])
    );
    const branchLevels = new Map(
      (
        await prismaService.inventoryLevel.findMany({
          where: { tenantId, locationId: shopId },
          select: { productId: true, onHand: true },
        })
      ).map((l) => [l.productId, l.onHand])
    );

    // Every line ships to a selling branch, out of stock the warehouse really
    // holds, in whole units — checked against the raw levels, not the loader.
    const movedByProduct = new Map<string, number>();
    for (const line of proposal!.lines) {
      expect(line.toLocationId).toBe(shopId);
      expect(Number.isInteger(line.qty)).toBe(true);
      expect(line.qty).toBeGreaterThan(0);
      expect(line.fromOnHand).toBe(sourceLevels.get(line.productId) ?? 0);
      expect(line.toOnHand).toBe(branchLevels.get(line.productId) ?? 0);
      expect(line.toDaysCoverAfter).toBeGreaterThanOrEqual(line.toDaysCoverBefore);
      expect(line.toDaysCoverAfter).toBeLessThanOrEqual(proposal!.coverDays + 1);
      movedByProduct.set(line.productId, (movedByProduct.get(line.productId) ?? 0) + line.qty);
    }
    for (const [productId, moved] of movedByProduct) {
      expect(moved).toBeLessThanOrEqual(sourceLevels.get(productId) ?? 0);
    }

    // Value on the move is qty x unit cost, recomputed from the products table.
    const costs = new Map(
      (
        await prismaService.product.findMany({
          where: { tenantId, id: { in: [...movedByProduct.keys()] } },
          select: { id: true, costKes: true },
        })
      ).map((p) => [p.id, p.costKes])
    );
    const expectedValue = proposal!.lines.reduce(
      (sum, l) => sum + l.qty * (costs.get(l.productId) ?? 0),
      0
    );
    expect(proposal!.totalValueKes).toBeCloseTo(expectedValue, 5);
    expect(proposal!.totalUnits).toBe(proposal!.lines.reduce((s, l) => s + l.qty, 0));
  });

  it("leaves not-for-sale and unsellable stock where it is", async () => {
    // A tester/display line is out of sellable cover everywhere else, so a plan
    // must not shuffle it between branches either.
    const marked = await prismaService.product.findFirst({
      where: { tenantId, active: true },
      select: { id: true },
      orderBy: { sku: "asc" },
    });
    await prismaService.product.update({
      where: { id: marked!.id },
      data: { notForSale: true },
    });
    const proposal = await getDistributionProposal(tenantId, {
      fromLocationId: warehouseId,
      canViewCosts: true,
    });
    expect(proposal!.lines.some((l) => l.productId === marked!.id)).toBe(false);
    await prismaService.product.update({
      where: { id: marked!.id },
      data: { notForSale: false },
    });
  });

  it("redacts every cost for a money-blind member without reordering a single row", async () => {
    const owner = await getDistributionProposal(tenantId, {
      fromLocationId: warehouseId,
      canViewCosts: true,
    });
    const member = await getDistributionProposal(tenantId, {
      fromLocationId: warehouseId,
      canViewCosts: false,
    });

    expect(member!.totalValueKes).toBeNull();
    expect(member!.lines.every((l) => l.valueKes === null)).toBe(true);
    expect(member!.destinations.every((d) => d.valueKes === null)).toBe(true);
    // Same rows, same order, same quantities — only the money is gone.
    expect(member!.lines.map((l) => `${l.productId}:${l.toLocationId}:${l.qty}`)).toEqual(
      owner!.lines.map((l) => `${l.productId}:${l.toLocationId}:${l.qty}`)
    );
    expect(member!.totalUnits).toBe(owner!.totalUnits);
  });

  it("saves, lists and finalises a plan, redacting value for a money-blind member", async () => {
    const proposal = await getDistributionProposal(tenantId, {
      fromLocationId: warehouseId,
      canViewCosts: true,
    });
    const planId = await saveDistributionPlan(tenantId, proposal!, { name: "Warehouse push" });

    // Lines landed with the tenant stamped on every one (the RLS discriminator).
    const stored = await prismaService.distributionPlanLine.findMany({
      where: { tenantId, planId },
      select: { tenantId: true, qty: true, toLocationId: true },
    });
    expect(stored).toHaveLength(proposal!.lines.length);
    expect(stored.every((l) => l.tenantId === tenantId)).toBe(true);
    expect(stored.reduce((s, l) => s + l.qty, 0)).toBe(proposal!.totalUnits);

    const listed = await listDistributionPlans(tenantId, { canViewCosts: true });
    const summary = listed.find((p) => p.id === planId)!;
    expect(summary.name).toBe("Warehouse push");
    expect(summary.status).toBe("draft");
    expect(summary.units).toBe(proposal!.totalUnits);
    expect(summary.valueKes).toBeCloseTo(proposal!.totalValueKes!, 5);

    const blind = await listDistributionPlans(tenantId, { canViewCosts: false });
    expect(blind.find((p) => p.id === planId)!.valueKes).toBeNull();
    expect(blind.map((p) => p.id)).toEqual(listed.map((p) => p.id));

    const detailBlind = await getDistributionPlan(tenantId, planId, { canViewCosts: false });
    expect(detailBlind!.valueKes).toBeNull();
    expect(detailBlind!.lines.every((l) => l.valueKes === null)).toBe(true);

    expect(await finaliseDistributionPlan(tenantId, planId)).toBe(true);
    // Finalising twice is a no-op, not a second state change.
    expect(await finaliseDistributionPlan(tenantId, planId)).toBe(false);
    const after = await prismaService.distributionPlan.findFirst({
      where: { tenantId, id: planId },
      select: { status: true },
    });
    expect(after!.status).toBe("final");
  });

  it("never reaches another tenant's plans, locations or stock", async () => {
    await prismaService.tenant.deleteMany({ where: { slug: OTHER_SLUG } });
    const other = await prismaService.tenant.create({
      data: { name: "Other Shop", slug: OTHER_SLUG, plan: "growth" },
    });
    const otherLocation = await prismaService.location.create({
      data: { tenantId: other.id, name: "Other Branch", locationType: "branch" },
    });
    const otherPlan = await prismaService.distributionPlan.create({
      data: { tenantId: other.id, name: "Theirs", fromLocationId: otherLocation.id },
    });

    const mine = await listDistributionPlans(tenantId, { canViewCosts: true });
    expect(mine.some((p) => p.id === otherPlan.id)).toBe(false);
    expect(await getDistributionPlan(tenantId, otherPlan.id, { canViewCosts: true })).toBeNull();

    // A source id from the other tenant resolves to nothing under RLS, so the
    // proposal falls back to this tenant's own warehouse rather than leaking.
    const proposal = await getDistributionProposal(tenantId, {
      fromLocationId: otherLocation.id,
      canViewCosts: true,
    });
    expect(proposal!.fromLocationId).toBe(warehouseId);
    expect(proposal!.lines.every((l) => l.toLocationId !== otherLocation.id)).toBe(true);

    // And the other tenant sees only its own (empty) world.
    expect(await getTransferLocations(other.id)).toHaveLength(1);
    expect(await listDistributionPlans(other.id, { canViewCosts: true })).toHaveLength(1);
    expect(await getDistributionPlan(other.id, otherPlan.id, { canViewCosts: true })).not.toBeNull();

    await prismaService.tenant.deleteMany({ where: { id: other.id } });
  });
});

describe.skipIf(!runnable)("transfers across two branches selling at different rates", () => {
  let branchAId: string;
  let branchBId: string;
  let productId: string;
  let warehouseStock: number;

  /**
   * The founder's case: two shops, different sales, one warehouse. Attribution
   * is created by pointing the seeded history at a branch per channel (the
   * unique key is product+date+channel, so re-pointing beats inserting), which
   * gives each branch a real, different share of the same product's demand.
   */
  beforeAll(async () => {
    seeded = await seedDev();
    tenantId = seeded.tenantId;
    const locations = await prismaService.location.findMany({
      where: { tenantId },
      select: { id: true, locationType: true },
    });
    warehouseId = locations.find((l) => l.locationType === "warehouse")!.id;
    branchAId = locations.find((l) => l.locationType === "branch")!.id;
    branchBId = (
      await prismaService.location.create({
        data: { tenantId, name: "Westlands Shop", locationType: "branch", roleStatus: "confirmed" },
      })
    ).id;

    // A steady seller with a real split between counter and web sales, so the
    // two branches end up with clearly different (and non-zero) demand.
    productId = (await prismaService.product.findFirstOrThrow({
      where: { tenantId, sku: "NIV-PR-400" },
      select: { id: true },
    })).id;
    warehouseStock = 400;

    await prismaService.salesHistory.updateMany({
      where: { tenantId, productId, channel: "pos" },
      data: { locationId: branchAId },
    });
    await prismaService.salesHistory.updateMany({
      where: { tenantId, productId, channel: "shopify" },
      data: { locationId: branchBId },
    });
    // Both quantities move together: nothing here is committed to an order, and
    // a level whose available lags its on-hand is a state no writer produces —
    // the sync sets both, and receiving a PO settles available with COALESCE.
    await prismaService.inventoryLevel.updateMany({
      where: { tenantId, productId, locationId: branchAId },
      data: { onHand: 0, available: 0 },
    });
    await prismaService.inventoryLevel.create({
      data: { tenantId, productId, locationId: branchBId, onHand: 0, available: 0 },
    });
    await prismaService.inventoryLevel.upsert({
      where: { locationId_productId: { locationId: warehouseId, productId } },
      create: {
        tenantId,
        productId,
        locationId: warehouseId,
        onHand: warehouseStock,
        available: warehouseStock,
      },
      update: { onHand: warehouseStock, available: warehouseStock },
    });
  }, 120_000);

  afterAll(async () => {
    await prismaService.$disconnect();
  });

  it("splits by each branch's own sales and lands both on the same cover", async () => {
    const proposal = await getDistributionProposal(tenantId, {
      fromLocationId: warehouseId,
      coverDays: 14,
      canViewCosts: true,
    });
    const lines = proposal!.lines.filter((l) => l.productId === productId);
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.rateBasis === "attributed")).toBe(true);
    expect(proposal!.hasAttributedDemand).toBe(true);

    // Independent expectation: with both branches starting empty, the split is
    // the ratio of their attributed sales over the 90-day window.
    const since = new Date(Date.now() - 90 * 86_400_000);
    const attributed = await prismaService.salesHistory.groupBy({
      by: ["locationId"],
      where: { tenantId, productId, date: { gte: since }, locationId: { not: null } },
      _sum: { quantity: true },
    });
    const soldA = attributed.find((a) => a.locationId === branchAId)!._sum.quantity!;
    const soldB = attributed.find((a) => a.locationId === branchBId)!._sum.quantity!;
    expect(soldA).toBeGreaterThan(soldB); // the seeded product is POS-heavy

    const byLocation = new Map(lines.map((l) => [l.toLocationId, l]));
    const qtyA = byLocation.get(branchAId)!.qty;
    const qtyB = byLocation.get(branchBId)!.qty;
    expect(qtyA).toBeGreaterThan(qtyB);
    expect(qtyA / (qtyA + qtyB)).toBeCloseTo(soldA / (soldA + soldB), 1);

    // The promise on the tin: equal days of cover, inside one unit of rounding.
    const coverA = qtyA / byLocation.get(branchAId)!.toRunRate;
    const coverB = qtyB / byLocation.get(branchBId)!.toRunRate;
    expect(Math.abs(coverA - coverB)).toBeLessThan(1);
    expect(qtyA + qtyB).toBeLessThanOrEqual(warehouseStock);
  });

  it("is capped by the source: a thin warehouse levels both branches lower", async () => {
    await prismaService.inventoryLevel.update({
      where: { locationId_productId: { locationId: warehouseId, productId } },
      data: { onHand: 20, available: 20 },
    });

    const proposal = await getDistributionProposal(tenantId, {
      fromLocationId: warehouseId,
      coverDays: 14,
      canViewCosts: true,
    });
    const lines = proposal!.lines.filter((l) => l.productId === productId);
    const moved = lines.reduce((sum, l) => sum + l.qty, 0);
    expect(moved).toBe(20); // every available unit is spent
    for (const line of lines) expect(line.toDaysCoverAfter).toBeLessThan(14);

    const covers = lines.map((l) => l.qty / l.toRunRate);
    expect(Math.abs(covers[0]! - covers[1]!)).toBeLessThan(1);

    await prismaService.inventoryLevel.update({
      where: { locationId_productId: { locationId: warehouseId, productId } },
      data: { onHand: warehouseStock },
    });
  });

  it("flags a branch with no demand signal instead of dumping stock on it", async () => {
    const quiet = await prismaService.location.create({
      data: { tenantId, name: "Quiet Shop", locationType: "branch", roleStatus: "confirmed" },
    });

    const proposal = await getDistributionProposal(tenantId, {
      fromLocationId: warehouseId,
      canViewCosts: true,
    });
    expect(proposal!.lines.every((l) => l.toLocationId !== quiet.id)).toBe(true);
    expect(proposal!.skipped.map((s) => s.locationId)).toContain(quiet.id);
    expect(proposal!.skipped.find((s) => s.locationId === quiet.id)!.reason).toBe(
      "no-demand-signal"
    );

    await prismaService.location.delete({ where: { id: quiet.id } });
  });
});
