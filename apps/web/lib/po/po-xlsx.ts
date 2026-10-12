import ExcelJS from "exceljs";
import { poDate, type PoDocumentData } from "@/lib/po/po-model";

/**
 * The purchase order as an .xlsx workbook — the spreadsheet a shop opens to work
 * the order in Excel or Sheets. A fourth renderer of the same PoDocumentData as
 * the print view, the PDF and the email, so its numbers can never disagree with
 * theirs: it prints figures the document already shaped, adds no total of its own
 * beyond the running count, and does not round.
 *
 * exceljs is pure JavaScript, so it runs on the Node serverless runtime with no
 * headless browser or native module — but it is a Node library, hence the route's
 * `runtime = "nodejs"`.
 *
 * Cost visibility rides the document: a document built for a money-blind viewer
 * carries null unit costs / line totals, and this drops the Unit cost / Line total
 * columns entirely when `canViewCosts` is false rather than print a column of
 * blanks. The bytes are returned to the caller and never written to disk: like the
 * PDF, this file carries the supplier's costs.
 */

const HEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF1C2130" },
};
const HEADER_FONT: Partial<ExcelJS.Font> = { bold: true, color: { argb: "FFFFFFFF" } };
/** Thousands-separated integer, matching poAmount's on-screen money style. */
const MONEY_FORMAT = "#,##0";

export async function poXlsxBuffer(
  doc: PoDocumentData,
  { canViewCosts }: { canViewCosts: boolean }
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Wezesha Restock";
  wb.created = new Date();
  const ws = wb.addWorksheet("Purchase order");

  // ── Header block: shop, order number, supplier, dates ──────────────────────
  const meta: [string, string][] = [
    [doc.shop.name, "Purchase order"],
    ["PO number", doc.poNumber],
    ["Date", poDate(doc.sentAt ?? doc.createdAt)],
    ["Supplier", doc.supplier?.name ?? "—"],
  ];
  if (doc.supplier?.email) meta.push(["Supplier email", doc.supplier.email]);
  meta.push([
    "Delivery",
    doc.expectedAt ? `Expected by ${poDate(doc.expectedAt)}` : "Expected date to be confirmed",
  ]);
  if (doc.createdByName) meta.push(["Raised by", doc.createdByName]);
  for (const [label, value] of meta) {
    const row = ws.addRow([label, value]);
    row.getCell(1).font = { bold: true };
  }
  ws.addRow([]);

  // ── Line table ─────────────────────────────────────────────────────────────
  const headers = canViewCosts
    ? ["SKU", "Item", "Qty", `Unit cost (${doc.currency})`, `Total (${doc.currency})`]
    : ["SKU", "Item", "Qty"];
  const headerRow = ws.addRow(headers);
  headerRow.eachCell((cell) => {
    cell.font = HEADER_FONT;
    cell.fill = HEADER_FILL;
  });

  for (const line of doc.lines) {
    const values: (string | number | null)[] = canViewCosts
      ? [line.sku, line.title, line.quantity, line.unitCostKes, line.lineTotalKes]
      : [line.sku, line.title, line.quantity];
    const row = ws.addRow(values);
    if (canViewCosts) {
      row.getCell(4).numFmt = MONEY_FORMAT;
      row.getCell(5).numFmt = MONEY_FORMAT;
    }
  }

  // ── Totals ─────────────────────────────────────────────────────────────────
  const count = `${doc.lines.length} line${doc.lines.length === 1 ? "" : "s"} · ${doc.totalUnits} units`;
  if (canViewCosts) {
    const totalRow = ws.addRow([count, "", "", `Total (${doc.currency})`, doc.subtotalKes]);
    totalRow.font = { bold: true };
    totalRow.getCell(5).numFmt = MONEY_FORMAT;
  } else {
    ws.addRow([count]).font = { bold: true };
  }

  // Widths: SKU and Item read whole; the numeric columns stay tight.
  ws.columns.forEach((column, i) => {
    column.width = i === 1 ? 40 : i === 0 ? 16 : 14;
  });

  // exceljs types xlsx.writeBuffer as ArrayBuffer/Buffer; normalise to a Node Buffer.
  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}

/** "PO-2087.xlsx" — the shop files it by order number. */
export function poXlsxFilename(doc: PoDocumentData): string {
  return `${doc.poNumber.replace(/[^A-Za-z0-9._-]+/g, "-")}.xlsx`;
}
