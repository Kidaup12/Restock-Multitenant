import { rowsToCsv, type CellValue } from "@/lib/export/csv";
import { type PoDocumentData } from "@/lib/po/po-model";

/**
 * Purchase-order CSV exports. Pure string builders (no DOM, no db) so they test
 * directly; the route wraps the string in a download response. Both formats read
 * the same PoDocumentData every other PO renderer consumes (lib/po/po-document.tsx,
 * lib/po/po-pdf.ts), so a CSV can never show a figure the printed order doesn't.
 * Two formats:
 *   - QuickBooks: matches the common QBO Purchase-Order import template (SaasAnt /
 *     Transaction Pro column set). One row per line item so an import recreates the
 *     PO with its items.
 *   - Generic: a plain supplier order sheet for shops without QuickBooks.
 *
 * Cost visibility rides the document, not this builder: a document shaped for a
 * money-blind viewer already carries null unit costs / line totals (see
 * buildPoDocument). The QuickBooks layout is positional, so a null cost stays a
 * blank cell to keep the column grid intact; the generic sheet drops the cost
 * columns entirely when `canViewCosts` is false.
 *
 * CSV mechanics (RFC 4180, UTF-8 BOM, formula-injection guard) come from
 * lib/export/csv rowsToCsv — the one CSV writer this app ships.
 */

export type PoCsvFormat = "quickbooks" | "generic";

/** Label for the supplier column: the supplier's name when known, else a clear
 *  placeholder so an unassigned PO doesn't export an empty vendor cell. */
function supplierLabel(doc: PoDocumentData): string {
  return doc.supplier?.name ?? "Unassigned";
}

/** YYYY-MM-DD for spreadsheet date parsing — the export date, distinct from the
 *  human "23 Jul 2026" poDate the printed document uses. QuickBooks imports the
 *  ISO form without a locale guess. */
function isoDate(date: Date): string {
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

// QuickBooks Online Purchase-Order import, one row per line item. The LINE
// columns lead, in QBO's left-to-right PO line-grid order (Product/Service, SKU,
// Description, Qty, Rate, Amount), so a positional importer maps them straight
// across; the PO-level columns (Vendor / PurchaseOrder No / Date / Memo) trail.
// Rows group into one PO by PurchaseOrder No; Vendor sets the QB vendor; Memo
// re-stamps the PO number so the QB read-back always matches. Product/Service must
// match a QB item name to auto-map.
const QB_HEADER = [
  "Product/Service", "SKU", "Description", "Qty", "Rate", "Amount",
  "Vendor", "PurchaseOrder No", "PurchaseOrder Date", "Memo",
] as const;

/** One row per line. Rate/Amount are the document's already-shaped figures —
 *  null (a redacted cost) stays a blank cell so the positional grid holds. */
function quickBooksRows(doc: PoDocumentData): CellValue[][] {
  const date = isoDate(doc.sentAt ?? doc.createdAt);
  const supplier = supplierLabel(doc);
  return doc.lines.map((l) => [
    l.title,          // Product/Service (must match a QB item name to auto-map)
    l.sku,            // SKU
    l.title,          // Description
    l.quantity,       // Qty
    l.unitCostKes,    // Rate (unit cost) — blank when redacted
    l.lineTotalKes,   // Amount (line total) — blank when redacted
    supplier,         // Vendor
    doc.poNumber,     // PurchaseOrder No
    date,             // PurchaseOrder Date
    doc.poNumber,     // Memo — stamps the PO number so the QB read-back matches
  ]);
}

/** Generic supplier sheet, cost columns included only when the document carries
 *  costs (a money-blind viewer's document does not, so those two columns drop
 *  rather than print a column of masks). */
function genericHeader(canViewCosts: boolean): string[] {
  const base = ["Supplier", "SKU", "Product", "Qty"];
  return canViewCosts ? [...base, "Unit cost", "Line total"] : base;
}

function genericRows(doc: PoDocumentData, canViewCosts: boolean): CellValue[][] {
  const supplier = supplierLabel(doc);
  return doc.lines.map((l) => {
    const base: CellValue[] = [supplier, l.sku, l.title, l.quantity];
    return canViewCosts ? [...base, l.unitCostKes, l.lineTotalKes] : base;
  });
}

export function toQuickBooksCsv(doc: PoDocumentData): string {
  return rowsToCsv(QB_HEADER, quickBooksRows(doc));
}

export function toGenericPoCsv(doc: PoDocumentData, canViewCosts: boolean): string {
  return rowsToCsv(genericHeader(canViewCosts), genericRows(doc, canViewCosts));
}

/** The document is shaped with cost visibility already applied, so the QuickBooks
 *  layout needs no flag (redacted costs are blank cells); the generic sheet takes
 *  it to decide whether the cost columns exist at all. */
export function toPoCsv(doc: PoDocumentData, format: PoCsvFormat, canViewCosts: boolean): string {
  return format === "quickbooks" ? toQuickBooksCsv(doc) : toGenericPoCsv(doc, canViewCosts);
}

/** "PO-2087" -> "PO-2087-quickbooks" — a route-safe base the download names the
 *  file with (timestampedFilename adds the date + extension). */
export function poCsvFilenameBase(doc: PoDocumentData, format: PoCsvFormat): string {
  const safe = doc.poNumber.replace(/[^A-Za-z0-9._-]+/g, "-");
  return `${safe}-${format}`;
}
