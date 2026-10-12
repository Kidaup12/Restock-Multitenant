import { prismaService } from "@wezesha/db";
import { aggregateStoredPosLines, planPosIngest } from "./aggregate";
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
 *   - SalesHistory channel="pos": old and new touched local days are rebuilt
 *     from every stored receipt, so partial payloads cannot truncate a day.
 * Raw replacement and derived rebuilding commit together.
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
  // eslint-disable-next-line tenant-safety/require-tenant-scope -- reads the caller's own tenant by the id authenticatePosFeed already proved; the blanket ban on single-row tenant lookups is what trips here.
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

  return prismaService.$transaction(async (tx) => {
    // Serialize feed requests and repair for this tenant. A full-day rebuild must
    // see every committed receipt, including simultaneous partial payloads.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId}, 0))`;

    const [products, ignoreRules, warehouseMaps, matchedHistory] = await Promise.all([
      tx.product.findMany({
        where: { tenantId },
        select: { id: true, sku: true, priceKes: true },
      }),
      tx.ignoreRule.findMany({
        where: { tenantId, kind: "till_sku" },
        select: { value: true },
      }),
      tx.warehouseLocationMap.findMany({
        where: { tenantId },
        select: { warehouseName: true, locationId: true },
      }),
      // Learned matches: till SKUs a human matched (Match action) that differ from
      // any Product.sku. Read BEFORE the set-semantics delete so a re-pull of the
      // same window re-applies the link instead of dropping it back to unmatched.
      tx.posSaleLine.findMany({
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
    // Include online corrections: removing a formerly physical receipt must also
    // remove its old contribution. Include OLD days when receipt dates change.
    const externalIds = [...new Set(args.sales.map((s) => s.externalId))];
    const previous = await tx.posSale.findMany({
      where: { tenantId, externalId: { in: externalIds } },
      select: { date: true },
    });
    await tx.posSale.deleteMany({
      where: { tenantId, externalId: { in: externalIds } },
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
      await tx.posSale.createMany({ data: saleRows.slice(i, i + CHUNK) });
    }
    for (let i = 0; i < lineRows.length; i += CHUNK) {
      await tx.posSaleLine.createMany({ data: lineRows.slice(i, i + CHUNK) });
    }

    // ── Derived SalesHistory channel="pos": set-semantics by (product, day) ──
    const dayKeys = [...new Set([...previous, ...saleRows].map((s) => tenantDayKey(tenant.timezone, s.date)))];
    const rebuilt = await rebuildDays(tx, tenantId, tenant.timezone, dayKeys, {
      skuToProductId,
      ignoredSkus: new Set(ignoreRules.map((r) => normalizeSku(r.value))),
      priceByProductId: new Map(products.map((p) => [p.id, p.priceKes ?? 0])),
      warehouseToLocationId: new Map(warehouseMaps.map((w) => [normalizeSku(w.warehouseName), w.locationId])),
    });

    return {
      ok: true,
      tenantId,
      salesIngested: plan.sales.length,
      salesExcluded: plan.salesExcluded,
      linesMatched: plan.linesMatched,
      linesUnmatched: plan.linesUnmatched,
      linesIgnored: plan.linesIgnored,
      salesHistoryRows: rebuilt,
      unmatchedSkus: plan.unmatched.length,
      sampleUnmatchedSkus: plan.unmatched.slice(0, 10).map((u) => u.sku),
    };
  }, { maxWait: 30_000, timeout: 120_000 });
}

type RollupTx = Pick<typeof prismaService, "posSaleLine" | "salesHistory">;
type RollupMaps = {
  skuToProductId: Map<string, string>;
  ignoredSkus: Set<string>;
  priceByProductId: Map<string, number>;
  warehouseToLocationId: Map<string, string>;
};

/** Whole-day replacement from the complete ledger, inside the caller's transaction. */
async function rebuildDays(tx: RollupTx, tenantId: string, timezone: string, dayKeys: string[], maps: RollupMaps): Promise<number> {
  if (!dayKeys.length) return 0;
  const wanted = new Set(dayKeys);
  const days = [...wanted].map(dayMarker);
  const since = new Date(Math.min(...days.map(Number)) - 36 * 3_600_000);
  const until = new Date(Math.max(...days.map(Number)) + 36 * 3_600_000);
  const raw = await tx.posSaleLine.findMany({
    where: { tenantId, posSale: { tenantId, channel: "physical", date: { gte: since, lt: until } } },
    select: { sku: true, productId: true, qty: true, price: true, subtotal: true, posSale: { select: { date: true, warehouse: true } } },
  });
  const lines = raw.flatMap((line) => {
    const key = normalizeSku(line.sku);
    if (maps.ignoredSkus.has(key) || !wanted.has(tenantDayKey(timezone, line.posSale.date))) return [];
    // Keep explicit human matches; current catalogue/learned matches recover
    // receipts whose product did not exist at their original ingest.
    const productId = line.productId ?? maps.skuToProductId.get(key);
    if (!productId || !maps.priceByProductId.has(productId)) return [];
    return [{ productId, qty: line.qty, price: line.price, subtotal: line.subtotal, saleDate: line.posSale.date, warehouse: line.posSale.warehouse }];
  });
  const rows = aggregateStoredPosLines(lines, { ...maps, dayKeyOf: (d) => tenantDayKey(timezone, d) });
  // Clear even days whose last matched line moved, was removed, or became online.
  await tx.salesHistory.deleteMany({ where: { tenantId, channel: "pos", date: { in: days } } });
  for (let i = 0; i < rows.length; i += CHUNK) {
    await tx.salesHistory.createMany({ data: rows.slice(i, i + CHUNK).map((r) => ({ tenantId, productId: r.productId, date: dayMarker(r.dayKey), quantity: r.quantity, revenueKes: r.revenueKes, channel: "pos", locationId: r.locationId })) });
  }
  return rows.length;
}

/** Repair every local day in the recent window, including stale derived-only days. */
export async function healPosRollup(tenantId: string, trailingDays = 35, now = new Date()): Promise<{ days: number; rows: number } | null> {
  if (!Number.isInteger(trailingDays) || trailingDays < 1 || trailingDays > 366) throw new Error("trailingDays must be between 1 and 366");
  // eslint-disable-next-line tenant-safety/require-tenant-scope -- system repair resolves its caller-authorized tenant id.
  const tenant = await prismaService.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
  if (!tenant) return null;
  return prismaService.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId}, 0))`;
    const [products, ignores, warehouses, matches] = await Promise.all([
      tx.product.findMany({ where: { tenantId }, select: { id: true, sku: true, priceKes: true } }),
      tx.ignoreRule.findMany({ where: { tenantId, kind: "till_sku" }, select: { value: true } }),
      tx.warehouseLocationMap.findMany({ where: { tenantId }, select: { warehouseName: true, locationId: true } }),
      tx.posSaleLine.findMany({ where: { tenantId, productId: { not: null } }, select: { sku: true, productId: true }, distinct: ["sku", "productId"] }),
    ]);
    const skuToProductId = resolvePosSkuMap(products);
    mergeLearnedAliases(skuToProductId, matches);
    const today = dayMarker(tenantDayKey(tenant.timezone, now));
    const days = Array.from({ length: trailingDays }, (_, i) => new Date(+today - i * 86_400_000).toISOString().slice(0, 10));
    const rows = await rebuildDays(tx, tenantId, tenant.timezone, days, {
      skuToProductId,
      ignoredSkus: new Set(ignores.map((r) => normalizeSku(r.value))),
      priceByProductId: new Map(products.map((p) => [p.id, p.priceKes ?? 0])),
      warehouseToLocationId: new Map(warehouses.map((w) => [normalizeSku(w.warehouseName), w.locationId])),
    });
    return { days: days.length, rows };
  }, { maxWait: 30_000, timeout: 120_000 });
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
