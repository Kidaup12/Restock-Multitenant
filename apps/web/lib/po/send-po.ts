import { prismaForTenant, prismaService } from "@wezesha/db";
import { sendEmail } from "@/lib/email";
import { buildPoDocument } from "@/lib/po/po-model";
import { poEmailHtml, poEmailSubject, poEmailText } from "@/lib/po/po-email";

/**
 * "Email to supplier": render the PO document to an HTML + text email through
 * the sendEmail seam, then mark the PO sent. Send-then-mark ordering: a failed
 * send leaves the PO in draft (retryable); the worst retry case is a duplicate
 * email, never a "sent" PO the supplier never saw.
 */

const DAY_MS = 86_400_000;

export type SendPoResult =
  | { ok: true; expectedAt: Date | null }
  | { ok: false; reason: "not_found" | "not_sendable" | "no_supplier_email" };

export async function sendPoToSupplier(tenantId: string, poId: string): Promise<SendPoResult> {
  const db = prismaForTenant(tenantId);
  const [po, tenant] = await Promise.all([
    db.purchaseOrder.findFirst({
      where: { id: poId, deletedAt: null },
      select: {
        id: true,
        poNumber: true,
        status: true,
        createdAt: true,
        currency: true,
        subtotalKes: true,
        createdByName: true,
        supplier: {
          select: { name: true, email: true, country: true, leadTimeAvgDays: true },
        },
        lines: {
          select: { sku: true, title: true, quantity: true, unitCostKes: true, lineTotalKes: true },
          orderBy: { title: "asc" },
        },
      },
    }),
    db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
  ]);
  if (!po || !tenant) return { ok: false, reason: "not_found" };
  if (po.status !== "draft") return { ok: false, reason: "not_sendable" };
  if (!po.supplier?.email) return { ok: false, reason: "no_supplier_email" };

  const sentAt = new Date();
  // ETA only when a lead time is known (typed or learned) — never a guess.
  const lead = po.supplier.leadTimeAvgDays;
  const expectedAt = lead != null ? new Date(sentAt.getTime() + lead * DAY_MS) : null;

  const doc = buildPoDocument({ ...po, sentAt, expectedAt }, tenant.name);
  await sendEmail({
    to: po.supplier.email,
    subject: poEmailSubject(doc),
    text: poEmailText(doc),
    html: poEmailHtml(doc),
  });

  await db.purchaseOrder.update({
    where: { id: po.id },
    data: { status: "sent", sentAt, expectedAt },
  });
  // The linked queue rows inherit the ETA so "on the way" surfaces can show it.
  if (expectedAt) {
    await db.order.updateMany({
      where: { purchaseOrderId: po.id, status: "ordered" },
      data: { expectedArrivalAt: expectedAt },
    });
  }

  await prismaService.auditEvent.create({
    data: {
      tenantId,
      entity: "PurchaseOrder",
      entityId: po.id,
      action: "ordered",
      meta: { poNumber: po.poNumber, to: po.supplier.email, expectedAt },
    },
  });

  return { ok: true, expectedAt };
}
