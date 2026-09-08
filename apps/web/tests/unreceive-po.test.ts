import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { receivePoLines } from "../lib/po/receive-po";
import { unreceivePoLines } from "../lib/po/unreceive-po";

/**
 * Reversing a receipt, against the local database.
 *
 * Receiving had no inverse, so a mis-keyed quantity left stock wrong on every
 * screen that reads it with no way back. The case that carries the weight here
 * is the ROUND TRIP: receive then reverse the same units, and every stored
 * number — received quantity, on-hand, available, PO status — must be exactly
 * what it was before. Read back from the database, never from a return value,
 * because a return value is only the code agreeing with itself.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const SLUG = "unreceive-test";
const START_ON_HAND = 5;

type Fixture = {
  tenantId: string;
  poId: string;
  lineId: string;
  productId: string;
  ownLocationId: string;
  storeLocationId: string;
};

async function build(): Promise<Fixture> {
  await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
  const tenant = await prismaService.tenant.create({
    data: { name: "Unreceive Co", slug: SLUG },
  });
  const tenantId = tenant.id;
  // Ours to report: no Shopify location id, so receiving moves the shelf.
  const ownLocation = await prismaService.location.create({
    data: { tenantId, name: "Back room", source: "manual", locationType: "branch" },
  });
  // The store reports this one, so neither path may write stock to it.
  const storeLocation = await prismaService.location.create({
    data: {
      tenantId,
      name: "Shopify shop",
      source: "shopify",
      shopifyLocationId: "gid://shopify/Location/1",
      locationType: "branch",
    },
  });
  const product = await prismaService.product.create({
    data: { tenantId, sku: "UR-1", title: "Shea Butter", priceKes: 900, costKes: 400 },
  });
  await prismaService.inventoryLevel.createMany({
    data: [
      {
        tenantId,
        locationId: ownLocation.id,
        productId: product.id,
        onHand: START_ON_HAND,
        available: START_ON_HAND,
      },
      // The store-owned shelf needs a level too, or "no stock was written here"
      // is unfalsifiable: with no row to change, removing the guard looks
      // identical to honouring it.
      {
        tenantId,
        locationId: storeLocation.id,
        productId: product.id,
        onHand: START_ON_HAND,
        available: START_ON_HAND,
      },
    ],
  });
  const po = await prismaService.purchaseOrder.create({
    data: {
      tenantId,
      poNumber: "PO-UR-1",
      status: "sent",
      sentAt: new Date(),
      lines: {
        create: {
          tenantId,
          productId: product.id,
          sku: "UR-1",
          title: "Shea Butter",
          quantity: 10,
          unitCostKes: 400,
          lineTotalKes: 4000,
        },
      },
    },
    select: { id: true, lines: { select: { id: true } } },
  });
  return {
    tenantId,
    poId: po.id,
    lineId: po.lines[0]!.id,
    productId: product.id,
    ownLocationId: ownLocation.id,
    storeLocationId: storeLocation.id,
  };
}

/** Every number that matters, read back from the database. */
async function readState(f: Fixture) {
  const [po, line, level] = await Promise.all([
    prismaService.purchaseOrder.findUniqueOrThrow({
      where: { id: f.poId },
      select: { status: true, receivedAt: true },
    }),
    prismaService.purchaseOrderLine.findUniqueOrThrow({
      where: { id: f.lineId },
      select: { receivedQty: true, receivedAt: true },
    }),
    prismaService.inventoryLevel.findFirstOrThrow({
      where: { locationId: f.ownLocationId, productId: f.productId },
      select: { onHand: true, available: true },
    }),
  ]);
  return {
    status: po.status,
    poReceivedAt: po.receivedAt,
    receivedQty: line.receivedQty,
    lineReceivedAt: line.receivedAt,
    onHand: level.onHand,
    available: level.available,
  };
}

describe.skipIf(!runnable)("reversing a receipt (local db)", () => {
  let f: Fixture;

  beforeEach(async () => {
    f = await build();
  });

  afterEach(async () => {
    await prismaService.tenant.deleteMany({ where: { id: f.tenantId } });
  });

  it("leaves every stored number exactly as it found them", async () => {
    const before = await readState(f);

    const received = await receivePoLines(
      f.tenantId,
      f.poId,
      [{ lineId: f.lineId, qty: 10 }],
      f.ownLocationId
    );
    expect(received.ok).toBe(true);
    const mid = await readState(f);
    expect(mid.onHand, "the receipt did not move the shelf").toBe(START_ON_HAND + 10);
    expect(mid.receivedQty).toBe(10);
    expect(mid.status).toBe("received");

    const reversed = await unreceivePoLines(
      f.tenantId,
      f.poId,
      [{ lineId: f.lineId, qty: 10 }],
      f.ownLocationId
    );
    expect(reversed.ok).toBe(true);

    const after = await readState(f);
    expect(after.onHand, "on-hand did not come back").toBe(before.onHand);
    expect(after.available, "available did not come back").toBe(before.available);
    expect(after.receivedQty).toBe(0);
    expect(
      after.lineReceivedAt,
      "the line kept a stamp for a receipt that no longer exists"
    ).toBeNull();
    expect(after.status, "the order did not reopen").toBe("sent");
    expect(after.poReceivedAt).toBeNull();
  });

  it("reverses part of a receipt and leaves the rest booked in", async () => {
    await receivePoLines(f.tenantId, f.poId, [{ lineId: f.lineId, qty: 6 }], f.ownLocationId);
    const r = await unreceivePoLines(
      f.tenantId,
      f.poId,
      [{ lineId: f.lineId, qty: 2 }],
      f.ownLocationId
    );
    expect(r.ok).toBe(true);

    const s = await readState(f);
    expect(s.receivedQty).toBe(4);
    expect(s.onHand).toBe(START_ON_HAND + 4);
    expect(s.available).toBe(START_ON_HAND + 4);
    expect(s.status).toBe("partially_received");
    expect(s.lineReceivedAt, "a line with units still in lost its stamp").not.toBeNull();
  });

  it("refuses to reverse more than went in, and changes nothing when it refuses", async () => {
    await receivePoLines(f.tenantId, f.poId, [{ lineId: f.lineId, qty: 3 }], f.ownLocationId);
    const before = await readState(f);

    const r = await unreceivePoLines(
      f.tenantId,
      f.poId,
      [{ lineId: f.lineId, qty: 4 }],
      f.ownLocationId
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_qty");

    // A refusal that had already moved stock would be the worst outcome of all.
    expect(await readState(f)).toEqual(before);
  });

  it("will not reverse an order nothing was received against", async () => {
    const r = await unreceivePoLines(
      f.tenantId,
      f.poId,
      [{ lineId: f.lineId, qty: 1 }],
      f.ownLocationId
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_reversible");
  });

  it("moves no stock where the store owns the shelf", async () => {
    // The forward path deliberately writes no stock there, so reversing must not
    // invent a shortage by subtracting a movement that never happened.
    const rec = await receivePoLines(
      f.tenantId,
      f.poId,
      [{ lineId: f.lineId, qty: 10 }],
      f.storeLocationId
    );
    expect(rec.ok && rec.stockFollowsStore).toBe(true);

    const r = await unreceivePoLines(
      f.tenantId,
      f.poId,
      [{ lineId: f.lineId, qty: 10 }],
      f.storeLocationId
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.stockFollowsStore).toBe(true);

    // Read the STORE's level, which is the one that must not have moved.
    const storeLevel = await prismaService.inventoryLevel.findFirstOrThrow({
      where: { locationId: f.storeLocationId, productId: f.productId },
      select: { onHand: true, available: true },
    });
    expect(storeLevel.onHand, "a shelf the store owns was moved").toBe(START_ON_HAND);
    expect(storeLevel.available, "available moved on a shelf the store owns").toBe(START_ON_HAND);

    const s = await readState(f);
    expect(s.onHand, "the other location was touched").toBe(START_ON_HAND);
    expect(s.receivedQty).toBe(0);
  });

  it("writes its own ledger entry rather than editing the receipt's", async () => {
    await receivePoLines(f.tenantId, f.poId, [{ lineId: f.lineId, qty: 5 }], f.ownLocationId);
    await unreceivePoLines(f.tenantId, f.poId, [{ lineId: f.lineId, qty: 5 }], f.ownLocationId);

    const events = await prismaService.auditEvent.findMany({
      where: { tenantId: f.tenantId, entityId: f.poId },
      select: { action: true },
    });
    const actions = events.map((e) => e.action);
    expect(actions, "the receipt was erased instead of reversed").toContain("received");
    expect(actions, "the reversal left no trace").toContain("receipt_reversed");
  });
});
