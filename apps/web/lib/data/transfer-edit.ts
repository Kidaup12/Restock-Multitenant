import { prismaForTenantTx, roleOf, isSellable, sellableUnits } from "@wezesha/db";

class TransferEditError extends Error {}

/** Editing a draft changes the picking instruction, never inventory. The plan
 * row lock serializes edits to different destinations for the same product. */
export async function editTransferQuantity(tenantId: string, input: { planId: string; lineId: string; qty: number }): Promise<{ ok: true; previousQty: number } | { ok: false; error: string }> {
  if (!Number.isSafeInteger(input.qty) || input.qty < 0 || input.qty > 2147483647) return { ok: false, error: "Enter a whole quantity of zero or more." };
  try {
    return await prismaForTenantTx(tenantId, async tx => {
      const locked = await tx.distributionPlan.updateMany({ where: { id: input.planId, tenantId, status: "draft", deletedAt: null }, data: { updatedAt: new Date() } });
      if (!locked.count) throw new TransferEditError("Only a current draft can be edited.");
      const plan = await tx.distributionPlan.findFirst({ where: { id: input.planId, tenantId }, include: { fromLocation: true } });
      const line = await tx.distributionPlanLine.findFirst({ where: { id: input.lineId, planId: input.planId, tenantId }, include: { toLocation: true } });
      if (!plan || !line) throw new TransferEditError("That line is not in this plan.");
      if (!["holds", "sells"].includes(roleOf(plan.fromLocation)) || !isSellable(line.toLocation) || line.toLocationId === plan.fromLocationId) throw new TransferEditError("Confirm the source and branch location roles before editing.");
      const [level, siblings] = await Promise.all([
        tx.inventoryLevel.findFirst({ where: { tenantId, productId: line.productId, locationId: plan.fromLocationId }, select: { available: true, onHand: true } }),
        tx.distributionPlanLine.aggregate({ where: { tenantId, planId: input.planId, productId: line.productId, id: { not: line.id } }, _sum: { qty: true } }),
      ]);
      const available = Math.max(0, Math.floor(level ? sellableUnits(level) : 0));
      const otherUnits = siblings._sum.qty ?? 0;
      // Zero is always allowed so a stale draft can be reduced safely one line at a time.
      if (input.qty > 0 && input.qty + otherUnits > available) throw new TransferEditError(`Only ${available} units are available at the source; ${otherUnits} are already assigned to other branches in this plan.`);
      await tx.distributionPlanLine.update({ where: { id: line.id }, data: { qty: input.qty, toDaysCoverAfter: line.toRunRate > 0 ? (line.toOnHand + input.qty) / line.toRunRate : null } });
      return { ok: true as const, previousQty: line.qty };
    });
  } catch (error) {
    if (error instanceof TransferEditError) return { ok: false, error: error.message };
    throw error;
  }
}
