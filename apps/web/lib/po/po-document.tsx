import { poAmount, poDate, type PoDocumentData } from "@/lib/po/po-model";

/**
 * The purchase order as a clean, printable document: shop header, supplier
 * block, lines, totals, terms. Styled self-contained (no shell chrome) so the
 * print route can isolate it with @media print.
 *
 * PDF note: the supplier's copy goes out as a real PDF attachment, generated
 * server-side in lib/po/po-pdf.ts — this view is the screen and print surface
 * for the shop, not the supplier's document. Both render the same
 * PoDocumentData, which is what keeps a second layout from becoming a second
 * set of numbers; tests/po-pdf.test.tsx compares the two renderings cell by
 * cell. Changing a figure here means changing it there.
 */
export function PoDocument({ doc }: { doc: PoDocumentData }) {
  return (
    <div className="mx-auto max-w-3xl bg-white p-8 text-neutral-900">
      <div className="flex items-start justify-between border-b border-neutral-300 pb-6">
        <div>
          <p className="text-xl font-bold">{doc.shop.name}</p>
          <p className="mt-1 text-sm text-neutral-600">Purchase order</p>
        </div>
        <div className="text-right">
          <p className="text-lg font-bold">{doc.poNumber}</p>
          <p className="mt-1 text-sm text-neutral-600">{poDate(doc.sentAt ?? doc.createdAt)}</p>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-6 text-sm">
        <div>
          <p className="font-semibold uppercase tracking-wide text-neutral-500">Supplier</p>
          <p className="mt-1 font-medium">{doc.supplier?.name ?? "—"}</p>
          {doc.supplier?.email && <p className="text-neutral-600">{doc.supplier.email}</p>}
          {doc.supplier?.country && <p className="text-neutral-600">{doc.supplier.country}</p>}
        </div>
        <div className="text-right">
          <p className="font-semibold uppercase tracking-wide text-neutral-500">Delivery</p>
          <p className="mt-1 text-neutral-600">
            {doc.expectedAt ? `Expected by ${poDate(doc.expectedAt)}` : "Expected date to be confirmed"}
          </p>
          {doc.createdByName && <p className="text-neutral-600">Raised by {doc.createdByName}</p>}
        </div>
      </div>

      <table className="mt-8 w-full border-collapse text-sm">
        <thead>
          <tr className="border-b-2 border-neutral-800 text-left">
            <th className="py-2 pr-3 font-semibold">SKU</th>
            <th className="py-2 pr-3 font-semibold">Item</th>
            <th className="py-2 pr-3 text-right font-semibold">Qty</th>
            <th className="py-2 pr-3 text-right font-semibold">Unit cost ({doc.currency})</th>
            <th className="py-2 text-right font-semibold">Total ({doc.currency})</th>
          </tr>
        </thead>
        <tbody>
          {doc.lines.map((line) => (
            <tr key={line.sku} className="border-b border-neutral-200">
              <td className="py-2 pr-3 font-mono text-xs">{line.sku}</td>
              <td className="py-2 pr-3">{line.title}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{line.quantity}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{poAmount(line.unitCostKes)}</td>
              <td className="py-2 text-right tabular-nums">{poAmount(line.lineTotalKes)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={2} className="pt-3 font-semibold">
              {doc.lines.length} line{doc.lines.length === 1 ? "" : "s"} · {doc.totalUnits} units
            </td>
            <td colSpan={2} className="pt-3 text-right font-semibold">
              Total ({doc.currency})
            </td>
            <td className="pt-3 text-right text-base font-bold tabular-nums">
              {poAmount(doc.subtotalKes)}
            </td>
          </tr>
        </tfoot>
      </table>

      <p className="mt-10 border-t border-neutral-300 pt-4 text-xs text-neutral-500">
        Please confirm receipt of this order and the expected delivery date. Quote {doc.poNumber} on
        all correspondence, delivery notes and invoices.
      </p>
    </div>
  );
}
