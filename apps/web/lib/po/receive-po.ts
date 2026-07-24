import { prismaForTenantTx, prismaService } from "@wezesha/db";

/**
 * Line-by-line receiving with partial quantities. One tenant transaction:
 * line receivedQty/receivedAt, stock into the chosen location, product
 * currentStock recomputed from level sums, linked queue rows completed, PO
 * status advanced.
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
  | { ok: true; status: string; receivedUnits: number }
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
      select: { id: true },
    });
    if (!location) return { ok: false, reason: "bad_location" };

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
      await tx.inventoryLevel.upsert({
        where: { locationId_productId: { locationId, productId: line.productId } },
        create: { tenantId, locationId, productId: line.productId, onHand: entry.qty },
        update: { onHand: { increment: entry.qty } },
      });
      line.receivedQty = nextQty;
      receivedUnits += entry.qty;
      if (nextQty >= line.quantity) fullyReceivedProducts.push(line.productId);
    }

    // currentStock is defined as the sum of the product's level rows — recompute
    // from that source of truth rather than incrementing a second counter.
    const touched = [...new Set(receipts.map((e) => lineById.get(e.lineId)!.productId))];
    for (const productId of touched) {
      const sum = await tx.inventoryLevel.aggregate({
        where: { productId },
        _sum: { onHand: true },
      });
      await tx.product.update({
        where: { id: productId },
        data: { currentStock: sum._sum.onHand ?? 0 },
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

    return { ok: true, status: allFull ? "received" : "partially_received", receivedUnits };
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
        meta: { locationId, receivedUnits: result.receivedUnits, status: result.status },
      },
    });
  }
  return result;
}
