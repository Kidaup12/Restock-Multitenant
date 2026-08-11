import { prismaForTenantTx, prismaService, isSellable, sellableUnits } from "@wezesha/db";

/**
 * Line-by-line receiving with partial quantities. One tenant transaction:
 * line receivedQty/receivedAt, linked queue rows completed, PO status advanced.
 *
 * **Receiving does not move stock when the store owns it.** Adding the delivery
 * to the level here read as a stock increase for about fifteen minutes and was
 * then wiped: the sync writes Shopify's ABSOLUTE on-hand over ours every cycle
 * (apps/worker/src/shopify-sync.ts), so a receipt of 10 took the shelf from 3 to
 * 13 and back to 3 without anyone touching it — and the buy list went back to
 * asking for units the owner had just booked in. Claiming a number we cannot
 * keep is worse than showing the store's, so the receipt is recorded against the
 * purchase order and the shelf stays whatever the shop's own system reports.
 *
 * A location the sync does not own has no other source of truth, so receiving
 * still writes stock there — that is the only case where our number is the number.
 *
 * The supplier's TYPED lead time is deliberately left untouched here. A received
 * delivery used to overwrite Supplier.leadTimeAvgDays with the re-learned
 * median, which silently replaced the number the owner set — the value that
 * drives every reorder point moved without anyone deciding it should. The
 * learned lead time is now derived from this same receipt history at read time
 * (lib/data/suppliers.ts) and shown beside the typed value on the Suppliers
 * page; the owner adopts it with one click ("use learned"), which is the only
 * path that writes leadTimeAvgDays.
 */

export type ReceiveEntry = { lineId: string; qty: number };

export type ReceivePoResult =
  | {
      ok: true;
      status: string;
      receivedUnits: number;
      /** True when the shelf figure is the store's to report, so this receipt
       *  deliberately left stock alone. The screen says so rather than letting
       *  the owner expect a number that will not move. */
      stockFollowsStore: boolean;
    }
  | {
      ok: false;
      reason: "not_found" | "not_receivable" | "bad_location" | "bad_line" | "bad_qty" | "empty";
    };

export async function receivePoLines(
  tenantId: string,
  poId: string,
  entries: ReceiveEntry[],
  locationId: string,
  actor?: { userId: string; name: string | null }
): Promise<ReceivePoResult> {
  const receipts = entries.filter((e) => e.qty > 0);
  if (receipts.length === 0) return { ok: false, reason: "empty" };

  const result = await prismaForTenantTx(tenantId, async (tx): Promise<ReceivePoResult> => {
    // Serialise receipts against this PO. Everything below is decided from the
    // read that follows — the outstanding-quantity guard, the per-line running
    // total, the finished/partial status — and READ COMMITTED gives two
    // concurrent receipts no consistent view of it. Two staff submitting the
    // same delivery both read receivedQty = 0, both clear the over-receipt
    // guard, both write the same absolute receivedQty and both increment stock:
    // 100 units in, 200 on the shelf, PO reading "all in". Released at commit.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`po-receive:${poId}`}, 0))`;

    const po = await tx.purchaseOrder.findFirst({
      where: { id: poId, deletedAt: null },
      select: {
        id: true,
        poNumber: true,
        status: true,
        sentAt: true,
        supplierId: true,
        lines: {
          select: { id: true, productId: true, quantity: true, receivedQty: true },
        },
      },
    });
    if (!po) return { ok: false, reason: "not_found" };
    if (po.status !== "sent" && po.status !== "partially_received") {
      return { ok: false, reason: "not_receivable" };
    }

    // RLS scopes the lookup — a location id from another tenant resolves to nothing.
    const location = await tx.location.findFirst({
      where: { id: locationId },
      select: { id: true, shopifyLocationId: true },
    });
    if (!location) return { ok: false, reason: "bad_location" };
    // The sync owns every location it created, and overwrites on-hand and
    // available from the store on each run.
    const stockFollowsStore = location.shopifyLocationId !== null;

    const lineById = new Map(po.lines.map((l) => [l.id, l]));
    for (const entry of receipts) {
      const line = lineById.get(entry.lineId);
      if (!line) return { ok: false, reason: "bad_line" };
      if (!Number.isInteger(entry.qty)) return { ok: false, reason: "bad_qty" };
      // No over-receipt: an extra carton is a data problem to surface, not absorb.
      if (entry.qty > line.quantity - line.receivedQty) return { ok: false, reason: "bad_qty" };
    }

    const now = new Date();
    let receivedUnits = 0;
    const fullyReceivedProducts: string[] = [];

    for (const entry of receipts) {
      const line = lineById.get(entry.lineId)!;
      const nextQty = line.receivedQty + entry.qty;
      await tx.purchaseOrderLine.update({
        where: { id: line.id },
        data: { receivedQty: nextQty, receivedAt: now },
      });
      line.receivedQty = nextQty;
      receivedUnits += entry.qty;
      if (nextQty >= line.quantity) fullyReceivedProducts.push(line.productId);
      // Where the store reports the shelf, the receipt stops here: the next sync
      // would overwrite anything written below within fifteen minutes.
      if (stockFollowsStore) continue;

      // Stock arriving on a PO is both physically present and sellable, so both
      // columns move. Raw SQL rather than Prisma's `increment` for `available`:
      // it is nullable, and `NULL + n` is NULL in SQL, so an increment on a row
      // no available-aware sync has touched yet would silently erase the figure
      // the whole buy list reads. COALESCE makes the first receipt establish it.
      await tx.inventoryLevel.upsert({
        where: { locationId_productId: { locationId, productId: line.productId } },
        // available is left unset on create and settled by the statement below,
        // which runs on both paths — setting it here too would add the quantity
        // twice for a level this receipt is the first to touch.
        create: { tenantId, locationId, productId: line.productId, onHand: entry.qty },
        update: { onHand: { increment: entry.qty } },
      });
      // onHand already includes this receipt by now, so the NULL branch resolves
      // to the pre-receipt on-hand plus the quantity — i.e. treat a level no
      // available-aware sync has touched as having nothing committed, exactly
      // what sellableUnits() falls back to.
      await tx.$executeRaw`
        UPDATE "InventoryLevel"
           SET "available" = COALESCE("available", "onHand" - ${entry.qty}) + ${entry.qty}
         WHERE "locationId" = ${locationId} AND "productId" = ${line.productId}`;
    }

    // currentStock is SELLABLE on-hand — the sum of what can actually be sold
    // over Sells-role locations only, matching the sync's definition exactly (a
    // warehouse holds stock, it doesn't sell it; units promised to a customer
    // cannot be sold twice). Both halves matter: summing every level would let
    // received warehouse stock inflate sellable cover, and summing on-hand would
    // undo the sync's committed-unit subtraction on every receipt.
    const touched = stockFollowsStore
      ? []
      : [...new Set(receipts.map((e) => lineById.get(e.lineId)!.productId))];
    for (const productId of touched) {
      const levels = await tx.inventoryLevel.findMany({
        where: { productId },
        select: {
          available: true,
          onHand: true,
          location: { select: { locationType: true } },
        },
      });
      const sellable = levels
        .filter((l) => l.location && isSellable(l.location))
        .reduce((sum, l) => sum + sellableUnits(l), 0);
      await tx.product.update({
        where: { id: productId },
        data: { currentStock: sellable },
      });
    }

    // A queue row completes when its product's line is fully in.
    if (fullyReceivedProducts.length > 0) {
      await tx.order.updateMany({
        where: {
          purchaseOrderId: po.id,
          status: "ordered",
          productId: { in: fullyReceivedProducts },
        },
        data: { status: "completed", receivedAt: now },
      });
    }

    const allFull = po.lines.every((l) => l.receivedQty >= l.quantity);
    await tx.purchaseOrder.update({
      where: { id: po.id },
      data: allFull
        ? { status: "received", receivedAt: now }
        : { status: "partially_received" },
    });

    // The supplier's typed lead time is NOT rewritten on completion — the learned
    // median is derived from this receipt history at read time and adopted only
    // by the owner's explicit "use learned" action (see file header).

    return {
      ok: true,
      status: allFull ? "received" : "partially_received",
      receivedUnits,
      stockFollowsStore,
    };
  });

  if (result.ok) {
    await prismaService.auditEvent.create({
      data: {
        tenantId,
        entity: "PurchaseOrder",
        entityId: poId,
        action: "received",
        actorUserId: actor?.userId ?? null,
        actorName: actor?.name ?? null,
        meta: {
          locationId,
          receivedUnits: result.receivedUnits,
          status: result.status,
          stockFollowsStore: result.stockFollowsStore,
        },
      },
    });
  }
  return result;
}
