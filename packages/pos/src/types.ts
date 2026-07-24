/**
 * Wire types for a POS ingest window. Shared by the feed parser, the pure
 * planner, and the DB writer so one shape flows end to end.
 */

/** One rung line on a till receipt. */
export type PosLineInput = {
  sku: string;
  name?: string | null;
  qty: number;
  /** Unit price at the till (KES); optional. */
  price?: number | null;
  /** Line subtotal at the till (KES); optional — the preferred revenue source. */
  subtotal?: number | null;
};

/** One physical sale (receipt) as it arrives from the POS feed / POST payload. */
export type PosSaleInput = {
  /** POS provider's stable sale id — the set-semantics key. */
  externalId: string;
  reference?: string | null;
  /** Sale timestamp. A string is parsed as tenant-local wall-clock when it
   *  carries no offset (see parsePosDate); a Date is used as-is. */
  date: string | Date;
  createdBy?: string | null;
  salesAgent?: string | null;
  /** Raw POS warehouse/till name — mapped to a Location via WarehouseLocationMap. */
  warehouse?: string | null;
  customer?: string | null;
  saleStatus?: string | null;
  paymentStatus?: string | null;
  grandTotal?: number | null;
  /** Provider channel label. Lines the online channel already rang ("shopify"/
   *  "online") are excluded so POS never double-counts what the Shopify sync
   *  ingested. Absent/other values are treated as physical. */
  channel?: string | null;
  lines: PosLineInput[];
};

/** Minimal product shape the matcher needs (a Prisma Product projection). */
export type MatchProduct = {
  id: string;
  sku: string | null;
  title?: string | null;
  priceKes?: number | null;
};
