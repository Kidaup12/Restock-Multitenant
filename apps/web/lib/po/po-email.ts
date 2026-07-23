import { poAmount, poDate, type PoDocumentData } from "@/lib/po/po-model";

/**
 * The PO document rendered for email: a simple table-based HTML body plus a
 * plain-text fallback. Same PoDocumentData as the printable view, so both
 * always show identical numbers. Inline styles only — email clients strip
 * stylesheets.
 */

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const cell = "padding:6px 10px;border-bottom:1px solid #ddd;";
const num = `${cell}text-align:right;font-variant-numeric:tabular-nums;`;

export function poEmailSubject(doc: PoDocumentData): string {
  return `Purchase order ${doc.poNumber} from ${doc.shop.name}`;
}

export function poEmailHtml(doc: PoDocumentData): string {
  const rows = doc.lines
    .map(
      (l) => `<tr>
  <td style="${cell}font-family:monospace;font-size:12px;">${esc(l.sku)}</td>
  <td style="${cell}">${esc(l.title)}</td>
  <td style="${num}">${l.quantity}</td>
  <td style="${num}">${poAmount(l.unitCostKes)}</td>
  <td style="${num}">${poAmount(l.lineTotalKes)}</td>
</tr>`
    )
    .join("\n");

  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#1c2030;max-width:640px;">
<h2 style="margin:0;">${esc(doc.shop.name)}</h2>
<p style="margin:4px 0 16px;color:#555;">Purchase order <strong>${esc(doc.poNumber)}</strong> · ${poDate(doc.sentAt ?? doc.createdAt)}</p>
<p>Dear ${esc(doc.supplier?.name ?? "Supplier")},</p>
<p>Please supply the items below.${doc.expectedAt ? ` Expected delivery by <strong>${poDate(doc.expectedAt)}</strong>.` : ""}</p>
<table style="border-collapse:collapse;width:100%;font-size:14px;">
<thead>
<tr>
  <th style="${cell}text-align:left;">SKU</th>
  <th style="${cell}text-align:left;">Item</th>
  <th style="${num}">Qty</th>
  <th style="${num}">Unit cost (${esc(doc.currency)})</th>
  <th style="${num}">Total (${esc(doc.currency)})</th>
</tr>
</thead>
<tbody>
${rows}
</tbody>
<tfoot>
<tr>
  <td colspan="2" style="padding:8px 10px;font-weight:bold;">${doc.lines.length} line${doc.lines.length === 1 ? "" : "s"} · ${doc.totalUnits} units</td>
  <td colspan="2" style="padding:8px 10px;text-align:right;font-weight:bold;">Total (${esc(doc.currency)})</td>
  <td style="padding:8px 10px;text-align:right;font-weight:bold;">${poAmount(doc.subtotalKes)}</td>
</tr>
</tfoot>
</table>
<p style="margin-top:16px;">Please confirm receipt of this order and the expected delivery date. Quote ${esc(doc.poNumber)} on all correspondence, delivery notes and invoices.</p>
<p style="color:#555;">${esc(doc.shop.name)}${doc.createdByName ? ` · ${esc(doc.createdByName)}` : ""}</p>
</div>`;
}

export function poEmailText(doc: PoDocumentData): string {
  const lines = doc.lines
    .map(
      (l) =>
        `  ${l.sku}  ${l.title}  x${l.quantity}  @ ${poAmount(l.unitCostKes)} ${doc.currency}  = ${poAmount(l.lineTotalKes)} ${doc.currency}`
    )
    .join("\n");
  return [
    `Purchase order ${doc.poNumber} from ${doc.shop.name}`,
    `Date: ${poDate(doc.sentAt ?? doc.createdAt)}`,
    doc.expectedAt ? `Expected delivery by ${poDate(doc.expectedAt)}` : null,
    "",
    `Dear ${doc.supplier?.name ?? "Supplier"},`,
    "",
    "Please supply the items below:",
    "",
    lines,
    "",
    `${doc.lines.length} line${doc.lines.length === 1 ? "" : "s"} · ${doc.totalUnits} units · Total ${poAmount(doc.subtotalKes)} ${doc.currency}`,
    "",
    `Please confirm receipt of this order and the expected delivery date. Quote ${doc.poNumber} on all correspondence, delivery notes and invoices.`,
    "",
    `${doc.shop.name}${doc.createdByName ? ` · ${doc.createdByName}` : ""}`,
  ]
    .filter((l): l is string => l !== null)
    .join("\n");
}
