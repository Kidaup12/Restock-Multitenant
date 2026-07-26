import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { createPoFromOrders } from "../lib/po/create-po";
import { receivePoLines } from "../lib/po/receive-po";

/**
 * Two staff hitting the same button at the same moment, against the local
 * database. Both paths read, decide, then write, and the read is not held by
 * any lock — so the tests fire genuinely concurrent calls (Promise.all, two
 * pooled connections, two real transactions) and assert the INVARIANT that must
 * survive whichever order Postgres picks, not a particular winner.
 *
 * Each round uses its own fixture so a round can't be rescued by the previous
 * one's state.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const SLUG = "po-race-tenant";
const ROUNDS = 3;
const ORDERED = 100;

type Fixture = { poId: string; lineId: string; productId: string };

describe.skipIf(!runnable)("purchase-order concurrency (local db)", () => {
  let tenantId: string;
  let supplierId: string;
  let locationId: string;

  beforeAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    const tenant = await prismaService.tenant.create({
      data: { name: "PO Race", slug: SLUG },
    });
    tenantId = tenant.id;
    const supplier = await prismaService.supplier.create({
      data: { tenantId, name: "Race Supplier", email: "orders@race.example", moq: 1 },
    });
    supplierId = supplier.id;
    const location = await prismaService.location.create({
      data: { tenantId, name: "Race Branch", locationType: "branch", isPrimary: true },
    });
    locationId = location.id;
  }, 30_000);

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { id: tenantId } });
    await prismaService.$disconnect();
  }, 30_000);

  /** One sent PO with a single 100-unit line, its product at zero stock. */
  async function sentPo(tag: string): Promise<Fixture> {
    const product = await prismaService.product.create({
      data: {
        tenantId,
        supplierId,
        sku: `RACE-${tag}`,
        title: `Race SKU ${tag}`,
        costKes: 100,
        currentStock: 0,
      },
    });
    await prismaService.inventoryLevel.create({
      data: { tenantId, locationId, productId: product.id, onHand: 0 },
    });
    const po = await prismaService.purchaseOrder.create({
      data: {
        tenantId,
        supplierId,
        poNumber: `PO-RACE-${tag}`,
        status: "sent",
        sentAt: new Date(),
        subtotalKes: ORDERED * 100,
        lines: {
          create: [
            {
              tenantId,
              productId: product.id,
              sku: product.sku,
              title: product.title,
              quantity: ORDERED,
              unitCostKes: 100,
              lineTotalKes: ORDERED * 100,
            },
          ],
        },
      },
      select: { id: true, lines: { select: { id: true } } },
    });
    return { poId: po.id, lineId: po.lines[0]!.id, productId: product.id };
  }

  it("a double-submitted receipt never puts more on the shelf than it records", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const fixture = await sentPo(`recv-${round}`);
      const submit = () =>
        receivePoLines(tenantId, fixture.poId, [{ lineId: fixture.lineId, qty: ORDERED }], locationId);
      const results = await Promise.all([submit(), submit()]);

      const line = await prismaService.purchaseOrderLine.findUniqueOrThrow({
        where: { id: fixture.lineId },
      });
      const level = await prismaService.inventoryLevel.findUniqueOrThrow({
        where: { locationId_productId: { locationId, productId: fixture.productId } },
      });
      const product = await prismaService.product.findUniqueOrThrow({
        where: { id: fixture.productId },
      });

      // The invariant: units on the shelf equal units the PO says were received.
      expect(level.onHand).toBe(line.receivedQty);
      expect(product.currentStock).toBe(line.receivedQty);
      // And a 100-unit line can never end up over-received.
      expect(line.receivedQty).toBeLessThanOrEqual(ORDERED);
      // One submit is a real receipt; the other is a duplicate, not a second delivery.
      expect(results.filter((r) => r.ok)).toHaveLength(1);
    }
  });

  it("two receipts on different lines of one PO still close it out", async () => {
    const [productA, productB] = await Promise.all(
      ["A", "B"].map((tag) =>
        prismaService.product.create({
          data: {
            tenantId,
            supplierId,
            sku: `RACE-SPLIT-${tag}`,
            title: `Split ${tag}`,
            costKes: 50,
          },
        })
      )
    );
    const po = await prismaService.purchaseOrder.create({
      data: {
        tenantId,
        supplierId,
        poNumber: "PO-RACE-SPLIT",
        status: "sent",
        sentAt: new Date(),
        lines: {
          create: [productA!, productB!].map((p) => ({
            tenantId,
            productId: p.id,
            sku: p.sku,
            title: p.title,
            quantity: 10,
            unitCostKes: 50,
            lineTotalKes: 500,
          })),
        },
      },
      select: { id: true, lines: { select: { id: true, sku: true } } },
    });
    const lineA = po.lines.find((l) => l.sku === productA!.sku)!;
    const lineB = po.lines.find((l) => l.sku === productB!.sku)!;

    const results = await Promise.all([
      receivePoLines(tenantId, po.id, [{ lineId: lineA.id, qty: 10 }], locationId),
      receivePoLines(tenantId, po.id, [{ lineId: lineB.id, qty: 10 }], locationId),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);

    // Everything ordered is in, so the PO must not be stuck on partial.
    const after = await prismaService.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
    expect(after.status).toBe("received");
    expect(after.receivedAt).not.toBeNull();
  });

  it("a double-submitted create leaves no second, sendable purchase order", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const product = await prismaService.product.create({
        data: {
          tenantId,
          supplierId,
          sku: `RACE-Q-${round}`,
          title: `Queued ${round}`,
          costKes: 200,
          currentStock: 5,
        },
      });
      const queued = await Promise.all(
        [1, 2, 3].map(() =>
          prismaService.order.create({
            data: { tenantId, status: "pending", productId: product.id, orderedQty: 12 },
          })
        )
      );
      const orderIds = queued.map((o) => o.id);

      const results = await Promise.all([
        createPoFromOrders(tenantId, orderIds),
        createPoFromOrders(tenantId, orderIds),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);

      // The invariant: the queue rows land on exactly one purchase order, and no
      // orphaned draft is left behind for someone to send to the supplier.
      const pos = await prismaService.purchaseOrder.findMany({
        where: { tenantId, poNumber: { not: { startsWith: "PO-RACE" } } },
        include: { orders: { select: { id: true } } },
      });
      const forThisRound = pos.filter((po) =>
        po.orders.some((o) => orderIds.includes(o.id))
      );
      expect(forThisRound).toHaveLength(1);
      expect(forThisRound[0]!.orders).toHaveLength(orderIds.length);
      expect(pos.filter((po) => po.orders.length === 0)).toEqual([]);

      await prismaService.order.deleteMany({ where: { id: { in: orderIds } } });
      await prismaService.purchaseOrder.deleteMany({
        where: { tenantId, poNumber: { not: { startsWith: "PO-RACE" } } },
      });
    }
  });
});
