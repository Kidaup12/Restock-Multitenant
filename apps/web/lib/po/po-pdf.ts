import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { poAmount, poDate, type PoDocumentData } from "@/lib/po/po-model";

/**
 * The purchase order as a PDF, for the supplier's email to carry as an
 * attachment. Third renderer of the same PoDocumentData as the print view
 * (lib/po/po-document.tsx) and the email body (lib/po/po-email.ts): every
 * figure is printed as the document already shaped it, and nothing here adds a
 * line up or rounds one — a total with two producers is a total with two
 * values. Formatting goes through poAmount/poDate for the same reason.
 *
 * pdf-lib is pure JavaScript with no headless browser, no native module and no
 * wasm, so it runs on the Node serverless runtime with nothing added to the
 * build. The cost of that is laying the page out by hand, below.
 *
 * The bytes are returned to the caller and never written to disk or logged:
 * this document carries the supplier's costs.
 */

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 48;
const RIGHT = PAGE.width - MARGIN;
const FLOOR = 64;

const BODY = 9;
const ROW = 15;

const INK = rgb(0.11, 0.13, 0.19);
const MUTED = rgb(0.42, 0.44, 0.49);
const RULE = rgb(0.8, 0.8, 0.83);

/** Left edges for the text columns, right edges for the numeric ones. */
const COL = { sku: MARGIN, title: 136, qty: 392, unit: 470, total: RIGHT };
const TITLE_WIDTH = COL.qty - COL.title - 60;

type Fonts = { body: PDFFont; bold: PDFFont };

/** "PO-2087.pdf" — the supplier files it by order number. */
export function poPdfFilename(doc: PoDocumentData): string {
  return `${doc.poNumber.replace(/[^A-Za-z0-9._-]+/g, "-")}.pdf`;
}

function right(page: PDFPage, text: string, edge: number, y: number, font: PDFFont, size = BODY) {
  page.drawText(text, { x: edge - font.widthOfTextAtSize(text, size), y, size, font, color: INK });
}

/** Trim to the column rather than letting a long title run under the numbers. */
function fit(text: string, font: PDFFont, width: number): string {
  if (font.widthOfTextAtSize(text, BODY) <= width) return text;
  let cut = text;
  while (cut.length > 1 && font.widthOfTextAtSize(`${cut}...`, BODY) > width) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}...`;
}

/** The column headings, repeated at the top of every page of lines. */
function columnHeadings(page: PDFPage, y: number, fonts: Fonts, currency: string): number {
  page.drawText("SKU", { x: COL.sku, y, size: BODY, font: fonts.bold, color: INK });
  page.drawText("Item", { x: COL.title, y, size: BODY, font: fonts.bold, color: INK });
  right(page, "Qty", COL.qty, y, fonts.bold);
  right(page, `Unit cost (${currency})`, COL.unit, y, fonts.bold);
  right(page, `Total (${currency})`, COL.total, y, fonts.bold);
  page.drawLine({
    start: { x: MARGIN, y: y - 5 },
    end: { x: RIGHT, y: y - 5 },
    thickness: 1,
    color: INK,
  });
  return y - ROW - 5;
}

/** The shop, order number and date block that opens the document. */
function letterhead(page: PDFPage, doc: PoDocumentData, fonts: Fonts): number {
  let y = PAGE.height - MARGIN - 12;
  page.drawText(doc.shop.name, { x: MARGIN, y, size: 15, font: fonts.bold, color: INK });
  right(page, doc.poNumber, RIGHT, y, fonts.bold, 13);
  y -= 15;
  page.drawText("Purchase order", { x: MARGIN, y, size: BODY, font: fonts.body, color: MUTED });
  right(page, poDate(doc.sentAt ?? doc.createdAt), RIGHT, y, fonts.body);
  y -= 14;
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: RIGHT, y },
    thickness: 1,
    color: RULE,
  });

  y -= 24;
  page.drawText("SUPPLIER", { x: MARGIN, y, size: 8, font: fonts.bold, color: MUTED });
  right(page, "DELIVERY", RIGHT, y, fonts.bold, 8);
  y -= 13;
  page.drawText(doc.supplier?.name ?? "—", { x: MARGIN, y, size: BODY, font: fonts.bold, color: INK });
  right(
    page,
    doc.expectedAt ? `Expected by ${poDate(doc.expectedAt)}` : "Expected date to be confirmed",
    RIGHT,
    y,
    fonts.body
  );
  y -= 12;
  if (doc.supplier?.email) {
    page.drawText(doc.supplier.email, { x: MARGIN, y, size: BODY, font: fonts.body, color: MUTED });
  }
  if (doc.createdByName) {
    right(page, `Raised by ${doc.createdByName}`, RIGHT, y, fonts.body);
  }
  y -= 12;
  if (doc.supplier?.country) {
    page.drawText(doc.supplier.country, { x: MARGIN, y, size: BODY, font: fonts.body, color: MUTED });
    y -= 12;
  }
  return y - 20;
}

export async function poPdfBytes(doc: PoDocumentData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Purchase order ${doc.poNumber}`);
  const fonts: Fonts = {
    body: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
  };

  let page = pdf.addPage([PAGE.width, PAGE.height]);
  let y = columnHeadings(page, letterhead(page, doc, fonts), fonts, doc.currency);

  for (const line of doc.lines) {
    if (y < FLOOR) {
      page = pdf.addPage([PAGE.width, PAGE.height]);
      y = columnHeadings(page, PAGE.height - MARGIN, fonts, doc.currency);
    }
    page.drawText(line.sku, { x: COL.sku, y, size: BODY, font: fonts.body, color: INK });
    page.drawText(fit(line.title, fonts.body, TITLE_WIDTH), {
      x: COL.title,
      y,
      size: BODY,
      font: fonts.body,
      color: INK,
    });
    right(page, String(line.quantity), COL.qty, y, fonts.body);
    right(page, poAmount(line.unitCostKes), COL.unit, y, fonts.body);
    right(page, poAmount(line.lineTotalKes), COL.total, y, fonts.body);
    page.drawLine({
      start: { x: MARGIN, y: y - 5 },
      end: { x: RIGHT, y: y - 5 },
      thickness: 0.5,
      color: RULE,
    });
    y -= ROW;
  }

  // Totals and terms belong together; start a page rather than split them.
  if (y < FLOOR + 60) {
    page = pdf.addPage([PAGE.width, PAGE.height]);
    y = PAGE.height - MARGIN;
  }
  y -= 8;
  const count = `${doc.lines.length} line${doc.lines.length === 1 ? "" : "s"} · ${doc.totalUnits} units`;
  page.drawText(count, { x: MARGIN, y, size: BODY, font: fonts.bold, color: INK });
  right(page, `Total (${doc.currency})`, COL.unit, y, fonts.bold);
  right(page, poAmount(doc.subtotalKes), COL.total, y, fonts.bold, 11);

  y -= 34;
  page.drawLine({
    start: { x: MARGIN, y: y + 12 },
    end: { x: RIGHT, y: y + 12 },
    thickness: 1,
    color: RULE,
  });
  page.drawText(
    `Please confirm receipt of this order and the expected delivery date. Quote ${doc.poNumber} on`,
    { x: MARGIN, y, size: 8, font: fonts.body, color: MUTED }
  );
  page.drawText("all correspondence, delivery notes and invoices.", {
    x: MARGIN,
    y: y - 11,
    size: 8,
    font: fonts.body,
    color: MUTED,
  });

  return pdf.save();
}
