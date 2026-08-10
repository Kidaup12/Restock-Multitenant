import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { seedDev, type SeedResult } from "../../../packages/db/scripts/seed-dev";
import { getProductDetail } from "../lib/data/product-detail";

/**
 * The product page is a new cost-bearing surface, so it needs the two proofs
 * every such surface needs: a money-blind member's payload carries no cost, and
 * a product id from another workspace resolves to nothing rather than to a row.
 *
 * Skips with no local db.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

let seeded: SeedResult;
let tenantId: string;
let productId: string;
let otherTenantId: string;
let otherProductId: string;

describe.skipIf(!runnable)("one product's detail (seeded local db)", () => {
  beforeAll(async () => {
    seeded = await seedDev();
    tenantId = seeded.tenantId;

    const product = await prismaService.product.findFirst({
      where: { tenantId, active: true, costKes: { gt: 0 } },
      select: { id: true },
    });
    productId = product!.id;

    const other = await prismaService.tenant.upsert({
      where: { slug: "product-detail-other" },
      update: {},
      create: { name: "Product Detail Other", slug: "product-detail-other", currency: "KES" },
      select: { id: true },
    });
    otherTenantId = other.id;
    const foreign = await prismaService.product.create({
      data: {
        tenantId: otherTenantId,
        sku: "PD-FOREIGN-1",
        title: "Someone else's product",
        priceKes: 500,
        costKes: 200,
        currentStock: 7,
      },
      select: { id: true },
    });
    otherProductId = foreign.id;
  }, 180_000);

  afterAll(async () => {
    await prismaService.product.deleteMany({ where: { tenantId: otherTenantId } });
    await prismaService.tenant.deleteMany({ where: { id: otherTenantId } });
    await prismaService.$disconnect();
  });

  it("tells the whole story of one product", async () => {
    const detail = await getProductDetail(tenantId, productId, { canViewCosts: true });
    expect(detail).not.toBeNull();
    expect(detail!.productId).toBe(productId);
    expect(detail!.unitCostKes).toBeGreaterThan(0);
    // Twelve buckets whether or not every month sold — a gap is information.
    expect(detail!.months).toHaveLength(12);
    expect(detail!.months.every((m) => typeof m.units === "number")).toBe(true);
  }, 120_000);

  it("sends a money-blind member no cost at all", async () => {
    const detail = await getProductDetail(tenantId, productId, { canViewCosts: false });
    expect(detail).not.toBeNull();
    // Redacted at the data layer, not hidden at render: the number must never
    // reach the browser for someone who may not see it.
    expect(detail!.unitCostKes).toBeNull();
    expect(detail!.stockValueKes).toBeNull();
    // Sales figures are not costs, and staff are allowed them.
    expect(detail!.priceKes).toBeGreaterThan(0);
    expect(typeof detail!.revenue30dKes).toBe("number");
  }, 120_000);

  it("cannot reach a product in another workspace", async () => {
    const detail = await getProductDetail(tenantId, otherProductId, { canViewCosts: true });
    expect(detail, "a foreign product id must resolve to nothing").toBeNull();
  }, 120_000);
});
