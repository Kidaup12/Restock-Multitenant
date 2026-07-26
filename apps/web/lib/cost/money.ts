/**
 * The money lens over the catalogue (spec §2 "Money summary & scale"): the four
 * owner's-eye band tiles, and the per-row inventory-truth figures (margin %, cash
 * tied up, cover verdict). Pure — it consumes numbers the shared metric engine
 * already produced (sellable on-hand, cover, revenue, money-at-rest) and the
 * resolved cost; it never re-derives a metric, so the catalogue stays one
 * calculation.
 *
 * "Not for sale" rows (testers/display/damaged) are out of sellable stock and
 * cover, so they are excluded from every band tile — the band is the sellable
 * catalogue's gut check.
 */

/** Overstock / dead-stock threshold: cover beyond this is idle capital (spec). */
export const OVERSTOCK_COVER_DAYS = 90;

/** Margin % of selling price: (price − cost) / price. Null when there is no
 *  price to divide by (a missing-price row can't show a margin). Negative =
 *  selling below cost (loud red in the table). */
export function marginPct(costKes: number, priceKes: number): number | null {
  if (!(priceKes > 0)) return null;
  return ((priceKes - costKes) / priceKes) * 100;
}

/** Cash tied up in a row: unit cost × sellable on-hand (oversold clamps to 0 —
 *  you can't have negative capital on the shelf). Matches the metric engine's
 *  moneyAtRest so the per-row and band figures never disagree. */
export function cashTiedUp(costKes: number, sellableOnHand: number): number {
  return costKes * Math.max(0, sellableOnHand);
}

export type VerdictKind = "oversold" | "stockout" | "order_now" | "healthy" | "overstock";

export const VERDICT_LABELS: Record<VerdictKind, string> = {
  oversold: "Oversold",
  stockout: "Stockout",
  order_now: "Order now",
  healthy: "Healthy",
  overstock: "Overstock",
};

/** Badge tone per verdict — reuses the shared Badge tones. */
export const VERDICT_TONES: Record<VerdictKind, "negative" | "warning" | "positive" | "neutral"> = {
  oversold: "negative",
  stockout: "negative",
  order_now: "warning",
  healthy: "positive",
  overstock: "neutral",
};

/**
 * The days-of-cover number turned into a judgement (spec read order ends at the
 * verdict): Oversold (negative stock) · Stockout (nothing to sell) · Order now
 * (cover below the lead time — order later and you stock out) · Overstock (idle
 * capital: cover past 90d, or stock with no velocity at all) · Healthy.
 */
export function coverVerdict(
  sellableOnHand: number,
  coverDays: number | null,
  leadDays: number,
): VerdictKind {
  if (sellableOnHand < 0) return "oversold";
  if (sellableOnHand === 0) return "stockout";
  if (coverDays == null) return "overstock"; // stock on hand but no velocity — idle
  if (coverDays < leadDays) return "order_now";
  if (coverDays > OVERSTOCK_COVER_DAYS) return "overstock";
  return "healthy";
}

export type MoneyRow = {
  /** Resolved cost (0 when missing). */
  costKes: number;
  priceKes: number;
  sellableOnHand: number;
  coverDays: number | null;
  /** Resolved lead time (product override → supplier → ASSUMED_LEAD_DAYS). */
  leadDays: number;
  revenue30dKes: number;
  /** cost × max(0, sellable) — from the metric engine. */
  moneyAtRestKes: number;
  notForSale: boolean;
};

export type MoneyBand = {
  /** Σ money-at-rest across the sellable catalogue. */
  cashTiedUpKes: number;
  /** Σ money-at-rest of overstock/dead rows (cover > 90d or no velocity). */
  deadOverstockKes: number;
  deadOverstockCount: number;
  /** Σ 30-day revenue of rows out of stock or with cover below lead time. */
  revenueAtRiskKes: number;
  revenueAtRiskCount: number;
  /** Rows selling below cost (margin < 0) and their 30-day revenue exposure. */
  belowCostCount: number;
  belowCostRevenueKes: number;
};

/** Compute the four money-band tiles across the active, sellable catalogue. */
export function computeMoneyBand(rows: MoneyRow[]): MoneyBand {
  const band: MoneyBand = {
    cashTiedUpKes: 0,
    deadOverstockKes: 0,
    deadOverstockCount: 0,
    revenueAtRiskKes: 0,
    revenueAtRiskCount: 0,
    belowCostCount: 0,
    belowCostRevenueKes: 0,
  };

  for (const r of rows) {
    if (r.notForSale) continue; // out of sellable stock → out of the band

    band.cashTiedUpKes += r.moneyAtRestKes;

    const idle = r.coverDays == null || r.coverDays > OVERSTOCK_COVER_DAYS;
    if (idle && r.sellableOnHand > 0) {
      band.deadOverstockKes += r.moneyAtRestKes;
      band.deadOverstockCount += 1;
    }

    const atRisk = r.sellableOnHand <= 0 || (r.coverDays != null && r.coverDays < r.leadDays);
    if (atRisk) {
      band.revenueAtRiskKes += r.revenue30dKes;
      band.revenueAtRiskCount += 1;
    }

    if (r.costKes > 0 && r.priceKes > 0 && r.costKes > r.priceKes) {
      band.belowCostCount += 1;
      band.belowCostRevenueKes += r.revenue30dKes;
    }
  }

  return band;
}
