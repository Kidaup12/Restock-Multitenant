/**
 * The PO document's data model — one shape consumed by both renderers: the
 * printable page (lib/po/po-document.tsx) and the supplier email
 * (lib/po/po-email.ts). Shaping lives here so the two renderings can never
 * show different numbers.
 *
 * Cost visibility is decided here, at shaping time, via `canViewCosts`:
 *   - The supplier email is the PO's whole point — the supplier is quoting
 *     against these figures — so the send path (lib/po/send-po.ts) always builds
 *     with canViewCosts: true. That authorisation comes from the send action,
 *     not from whoever happens to be viewing.
 *   - The on-screen print view (lib/data/orders.ts getPoDocument) passes the
 *     viewing member's own permission, so a money-blind member who opens the
 *     printable PO sees the document with its costs nulled — the numbers never
 *     reach their browser.
 * Nulled fields render as the mask (see poAmount); every non-cost field is
 * identical whichever way the flag lands.
 */

export type PoDocumentLine = {
  sku: string;
  title: string;
  quantity: number;
  /** Null when the document is built for a viewer who can't see costs. */
  unitCostKes: number | null;
  lineTotalKes: number | null;
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
  /** Null when the document is built for a viewer who can't see costs. */
  subtotalKes: number | null;
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
  lines: { sku: string; title: string; quantity: number; unitCostKes: number; lineTotalKes: number }[];
};

export function buildPoDocument(
  po: PoRow,
  shopName: string,
  { canViewCosts }: { canViewCosts: boolean }
): PoDocumentData {
  return {
    poNumber: po.poNumber,
    status: po.status,
    createdAt: po.createdAt,
    sentAt: po.sentAt,
    expectedAt: po.expectedAt,
    currency: po.currency,
    shop: { name: shopName },
    supplier: po.supplier,
    lines: po.lines.map((l) => ({
      sku: l.sku,
      title: l.title,
      quantity: l.quantity,
      unitCostKes: canViewCosts ? l.unitCostKes : null,
      lineTotalKes: canViewCosts ? l.lineTotalKes : null,
    })),
    subtotalKes: canViewCosts ? po.subtotalKes : null,
    totalUnits: po.lines.reduce((sum, l) => sum + l.quantity, 0),
    createdByName: po.createdByName,
  };
}

/** "23 Jul 2026" — the document's date style, stable across renderers. */
export function poDate(date: Date): string {
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** Thousands-separated integer amount, e.g. "1,234,567". Null (a cost redacted
 *  for a money-blind viewer) renders as the mask, so a document built without
 *  cost visibility shows "•••" in every money cell. */
export function poAmount(value: number | null): string {
  return value == null ? "•••" : Math.round(value).toLocaleString("en-KE");
}
