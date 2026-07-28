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
  /** Signed percent jump (e.g. 18, -22). */
  movedPct: number;
  movedAt: Date;
  /** Null when the caller can't view costs. */
  costKes: number | null;
  priceKes: number;
};

/** Active cost-moved attention rows, biggest swing first. */
export async function getCostMovedAlerts(
  tenantId: string,
  { canViewCosts }: { canViewCosts: boolean },
): Promise<CostMovedAlert[]> {
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
      costKes: canViewCosts ? r.costKes : null,
      priceKes: r.priceKes,
    }));
}
