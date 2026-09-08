import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { removePoLine, setPoLineQuantity } from "../lib/po/edit-po-lines";

/**
 * Editing a draft purchase order's lines, against the local database.
 *
 * Two things carry the weight. The order's SUBTOTAL must follow the lines —
 * a line total and an order total that disagree is money on a document a
 * supplier reads. And a SENT order must refuse every edit, because the supplier
 * already holds those numbers and changing ours afterwards would leave the two
 * records silently different.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const SLUG = "edit-po-lines-test";

type Fixture = {
  tenantId: string;
  poId: string;
  lineA: string;
  lineB: string;
  productA: string;
};

async function build(status = "draft"): Promise<Fixture> {
  await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
  const tenant = await prismaService.tenant.create({
    data: { name: "Edit Lines Co", slug: SLUG },
  });
  const tenantId = tenant.id;
  const a = await prismaService.product.create({
    data: { tenantId, sku: "EL-A", title: "Shea Butter", priceKes: 900, costKes: 100 },
  });
  const b = await prismaService.product.create({
    data: { tenantId, sku: "EL-B", title: "Coconut Oil", priceKes: 700, costKes: 50 },
  });
  const po = await prismaService.purchaseOrder.create({
    data: {
      tenantId,
      poNumber: "PO-EL-1",
      status,
      // 10 x 100 + 20 x 50 = 2000
      subtotalKes: 2000,
      lines: {
        create: [
          {
            tenantId,
            productId: a.id,
            sku: "EL-A",
            title: "Shea Butter",
            quantity: 10,
            unitCostKes: 100,
            lineTotalKes: 1000,
            recommendedQty: 7,
          },
          {
            tenantId,
            productId: b.id,
            sku: "EL-B",
            title: "Coconut Oil",
            quantity: 20,
            unitCostKes: 50,
            lineTotalKes: 1000,
            recommendedQty: 20,
          },
        ],
      },
    },
    select: { id: true, lines: { select: { id: true, sku: true } } },
  });
  const lineA = po.lines.find((l) => l.sku === "EL-A")!.id;
  const lineB = po.lines.find((l) => l.sku === "EL-B")!.id;
  // A queued row pointing at this order, as createPoFromOrders leaves them.
  await prismaService.order.create({
    data: {
      tenantId,
      productId: a.id,
      status: "ordered",
      purchaseOrderId: po.id,
      orderedQty: 10,
      orderedAt: new Date(),
    },
  });
  return { tenantId, poId: po.id, lineA, lineB, productA: a.id };
}

async function readPo(f: Fixture) {
  const po = await prismaService.purchaseOrder.findUniqueOrThrow({
    where: { id: f.poId },
    select: {
      status: true,
      subtotalKes: true,
      lines: {
        select: { id: true, quantity: true, lineTotalKes: true, recommendedQty: true },
        orderBy: { sku: "asc" },
      },
    },
  });
  return po;
}

describe.skipIf(!runnable)("editing a draft purchase order (local db)", () => {
  let f: Fixture;

  afterEach(async () => {
    await prismaService.tenant.deleteMany({ where: { id: f.tenantId } });
  });

  describe("on a draft", () => {
    beforeEach(async () => {
      f = await build("draft");
    });

    it("re-prices the line and the order together", async () => {
      const r = await setPoLineQuantity(f.tenantId, f.poId, f.lineA, 25);
      expect(r.ok).toBe(true);

      const po = await readPo(f);
      const a = po.lines.find((l) => l.id === f.lineA)!;
      expect(a.quantity).toBe(25);
      expect(a.lineTotalKes, "the line total did not follow the quantity").toBe(2500);
      // 25 x 100 + 20 x 50 = 3500. An order total that lags its lines is money
      // wrong on a document the supplier reads.
      expect(po.subtotalKes, "the order total did not follow the lines").toBe(3500);
    });

    it("keeps what the model asked for, so the disagreement stays measurable", async () => {
      await setPoLineQuantity(f.tenantId, f.poId, f.lineA, 25);
      const po = await readPo(f);
      const a = po.lines.find((l) => l.id === f.lineA)!;
      expect(a.recommendedQty, "the owner's number overwrote the model's").toBe(7);
    });

    it("refuses a quantity no order can mean", async () => {
      for (const bad of [0, -5, 2.5]) {
        const r = await setPoLineQuantity(f.tenantId, f.poId, f.lineA, bad);
        expect(r.ok, `accepted ${bad}`).toBe(false);
      }
      expect((await readPo(f)).subtotalKes).toBe(2000);
    });

    it("puts a removed line's items back on the buy list", async () => {
      const r = await removePoLine(f.tenantId, f.poId, f.lineA);
      expect(r.ok).toBe(true);

      const po = await readPo(f);
      expect(po.lines).toHaveLength(1);
      expect(po.subtotalKes, "the total still counts the removed line").toBe(1000);

      const queued = await prismaService.order.findMany({
        where: { tenantId: f.tenantId, productId: f.productA },
        select: { status: true, purchaseOrderId: true },
      });
      // Left as "ordered" the product reads as already on the way: off the buy
      // list, and on no order anyone will ever receive.
      expect(queued[0]!.status, "the item did not go back on the buy list").toBe("pending");
      expect(queued[0]!.purchaseOrderId).toBeNull();
    });

    it("will not empty an order", async () => {
      await removePoLine(f.tenantId, f.poId, f.lineA);
      const r = await removePoLine(f.tenantId, f.poId, f.lineB);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("last_line");
      expect((await readPo(f)).lines).toHaveLength(1);
    });

    it("rejects a line from another order", async () => {
      const r = await setPoLineQuantity(f.tenantId, f.poId, "not-a-line-of-this-po", 5);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("bad_line");
    });
  });

  describe("once sent", () => {
    beforeEach(async () => {
      f = await build("sent");
    });

    it("refuses to change a quantity the supplier already has", async () => {
      const r = await setPoLineQuantity(f.tenantId, f.poId, f.lineA, 99);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("not_editable");

      const po = await readPo(f);
      expect(po.lines.find((l) => l.id === f.lineA)!.quantity).toBe(10);
      expect(po.subtotalKes).toBe(2000);
    });

    it("refuses to remove a line the supplier already has", async () => {
      const r = await removePoLine(f.tenantId, f.poId, f.lineA);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("not_editable");
      expect((await readPo(f)).lines).toHaveLength(2);
    });
  });
});
