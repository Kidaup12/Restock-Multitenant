import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { createManualPo } from "../lib/po/create-manual-po";

/**
 * Ordering something the forecast never asked for, against the local database.
 *
 * The case that carries the most weight is the QUEUE ROW. The buy list holds a
 * product back on the strength of an open Order row, not a PO line, so a manual
 * order that wrote only lines would leave its products on the list and the next
 * forecast run would ask for them again — the shop orders twice, and nothing in
 * the app says why.
 *
 * The cost guard matters for the same reason it is absent upstream: the queued
 * path inherits the plan's unplannable gate, this one has no gate at all, and a
 * zero-cost line prices a real supplier order at nothing.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const SLUG = "manual-po-test";

type Fixture = {
  tenantId: string;
  supplierId: string;
  otherSupplierId: string;
  productId: string;
  otherSuppliersProduct: string;
  costlessProduct: string;
};

async function build(moq = 1): Promise<Fixture> {
  await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
  const tenant = await prismaService.tenant.create({
    data: { name: "Manual PO Co", slug: SLUG, currency: "KES" },
  });
  const tenantId = tenant.id;
  const supplier = await prismaService.supplier.create({
    data: { tenantId, name: "Beauty Plus", moq },
  });
  const other = await prismaService.supplier.create({
    data: { tenantId, name: "Someone Else", moq: 1 },
  });
  const product = await prismaService.product.create({
    data: {
      tenantId,
      sku: "MP-1",
      title: "Shea Butter",
      priceKes: 900,
      costKes: 400,
      currentStock: 12,
      supplierId: supplier.id,
    },
  });
  const foreign = await prismaService.product.create({
    data: {
      tenantId,
      sku: "MP-2",
      title: "Someone Else's Oil",
      priceKes: 500,
      costKes: 200,
      supplierId: other.id,
    },
  });
  const costless = await prismaService.product.create({
    data: {
      tenantId,
      sku: "MP-3",
      title: "No Cost On File",
      priceKes: 500,
      costKes: 0,
      supplierId: supplier.id,
    },
  });
  return {
    tenantId,
    supplierId: supplier.id,
    otherSupplierId: other.id,
    productId: product.id,
    otherSuppliersProduct: foreign.id,
    costlessProduct: costless.id,
  };
}

describe.skipIf(!runnable)("creating a purchase order by hand (local db)", () => {
  let f: Fixture;

  afterEach(async () => {
    await prismaService.tenant.deleteMany({ where: { id: f.tenantId } });
  });

  describe("with a straightforward supplier", () => {
    beforeEach(async () => {
      f = await build(1);
    });

    it("writes the order, its lines and its money", async () => {
      const r = await createManualPo(f.tenantId, f.supplierId, [
        { productId: f.productId, qty: 7 },
      ]);
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      const po = await prismaService.purchaseOrder.findUniqueOrThrow({
        where: { id: r.poId },
        select: {
          status: true,
          supplierId: true,
          subtotalKes: true,
          currency: true,
          lines: { select: { quantity: true, unitCostKes: true, lineTotalKes: true } },
        },
      });
      expect(po.status, "a hand-built order should start as a draft").toBe("draft");
      expect(po.supplierId).toBe(f.supplierId);
      expect(po.currency, "priced from costKes, so it carries the shop's currency").toBe("KES");
      expect(po.lines).toHaveLength(1);
      expect(po.lines[0]!.lineTotalKes).toBe(2800);
      expect(po.subtotalKes).toBe(2800);
    });

    it("counts as already on the way, so the buy list stops asking", async () => {
      const r = await createManualPo(f.tenantId, f.supplierId, [
        { productId: f.productId, qty: 7 },
      ]);
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      const queued = await prismaService.order.findMany({
        where: { tenantId: f.tenantId, productId: f.productId },
        select: { status: true, purchaseOrderId: true, orderedQty: true, stockAtOrder: true },
      });
      // Without this row the product stays on the buy list, the next run asks
      // for it again, and the shop orders it twice.
      expect(queued, "the order left nothing on the queue").toHaveLength(1);
      expect(queued[0]!.status).toBe("ordered");
      expect(queued[0]!.purchaseOrderId).toBe(r.poId);
      expect(queued[0]!.orderedQty).toBe(7);
      expect(queued[0]!.stockAtOrder, "what was on the shelf when it was ordered").toBe(12);
    });

    it("refuses a product the supplier does not sell", async () => {
      const r = await createManualPo(f.tenantId, f.supplierId, [
        { productId: f.otherSuppliersProduct, qty: 3 },
      ]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("wrong_supplier");
      expect(await prismaService.purchaseOrder.count({ where: { tenantId: f.tenantId } })).toBe(0);
    });

    it("refuses to price a line at nothing", async () => {
      // Nothing upstream filters this out on the manual path.
      const r = await createManualPo(f.tenantId, f.supplierId, [
        { productId: f.costlessProduct, qty: 5 },
      ]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("no_cost");
      expect(await prismaService.purchaseOrder.count({ where: { tenantId: f.tenantId } })).toBe(0);
    });

    it("refuses a quantity no order can mean", async () => {
      for (const qty of [0, -2, 1.5]) {
        const r = await createManualPo(f.tenantId, f.supplierId, [
          { productId: f.productId, qty },
        ]);
        expect(r.ok, `accepted ${qty}`).toBe(false);
      }
      expect(await prismaService.purchaseOrder.count({ where: { tenantId: f.tenantId } })).toBe(0);
    });
  });

  describe("with a minimum order quantity", () => {
    beforeEach(async () => {
      f = await build(24);
    });

    it("raises the line to the supplier's minimum and prices what will be sent", async () => {
      const r = await createManualPo(f.tenantId, f.supplierId, [
        { productId: f.productId, qty: 5 },
      ]);
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      const po = await prismaService.purchaseOrder.findUniqueOrThrow({
        where: { id: r.poId },
        select: { subtotalKes: true, lines: { select: { quantity: true, recommendedQty: true } } },
      });
      // The supplier will not ship five, so the money must be for twenty-four.
      expect(po.lines[0]!.quantity).toBe(24);
      expect(po.lines[0]!.recommendedQty, "what was actually asked for").toBe(5);
      expect(po.subtotalKes).toBe(24 * 400);
    });
  });
});
