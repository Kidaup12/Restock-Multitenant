/**
 * What to do about stock that isn't selling — the rules behind the
 * Recommendations tab. Pure: the worker gathers the facts, this decides.
 *
 * The rules set every number (which action, the discount %, the units, the
 * cash). Any AI wording layered on top only re-says these numbers; it never
 * changes them.
 *
 * Two kinds of idle stock:
 *  - Dead: held with no sale in the shop's window and on the shelf the whole
 *    window (isDeadStock).
 *  - Overstocked: still selling, but holding more than OVERSTOCK_COVER_DAYS of
 *    cover. Only the stock beyond that is "idle".
 *
 * Each idle product gets up to two actions:
 *  - stop_reorder, when the current plan would buy more of it anyway;
 *  - plus one way to turn it back into cash: discount if the margin allows,
 *    otherwise bundle it with a best seller from its category, and clear it
 *    (return or clearance) when it has been dead for a long time.
 *
 * Products moving between shops is deliberately not suggested: stock moves
 * warehouse → shops only (Transfers), never shop to shop.
 */
import { overstockExcess } from "./overstock";

/** Cover beyond this many days counts as overstock. Same line as the app's
 *  "too much" cash-asleep reason. */
export const OVERSTOCK_COVER_DAYS = 90;
/** The lowest a discounted price may fall, as a multiple of cost. */
export const MIN_PRICE_OVER_COST = 1.05;
/** Smaller than this, a discount isn't worth announcing. */
export const MIN_DISCOUNT_PCT = 10;

export type RecommendationAction = "stop_reorder" | "discount" | "bundle" | "clear";

export type RecommendationProduct = {
  productId: string;
  title: string;
  abc: string | null;
  category: string | null;
  onHand: number;
  costKes: number;
  priceKes: number;
  /** Units per day the shop sees on its screens; 0 when nothing sells. */
  runRate: number;
  /** Already judged dead by the shared dead-stock rule. */
  dead: boolean;
  /** Days since the last sale; null when it has never sold. */
  daysSinceSale: number | null;
  /** Units the current plan would order (after the owner's overrides). */
  plannedQty: number;
};

export type Recommendation = {
  productId: string;
  action: RecommendationAction;
  /** Cash freed (discount/bundle/clear) or not spent (stop_reorder), at cost. */
  cashKes: number;
  idleUnits: number;
  /** Plain sentence built from the numbers — the fallback wording. */
  reason: string;
  payload: Record<string, string | number | null>;
};

const round = (n: number) => Math.round(n);

/** Steps the discount by how stale the stock is, then caps it so the price
 *  still clears cost. Null when the margin can't fund a worthwhile discount. */
export function suggestedDiscountPct(p: RecommendationProduct, windowDays: number): number | null {
  if (p.priceKes <= 0) return null;
  const target = !p.dead ? 10 : (p.daysSinceSale ?? Infinity) >= windowDays * 1.5 ? 30 : 20;
  const maxByMargin = p.costKes > 0 ? (1 - (p.costKes * MIN_PRICE_OVER_COST) / p.priceKes) * 100 : target;
  const pct = Math.floor(Math.min(target, maxByMargin) / 5) * 5;
  return pct >= MIN_DISCOUNT_PCT ? pct : null;
}

export function recommendFor(
  products: RecommendationProduct[],
  { windowDays }: { windowDays: number }
): Recommendation[] {
  // Best seller in each category with stock — the partner for a bundle.
  const anchors = new Map<string, RecommendationProduct>();
  for (const p of products) {
    if (!p.category || p.abc !== "A" || p.onHand <= 0 || p.dead) continue;
    const cur = anchors.get(p.category);
    if (!cur || p.runRate > cur.runRate) anchors.set(p.category, p);
  }

  const out: Recommendation[] = [];
  for (const p of products) {
    if (p.onHand <= 0) continue;
    const over = p.dead
      ? null
      : overstockExcess({ currentStock: p.onHand, dailyRate: p.runRate, costKes: p.costKes, thresholdDays: OVERSTOCK_COVER_DAYS });
    if (!p.dead && !over?.isOverstock) continue;

    const idleUnits = p.dead ? Math.floor(p.onHand) : Math.floor(over!.excessUnits);
    if (idleUnits <= 0) continue;
    const idleCash = idleUnits * Math.max(0, p.costKes);
    const why = p.dead
      ? p.daysSinceSale == null
        ? `${idleUnits} on the shelf and it has never sold`
        : `${idleUnits} on the shelf and no sale in ${p.daysSinceSale} days`
      : `${round(over!.coverDays ?? 0)} days of stock at ${p.runRate.toFixed(2)} a day — ${idleUnits} more than needed`;

    if (p.plannedQty > 0) {
      out.push({
        productId: p.productId,
        action: "stop_reorder",
        cashKes: p.plannedQty * Math.max(0, p.costKes),
        idleUnits,
        reason: `The plan would order ${p.plannedQty} more, but ${why}. Skip this reorder.`,
        payload: { plannedQty: p.plannedQty },
      });
    }

    const longDead = p.dead && (p.daysSinceSale == null || p.daysSinceSale >= windowDays * 2);
    const pct = suggestedDiscountPct(p, windowDays);
    const anchor = p.category ? anchors.get(p.category) : undefined;

    if (longDead && pct == null) {
      out.push({
        productId: p.productId,
        action: "clear",
        cashKes: idleCash,
        idleUnits,
        reason: `${why}, and the margin can't fund a discount. Ask the supplier about a return, or clear it out.`,
        payload: { units: idleUnits },
      });
    } else if (pct != null) {
      const newPrice = round(p.priceKes * (1 - pct / 100));
      out.push({
        productId: p.productId,
        action: "discount",
        cashKes: idleCash,
        idleUnits,
        reason: `${why}. Try ${pct}% off (${newPrice} instead of ${round(p.priceKes)}) to free the cash.`,
        payload: { pct, newPriceKes: newPrice, priceKes: round(p.priceKes) },
      });
    } else if (anchor && anchor.productId !== p.productId) {
      out.push({
        productId: p.productId,
        action: "bundle",
        cashKes: idleCash,
        idleUnits,
        reason: `${why}. Pair it with ${anchor.title}, a best seller in ${p.category}, as a bundle or a free add-on.`,
        payload: { pairProductId: anchor.productId, pairTitle: anchor.title },
      });
    }
  }
  return out.sort((a, b) => b.cashKes - a.cashKes || b.idleUnits - a.idleUnits);
}
