/**
 * Lead-time and order-cover resolution — real data only.
 *
 * Lead time, lead-time variability, and the order-cover window come from
 * measured data (per-product override -> supplier average / supplier std) with
 * a single flat variability fallback. There is deliberately no guessed default
 * lead time: unknown lead sizes the order to the review cycle only and is
 * surfaced as data to fix, because guessed leads inflate orders past a shop's
 * real shipping times.
 */

/** Single lead-time variability (± days) fallback, used only when the supplier
 *  carries no measured std. Feeds King's safety stock. */
const FALLBACK_LEAD_STD_DAYS = 7;

/** Review period (days): time between reorder opportunities. One order must
 *  last until the NEXT order can arrive — lead time + this. The calibrated
 *  reorder path protects the same cycle. */
export const ORDER_REVIEW_DAYS = 7;

export type ProductLeadFacts = { leadTimeDays?: number | null };
export type SupplierLeadFacts = { leadTimeAvgDays?: number | null; leadTimeStdDays?: number | null };

/**
 * Lead-time precedence: per-product override -> supplier average -> NULL.
 * Null means "no real lead data" — callers must not invent one.
 */
export function leadDaysFor(
  product: ProductLeadFacts,
  supplier?: SupplierLeadFacts | null
): number | null {
  if (product.leadTimeDays != null) return product.leadTimeDays;
  if (supplier?.leadTimeAvgDays != null) return supplier.leadTimeAvgDays;
  return null;
}

/**
 * Lead-time STD: the supplier's measured std when present, else the flat
 * fallback. A per-product lead OVERRIDE only fixes the average lead, not its
 * variability, so it does not enter here.
 */
export function leadStdFor(supplier?: SupplierLeadFacts | null): number {
  if (supplier?.leadTimeStdDays != null) return supplier.leadTimeStdDays;
  return FALLBACK_LEAD_STD_DAYS;
}

/** Order-cover window: how many days of demand one order should span. The
 *  item's real lead time plus the review cycle — enough to last until the next
 *  order can land. NO lead data -> review cycle only: never inflate an order on
 *  a guess; the caller flags the item so the owner links a supplier or sets a
 *  lead instead. */
export function coverDaysFor(
  product: ProductLeadFacts,
  supplier?: SupplierLeadFacts | null
): number {
  return (leadDaysFor(product, supplier) ?? 0) + ORDER_REVIEW_DAYS;
}
