import { prismaForTenantTx, prismaService } from "@wezesha/db";
import { subtotal } from "@/lib/po/po-math";

/**
 * Changing a draft purchase order's lines.
 *
 * A draft built from the queue used to be immutable: the only quantity lever was
 * the MOQ floor, and the only remedy for a wrong number was to cancel the order
 * and rebuild it. Every quantity that reached a supplier was one the engine
 * sized, whether or not the owner agreed with it.
 *
 * **Drafts only, deliberately.** Once a PO is sent, the supplier is holding a
 * document with those numbers on it. Editing the line afterwards would leave our
 * record disagreeing with the one the supplier is picking from, silently, and
 * the receiving screen would then check deliveries against a quantity nobody
 * outside this system ever saw. A sent order is changed by talking to the
 * supplier — and cancelling, which already returns its items to the queue.
 *
 * `recommendedQty` is never rewritten. It records what the model asked for
 * BEFORE anyone intervened, which is the whole basis of measuring
 * recommended-versus-actual later; overwriting it with the owner's number would
 * erase the disagreement being measured.
 *
 * The final write is status-guarded (`updateMany ... where status = "draft"`)
 * rather than merely status-checked at the top. Sending claims the row with its
 * own guarded update and takes no lock, so a read-then-write here could edit a
 * PO that became "sent" mid-transaction. Nothing affected means the draft is
 * gone, and the whole transaction rolls back.
 */

export type EditPoLinesResult =
  | { ok: true; lineCount: number; subtotalKes: number }
  | {
      ok: false;
      reason: "not_found" | "not_editable" | "bad_line" | "bad_qty" | "last_line";
    };

/** Thrown to roll the transaction back when the draft was sent underneath us. */
const NO_LONGER_DRAFT = "po-no-longer-draft";

type LineRow = { id: string; quantity: number; unitCostKes: number; productId: string };

async function rewriteSubtotal(
  tx: Parameters<Parameters<typeof prismaForTenantTx>[1]>[0],
  poId: string,
  lines: Pick<LineRow, "quantity" | "unitCostKes">[]
): Promise<number> {
  const subtotalKes = subtotal(
    lines.map((l) => ({ lineTotalKes: l.quantity * l.unitCostKes }))
  );
  const touched = await tx.purchaseOrder.updateMany({
    where: { id: poId, status: "draft" },
    data: { subtotalKes },
  });
  if (touched.count === 0) throw new Error(NO_LONGER_DRAFT);
  return subtotalKes;
}

/** Set one draft line's quantity, re-pricing the line and the order. */
export async function setPoLineQuantity(
  tenantId: string,
  poId: string,
  lineId: string,
  quantity: number,
  actor?: { userId: string; name: string | null }
): Promise<EditPoLinesResult> {
  if (!Number.isInteger(quantity) || quantity < 1) return { ok: false, reason: "bad_qty" };

  let previous = 0;
  try {
    const result = await prismaForTenantTx(tenantId, async (tx): Promise<EditPoLinesResult> => {
      const po = await tx.purchaseOrder.findFirst({
        where: { id: poId, deletedAt: null },
        select: {
          status: true,
          lines: { select: { id: true, quantity: true, unitCostKes: true, productId: true } },
        },
      });
      if (!po) return { ok: false, reason: "not_found" };
      if (po.status !== "draft") return { ok: false, reason: "not_editable" };

      const line = po.lines.find((l) => l.id === lineId);
      if (!line) return { ok: false, reason: "bad_line" };
      previous = line.quantity;

      await tx.purchaseOrderLine.update({
        where: { id: line.id },
        // recommendedQty deliberately untouched — see the file header.
        data: { quantity, lineTotalKes: quantity * line.unitCostKes },
      });

      const next = po.lines.map((l) => (l.id === lineId ? { ...l, quantity } : l));
      const subtotalKes = await rewriteSubtotal(tx, poId, next);
      return { ok: true, lineCount: next.length, subtotalKes };
    });

    if (result.ok) {
      await prismaService.auditEvent.create({
        data: {
          tenantId,
          entity: "PurchaseOrder",
          entityId: poId,
          action: "po_line_quantity_changed",
          actorUserId: actor?.userId ?? null,
          actorName: actor?.name ?? null,
          meta: { lineId, from: previous, to: quantity, subtotalKes: result.subtotalKes },
        },
      });
    }
    return result;
  } catch (err) {
    if (err instanceof Error && err.message === NO_LONGER_DRAFT) {
      return { ok: false, reason: "not_editable" };
    }
    throw err;
  }
}

/**
 * Drop a line from a draft, returning its queued items to the buy list.
 *
 * The queue rows go back to "pending" exactly as cancelling the whole order
 * does. A line removed without that leaves its product counted as already on
 * the way — off the buy list, and on no order anyone will ever receive.
 */
export async function removePoLine(
  tenantId: string,
  poId: string,
  lineId: string,
  actor?: { userId: string; name: string | null }
): Promise<EditPoLinesResult> {
  try {
    const result = await prismaForTenantTx(tenantId, async (tx): Promise<EditPoLinesResult> => {
      const po = await tx.purchaseOrder.findFirst({
        where: { id: poId, deletedAt: null },
        select: {
          status: true,
          lines: { select: { id: true, quantity: true, unitCostKes: true, productId: true } },
        },
      });
      if (!po) return { ok: false, reason: "not_found" };
      if (po.status !== "draft") return { ok: false, reason: "not_editable" };

      const line = po.lines.find((l) => l.id === lineId);
      if (!line) return { ok: false, reason: "bad_line" };
      // An order with no lines is not an order. Cancelling says what actually
      // happened and already puts every item back; a zero-line draft would sit
      // in the list meaning nothing.
      if (po.lines.length === 1) return { ok: false, reason: "last_line" };

      await tx.purchaseOrderLine.delete({ where: { id: line.id } });
      await tx.order.updateMany({
        where: { purchaseOrderId: poId, productId: line.productId, status: "ordered" },
        data: { status: "pending", purchaseOrderId: null, orderedAt: null, expectedArrivalAt: null },
      });

      const next = po.lines.filter((l) => l.id !== lineId);
      const subtotalKes = await rewriteSubtotal(tx, poId, next);
      return { ok: true, lineCount: next.length, subtotalKes };
    });

    if (result.ok) {
      await prismaService.auditEvent.create({
        data: {
          tenantId,
          entity: "PurchaseOrder",
          entityId: poId,
          action: "po_line_removed",
          actorUserId: actor?.userId ?? null,
          actorName: actor?.name ?? null,
          meta: { lineId, linesLeft: result.lineCount, subtotalKes: result.subtotalKes },
        },
      });
    }
    return result;
  } catch (err) {
    if (err instanceof Error && err.message === NO_LONGER_DRAFT) {
      return { ok: false, reason: "not_editable" };
    }
    throw err;
  }
}
