import { prismaForTenant, prismaService } from "@wezesha/db";
import { sendEmail, type EmailOutcome } from "@/lib/email";
import { buildPoDocument } from "@/lib/po/po-model";
import { poEmailHtml, poEmailSubject, poEmailText } from "@/lib/po/po-email";
import { poPdfBytes, poPdfFilename } from "@/lib/po/po-pdf";

/**
 * "Email to supplier": render the PO document to an HTML + text email with the
 * order attached as a PDF, send it through the sendEmail seam, and mark the PO
 * sent. A failed send leaves the PO in draft (retryable); the worst retry case
 * is a duplicate email, never a "sent" PO the supplier never saw.
 *
 * `emailed` carries the seam's own answer rather than inferring one from the
 * absence of an exception. Where the console fallback is live the send is
 * skipped, not failed — the PO is legitimately marked sent, but the supplier has
 * not been told, and only the caller saying so out loud keeps that honest.
 */

const DAY_MS = 86_400_000;

export type SendPoResult =
  | { ok: true; expectedAt: Date | null; emailed: boolean }
  | { ok: false; reason: "not_found" | "not_sendable" | "no_supplier_email" };

export async function sendPoToSupplier(
  tenantId: string,
  poId: string,
  actor?: { userId: string; name: string | null }
): Promise<SendPoResult> {
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

  // The supplier is quoting against these figures — the send action is what
  // authorises the costs to leave the building, not the viewing member — so the
  // supplier-facing document always carries them.
  const doc = buildPoDocument({ ...po, sentAt, expectedAt }, tenant.name, { canViewCosts: true });
  // Render the attachment before the claim below, not after it. Generation is
  // the one step here that does real work on data nobody validated (line count,
  // odd titles); after the claim, a failure would depend on the rollback also
  // landing to avoid a PO marked sent with nothing delivered. Before it, there
  // is nothing to roll back — the row is untouched and still draft.
  const pdf = await poPdfBytes(doc);

  // Claim the PO BEFORE the email goes out. Read-then-send-then-mark let two
  // admins, two tabs or a double-click each read "draft" and each email the
  // supplier — one real order placed twice, with a single PO showing as sent.
  // The status guard makes the claim the race: exactly one caller updates a row
  // still in draft, and only that caller sends.
  const claim = await db.purchaseOrder.updateMany({
    where: { id: po.id, status: "draft", deletedAt: null },
    data: { status: "sent", sentAt, expectedAt },
  });
  if (claim.count === 0) return { ok: false, reason: "not_sendable" };

  let outcome: EmailOutcome;
  try {
    outcome = await sendEmail({
      to: po.supplier.email,
      subject: poEmailSubject(doc),
      text: poEmailText(doc),
      html: poEmailHtml(doc),
      attachments: [{ filename: poPdfFilename(doc), content: pdf }],
      tenantId,
      kind: "purchase_order",
      purchaseOrderId: po.id,
    });
  } catch (err) {
    // Hand the claim back so the owner can retry, rather than leaving a PO that
    // says "sent" to a supplier who never heard from us.
    await db.purchaseOrder.updateMany({
      where: { id: po.id, status: "sent" },
      data: { status: "draft", sentAt: null, expectedAt: null },
    });
    throw err;
  }
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
      actorUserId: actor?.userId ?? null,
      actorName: actor?.name ?? null,
      meta: { poNumber: po.poNumber, to: po.supplier.email, expectedAt },
    },
  });

  return { ok: true, expectedAt, emailed: outcome === "sent" };
}
