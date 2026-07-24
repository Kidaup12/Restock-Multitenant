import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import {
  seedDev,
  seedOrdersDemo,
  type SeedResult,
} from "../../../packages/db/scripts/seed-dev";
import {
  getLeadTimeDriftAlerts,
  getSupplierOptions,
  getSuppliers,
  getUnassignedByBrand,
} from "../lib/data/suppliers";

/**
 * Suppliers data module against the seeded local database (amara-beauty has
 * three suppliers with delivery history from the orders demo). The module runs
 * on the RLS-enforced tenant client; expectations are computed independently on
 * the service client. Skips when no local database is configured.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);
const DAY = 86_400_000;

let seeded: SeedResult;
let tenantId: string;

describe.skipIf(!runnable)("suppliers data module (seeded local db)", () => {
  beforeAll(async () => {
    seeded = await seedDev();
    tenantId = seeded.tenantId;
    await seedOrdersDemo(tenantId);
  }, 120_000);

  afterAll(async () => {
    await prismaService.$disconnect();
  });

  it("lists the three seeded suppliers with typed lead times and speed bands", async () => {
    const rows = await getSuppliers(tenantId);
    expect(rows.map((r) => r.name)).toEqual([
      "Beauty Plus Distributors",
      "Haria Industries",
      "Orbit Imports",
    ]);
    const byName = new Map(rows.map((r) => [r.name, r]));
    expect(byName.get("Beauty Plus Distributors")!.leadTimeTypedDays).toBe(10);
    expect(byName.get("Beauty Plus Distributors")!.speedBand).toBe("regional");
    expect(byName.get("Haria Industries")!.leadTimeTypedDays).toBe(21);
    expect(byName.get("Haria Industries")!.speedBand).toBe("import");
    expect(byName.get("Orbit Imports")!.speedBand).toBe("import");

    const options = await getSupplierOptions(tenantId);
    expect(options.map((o) => o.name)).toEqual([
      "Beauty Plus Distributors",
      "Haria Industries",
      "Orbit Imports",
    ]);
  });

  it("scores from real delivery history and derives assigned-product counts", async () => {
    const rows = await getSuppliers(tenantId);
    const byName = new Map(rows.map((r) => [r.name, r]));

    // Assigned-product counts, computed independently on the service client.
    const [counts, suppliers] = await Promise.all([
      prismaService.product.groupBy({
        by: ["supplierId"],
        where: { tenantId },
        _count: { _all: true },
      }),
      prismaService.supplier.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    ]);
    const nameById = new Map(suppliers.map((s) => [s.id, s.name]));
    const expectedCount = new Map<string, number>();
    for (const c of counts) {
      if (c.supplierId) expectedCount.set(nameById.get(c.supplierId)!, c._count._all);
    }
    for (const row of rows) {
      expect(row.assignedProductCount).toBe(expectedCount.get(row.name) ?? 0);
    }

    // PO-0001: 9 actual vs 10 promised — on time, in full.
    const beauty = byName.get("Beauty Plus Distributors")!;
    expect(beauty.deliveriesTracked).toBe(1);
    expect(beauty.onTimePct).toBe(100);
    expect(beauty.fillRatePct).toBe(100);
    expect(beauty.shortShipPct).toBe(0);
    // A single delivery is below the >=3 minimum — no learned value, no drift.
    expect(beauty.learnedLeadDays).toBeNull();
    expect(beauty.drift.drifting).toBe(false);

    // PO-0002: 25 actual vs 21 promised — late, in full.
    const haria = byName.get("Haria Industries")!;
    expect(haria.onTimePct).toBe(0);
    expect(haria.fillRatePct).toBe(100);

    // Orbit has no deliveries yet — no invented score.
    const orbit = byName.get("Orbit Imports")!;
    expect(orbit.deliveriesTracked).toBe(0);
    expect(orbit.onTimePct).toBeNull();
    expect(orbit.shortShipPct).toBeNull();
  });

  it("surfaces a learned median and a drift alert once enough deliveries land", async () => {
    const product = await prismaService.product.findFirst({
      where: { tenantId },
      select: { id: true, sku: true, title: true, costKes: true },
    });
    const supplier = await prismaService.supplier.create({
      data: {
        tenantId,
        name: "Guangzhou Traders",
        currency: "CNY",
        leadTimeAvgDays: 28,
        leadTimeStdDays: 4,
      },
    });
    // Three completed deliveries, each 34 days against a typed 28 — median 34d.
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      const receivedAt = new Date(now - (i + 1) * DAY);
      const sentAt = new Date(receivedAt.getTime() - 34 * DAY);
      await prismaService.purchaseOrder.create({
        data: {
          tenantId,
          supplierId: supplier.id,
          poNumber: `PO-GZ-${i}`,
          status: "received",
          sentAt,
          receivedAt,
          expectedAt: new Date(sentAt.getTime() + 28 * DAY),
          lines: {
            create: [
              {
                tenantId,
                productId: product!.id,
                sku: product!.sku,
                title: product!.title,
                quantity: 10,
                unitCostKes: product!.costKes,
                lineTotalKes: 10 * product!.costKes,
                receivedQty: 10,
              },
            ],
          },
        },
      });
    }

    const rows = await getSuppliers(tenantId);
    const gz = rows.find((r) => r.name === "Guangzhou Traders")!;
    expect(gz.deliveriesTracked).toBe(3);
    expect(gz.learnedLeadDays).toBe(34);
    expect(gz.leadTimeTypedDays).toBe(28);
    expect(gz.drift.drifting).toBe(true);
    expect(gz.drift.direction).toBe("later");
    expect(gz.drift.deltaDays).toBe(6);

    const alerts = await getLeadTimeDriftAlerts(tenantId);
    const gzAlert = alerts.find((a) => a.supplierName === "Guangzhou Traders")!;
    expect(gzAlert).toBeTruthy();
    expect(gzAlert.typedDays).toBe(28);
    expect(gzAlert.learnedDays).toBe(34);
  });

  it("groups unassigned products by brand with a suggested supplier", async () => {
    // The seed assigns every product, so nothing is unassigned to begin with.
    expect(await getUnassignedByBrand(tenantId)).toEqual([]);

    // Unassign one Garnier product; its sibling stays with Beauty Plus.
    const [garnier, beauty] = await Promise.all([
      prismaService.product.findFirst({
        where: { tenantId, sku: "GAR-VCS-30" },
        select: { id: true },
      }),
      prismaService.supplier.findFirst({
        where: { tenantId, name: "Beauty Plus Distributors" },
        select: { id: true },
      }),
    ]);
    await prismaService.product.update({
      where: { id: garnier!.id },
      data: { supplierId: null },
    });

    const brands = await getUnassignedByBrand(tenantId);
    const gar = brands.find((b) => b.vendor === "Garnier")!;
    expect(gar.productCount).toBe(1);
    // The remaining Garnier product is Beauty Plus's, so it's suggested.
    expect(gar.suggestedSupplierId).toBe(beauty!.id);
    expect(gar.suggestedSupplierName).toBe("Beauty Plus Distributors");
  });

  it("is tenant-scoped: another tenant sees none of these suppliers", async () => {
    const probe = await prismaService.tenant.create({
      data: { name: "Suppliers Probe", slug: "suppliers-data-probe" },
    });
    try {
      expect(await getSuppliers(probe.id)).toEqual([]);
      expect(await getUnassignedByBrand(probe.id)).toEqual([]);
      expect(await getSupplierOptions(probe.id)).toEqual([]);
    } finally {
      await prismaService.tenant.delete({ where: { id: probe.id } });
    }
  });
});
