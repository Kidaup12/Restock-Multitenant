import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { activeMembership, requireSession } from "@/lib/auth";
import { getPoDocument } from "@/lib/data/orders";
import { PoDocument } from "@/lib/po/po-document";
import { PrintButton } from "./print-button";

export const metadata: Metadata = {
  title: "Print purchase order",
};

/**
 * Printable PO. On print, everything but the document (shell chrome included)
 * is hidden via the visibility trick below — no layout changes needed, and the
 * browser's print-to-PDF turns this into the attachment-grade file.
 */
export default async function PoPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  if (!membership) notFound();

  const doc = await getPoDocument(membership.tenantId, id);
  if (!doc) notFound();

  return (
    <div className="space-y-4">
      <style>{`@media print {
        body * { visibility: hidden; }
        .po-print-area, .po-print-area * { visibility: visible; }
        .po-print-area { position: absolute; inset: 0; margin: 0; }
      }`}</style>
      <div className="flex items-center justify-between print:hidden">
        <Link
          href={`/orders/${id}`}
          className="text-sm font-medium text-accent-ink hover:underline"
        >
          ← Back to {doc.poNumber}
        </Link>
        <PrintButton />
      </div>
      <div className="po-print-area overflow-hidden rounded-lg border border-edge">
        <PoDocument doc={doc} />
      </div>
    </div>
  );
}
