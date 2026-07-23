/**
 * The PO document's data model — one shape consumed by both renderers: the
 * printable page (lib/po/po-document.tsx) and the supplier email
 * (lib/po/po-email.ts). Shaping lives here so the two renderings can never
 * show different numbers.
 */

export type PoDocumentLine = {
  sku: string;
  title: string;
  quantity: number;
  unitCostKes: number;
  lineTotalKes: number;
};

export type PoDocumentData = {
  poNumber: string;
  status: string;
  createdAt: Date;
  sentAt: Date | null;
  expectedAt: Date | null;
  currency: string;
  shop: { name: string };
  supplier: { name: string; email: string | null; country: string | null } | null;
  lines: PoDocumentLine[];
  subtotalKes: number;
  totalUnits: number;
  createdByName: string | null;
};

type PoRow = {
  poNumber: string;
  status: string;
  createdAt: Date;
  sentAt: Date | null;
  expectedAt: Date | null;
  currency: string;
  subtotalKes: number;
  createdByName: string | null;
  supplier: { name: string; email: string | null; country: string | null } | null;
  lines: PoDocumentLine[];
};

export function buildPoDocument(po: PoRow, shopName: string): PoDocumentData {
  return {
    poNumber: po.poNumber,
    status: po.status,
    createdAt: po.createdAt,
    sentAt: po.sentAt,
    expectedAt: po.expectedAt,
    currency: po.currency,
    shop: { name: shopName },
    supplier: po.supplier,
    lines: po.lines,
    subtotalKes: po.subtotalKes,
    totalUnits: po.lines.reduce((sum, l) => sum + l.quantity, 0),
    createdByName: po.createdByName,
  };
}

/** "23 Jul 2026" — the document's date style, stable across renderers. */
export function poDate(date: Date): string {
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** Thousands-separated integer amount, e.g. "1,234,567". */
export function poAmount(value: number): string {
  return Math.round(value).toLocaleString("en-KE");
}
