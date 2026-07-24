import { actualLeadDays } from "@/lib/po/supplier-stats";

/**
 * Pure lead-time math for the Suppliers surface — the "trust" numbers a
 * received delivery no longer writes back silently (see lib/po/receive-po.ts).
 * All read-time and derived: the typed value on Supplier stays the owner's; the
 * learned value is computed from receipt history here and only adopted on the
 * owner's one click.
 *
 * Speed band is derived from lead time. The metric-contract stream owns the
 * canonical band helper in lib/facets; this is a LOCAL copy with the same
 * thresholds (Local <=7d / Regional 8-20d / Import 21d+) so the page stands on
 * its own until the two reconcile at merge.
 */

/** Learned lead time only shows once enough deliveries exist to mean something. */
export const LEARNED_MIN_DELIVERIES = 3;
/** Median is taken over the most recent deliveries, not all history. */
export const LEARNED_WINDOW = 8;
/** Drift thresholds: flag when learned diverges from typed by either bound. */
export const DRIFT_ABS_DAYS = 5;
export const DRIFT_REL = 0.25;

/** A completed delivery: sent and fully received. */
export type CompletedDelivery = { sentAt: Date; receivedAt: Date };

/** Whole-number median of a non-empty list. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const raw =
    sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  return Math.round(raw);
}

/**
 * Median actual lead time (days) over the last N completed deliveries, or null
 * below the minimum. "Actual median 33d over last 8 deliveries" — the number the
 * supplier page shows beside the typed value.
 */
export function learnedLeadMedianDays(
  deliveries: CompletedDelivery[],
  { window = LEARNED_WINDOW, min = LEARNED_MIN_DELIVERIES } = {},
): number | null {
  const recent = [...deliveries]
    .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
    .slice(0, window);
  if (recent.length < min) return null;
  return median(recent.map((d) => actualLeadDays(d.sentAt, d.receivedAt)));
}

export type SpeedBand = "local" | "regional" | "import";

export const SPEED_BAND_LABEL: Record<SpeedBand, string> = {
  local: "Local",
  regional: "Regional",
  import: "Import",
};

/** Local <=7d, Regional 8-20d, Import 21d+. null when no lead time is known. */
export function speedBand(leadDays: number | null): SpeedBand | null {
  if (leadDays == null) return null;
  if (leadDays <= 7) return "local";
  if (leadDays <= 20) return "regional";
  return "import";
}

export type LeadTimeDrift = {
  drifting: boolean;
  /** learned − typed (positive = learned is slower). null when not comparable. */
  deltaDays: number | null;
  /** Which way it drifted; "later" is the dangerous one (orders placed too late). */
  direction: "later" | "earlier" | null;
};

const NO_DRIFT: LeadTimeDrift = { drifting: false, deltaDays: null, direction: null };

/**
 * Flag a supplier whose learned lead time diverges from the typed value beyond
 * either threshold — >5 days OR >25% of the typed value. Comparable only when
 * both numbers exist (learned already requires enough deliveries).
 */
export function leadTimeDrift(
  typedDays: number | null,
  learnedDays: number | null,
  { absDays = DRIFT_ABS_DAYS, rel = DRIFT_REL } = {},
): LeadTimeDrift {
  if (typedDays == null || learnedDays == null) return NO_DRIFT;
  const deltaDays = learnedDays - typedDays;
  const abs = Math.abs(deltaDays);
  const relExceeded = typedDays > 0 && abs / typedDays > rel;
  const drifting = abs > absDays || relExceeded;
  const direction = deltaDays === 0 ? null : deltaDays > 0 ? "later" : "earlier";
  return { drifting, deltaDays, direction };
}

/** A delivery's ordered-vs-received slice for short-ship scoring. */
export type ShippedDelivery = { lines: { quantity: number; receivedQty: number }[] };

/**
 * Share of deliveries that arrived short (total received < total ordered), as a
 * whole percent. Population is deliveries with any receipt; null when there are
 * none. "A supplier who often ships short makes you run out even when you
 * ordered right."
 */
export function shortShipRatePct(deliveries: ShippedDelivery[]): number | null {
  let delivered = 0;
  let short = 0;
  for (const d of deliveries) {
    const ordered = d.lines.reduce((s, l) => s + l.quantity, 0);
    const received = d.lines.reduce((s, l) => s + l.receivedQty, 0);
    if (received <= 0) continue; // never delivered — not a short-ship
    delivered += 1;
    if (received < ordered) short += 1;
  }
  if (delivered === 0) return null;
  return Math.round((short / delivered) * 100);
}
