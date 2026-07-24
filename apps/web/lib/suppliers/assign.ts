/**
 * Bulk-assign-by-brand suggestion. Assigning 400 products one by one is not
 * viable, so the page offers "Garnier — 12 products, no supplier -> [supplier]"
 * with a suggested supplier. Two signals, strongest first:
 *
 *   1. Learned — the supplier that already carries the most of THIS brand's
 *      already-assigned products (the shop has told us before).
 *   2. Name match — a supplier whose name overlaps the vendor/brand name.
 *
 * A suggestion is only ever a default the owner confirms; null means "no guess,
 * pick one". Pure and side-effect free so it is trivially testable.
 */

export type SupplierLite = { id: string; name: string };

/** How many of one vendor's already-assigned products each supplier carries. */
export type VendorSupplierCount = { supplierId: string; count: number };

/** lowercased, alphanumeric-only — "Garnier Kenya Ltd." -> "garnierkenyaltd". */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Best-guess supplier id for an unassigned brand, or null when nothing fits. */
export function suggestSupplierForVendor(
  vendor: string,
  suppliers: SupplierLite[],
  assignedCounts: VendorSupplierCount[] = [],
): string | null {
  // 1 · Learned association wins: the supplier already carrying the most of this
  // brand. Ties broken deterministically by supplier id.
  const strongest = [...assignedCounts]
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count || a.supplierId.localeCompare(b.supplierId))[0];
  if (strongest && suppliers.some((s) => s.id === strongest.supplierId)) {
    return strongest.supplierId;
  }

  // 2 · Name overlap between the brand and a supplier name.
  const needle = normalize(vendor);
  if (needle.length >= 3) {
    const match = suppliers.find((s) => {
      const hay = normalize(s.name);
      return hay.includes(needle) || needle.includes(hay);
    });
    if (match) return match.id;
  }

  return null;
}
