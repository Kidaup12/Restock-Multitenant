import { numericCore } from "./ids";
import type { ShopifyOrderNode } from "./resources";

/**
 * Pure order → (product, day) aggregation for the idempotent day-set sales
 * writer. Two rules earned by production bugs:
 *
 *  - Bucket by `processedAt ?? createdAt`. createdAt is API-insertion time;
 *    imported / back-dated / POS-channel orders carry the real sale date in
 *    processedAt, and bucketing by createdAt collapses months of history onto
 *    the sync day.
 *  - Look products up by NUMERIC CORE (line items carry gids; the catalog map
 *    is keyed by core), so id-spelling mismatches can't orphan sales.
 */

export type DayBucket = {
  productId: string; // local Product.id
  dateKey: string; // YYYY-MM-DD (UTC)
  quantity: number;
  revenue: number;
  // Fulfilment location (local Location.id) for this bucket; null when the order
  // carried no single location. One bucket PER branch per product-day, so a day
  // split across branches keeps both — the unique key carries locationId.
  locationId: string | null;
};

/** Resolve an order's single fulfilment location (local id), or null when it
 *  has none or shipped from more than one place. */
function orderLocationId(
  order: ShopifyOrderNode,
  locationIdByCore: Map<string, string>
): string | null {
  const ids = new Set<string>();
  for (const f of order.fulfillments ?? []) {
    const gid = f.location?.id;
    if (!gid) continue;
    const local = locationIdByCore.get(numericCore(gid));
    if (local) ids.add(local);
  }
  return ids.size === 1 ? [...ids][0]! : null;
}

/** Units returned per line item across every refund on an order. Keyed by line
 *  item id because that is what carries the price the units were sold at. */
function refundedQtyByLineItem(order: ShopifyOrderNode): Map<string, number> {
  const out = new Map<string, number>();
  for (const refund of order.refunds ?? []) {
    for (const item of refund.refundLineItems ?? []) {
      const id = item.lineItem?.id;
      const qty = item.quantity ?? 0;
      if (!id || qty <= 0) continue;
      out.set(id, (out.get(id) ?? 0) + qty);
    }
  }
  return out;
}

/** Aggregate order line items into (product, day) buckets. `productIdByCore`
 *  maps a Shopify product id CORE → local product id. `dayKeyOf` turns a sale
 *  instant into the trading day it belongs to — required, and not defaulted to
 *  UTC, because the sales day is pinned to the TENANT's timezone: an order
 *  placed at 01:30 in Nairobi is that shop's previous trading day, and slicing
 *  the UTC string would file it a day early and split one day of trade across
 *  two rows while the till's sales for the same day key correctly. The POS
 *  ingest takes the same function, so both channels agree on where a day ends.
 *  `locationIdByCore` (maps a Shopify location id CORE → local Location.id)
 *  enables per-branch attribution; omit it to leave every bucket unattributed.
 *  `productIdByVariantCore` (Shopify VARIANT id CORE → local product id) is
 *  tried first: the catalogue is one row per variant, so a product-id lookup
 *  can only land on an arbitrary sibling of a multi-variant product. The
 *  product map stays as the fallback for lines that carry no variant. */
export function bucketSalesByProductDay(
  orders: ShopifyOrderNode[],
  productIdByCore: Map<string, string>,
  dayKeyOf: (saleAt: Date) => string,
  locationIdByCore?: Map<string, string>,
  productIdByVariantCore?: Map<string, string>
): Map<string, DayBucket> {
  const buckets = new Map<string, DayBucket>();
  for (const order of orders) {
    // A cancelled order never became a sale, so it must not create demand the
    // forecast then tries to replace.
    if (order.cancelledAt) continue;
    const saleAt = order.processedAt ?? order.createdAt;
    if (!saleAt) continue;
    const instant = new Date(saleAt);
    if (Number.isNaN(instant.getTime())) continue;
    const dateKey = dayKeyOf(instant);
    const loc = locationIdByCore ? orderLocationId(order, locationIdByCore) : null;
    const refundedByLine = refundedQtyByLineItem(order);
    for (const line of order.lineItems ?? []) {
      const variantGid = line.variant?.id;
      const productGid = line.product?.id;
      const productId =
        (variantGid ? productIdByVariantCore?.get(numericCore(variantGid)) : undefined) ??
        (productGid ? productIdByCore.get(numericCore(productGid)) : undefined);
      if (!productId) continue; // product not in the catalog — skip
      // Returned units come off the day they were sold, not the day they came
      // back: the shop is asking "how fast does this actually move", and goods
      // that walked back in never moved. A fully returned line drops out.
      const sold = line.quantity ?? 0;
      const qty = sold - (line.id ? (refundedByLine.get(line.id) ?? 0) : 0);
      if (qty <= 0) continue;
      const unit = line.originalUnitPriceSet?.shopMoney?.amount
        ? Number.parseFloat(line.originalUnitPriceSet.shopMoney.amount)
        : 0;
      const revenue = Number.isFinite(unit) ? unit * qty : 0;

      // Keyed by BRANCH as well as product and day. A day that traded at two
      // branches is two rows now, not one unattributed row — losing the busiest
      // days was exactly what made a per-branch rate impossible.
      const key = `${productId}|${dateKey}|${loc ?? ""}`;
      const existing = buckets.get(key);
      if (existing) {
        existing.quantity += qty;
        existing.revenue += revenue;
      } else {
        buckets.set(key, { productId, dateKey, quantity: qty, revenue, locationId: loc });
      }
    }
  }
  return buckets;
}

/**
 * Every trading day the given orders land on — including cancelled and fully
 * refunded ones, whose day still has to be rebuilt (their old sales row must
 * go even though they produce no bucket now).
 */
export function affectedDayKeys(
  orders: ShopifyOrderNode[],
  dayKeyOf: (saleAt: Date) => string
): Set<string> {
  const days = new Set<string>();
  for (const order of orders) {
    const saleAt = order.processedAt ?? order.createdAt;
    if (!saleAt) continue;
    const instant = new Date(saleAt);
    if (Number.isNaN(instant.getTime())) continue;
    days.add(dayKeyOf(instant));
  }
  return days;
}

export type DayKeyRange = { from: string; to: string };

const DAY_MS = 86_400_000;
const dayMs = (dayKey: string) => Date.parse(`${dayKey}T00:00:00.000Z`);

/** Sorted day keys grouped into runs of consecutive days, so each run is one
 *  fetch instead of one per day. */
export function dayKeyRanges(dayKeys: Iterable<string>): DayKeyRange[] {
  const sorted = [...new Set(dayKeys)].sort();
  const ranges: DayKeyRange[] = [];
  for (const day of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && dayMs(day) - dayMs(last.to) === DAY_MS) last.to = day;
    else ranges.push({ from: day, to: day });
  }
  return ranges;
}

/** Wider than any timezone offset, so a UTC window padded by it always covers
 *  a whole tenant day without knowing the tenant's zone. */
const PAD_MS = 14 * 3_600_000;

/**
 * Whether a tenant day may hold sales the `updated_at >= windowStart` pull did
 * not return. An order sold at or after windowStart was necessarily updated at
 * or after it too, so a day lying wholly inside the window is already complete;
 * one that starts before it (an older day an edit touched, or the first hours
 * of a day east of UTC) has to be fetched by sale date before it is rebuilt.
 */
export function dayNeedsRefetch(dayKey: string, windowStart: Date): boolean {
  return dayMs(dayKey) - PAD_MS < windowStart.getTime();
}

/**
 * The UTC instants to fetch so a range of TENANT days is complete. Padded by
 * 14h each side — wider than any timezone offset — so no timezone math is
 * needed here; the caller keeps only orders whose tenant day is in the range.
 */
export function processedWindowFor(range: DayKeyRange): { startIso: string; endIso: string } {
  return {
    startIso: new Date(dayMs(range.from) - PAD_MS).toISOString(),
    endIso: new Date(dayMs(range.to) + DAY_MS + PAD_MS).toISOString(),
  };
}

/**
 * The days to rebuild, and every order sold on them.
 *
 * `changed` is what the `updated_at >= windowStart` pull returned. Its days are
 * the ones to rebuild; any of those that start before the window are re-read
 * by sale date, because rebuilding a day from only its changed orders replaces
 * the whole day with them.
 */
export async function collectDayOrders(
  changed: ShopifyOrderNode[],
  windowStart: Date,
  dayKeyOf: (saleAt: Date) => string,
  fetchSoldBetween: (startIso: string, endIso: string) => Promise<ShopifyOrderNode[]>
): Promise<{ days: Set<string>; orders: ShopifyOrderNode[] }> {
  const days = affectedDayKeys(changed, dayKeyOf);
  const byId = new Map(changed.map((o) => [o.id, o]));
  const toRefetch = [...days].filter((day) => dayNeedsRefetch(day, windowStart));
  for (const range of dayKeyRanges(toRefetch)) {
    const { startIso, endIso } = processedWindowFor(range);
    for (const order of await fetchSoldBetween(startIso, endIso)) byId.set(order.id, order);
  }
  // The padded fetch brings in neighbouring days; only the rebuilt ones count.
  const orders = [...byId.values()].filter((order) => {
    const at = order.processedAt ?? order.createdAt;
    return at ? days.has(dayKeyOf(new Date(at))) : false;
  });
  return { days, orders };
}

/**
 * Day-aligned start of a sync window.
 *
 *  - First run (no cursor): look back `firstRunLookbackDays`.
 *  - Subsequent runs: stored cursor minus `overlapHours` of safety (late /
 *    edited records), floored to UTC midnight so whole days are re-pulled —
 *    required for the idempotent day-set sales writer.
 */
export function computeWindowStart(
  cursor: Date | null,
  now: Date,
  opts: { overlapHours: number; firstRunLookbackDays: number }
): Date {
  const base = cursor
    ? new Date(cursor.getTime() - opts.overlapHours * 3600_000)
    : new Date(now.getTime() - opts.firstRunLookbackDays * 24 * 3600_000);
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
}
