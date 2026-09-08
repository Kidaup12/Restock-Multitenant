import { prismaForTenantTx, prismaService } from "@wezesha/db";
import { recomputeSellableStock } from "@/lib/inventory/sellable-rollup";

/**
 * Reversing a receipt, line by line.
 *
 * Receiving had no inverse. It writes `receivedQty`, moves `onHand` and
 * `available`, recomputes sellable stock, completes queue rows and advances the
 * PO — and a mis-keyed quantity was unrecoverable from the UI, leaving stock
 * silently wrong on every screen that reads it, which is most of them.
 *
 * This is a CORRECTION, not an event replay. The audit ledger records a
 * receipt's total units and its location, never a per-line breakdown, so "undo
 * the last receipt" cannot be reconstructed from what is stored. Asking which
 * lines and how many is therefore the honest shape: the caller states what was
 * over-booked, and this reverses exactly that.
 *
 * Every rule the forward path applies is mirrored here rather than restated:
 * the same advisory lock (so a receipt and a reversal can never interleave), the
 * same store-owns-the-shelf test, and the same COALESCE handling of a null
 * `available`. Where the sync owns the location the forward path wrote no stock,
 * so neither does this — reversing a movement that never happened would invent
 * a shortage.
 *
 * On-hand is allowed to go negative. If phantom units were sold before the
 * mistake was noticed they cannot be unsold, and a shelf that is genuinely short
 * should say so — "Oversold" is a state this product already names and surfaces.
 * Clamping at zero would hide a real discrepancy behind a tidier number.
 */

export type UnreceiveEntry = { lineId: string; qty: number };

export type UnreceivePoResult =
  | {
      ok: true;
      status: string;
      reversedUnits: number;
      /** True when the shelf figure is the store's, so no stock was moved back —
       *  the screen says so rather than implying the shelf changed. */
      stockFollowsStore: boolean;
    }
  | {
      ok: false;
      reason: "not_found" | "not_reversible" | "bad_location" | "bad_line" | "bad_qty" | "empty";
    };

export async function unreceivePoLines(
  tenantId: string,
  poId: string,
  entries: UnreceiveEntry[],
  locationId: string,
  actor?: { userId: string; name: string | null }
): Promise<UnreceivePoResult> {
  const reversals = entries.filter((e) => e.qty > 0);
  if (reversals.length === 0) return { ok: false, reason: "empty" };

  const result = await prismaForTenantTx(tenantId, async (tx): Promise<UnreceivePoResult> => {
    // The SAME key the receipt takes. A reversal racing a receipt on one PO
    // would otherwise both read the same receivedQty and write conflicting
    // absolutes, which is the failure the receive path documents.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`po-receive:${poId}`}, 0))`;

    const po = await tx.purchaseOrder.findFirst({
      where: { id: poId, deletedAt: null },
      select: {
        id: true,
        status: true,
        lines: { select: { id: true, productId: true, quantity: true, receivedQty: true } },
      },
    });
    if (!po) return { ok: false, reason: "not_found" };
    if (po.status !== "received" && po.status !== "partially_received") {
      return { ok: false, reason: "not_reversible" };
    }

    const location = await tx.location.findFirst({
      where: { id: locationId },
      select: { id: true, shopifyLocationId: true },
    });
    if (!location) return { ok: false, reason: "bad_location" };
    const stockFollowsStore = location.shopifyLocationId !== null;

    const lineById = new Map(po.lines.map((l) => [l.id, l]));
    for (const entry of reversals) {
      const line = lineById.get(entry.lineId);
      if (!line) return { ok: false, reason: "bad_line" };
      if (!Number.isInteger(entry.qty)) return { ok: false, reason: "bad_qty" };
      // Cannot un-receive more than went in: the result would be a negative
      // received quantity, which no screen can mean anything by.
      if (entry.qty > line.receivedQty) return { ok: false, reason: "bad_qty" };
    }

    let reversedUnits = 0;
    const droppedBelowFull: string[] = [];

    for (const entry of reversals) {
      const line = lineById.get(entry.lineId)!;
      const wasFull = line.receivedQty >= line.quantity;
      const nextQty = line.receivedQty - entry.qty;
      await tx.purchaseOrderLine.update({
        where: { id: line.id },
        // Back to "never received" when nothing is left booked in, so the line
        // does not keep a timestamp for a receipt that no longer exists.
        data: { receivedQty: nextQty, receivedAt: nextQty === 0 ? null : new Date() },
      });
      line.receivedQty = nextQty;
      reversedUnits += entry.qty;
      if (wasFull && nextQty < line.quantity) droppedBelowFull.push(line.productId);

      if (stockFollowsStore) continue;

      await tx.inventoryLevel.updateMany({
        where: { locationId, productId: line.productId },
        data: { onHand: { decrement: entry.qty } },
      });
      // onHand no longer includes this receipt, so the NULL branch resolves to
      // the pre-reversal on-hand — the mirror of the forward statement.
      await tx.$executeRaw`
        UPDATE "InventoryLevel"
           SET "available" = COALESCE("available", "onHand" + ${entry.qty}) - ${entry.qty}
         WHERE "locationId" = ${locationId} AND "productId" = ${line.productId}`;
    }

    const touched = stockFollowsStore
      ? []
      : [...new Set(reversals.map((e) => lineById.get(e.lineId)!.productId))];
    await recomputeSellableStock(tx, touched);

    // A queue row that completed on a full line goes back to outstanding, or the
    // product silently drops off the buy list while its units are not on a shelf.
    if (droppedBelowFull.length > 0) {
      await tx.order.updateMany({
        where: {
          purchaseOrderId: po.id,
          status: "completed",
          productId: { in: droppedBelowFull },
        },
        data: { status: "ordered", receivedAt: null },
      });
    }

    // Recomputed from the lines rather than stepped back from the old status:
    // the status is a function of what is booked in, and deriving it is the only
    // way a partial reversal of a partial receipt lands correctly.
    const nothingIn = po.lines.every((l) => l.receivedQty === 0);
    const allFull = po.lines.every((l) => l.receivedQty >= l.quantity);
    const status = nothingIn ? "sent" : allFull ? "received" : "partially_received";
    await tx.purchaseOrder.update({
      where: { id: po.id },
      data: { status, receivedAt: allFull ? new Date() : null },
    });

    return { ok: true, status, reversedUnits, stockFollowsStore };
  });

  if (result.ok) {
    // Its own ledger entry, never a quiet edit of the receipt's. The trail has to
    // show that units were booked in and then taken back out, and by whom.
    await prismaService.auditEvent.create({
      data: {
        tenantId,
        entity: "PurchaseOrder",
        entityId: poId,
        action: "receipt_reversed",
        actorUserId: actor?.userId ?? null,
        actorName: actor?.name ?? null,
        meta: {
          locationId,
          reversedUnits: result.reversedUnits,
          status: result.status,
          stockFollowsStore: result.stockFollowsStore,
        },
      },
    });
  }
  return result;
}
