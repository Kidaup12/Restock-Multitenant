import { prismaForTenant, prismaForTenantTx, prismaService } from "@wezesha/db";
import { buildPoLines, subtotal, type LineInput } from "@/lib/po/po-math";
import { nextPoNumber } from "@/lib/po/po-number";

/**
 * Ordering something the forecast never asked for.
 *
 * Every purchase order had to come from the queue, so a one-off buy — a new
 * line, a customer request, a supplier deal — could not be placed through the
 * app at all. The shop's only options were to order outside the system, which
 * leaves stock and cover wrong, or not to order.
 *
 * **It writes queue rows as well as PO lines, and that is the point.** The buy
 * list holds a product back as "already-ordered" on the strength of an open
 * `Order` row, not a PO line (see lib/data/plan.ts). A manual order that wrote
 * only lines would leave its products on the buy list, the forecast would ask
 * for them again next run, and the shop would order twice. Writing the queue
 * rows also makes a manual order behave exactly like a queued one everywhere
 * downstream: receiving completes them, cancelling returns them, and removing a
 * line puts that one back.
 *
 * **Cost is checked here because nothing upstream does it.** The queue path
 * inherits the plan's `unplannable` gate, which keeps a product with a missing
 * or broken cost off the buy list entirely, so `createPoFromOrders` can copy
 * `costKes` unconditionally. This path has no such gate: a zero-cost line would
 * quietly price a real order at nothing.
 *
 * **Every product must belong to the supplier being ordered from.** A line sent
 * to a supplier who does not sell it is a document they cannot fill — and the
 * delivery would then score against a supplier who never had the order, which
 * is what on-time and fill-rate are built from.
 */

export type ManualPoItem = { productId: string; qty: number };

export type CreateManualPoResult =
  | { ok: true; poId: string; poNumber: string; lineCount: number; subtotalKes: number }
  | {
      ok: false;
      reason: "no_items" | "bad_qty" | "no_supplier" | "wrong_supplier" | "no_product" | "no_cost";
    };

export async function createManualPo(
  tenantId: string,
  supplierId: string,
  items: ManualPoItem[],
  actor?: { userId: string; name: string | null }
): Promise<CreateManualPoResult> {
  const wanted = items.filter((i) => i.qty > 0);
  if (wanted.length === 0) return { ok: false, reason: "no_items" };
  if (wanted.some((i) => !Number.isInteger(i.qty))) return { ok: false, reason: "bad_qty" };

  const db = prismaForTenant(tenantId);
  const supplier = await db.supplier.findFirst({
    where: { id: supplierId },
    select: { id: true, moq: true },
  });
  if (!supplier) return { ok: false, reason: "no_supplier" };

  const products = await db.product.findMany({
    where: { id: { in: wanted.map((i) => i.productId) } },
    // Prices the order server-side and returns no cost to any client: the
    // action hands back only a PO number and a message. Redacting here would
    // price a real supplier order at nothing for a money-blind member.
    // eslint-disable-next-line cost-visibility/require-cost-gate -- see above
    select: { id: true, sku: true, title: true, costKes: true, currentStock: true, supplierId: true },
  });
  const byId = new Map(products.map((p) => [p.id, p]));
  if (products.length !== new Set(wanted.map((i) => i.productId)).size) {
    return { ok: false, reason: "no_product" };
  }
  if (products.some((p) => p.supplierId !== supplierId)) {
    return { ok: false, reason: "wrong_supplier" };
  }
  if (products.some((p) => !(p.costKes > 0))) return { ok: false, reason: "no_cost" };

  const inputs: LineInput[] = wanted.map((i) => {
    const p = byId.get(i.productId)!;
    return { productId: p.id, sku: p.sku, title: p.title, qty: i.qty, unitCostKes: p.costKes };
  });
  const lines = buildPoLines(inputs, supplier.moq);
  const subtotalKes = subtotal(lines);

  const created = await prismaForTenantTx(tenantId, async (tx) => {
    // The same per-tenant lock the queued path takes: max+1 numbering is
    // race-free only while no two transactions read the max at once.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`po-number:${tenantId}`}, 0))`;

    const [existing, tenant] = await Promise.all([
      tx.purchaseOrder.findMany({ select: { poNumber: true } }),
      tx.tenant.findUnique({
        where: { id: tenantId },
        select: { poNumberFloor: true, currency: true },
      }),
    ]);
    const poNumber = nextPoNumber(
      existing.map((r) => r.poNumber),
      tenant?.poNumberFloor ?? 0
    );

    const po = await tx.purchaseOrder.create({
      data: {
        tenantId,
        supplierId: supplier.id,
        poNumber,
        status: "draft",
        // The tenant's currency, not the supplier's — every line is priced from
        // Product.costKes, which is held in the workspace's own currency.
        currency: tenant?.currency ?? "KES",
        subtotalKes,
        createdByUserId: actor?.userId ?? null,
        createdByName: actor?.name ?? null,
        lines: { create: lines.map((l) => ({ tenantId, ...l })) },
      },
      select: { id: true, poNumber: true },
    });

    // The queue rows this order counts as. Without them the buy list would ask
    // for these products again on the next run — see the file header.
    for (const line of lines) {
      await tx.order.create({
        data: {
          tenantId,
          productId: line.productId,
          status: "ordered",
          purchaseOrderId: po.id,
          orderedQty: line.quantity,
          orderedAt: new Date(),
          stockAtOrder: byId.get(line.productId)?.currentStock ?? null,
          source: "app",
        },
      });
    }

    return po;
  });

  await prismaService.auditEvent.create({
    data: {
      tenantId,
      entity: "PurchaseOrder",
      entityId: created.id,
      action: "created",
      actorUserId: actor?.userId ?? null,
      actorName: actor?.name ?? null,
      // Marked as hand-built so the trail distinguishes an order the shop chose
      // to place from one the forecast proposed.
      meta: { poNumber: created.poNumber, lines: lines.length, manual: true },
    },
  });

  return {
    ok: true,
    poId: created.id,
    poNumber: created.poNumber,
    lineCount: lines.length,
    subtotalKes,
  };
}
