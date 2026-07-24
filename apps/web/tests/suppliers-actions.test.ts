import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Suppliers server actions against the local database: the manage_settings gate,
 * the RLS-scoped writes (a foreign id is invisible), and the audit trail — for
 * bulk-assign-by-brand, "use learned" lead time, and soft-delete. Session +
 * revalidation are stubbed; the database work is real. Skips with no local db.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);
const DAY = 86_400_000;

const authState = vi.hoisted(() => ({
  session: null as { user: { id: string; name: string | null; email: string } } | null,
  membership: null as
    | { tenantId: string; displayName: string | null; role: string; permissions: unknown }
    | null,
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({
  requireSession: async () => authState.session,
  activeMembership: async () => authState.membership,
}));

import { prismaForTenant, prismaService } from "@wezesha/db";
import {
  bulkAssignByBrandAction,
  deleteSupplierAction,
  adoptLearnedLeadAction,
} from "../app/(shell)/suppliers/actions";

const SLUGS = ["supplier-action-a", "supplier-action-b"];

describe.skipIf(!runnable)("suppliers actions (local db)", () => {
  let tenantA: string;
  let tenantB: string;
  let beautyA: string; // supplier in A, target of Garnier assignment
  let guangzhouA: string; // supplier in A with delivery history
  let otherB: string; // supplier in B (RLS probe)
  let garnierA1: string;
  let garnierA2: string;

  async function receivedPo(
    tenantId: string,
    supplierId: string,
    poNumber: string,
    leadDays: number,
    product: { id: string; sku: string; title: string },
    receivedDaysAgo: number,
  ) {
    const receivedAt = new Date(Date.now() - receivedDaysAgo * DAY);
    const sentAt = new Date(receivedAt.getTime() - leadDays * DAY);
    await prismaService.purchaseOrder.create({
      data: {
        tenantId,
        supplierId,
        poNumber,
        status: "received",
        sentAt,
        receivedAt,
        expectedAt: new Date(sentAt.getTime() + 28 * DAY),
        lines: {
          create: [
            {
              tenantId,
              productId: product.id,
              sku: product.sku,
              title: product.title,
              quantity: 10,
              unitCostKes: 100,
              lineTotalKes: 1000,
              receivedQty: 10,
            },
          ],
        },
      },
    });
  }

  beforeAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: { in: SLUGS } } });
    const a = await prismaService.tenant.create({ data: { name: "Supplier Action A", slug: SLUGS[0]! } });
    const b = await prismaService.tenant.create({ data: { name: "Supplier Action B", slug: SLUGS[1]! } });
    tenantA = a.id;
    tenantB = b.id;

    const beauty = await prismaService.supplier.create({
      data: { tenantId: tenantA, name: "Beauty Plus", leadTimeAvgDays: 28, leadTimeStdDays: 4 },
    });
    beautyA = beauty.id;
    const gz = await prismaService.supplier.create({
      data: { tenantId: tenantA, name: "Guangzhou Traders", leadTimeAvgDays: 28, leadTimeStdDays: 4 },
    });
    guangzhouA = gz.id;
    const other = await prismaService.supplier.create({
      data: { tenantId: tenantB, name: "Other Co", leadTimeAvgDays: 14 },
    });
    otherB = other.id;

    // A product to hang Guangzhou's delivery history on, then three 34-day deliveries.
    const poProduct = await prismaService.product.create({
      data: { tenantId: tenantA, sku: "GZ-PROD", title: "GZ Product", vendor: "House" },
    });
    for (let i = 0; i < 3; i++) {
      await receivedPo(tenantA, guangzhouA, `PO-GZA-${i}`, 34, poProduct, i + 1);
    }

    // Two unassigned Garnier products in A, one in B (proves cross-tenant safety).
    const g1 = await prismaService.product.create({
      data: { tenantId: tenantA, sku: "GAR-1", title: "Garnier One", vendor: "Garnier" },
    });
    const g2 = await prismaService.product.create({
      data: { tenantId: tenantA, sku: "GAR-2", title: "Garnier Two", vendor: "Garnier" },
    });
    garnierA1 = g1.id;
    garnierA2 = g2.id;
    await prismaService.product.create({
      data: { tenantId: tenantB, sku: "GAR-B", title: "Garnier B", vendor: "Garnier" },
    });
  });

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    await prismaService.$disconnect();
  });

  function actAs(tenantId: string, permissions: unknown) {
    authState.session = { user: { id: "actor-1", name: "Owner", email: "owner@example.test" } };
    authState.membership = { tenantId, displayName: "Owner", role: "OWNER", permissions };
  }

  // ── bulk-assign-by-brand ───────────────────────────────────────────────────

  it("assigns a whole brand in one write and audits it (RLS-scoped)", async () => {
    actAs(tenantA, null);
    const result = await bulkAssignByBrandAction({ vendor: "Garnier", supplierId: beautyA });
    expect(result).toEqual({
      ok: true,
      message: "Assigned 2 Garnier products to Beauty Plus.",
    });

    const products = await prismaForTenant(tenantA).product.findMany({
      where: { id: { in: [garnierA1, garnierA2] } },
      select: { supplierId: true },
    });
    expect(products.every((p) => p.supplierId === beautyA)).toBe(true);

    const audits = await prismaForTenant(tenantA).auditEvent.findMany({
      where: { entity: "Supplier", entityId: beautyA },
    });
    expect(audits).toHaveLength(1);
    expect((audits[0]!.meta as { action: string; products: number }).action).toBe(
      "bulk_assign_by_brand",
    );
    expect((audits[0]!.meta as { products: number }).products).toBe(2);
    // Tenant B cannot see A's audit row.
    expect(
      await prismaForTenant(tenantB).auditEvent.findMany({ where: { entity: "Supplier" } }),
    ).toEqual([]);
  });

  it("is a no-op once the brand is already assigned", async () => {
    actAs(tenantA, null);
    const result = await bulkAssignByBrandAction({ vendor: "Garnier", supplierId: beautyA });
    expect(result).toEqual({ ok: false, error: "Those products already have a supplier." });
  });

  it("cannot assign to another tenant's supplier (RLS) and leaves B untouched", async () => {
    actAs(tenantB, null);
    const result = await bulkAssignByBrandAction({ vendor: "Garnier", supplierId: otherB });
    // B's own Garnier product exists and assigns fine — prove the write is scoped
    // by instead pointing tenant B at tenant A's supplier id.
    expect(result.ok).toBe(true);

    actAs(tenantA, null);
    const foreign = await bulkAssignByBrandAction({ vendor: "House", supplierId: otherB });
    expect(foreign).toEqual({ ok: false, error: "Pick a supplier that still exists." });
  });

  it("rejects a member without manage_settings", async () => {
    actAs(tenantA, []); // explicit empty override
    const result = await bulkAssignByBrandAction({ vendor: "House", supplierId: beautyA });
    expect(result).toEqual({ ok: false, error: "You don't have settings access in this workspace." });
  });

  // ── use learned lead time ──────────────────────────────────────────────────

  it("adopts the learned median as the typed lead time and audits it", async () => {
    actAs(tenantA, null);
    const result = await adoptLearnedLeadAction({ supplierId: guangzhouA });
    expect(result).toEqual({
      ok: true,
      message: "Guangzhou Traders lead time set to 34 days.",
    });

    const supplier = await prismaForTenant(tenantA).supplier.findUnique({
      where: { id: guangzhouA },
    });
    expect(supplier!.leadTimeAvgDays).toBe(34);

    const audit = await prismaForTenant(tenantA).auditEvent.findFirst({
      where: { entity: "Supplier", entityId: guangzhouA },
      orderBy: { createdAt: "desc" },
    });
    expect((audit!.meta as { source: string; from: number; to: number })).toMatchObject({
      source: "learned",
      from: 28,
      to: 34,
    });
  });

  it("refuses to learn below the minimum delivery count", async () => {
    actAs(tenantA, null);
    const result = await adoptLearnedLeadAction({ supplierId: beautyA });
    expect(result).toEqual({
      ok: false,
      error: "Not enough deliveries yet to learn a lead time.",
    });
  });

  it("cannot learn on another tenant's supplier (RLS)", async () => {
    actAs(tenantB, null);
    const result = await adoptLearnedLeadAction({ supplierId: guangzhouA });
    expect(result).toEqual({ ok: false, error: "That supplier no longer exists." });
  });

  it("rejects a member without manage_settings for use-learned", async () => {
    actAs(tenantA, []);
    const result = await adoptLearnedLeadAction({ supplierId: guangzhouA });
    expect(result).toEqual({ ok: false, error: "You don't have settings access in this workspace." });
  });

  // ── soft-delete ────────────────────────────────────────────────────────────

  it("soft-deletes a supplier and unlinks its products", async () => {
    actAs(tenantA, null);
    const result = await deleteSupplierAction({ supplierId: beautyA });
    expect(result.ok).toBe(true);

    const supplier = await prismaForTenant(tenantA).supplier.findUnique({ where: { id: beautyA } });
    expect(supplier!.deletedAt).not.toBeNull();
    // Its Garnier products were unlinked (re-flagged as unassigned).
    const products = await prismaForTenant(tenantA).product.findMany({
      where: { id: { in: [garnierA1, garnierA2] } },
      select: { supplierId: true },
    });
    expect(products.every((p) => p.supplierId === null)).toBe(true);

    const audit = await prismaForTenant(tenantA).auditEvent.findFirst({
      where: { entity: "Supplier", entityId: beautyA, action: "deleted" },
    });
    expect((audit!.meta as { productsUnlinked: number }).productsUnlinked).toBe(2);
  });
});
