import { prismaForTenantTx, prismaService } from "@wezesha/db";

/**
 * Cancel a draft or sent PO that won't be fulfilled. The linked queue rows go
 * back to pending — the demand didn't disappear with the paperwork, so the
 * products return to the order queue instead of silently dropping out.
 * Accounting-grade: the PO row survives as status "cancelled" with who/when.
 */

export type CancelPoResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "not_cancellable" };

export async function cancelPo(
  tenantId: string,
  poId: string,
  actor?: { userId: string; name: string | null }
): Promise<CancelPoResult> {
  const result = await prismaForTenantTx(tenantId, async (tx): Promise<CancelPoResult> => {
    const po = await tx.purchaseOrder.findFirst({
      where: { id: poId, deletedAt: null },
      select: { id: true, poNumber: true, status: true },
    });
    if (!po) return { ok: false, reason: "not_found" };
    // Anything with stock already checked in stays on the books.
    if (po.status !== "draft" && po.status !== "sent") {
      return { ok: false, reason: "not_cancellable" };
    }

    await tx.order.updateMany({
      where: { purchaseOrderId: po.id, status: "ordered" },
      data: { status: "pending", purchaseOrderId: null, orderedAt: null, expectedArrivalAt: null },
    });
    await tx.purchaseOrder.update({
      where: { id: po.id },
      data: { status: "cancelled", cancelledAt: new Date(), cancelledByName: actor?.name ?? null },
    });
    return { ok: true };
  });

  if (result.ok) {
    await prismaService.auditEvent.create({
      data: {
        tenantId,
        entity: "PurchaseOrder",
        entityId: poId,
        action: "cancelled",
        actorUserId: actor?.userId ?? null,
        actorName: actor?.name ?? null,
      },
    });
  }
  return result;
}
