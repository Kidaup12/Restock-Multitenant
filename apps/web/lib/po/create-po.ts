import { prismaForTenant, prismaForTenantTx, prismaService } from "@wezesha/db";
import { buildPoLines, subtotal, type LineInput } from "@/lib/po/po-math";
import { nextPoNumber } from "@/lib/po/po-number";

/**
 * Create one purchase order from a set of queued (pending) Order rows, all
 * belonging to one supplier. Everything financial happens in a single tenant
 * transaction; the PO number is issued under a per-tenant advisory lock so two
 * concurrent creates can never compute the same max+1.
 */

export type CreatePoResult =
  | { ok: true; poId: string; poNumber: string }
  | { ok: false; reason: "no_orders" | "mixed_suppliers" | "no_supplier" };

/** Thrown when the queue rows were claimed by another create (see below). */
class QueueClaimed extends Error {}

export async function createPoFromOrders(
  tenantId: string,
  orderIds: string[],
  actor?: { userId: string; name: string | null }
): Promise<CreatePoResult> {
  const db = prismaForTenant(tenantId);
  // Order.productId is a bare column (no FK) — resolve the products separately.
  const rows = await db.order.findMany({
    where: { id: { in: orderIds }, status: "pending", productId: { not: null } },
    select: { id: true, orderedQty: true, productId: true },
  });
  if (rows.length === 0) return { ok: false, reason: "no_orders" };

  const products = await db.product.findMany({
    where: { id: { in: rows.map((r) => r.productId!) } },
    select: {
      id: true,
      sku: true,
      title: true,
      costKes: true,
      currentStock: true,
      supplierId: true,
      supplier: { select: { id: true, name: true, moq: true } },
    },
  });
  const productById = new Map(products.map((p) => [p.id, p]));
  const orders = rows
    .map((r) => ({ ...r, product: productById.get(r.productId!) ?? null }))
    .filter((r) => r.product != null);
  if (orders.length === 0) return { ok: false, reason: "no_orders" };

  const supplierIds = new Set(orders.map((o) => o.product!.supplierId ?? null));
  if (supplierIds.size > 1) return { ok: false, reason: "mixed_suppliers" };
  const supplier = orders[0]!.product!.supplier ?? null;
  // A PO is addressed to somebody — queue rows for supplier-less products stay
  // in the queue until the product gets a supplier.
  if (!supplier) return { ok: false, reason: "no_supplier" };

  const inputs: LineInput[] = orders.map((o) => ({
    productId: o.product!.id,
    sku: o.product!.sku,
    title: o.product!.title,
    qty: o.orderedQty ?? 1,
    unitCostKes: o.product!.costKes,
  }));
  const lines = buildPoLines(inputs, supplier.moq);
  const stockByProduct = new Map(orders.map((o) => [o.product!.id, o.product!.currentStock]));

  const created = await prismaForTenantTx(tenantId, async (tx) => {
    // Serialise PO creation per tenant: max+1 numbering is race-free only when
    // no two transactions read the max concurrently. Released at commit.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`po-number:${tenantId}`}, 0))`;

    // Claim the queue rows here, not on the read above: that read committed
    // before this transaction opened, so two tabs submitting the same queue
    // both saw every row pending and both built a full PO — one of them a live,
    // sendable orphan the supplier would ship against a second time. Only the
    // create that still finds every row pending may proceed.
    const now = new Date();
    const claimed = await tx.order.updateMany({
      where: { id: { in: orders.map((o) => o.id) }, status: "pending" },
      data: { status: "ordered", orderedAt: now },
    });
    if (claimed.count !== orders.length) throw new QueueClaimed();

    const [existing, tenant] = await Promise.all([
      tx.purchaseOrder.findMany({ select: { poNumber: true } }),
      tx.tenant.findUnique({ where: { id: tenantId }, select: { poNumberFloor: true, currency: true } }),
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
        // The TENANT's currency, not the supplier's: every line is priced from
        // Product.costKes, which is held in the workspace's own currency. A
        // supplier who invoices in another one still needs converting, and
        // stamping their code here would send them a document whose numbers are
        // in one currency and whose label says another.
        currency: tenant?.currency ?? "KES",
        subtotalKes: subtotal(lines),
        createdByUserId: actor?.userId ?? null,
        createdByName: actor?.name ?? null,
        lines: { create: lines.map((l) => ({ tenantId, ...l })) },
      },
      select: { id: true, poNumber: true },
    });

    for (const order of orders) {
      await tx.order.update({
        where: { id: order.id },
        data: {
          purchaseOrderId: po.id,
          stockAtOrder: stockByProduct.get(order.product!.id) ?? null,
        },
      });
    }
    return po;
  }).catch((error: unknown) => {
    if (error instanceof QueueClaimed) return null;
    throw error;
  });
  // Rolled back with nothing created — the queue rows are already on someone
  // else's purchase order.
  if (!created) return { ok: false, reason: "no_orders" };

  // Audit trail rides on the service client so no tenant role can filter it.
  await prismaService.auditEvent.create({
    data: {
      tenantId,
      entity: "PurchaseOrder",
      entityId: created.id,
      action: "created",
      actorUserId: actor?.userId ?? null,
      actorName: actor?.name ?? null,
      meta: { poNumber: created.poNumber, supplier: supplier.name, lines: lines.length },
    },
  });

  return { ok: true, poId: created.id, poNumber: created.poNumber };
}
