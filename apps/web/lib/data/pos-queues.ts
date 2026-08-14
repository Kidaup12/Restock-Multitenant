import { BUYABLE_PRODUCT_WHERE, prismaForTenant } from "@wezesha/db";
import {
  detectSalesGaps,
  normalizeSku,
  suggestProductForSku,
  tenantDayKey,
  type ProductSuggestion,
} from "@wezesha/pos";

/**
 * POS fix-queue reads for the Sales screen — the unmatched-SKU queue, the
 * sales-gap list, and the unmapped-till list. New, sibling to lib/data/sales.ts
 * (which owns the metric tiles); nothing here touches those aggregates.
 *
 * Server-only, RLS-enforced tenant client throughout, so a queue can never
 * surface another tenant's till lines. All three drive owner "downstream fixes"
 * — the only place POS data needs a human.
 */

const DAY_MS = 86_400_000;
const GAP_WINDOW_DAYS = 14;

export type UnmatchedPosSku = {
  /** Representative raw till code. */
  sku: string;
  productName: string;
  units: number;
  revenueKes: number;
  /** Advisory catalogue match for the "suggested product" column (never auto-applied). */
  suggestion: ProductSuggestion | null;
};

function lineRevenue(price: number, subtotal: number, qty: number): number {
  if (subtotal > 0) return subtotal;
  if (price > 0) return price * qty;
  return 0;
}

/**
 * Till SKUs that matched no product, rolled up with units + revenue + a
 * suggested catalogue match. Ignored SKUs (an IgnoreRule "not a product") are
 * filtered out so junk never re-queues.
 */
export async function getUnmatchedPosSkus(tenantId: string): Promise<UnmatchedPosSku[]> {
  const db = prismaForTenant(tenantId);
  const [lines, ignoreRules, products] = await Promise.all([
    db.posSaleLine.findMany({
      where: { productId: null },
      select: { sku: true, productName: true, qty: true, price: true, subtotal: true },
    }),
    db.ignoreRule.findMany({ where: { kind: "till_sku" }, select: { value: true } }),
    db.product.findMany({ select: { id: true, sku: true, title: true, priceKes: true } }),
  ]);

  const ignored = new Set(ignoreRules.map((r) => normalizeSku(r.value)));
  const byKey = new Map<string, { sku: string; productName: string; units: number; revenueKes: number }>();
  for (const l of lines) {
    const key = normalizeSku(l.sku);
    if (!key || ignored.has(key)) continue; // empty or ignored → not queued
    const row = byKey.get(key);
    const rev = lineRevenue(l.price, l.subtotal, l.qty);
    if (row) {
      row.units += l.qty;
      row.revenueKes += rev;
      if (!row.productName && l.productName) row.productName = l.productName;
    } else {
      byKey.set(key, { sku: l.sku.trim(), productName: l.productName, units: l.qty, revenueKes: rev });
    }
  }

  return [...byKey.values()]
    .map((r) => ({ ...r, suggestion: suggestProductForSku(r.sku, r.productName, products) }))
    .sort((a, b) => b.revenueKes - a.revenueKes);
}

export type SalesGapView = {
  locationId: string;
  locationName: string;
  dayKey: string;
  /** Human day label, e.g. "Tue 15 Jul". */
  label: string;
};

/**
 * Live sales-gap list for the Sales screen: a Sells branch that recorded zero
 * sales on a day its siblings sold, over the trailing window, minus days already
 * dismissed as closures. Read-only — the daily cron raises the bells; this lists
 * what is still open.
 */
export async function getSalesGaps(tenantId: string, now: Date = new Date()): Promise<SalesGapView[]> {
  const db = prismaForTenant(tenantId);
  const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
  const timezone = tenant?.timezone ?? "Africa/Nairobi";

  const locations = await db.location.findMany({ select: { id: true, name: true, locationType: true } });
  const sells = locations.filter((l) => l.locationType == null || l.locationType === "branch");
  if (sells.length < 2) return [];
  const nameById = new Map(sells.map((l) => [l.id, l.name]));

  const days: string[] = [];
  for (let i = 1; i <= GAP_WINDOW_DAYS; i++) days.push(tenantDayKey(timezone, new Date(now.getTime() - i * DAY_MS)));
  const oldest = new Date(`${days[days.length - 1]}T00:00:00.000Z`);

  const [rows, closures] = await Promise.all([
    db.salesHistory.findMany({
      where: { locationId: { not: null }, date: { gte: oldest } },
      select: { locationId: true, date: true },
    }),
    db.locationClosure.findMany({ where: { date: { gte: oldest } }, select: { locationId: true, date: true } }),
  ]);

  const gaps = detectSalesGaps({
    sellsLocationIds: sells.map((l) => l.id),
    soldOn: rows.map((r) => ({ locationId: r.locationId!, dayKey: r.date.toISOString().slice(0, 10) })),
    days,
    closures: closures.map((c) => ({ locationId: c.locationId, dayKey: c.date.toISOString().slice(0, 10) })),
  });

  return gaps.map((g) => ({
    locationId: g.locationId,
    locationName: nameById.get(g.locationId) ?? "A branch",
    dayKey: g.dayKey,
    label: new Date(`${g.dayKey}T00:00:00.000Z`).toLocaleDateString("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    }),
  }));
}

export type PosMatchProduct = { id: string; sku: string; title: string };

/** Compact catalogue list for the Match picker (id/sku/title), title-sorted. */
export async function getPosMatchProducts(tenantId: string): Promise<PosMatchProduct[]> {
  const rows = await prismaForTenant(tenantId).product.findMany({
    where: { ...BUYABLE_PRODUCT_WHERE },
    select: { id: true, sku: true, title: true },
    orderBy: { title: "asc" },
  });
  return rows.map((r) => ({ id: r.id, sku: r.sku, title: r.title }));
}

export type UnmappedTill = {
  warehouse: string;
  salesCount: number;
};

export type TillMappingRow = {
  /** Raw till name as the POS sends it — the key of the mapping. */
  warehouse: string;
  salesCount: number;
  /** Branch it feeds, or null while it's unmapped. */
  locationId: string | null;
  locationName: string | null;
};

/**
 * Every till the POS has ever sent, mapped or not, for the Locations screen —
 * unmapped first (those are the ones costing a branch its run rate), then by
 * sales volume. Mapped tills with no sales still list, so a mapping can be
 * corrected or removed.
 */
export async function getTillMappings(tenantId: string): Promise<TillMappingRow[]> {
  const db = prismaForTenant(tenantId);
  const [grouped, maps, locations] = await Promise.all([
    db.posSale.groupBy({ by: ["warehouse"], where: { warehouse: { not: null } }, _count: { _all: true } }),
    db.warehouseLocationMap.findMany({ select: { warehouseName: true, locationId: true } }),
    db.location.findMany({ select: { id: true, name: true } }),
  ]);

  const locationName = new Map(locations.map((l) => [l.id, l.name]));
  const mapped = new Map(maps.map((m) => [normalizeSku(m.warehouseName), m]));
  const counts = new Map<string, { warehouse: string; salesCount: number }>();
  for (const g of grouped) {
    if (g.warehouse == null) continue;
    counts.set(normalizeSku(g.warehouse), { warehouse: g.warehouse, salesCount: g._count._all });
  }
  // A mapped till with no sales yet still needs a row to be editable.
  for (const [key, m] of mapped) {
    if (!counts.has(key)) counts.set(key, { warehouse: m.warehouseName, salesCount: 0 });
  }

  return [...counts.entries()]
    .map(([key, c]) => {
      const map = mapped.get(key);
      return {
        warehouse: c.warehouse,
        salesCount: c.salesCount,
        locationId: map?.locationId ?? null,
        locationName: map ? (locationName.get(map.locationId) ?? null) : null,
      };
    })
    .sort((a, b) => {
      if ((a.locationId == null) !== (b.locationId == null)) return a.locationId == null ? -1 : 1;
      return b.salesCount - a.salesCount;
    });
}

/**
 * POS warehouses/tills that sold but aren't mapped to a Location — their sales
 * count in channel totals but no branch's run rate (spec §3). One attention row
 * each, linking to Locations to map them.
 */
export async function getUnmappedTills(tenantId: string): Promise<UnmappedTill[]> {
  const db = prismaForTenant(tenantId);
  const [grouped, maps] = await Promise.all([
    db.posSale.groupBy({
      by: ["warehouse"],
      where: { warehouse: { not: null } },
      _count: { _all: true },
    }),
    db.warehouseLocationMap.findMany({ select: { warehouseName: true } }),
  ]);

  const mapped = new Set(maps.map((m) => normalizeSku(m.warehouseName)));
  return grouped
    .filter((g) => g.warehouse != null && !mapped.has(normalizeSku(g.warehouse)))
    .map((g) => ({ warehouse: g.warehouse as string, salesCount: g._count._all }))
    .sort((a, b) => b.salesCount - a.salesCount);
}
