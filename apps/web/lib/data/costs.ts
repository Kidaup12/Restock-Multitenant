import { BUYABLE_PRODUCT_WHERE, prismaForTenant } from "@wezesha/db";
import { getCatalogueMetrics } from "@/lib/metrics";
import { resolveCost, type CostSource } from "@/lib/cost";

/**
 * Costs-screen queries (spec §4): cost coverage + source split, and the live
 * cost-moved attention rows. Server-only; explicit tenantId; RLS-enforced tenant
 * client. Revenue coverage rides the shared metric engine (one calculation).
 *
 * Not-for-sale products are out of sellable stock, so their cost flags go quiet —
 * they're excluded from coverage and the source split (the coverage number is
 * about the catalogue you actually sell).
 *
 * Cost figures are redacted at this boundary, not at render: getters take an
 * explicit `canViewCosts` and null the KES fields for a money-blind member.
 * Where a whole row is cost intelligence rather than a KES field on an otherwise
 * operational row, the row itself is withheld — see `getCostMovedAlerts`.
 */

export type CostCoverage = {
  /** Sellable, active products (the coverage denominator). */
  products: number;
  /** Products with a trusted (non-suspect) cost. */
  trustedProducts: number;
  /** 0–100. */
  trustedProductPct: number;
  /** Share of trailing-30d revenue carried by trusted-cost products — matters
   *  more than product count (a missing cost on a top seller is worse). Null
   *  when the caller can't view costs. */
  trustedRevenuePct: number | null;
  /** Cost-source split across sellable products (counts). */
  sourceSplit: Record<CostSource, number>;
};

export async function getCostCoverage(
  tenantId: string,
  { canViewCosts }: { canViewCosts: boolean },
): Promise<CostCoverage> {
  const db = prismaForTenant(tenantId);
  const [products, metrics] = await Promise.all([
    db.product.findMany({
      where: { ...BUYABLE_PRODUCT_WHERE },
      select: { id: true, costKes: true, costSource: true, priceKes: true },
    }),
    getCatalogueMetrics(tenantId),
  ]);

  const sourceSplit: Record<CostSource, number> = { manual: 0, qb: 0, shopify: 0, missing: 0 };
  let trustedProducts = 0;
  let revenueTotal = 0;
  let revenueTrusted = 0;

  for (const p of products) {
    const c = resolveCost(p);
    sourceSplit[c.source] += 1;
    const rev = metrics.get(p.id)?.revenueKes[30] ?? 0;
    revenueTotal += rev;
    if (!c.isSuspect) {
      trustedProducts += 1;
      revenueTrusted += rev;
    }
  }

  const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 100);

  return {
    products: products.length,
    trustedProducts,
    trustedProductPct: pct(trustedProducts, products.length),
    trustedRevenuePct: canViewCosts ? pct(revenueTrusted, revenueTotal) : null,
    sourceSplit,
  };
}

export type CostMovedAlert = {
  productId: string;
  sku: string;
  title: string;
  /** Signed percent jump (e.g. 18, -22) — a buying-price delta, so these rows
   *  only ever reach a cost viewer. */
  movedPct: number;
  movedAt: Date;
  /** The current cost. Nullable so a consumer still guards it, but a row only
   *  ever reaches a caller who may see it. */
  costKes: number | null;
  priceKes: number;
};

/**
 * Active cost-moved attention rows, biggest swing first. Cost viewers only.
 *
 * Nulling `costKes` alone would not make this row money-blind: `movedPct` is a
 * signed per-product buying-price delta, and even without it the row's presence
 * says "this product's cost jumped past the threshold". The whole row is the
 * cost fact, so a money-blind caller gets an empty list rather than a redacted
 * one — the alert is the owner's margin decision to make.
 */
export async function getCostMovedAlerts(
  tenantId: string,
  { canViewCosts }: { canViewCosts: boolean },
): Promise<CostMovedAlert[]> {
  if (!canViewCosts) return [];

  const db = prismaForTenant(tenantId);
  const rows = await db.product.findMany({
    where: { ...BUYABLE_PRODUCT_WHERE, costMovedPct: { not: null } },
    select: { id: true, sku: true, title: true, costMovedPct: true, costMovedAt: true, costKes: true, priceKes: true },
  });

  return rows
    .filter((r) => r.costMovedPct != null && r.costMovedAt != null)
    .sort((a, b) => Math.abs(b.costMovedPct!) - Math.abs(a.costMovedPct!))
    .map((r) => ({
      productId: r.id,
      sku: r.sku,
      title: r.title,
      movedPct: r.costMovedPct!,
      movedAt: r.costMovedAt!,
      costKes: r.costKes,
      priceKes: r.priceKes,
    }));
}
