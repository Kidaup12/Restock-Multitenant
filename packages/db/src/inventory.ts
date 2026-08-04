/**
 * Inventory quantity semantics — the single source of truth for which stored
 * number answers "how much of this can we actually sell or move".
 *
 * Shopify reports three quantities per location. Two of them matter here:
 *
 *   on_hand   — everything physically present, INCLUDING units already
 *               committed to unfulfilled customer orders
 *   available — on_hand minus committed: what can genuinely be sold
 *
 * The system stored on_hand and treated it as sellable. A product with 2 on the
 * shelf and 1 already sold reads as 2, so days-of-cover is inflated and the buy
 * list under-orders by exactly the committed amount. Same failure shape as the
 * location-role mapping: a wrong quantity silently corrupts the numbers rather
 * than throwing, so like roles.ts it lives in exactly one place.
 *
 * Pure and framework-free: no Prisma, no I/O.
 */

/** The shape any caller needs — deliberately structural, so a Prisma row, a
 *  partial `select`, and a hand-built test fixture all satisfy it. */
export type SellableLevel = {
  available: number | null;
  onHand: number;
};

/**
 * What can be sold or moved from a location.
 *
 * The fallback is the whole reason `available` is nullable. A row written
 * before this column existed — or by any path that forgets it — has NULL, and
 * falling back to `onHand` degrades to the old, overstated figure. That is the
 * known-wrong number, and it is the right direction to fail: reading NULL as 0
 * would empty the stock screen and flood the buy list with orders for products
 * that are sitting on the shelf.
 */
export function sellableUnits(level: SellableLevel): number {
  return level.available ?? level.onHand;
}

/**
 * Units physically present but not sellable, because they are already spoken
 * for. This is the quantity by which recommendations rise when a shop switches
 * from on_hand to available — the number to show someone asking "why did my
 * order quantities change".
 */
export function committedUnits(level: SellableLevel): number {
  if (level.available === null) return 0;
  // Shopify can report available above on_hand in odd states (an oversold
  // location being reconciled). Negative "committed" is meaningless, so clamp.
  return Math.max(0, level.onHand - level.available);
}
