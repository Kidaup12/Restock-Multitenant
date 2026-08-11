import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { receivePoLines } from "../lib/po/receive-po";

/**
 * Who owns the shelf figure after a delivery is booked in.
 *
 * A receipt used to add its units to the level. The sync writes the store's
 * ABSOLUTE on-hand over ours every cycle, so on any Shopify-connected workspace
 * that increase survived about fifteen minutes and then vanished — and the buy
 * list went back to asking for units the owner had just received.
 *
 * Note the seed builds locations with no shopifyLocationId, so every other suite
 * exercises the branch production NEVER takes. This one forces production's
 * shape: a location the sync owns.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const SLUG = "receive-ownership";

describe.skipIf(!runnable)("receiving and stock ownership (local db)", () => {
  let tenantId: string;
  let productId: string;
  let poId: string;
  let lineId: string;
  /** A location the Shopify sync owns, and one that is ours alone. */
  let syncedLocationId: string;
  let ownLocationId: string;

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    await prismaService.$disconnect();
  });

  beforeEach(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    const tenant = await prismaService.tenant.create({
      data: { name: "Receive Ownership", slug: SLUG, currency: "KES" },
    });
    tenantId = tenant.id;

    const product = await prismaService.product.create({
      data: { tenantId, sku: "RCV-1", title: "Receivable", vendor: "House", currentStock: 3 },
    });
    productId = product.id;

    const synced = await prismaService.location.create({
      data: {
        tenantId,
        name: "Shop location",
        shopifyLocationId: "gid://shopify/Location/1",
        locationType: "branch",
        roleStatus: "confirmed",
        isPrimary: true,
      },
    });
    syncedLocationId = synced.id;
    const own = await prismaService.location.create({
      data: { tenantId, name: "Back room", locationType: "branch", roleStatus: "confirmed" },
    });
    ownLocationId = own.id;

    for (const locationId of [syncedLocationId, ownLocationId]) {
      await prismaService.inventoryLevel.create({
        data: { tenantId, locationId, productId, onHand: 3, available: 3 },
      });
    }

    const po = await prismaService.purchaseOrder.create({
      data: {
        tenantId,
        poNumber: "PO-0001",
        status: "sent",
        sentAt: new Date(),
        lines: {
          create: [
            {
              tenantId,
              productId,
              sku: "RCV-1",
              title: "Receivable",
              quantity: 25,
              unitCostKes: 100,
              lineTotalKes: 2500,
            },
          ],
        },
      },
      include: { lines: true },
    });
    poId = po.id;
    lineId = po.lines[0]!.id;
  });

  const levelAt = (locationId: string) =>
    prismaService.inventoryLevel.findFirst({
      where: { locationId, productId },
      select: { onHand: true, available: true },
    });

  it("records the delivery but leaves the shelf to the store", async () => {
    const result = await receivePoLines(tenantId, poId, [{ lineId, qty: 10 }], syncedLocationId);

    expect(result).toMatchObject({ ok: true, receivedUnits: 10, stockFollowsStore: true });

    // The purchase order remembers everything about the delivery.
    const line = await prismaService.purchaseOrderLine.findUnique({ where: { id: lineId } });
    expect(line).toMatchObject({ receivedQty: 10 });
    expect(line!.receivedAt).not.toBeNull();
    const po = await prismaService.purchaseOrder.findUnique({ where: { id: poId } });
    expect(po!.status).toBe("partially_received");

    // The shelf does not move — the store reports it.
    expect(await levelAt(syncedLocationId)).toMatchObject({ onHand: 3, available: 3 });
    const product = await prismaService.product.findUnique({ where: { id: productId } });
    expect(product!.currentStock).toBe(3);
  });

  it("still moves stock where nothing else reports it", async () => {
    const result = await receivePoLines(tenantId, poId, [{ lineId, qty: 10 }], ownLocationId);

    expect(result).toMatchObject({ ok: true, stockFollowsStore: false });
    expect(await levelAt(ownLocationId)).toMatchObject({ onHand: 13, available: 13 });
    // The synced location is untouched either way.
    expect(await levelAt(syncedLocationId)).toMatchObject({ onHand: 3 });
  });

  it("completes the queue row on a full delivery regardless of who owns the shelf", async () => {
    await prismaService.order.create({
      data: { tenantId, productId, purchaseOrderId: poId, status: "ordered", orderedQty: 25 },
    });

    const result = await receivePoLines(tenantId, poId, [{ lineId, qty: 25 }], syncedLocationId);
    expect(result).toMatchObject({ ok: true, status: "received" });

    const order = await prismaService.order.findFirst({ where: { purchaseOrderId: poId } });
    expect(order!.status).toBe("completed");
    // Still no stock written.
    expect(await levelAt(syncedLocationId)).toMatchObject({ onHand: 3 });
  });

  it("keeps the over-receipt guard", async () => {
    const result = await receivePoLines(tenantId, poId, [{ lineId, qty: 26 }], syncedLocationId);
    expect(result).toMatchObject({ ok: false, reason: "bad_qty" });
  });
});
