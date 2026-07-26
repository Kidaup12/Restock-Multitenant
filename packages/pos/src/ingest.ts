import { prismaService } from "@wezesha/db";
import { planPosIngest } from "./aggregate";
import type { PlannedSalesHistoryRow } from "./aggregate";
import { resolvePosSkuMap } from "./match";
import { normalizeSku } from "./normalize";
import { dayMarker, parsePosDate, tenantDayKey } from "./time";
import type { PosSaleInput } from "./types";

/**
 * POS ingest writer — the system/feed path. Runs on prismaService (BYPASSRLS)
 * WITH an explicit tenantId on every query, exactly like the Shopify sync: this
 * is a feed with no session, the documented use of the service client. Set
 * semantics on both stores make a re-run of any window overwrite, never double:
 *   - PosSale/PosSaleLine: deleted + recreated by (tenantId, externalId).
 *   - SalesHistory channel="pos": the touched (product, day) rows are deleted +
 *     recreated (partial windows leave other product-days untouched).
 */

export type PosIngestResult = {
  ok: true;
  tenantId: string;
  salesIngested: number;
  /** Online receipts skipped (already in SalesHistory via the Shopify sync). */
  salesExcluded: number;
  linesMatched: number;
  linesUnmatched: number;
  linesIgnored: number;
  salesHistoryRows: number;
  unmatchedSkus: number;
  sampleUnmatchedSkus: string[];
};

const CHUNK = 500;

/**
 * Fold human-matched SKU→product links learned from history into the match map,
 * for till codes no Product.sku covers. Exact Product.sku always wins (never
 * overridden); a code matched to two different products in history is ambiguous
 * and left unmatched (surfaces in the queue) rather than guessed.
 */
function mergeLearnedAliases(
  skuToProductId: Map<string, string>,
  matchedHistory: Array<{ sku: string; productId: string | null }>
): void {
  const byKey = new Map<string, Set<string>>();
  for (const row of matchedHistory) {
    if (!row.productId) continue;
    const key = normalizeSku(row.sku);
    if (!key || skuToProductId.has(key)) continue; // empty, or Product.sku already covers it
    let set = byKey.get(key);
    if (!set) byKey.set(key, (set = new Set()));
    set.add(row.productId);
  }
  for (const [key, productIds] of byKey) {
    if (productIds.size === 1) skuToProductId.set(key, [...productIds][0]!);
  }
}

/** Ingest a window of physical sales for one tenant. Null = unknown tenant.
 *  The tenantId is the caller's to prove: on the feed path it comes from
 *  authenticatePosFeed (src/auth.ts), never straight off a request body. */
export async function ingestPosSales(args: {
  tenantId: string;
  sales: PosSaleInput[];
}): Promise<PosIngestResult | null> {
  const { tenantId } = args;
  const tenant = await prismaService.tenant.findUnique({
    where: { id: tenantId },
    select: { timezone: true },
  });
  if (!tenant) return null;

  const empty: PosIngestResult = {
    ok: true,
    tenantId,
    salesIngested: 0,
    salesExcluded: 0,
    linesMatched: 0,
    linesUnmatched: 0,
    linesIgnored: 0,
    salesHistoryRows: 0,
    unmatchedSkus: 0,
    sampleUnmatchedSkus: [],
  };
  if (args.sales.length === 0) return empty;

  const [products, ignoreRules, warehouseMaps, matchedHistory] = await Promise.all([
    prismaService.product.findMany({
      where: { tenantId },
      select: { id: true, sku: true, priceKes: true },
    }),
    prismaService.ignoreRule.findMany({
      where: { tenantId, kind: "till_sku" },
      select: { value: true },
    }),
    prismaService.warehouseLocationMap.findMany({
      where: { tenantId },
      select: { warehouseName: true, locationId: true },
    }),
    // Learned matches: till SKUs a human matched (Match action) that differ from
    // any Product.sku. Read BEFORE the set-semantics delete so a re-pull of the
    // same window re-applies the link instead of dropping it back to unmatched.
    prismaService.posSaleLine.findMany({
      where: { tenantId, productId: { not: null } },
      select: { sku: true, productId: true },
      distinct: ["sku", "productId"],
    }),
  ]);

  const skuToProductId = resolvePosSkuMap(products);
  mergeLearnedAliases(skuToProductId, matchedHistory);

  const plan = planPosIngest({
    // Resolve wall-clock strings to instants in the tenant timezone up front, so
    // the pure planner only ever sees Dates.
    sales: args.sales.map((s) => ({ ...s, date: parsePosDate(s.date, tenant.timezone) })),
    skuToProductId,
    ignoredSkus: new Set(ignoreRules.map((r) => normalizeSku(r.value))),
    priceByProductId: new Map(products.map((p) => [p.id, p.priceKes ?? 0])),
    warehouseToLocationId: new Map(warehouseMaps.map((w) => [normalizeSku(w.warehouseName), w.locationId])),
    dayKeyOf: (d) => tenantDayKey(tenant.timezone, d),
  });

  // ── Raw store: set-semantics by externalId (delete cascades lines) ──
  await prismaService.posSale.deleteMany({
    where: { tenantId, externalId: { in: plan.externalIds } },
  });
  const saleRows = plan.sales.map((s) => ({
    id: crypto.randomUUID(),
    tenantId,
    externalId: s.externalId,
    reference: s.reference,
    date: s.date,
    createdBy: s.createdBy,
    salesAgent: s.salesAgent,
    warehouse: s.warehouse,
    customer: s.customer,
    saleStatus: s.saleStatus,
    paymentStatus: s.paymentStatus,
    grandTotal: s.grandTotal,
    channel: s.channel,
  }));
  const lineRows = plan.sales.flatMap((s, i) =>
    s.lines.map((l) => ({
      id: crypto.randomUUID(),
      posSaleId: saleRows[i]!.id,
      tenantId,
      sku: l.sku,
      productName: l.productName,
      qty: l.qty,
      price: l.price,
      subtotal: l.subtotal,
      productId: l.productId,
    }))
  );
  for (let i = 0; i < saleRows.length; i += CHUNK) {
    await prismaService.posSale.createMany({ data: saleRows.slice(i, i + CHUNK) });
  }
  for (let i = 0; i < lineRows.length; i += CHUNK) {
    await prismaService.posSaleLine.createMany({ data: lineRows.slice(i, i + CHUNK) });
  }

  // ── Derived SalesHistory channel="pos": set-semantics by (product, day) ──
  await writeDerivedPosSalesHistory(tenantId, plan.salesHistory);

  return {
    ok: true,
    tenantId,
    salesIngested: plan.sales.length,
    salesExcluded: plan.salesExcluded,
    linesMatched: plan.linesMatched,
    linesUnmatched: plan.linesUnmatched,
    linesIgnored: plan.linesIgnored,
    salesHistoryRows: plan.salesHistory.length,
    unmatchedSkus: plan.unmatched.length,
    sampleUnmatchedSkus: plan.unmatched.slice(0, 10).map((u) => u.sku),
  };
}

/**
 * Idempotent day-set writer for derived POS SalesHistory: delete exactly the
 * touched (product, day) channel="pos" rows, then recreate — so an overlapping
 * re-ingest overwrites the same rows instead of doubling them. Runs on the
 * service client with an explicit tenantId (system derivation).
 */
export async function writeDerivedPosSalesHistory(
  tenantId: string,
  rows: PlannedSalesHistoryRow[]
): Promise<number> {
  if (rows.length === 0) return 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await prismaService.salesHistory.deleteMany({
      where: {
        tenantId,
        channel: "pos",
        OR: chunk.map((r) => ({ productId: r.productId, date: dayMarker(r.dayKey) })),
      },
    });
    await prismaService.salesHistory.createMany({
      data: chunk.map((r) => ({
        tenantId,
        productId: r.productId,
        date: dayMarker(r.dayKey),
        quantity: r.quantity,
        revenueKes: r.revenueKes,
        channel: "pos",
        locationId: r.locationId,
      })),
    });
  }
  return rows.length;
}
