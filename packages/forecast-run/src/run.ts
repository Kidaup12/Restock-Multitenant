import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import {
  BUYABLE_PRODUCT_WHERE,
  OUTSTANDING_PO_STATUSES,
  effectiveOnOrder,
  isSellable,
  outstandingByProduct,
  prismaForTenant,
  prismaForTenantTx,
} from "@wezesha/db";
import {
  assignAbc,
  dailySalesValue,
  forecastProduct,
  historySpanDays,
  anchorToday,
  championForClass,
  policyForClass,
  resolveChampions,
  resolveForecastKnobs,
  selectProxy,
  isEstablishedProxy,
  borrowedForecast30d,
  selectPriorForProduct,
  applyOwnerPrior,
  windowsForProduct,
  expandPromoWindowsToDays,
  boundedMultiplier,
  assessIngestHealth,
  type IngestVerdict,
  type ActivePromo,
  type MonthlyExpectation,
  type DemandOverride,
  type OwnerPriorFacts,
  type PredictionFields,
  type PromoWindow,
  type ProxyCandidate,
  type ProxyTarget,
  type SalesPoint,
} from "@wezesha/forecast";
import { publishEvent } from "@wezesha/realtime";

/**
 * One forecast run for one tenant: load facts + history + owner priors, run the
 * pure engine per product, resolve cold-start borrows and owner expectations
 * across the catalogue, then replace the tenant's Prediction rows under a shared
 * forecastRunId and announce forecast.done over realtime.
 *
 * Trust layer (spec §6), persisted so the surfaces read it instead of
 * recomputing: a confidence WORD on every number, cold-start state (too-new /
 * borrowed, never a silent zero), the borrowed-from proxy, the owner-prior
 * chip, and the reproducible reorder breakdown (explainParts).
 *
 * The run also appends to ForecastRecommendation — the history Prediction cannot
 * be, since it is replaced wholesale here. That is what makes "how much of what
 * we asked for did the owner actually buy?" a measurement rather than a guess.
 *
 * Everything — reads AND writes — goes through the RLS-enforced tenant client:
 * the run is a single-tenant path, so the service client has no business here.
 * The delete-then-create replacement runs inside one tenant transaction.
 */

const DAY_MS = 86_400_000;
/** History window fed to the engine — matches its 30/90/365-day rate windows. */
const HISTORY_DAYS = 365;
/** A history-less product is a cold start only if it is genuinely NEW. An older
 *  listing with no sales is a dead dud, not a cold start — it keeps the engine's
 *  "recommend nothing" behaviour and never borrows a shape (spec §6/§11:
 *  dead-stock is "new vs old dud"). Age comes from shopifyCreatedAt. */
const COLD_START_MAX_AGE_DAYS = 60;
/** How long the recommendation history stays queryable. A year plus five weeks:
 *  long enough that "this week vs the same week last year" still has last year's
 *  row, short enough that the table never grows without bound. */
const RECOMMENDATION_RETENTION_DAYS = 400;
/** Urgencies kept in the history even when the run asked for nothing — the case
 *  worth auditing later is exactly "it was about to run out and we still
 *  recommended zero" (too new, no cost, capped). Everything else with a zero ask
 *  carries no adherence signal and is not written. */
const KEPT_ZERO_QTY_URGENCIES = new Set(["critical", "high"]);

function isGenuinelyNew(shopifyCreatedAt: Date | null, now: Date): boolean {
  if (shopifyCreatedAt == null) return true; // no age signal — a history-less row reads as new
  return (now.getTime() - shopifyCreatedAt.getTime()) / DAY_MS <= COLD_START_MAX_AGE_DAYS;
}

/** UTC-midnight day-key (ms) for a stored closure date. */
function dayKeyMs(d: Date): number {
  const t = new Date(d);
  t.setUTCHours(0, 0, 0, 0);
  return t.getTime();
}

/** Day-keys on which EVERY Sells-role location was closed. A partial closure
 *  (one branch of several shut) is deliberately left in the rate — censoring it
 *  would over-correct a multi-branch tenant, so v1 only drops fully-closed days. */
function fullClosureDayKeys(
  closures: Array<{ locationId: string; date: Date }>,
  sellsLocationIds: Set<string>
): Date[] {
  if (sellsLocationIds.size === 0) return [];
  const closedByDay = new Map<number, Set<string>>();
  for (const c of closures) {
    if (!sellsLocationIds.has(c.locationId)) continue;
    const k = dayKeyMs(c.date);
    let set = closedByDay.get(k);
    if (!set) closedByDay.set(k, (set = new Set()));
    set.add(c.locationId);
  }
  const out: Date[] = [];
  for (const [k, closed] of closedByDay) {
    if (closed.size >= sellsLocationIds.size) out.push(new Date(k));
  }
  return out;
}

export type ForecastRunResult = {
  created: number;
  forecastRunId: string;
  /** Set when the run was skipped to protect the last-good forecast — currently
   *  only "ingest_stale" (the sales feed looked stopped, so nothing was written). */
  skipped?: "ingest_stale";
};

/** Feed considered stopped past this — one notification per rolling window. */
const INGEST_STALL_DEDUP_DAYS = 3;

const r0 = (n: number) => Math.round(n);

/** Short chip text for an owner prior applied to a number. */
function priorLabel(p: OwnerPriorFacts): string {
  if (p.expectedUnits != null) return `Owner expects ~${r0(p.expectedUnits)}/mo`;
  if (p.multiplier != null) return `Owner set ${p.multiplier}× for this ${p.scope}`;
  return "Owner prior applied";
}

/**
 * Assess the whole tenant's ingest before forecasting. Rolls the loaded sales
 * rows up into one units-per-day series (all products, all channels), excluding
 * today (partial), and finds the newest sale timestamp — the two facts the pure
 * `assessIngestHealth` needs to tell a stopped feed from a genuinely quiet shop.
 */
function assessTenantIngest(
  sales: ReadonlyArray<{ date: Date; quantity: number }>,
  now: Date
): IngestVerdict {
  const todayKey = dayKeyMs(now);
  const byDay = new Map<number, number>();
  let latestSaleAt: Date | null = null;
  for (const row of sales) {
    const key = dayKeyMs(row.date);
    if (key >= todayKey) continue; // today is partial — judge completed days only
    byDay.set(key, (byDay.get(key) ?? 0) + row.quantity);
    if (latestSaleAt == null || row.date > latestSaleAt) latestSaleAt = row.date;
  }
  const daily = [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([dayKey, units]) => ({ dayKey, units }));
  // A shop that has barely ever sold has no established feed to call "stopped" —
  // an empty history is a young tenant, not a broken feed. Only judge staleness
  // once there is a real trading history to compare the silence against, so the
  // gate never blocks a new shop's very first forecast.
  const MIN_DAYS_TO_JUDGE = 14;
  if (daily.filter((d) => d.units > 0).length < MIN_DAYS_TO_JUDGE) {
    return { ok: true, stop: false, impute: false, gapDayKeys: [], reasons: [], stale: false, trailingNorm: 0 };
  }
  return assessIngestHealth(daily, latestSaleAt, now);
}

/**
 * Tell the owner the feed looks stopped and the forecast was held. One bell
 * notification per rolling window so a multi-day outage doesn't spam. Best-
 * effort: the stall protection (keeping the last-good forecast) already
 * happened; a failed notification write must not turn a safe skip into an error.
 */
async function raiseIngestStall(tenantId: string, verdict: IngestVerdict, now: Date): Promise<void> {
  try {
    const db = prismaForTenant(tenantId);
    const dedupSince = new Date(now.getTime() - INGEST_STALL_DEDUP_DAYS * DAY_MS);
    const recent = await db.notification.findFirst({
      where: { kind: "forecast_held_stale_feed", createdAt: { gte: dedupSince } },
      select: { id: true },
    });
    if (recent) return;
    await db.notification.create({
      data: {
        tenantId,
        kind: "forecast_held_stale_feed",
        title: "Forecast paused — your sales feed looks stopped",
        body:
          `${verdict.reasons.join(" ")} We kept your last buy list rather than ` +
          `telling you to order nothing off a gap. Reconnect the feed and it will refresh.`,
      },
    });
  } catch {
    // never let a bookkeeping failure undo a safe skip
  }
}

export async function runForecast(tenantId: string): Promise<ForecastRunResult> {
  const now = new Date();
  const historySince = new Date(now.getTime() - HISTORY_DAYS * DAY_MS);

  // One connection for the whole read phase. Issued as a Promise.all these become
  // one transaction per query, so the batch asks the pool for ten connections at
  // once and everything behind the slowest read times out waiting — which is how
  // the nightly run died against a pooled `connection_limit=1`. Sequential on one
  // connection cannot starve itself at any pool size.
  const {
    products,
    config,
    promos,
    pastPromos,
    closures,
    locations,
    monthlyContext,
    sales,
    priorRows,
    emptyShelfDays,
    firstSnapshot,
  } = await prismaForTenantTx(
    tenantId,
    async (tx) => ({
      // One predicate decides what the shop still sells — testers and damaged
      // stock, anything the store drafted or archived, anything that vanished
      // from it. They stay visible in the catalogue and earn no forecast, so
      // nothing the shop stopped selling can reach a buy list.
      products: await tx.product.findMany({
        where: { ...BUYABLE_PRODUCT_WHERE },
        select: {
          id: true,
          sku: true,
          title: true,
          productType: true,
          vendor: true,
          customCategory: true,
          priceKes: true,
          costKes: true,
          currentStock: true,
          onOrder: true,
          leadTimeDays: true,
          shopifyCreatedAt: true,
          supplier: { select: { leadTimeAvgDays: true, leadTimeStdDays: true } },
        },
      }),
      config: await tx.tenantConfig.findFirst(),
      promos: await tx.promo.findMany({
        where: { deletedAt: null, startDate: { lte: now }, endDate: { gte: now } },
        select: { discountPct: true, promoType: true, channel: true, scope: true, scopeValue: true },
      }),
      // Past/ongoing promo windows overlapping the history window: their spike days
      // are censored from the baseline run rate (distinct from the active-promo LIFT
      // above, which boosts the forward forecast).
      pastPromos: await tx.promo.findMany({
        where: { deletedAt: null, startDate: { lte: now }, endDate: { gte: historySince } },
        select: { startDate: true, endDate: true, scope: true, scopeValue: true },
      }),
      // Shop-closure days across the history window, censored so a closed-day zero
      // doesn't deflate the rate. Per-location; the full-closure filter is below.
      closures: await tx.locationClosure.findMany({
        where: { date: { gte: historySince } },
        select: { locationId: true, date: true },
      }),
      locations: await tx.location.findMany({ select: { id: true, locationType: true } }),
      // Months the shop has told us run above or below normal. Only rows
      // carrying a multiplier matter here — the rest of MonthlyContext is the
      // shop's own free-text notes, which the forecast cannot read.
      monthlyContext: await tx.monthlyContext.findMany({
        where: { expectedMultiplier: { not: null } },
        select: { month: true, expectedMultiplier: true },
      }),
      sales: await tx.salesHistory.findMany({
        where: { date: { gte: historySince } },
        select: { productId: true, date: true, quantity: true, revenueKes: true, channel: true },
      }),
      priorRows: await tx.ownerPrior.findMany({
        where: { revokedAt: null },
        select: {
          scope: true,
          scopeValue: true,
          expectedUnits: true,
          multiplier: true,
          proxyProductId: true,
          weeks: true,
          createdAt: true,
          revokedAt: true,
        },
      }),
      // The in-stock-day denominator: every product-day the nightly snapshot
      // recorded an empty shelf. ONE query for the whole catalogue (never a lookup
      // per product), and only the empty rows travel — the in-stock majority stays
      // in the database. Indexed on (tenantId, date).
      emptyShelfDays: await tx.inventorySnapshot.findMany({
        where: { date: { gte: historySince }, onHand: { lte: 0 } },
        select: { productId: true, date: true },
      }),
      // How far back the snapshots reach. Older history has no proof either way and
      // keeps gap inference, so a tenant a week into snapshotting is not read as
      // having been in stock all year.
      firstSnapshot: await tx.inventorySnapshot.findFirst({
        orderBy: { date: "asc" },
        select: { date: true },
      }),
    }),
    { maxWait: 30_000, timeout: 120_000 }
  );

  // Units we ordered ourselves and have not received. Why this exists and why
  // it combines with MAX rather than a sum lives with the rule, in
  // packages/db/src/inbound.ts — the buy list reads the same one.
  const outstandingPoUnits = outstandingByProduct(
    await prismaForTenantTx(tenantId, (tx) =>
      tx.purchaseOrderLine.findMany({
        where: {
          purchaseOrder: {
            status: { in: [...OUTSTANDING_PO_STATUSES] },
            deletedAt: null,
          },
        },
        select: { productId: true, quantity: true, receivedQty: true },
      })
    )
  );

  /** What is genuinely inbound for this product, from either source. */
  const inboundFor = (product: { id: string; onOrder: number }): number =>
    effectiveOnOrder(product.onOrder, outstandingPoUnits.get(product.id) ?? 0);

  const historyByProduct = new Map<string, SalesPoint[]>();
  for (const row of sales) {
    let list = historyByProduct.get(row.productId);
    if (!list) historyByProduct.set(row.productId, (list = []));
    list.push(row);
  }

  const stockoutsByProduct = new Map<string, Date[]>();
  for (const row of emptyShelfDays) {
    let list = stockoutsByProduct.get(row.productId);
    if (!list) stockoutsByProduct.set(row.productId, (list = []));
    list.push(row.date);
  }
  const snapshotsSince = firstSnapshot?.date ?? undefined;

  // ── Ingest-health gate: "no data ≠ no demand" ────────────────────────────
  // A silently broken sales feed looks exactly like a shop that sold nothing.
  // Forecasting off that hole would confidently tell the owner to order nothing
  // for a month. Before writing a fresh forecast, sanity-check the ingest
  // against the shop's own recent norm: if the feed is STALE (or too many recent
  // days came in far below normal), keep the last-good predictions and alert the
  // owner rather than overwrite them with a zero-demand run.
  const ingest = assessTenantIngest(sales, now);
  if (ingest.stop) {
    await raiseIngestStall(tenantId, ingest, now);
    // Keep the last-good forecast: return without touching Prediction rows.
    return { created: 0, forecastRunId: "", skipped: "ingest_stale" };
  }

  // Cross-product steps the pure pipeline leaves to the caller.
  const knobs = resolveForecastKnobs(config);
  // The method each class earned in the last audition; run rate until audited.
  const champions = resolveChampions(config?.forecastChampions);
  // This is the ONE place a product's current ABC class is decided; the column
  // it writes is what every screen reads. `now` is passed explicitly rather than
  // left to default: a run replayed with a fixed clock must rank against the
  // run's own date, not against whenever it happens to be executed.
  const abcByProduct = assignAbc(
    products.map((p) => ({
      id: p.id,
      revenue: dailySalesValue(historyByProduct.get(p.id) ?? [], p.priceKes, now),
    }))
  );
  const activePromos: ActivePromo[] = promos;
  // Stated seasonality, bounded here so a slipped decimal in the database can
  // never reach the sizing. The engine blends whichever months its horizon
  // touches; a month nobody stated counts as normal.
  const monthlyExpectations: MonthlyExpectation[] = monthlyContext.flatMap((m) => {
    const multiplier = boundedMultiplier(m.expectedMultiplier);
    return multiplier == null ? [] : [{ month: m.month, multiplier }];
  });
  const runDateKey = now.toISOString().slice(0, 10);
  const today = anchorToday(runDateKey);
  const priorFacts: OwnerPriorFacts[] = priorRows.map((p) => ({
    scope: p.scope === "brand" ? "brand" : "product",
    scopeValue: p.scopeValue,
    expectedUnits: p.expectedUnits,
    multiplier: p.multiplier,
    proxyProductId: p.proxyProductId,
    weeks: p.weeks,
    createdAt: p.createdAt,
    revokedAt: p.revokedAt,
  }));

  const titleById = new Map(products.map((p) => [p.id, p.title]));

  // Days censored from the baseline run rate: past-promo spike days (matched per
  // product) ∪ days the shop was fully closed. Promo spikes would otherwise
  // permanently over-order; closed-day zeros would deflate the rate.
  const pastPromoWindows: PromoWindow[] = pastPromos.map((p) => ({
    start: p.startDate,
    end: p.endDate,
    scope: p.scope,
    scopeValue: p.scopeValue,
  }));
  const sellsLocationIds = new Set(locations.filter(isSellable).map((l) => l.id));
  const fullClosureDays = fullClosureDayKeys(closures, sellsLocationIds);
  const excludedByProduct = new Map<string, Date[]>();
  for (const product of products) {
    const windows = windowsForProduct(pastPromoWindows, {
      sku: product.sku,
      productType: product.productType,
      vendor: product.vendor,
    });
    const promoDays = expandPromoWindowsToDays(windows, historySince, now);
    excludedByProduct.set(product.id, [...promoDays, ...fullClosureDays]);
  }

  // Pass 1: forecast every product from its own history (no override). This
  // gives the run rate that established products lend as cold-start proxies.
  const firstPass = new Map<string, PredictionFields>();
  const spanByProduct = new Map<string, number>();
  const factsById = new Map<string, ProxyCandidate>();
  for (const product of products) {
    const history = historyByProduct.get(product.id) ?? [];
    const abcCategory = abcByProduct[product.id] ?? null;
    const fields = forecastProduct({
      productId: product.id,
      product: {
        sku: product.sku,
        productType: product.productType,
        vendor: product.vendor,
        currentStock: product.currentStock,
        onOrder: inboundFor(product),
        leadTimeDays: product.leadTimeDays,
        priceKes: product.priceKes,
        costKes: product.costKes,
      },
      supplier: product.supplier,
      history,
      activePromos,
      monthlyExpectations,
      abcCategory,
      stockoutDates: stockoutsByProduct.get(product.id),
      snapshotsSince,
      excludedDates: excludedByProduct.get(product.id),
      policy: policyForClass(knobs.methods, abcCategory),
      demandMethod: championForClass(champions, abcCategory),
      serviceZ: knobs.serviceZ,
      capMultiple: knobs.capMultiple,
      runDateKey,
    });
    firstPass.set(product.id, fields);
    const span = historySpanDays(history, today);
    spanByProduct.set(product.id, span);
    factsById.set(product.id, {
      productId: product.id,
      vendor: product.vendor,
      customCategory: product.customCategory,
      historyDays: span,
      dailyRate: fields.layer1Forecast30d / 30, // the pure run rate, promo/cap aside
      priceKes: product.priceKes,
    });
  }
  const candidates = [...factsById.values()].filter(isEstablishedProxy);

  const forecastRunId = randomUUID();
  const runDate = now;

  const rows = products.map((product) => {
    const history = historyByProduct.get(product.id) ?? [];
    const abcCategory = abcByProduct[product.id] ?? null;
    const first = firstPass.get(product.id)!;
    const hasHistory = history.length > 0;
    const target: ProxyTarget = {
      productId: product.id,
      vendor: product.vendor,
      customCategory: product.customCategory,
      priceKes: product.priceKes,
    };
    const prior = selectPriorForProduct(priorFacts, { id: product.id, vendor: product.vendor }, now);

    let override: DemandOverride | null = null;
    let coldStart: "too_new" | "borrowed" | null = null;
    let borrowedFromProductId: string | null = null;

    if (!hasHistory && isGenuinelyNew(product.shopifyCreatedAt, now)) {
      // Cold start: never a silent zero. Owner "sell like X" wins, then owner
      // "I expect about X", then an auto-borrow from a similar established
      // product, else an honest "too new to forecast". An OLD history-less
      // product skips this entirely — it is a dead dud, not a cold start.
      const ownerProxy =
        prior?.proxyProductId != null ? factsById.get(prior.proxyProductId) ?? null : null;
      if (ownerProxy && isEstablishedProxy(ownerProxy)) {
        override = {
          forecast30d: borrowedForecast30d(ownerProxy, target),
          source: "borrowed",
          label: `Borrowed from ${titleById.get(ownerProxy.productId) ?? "a similar product"}`,
        };
        coldStart = "borrowed";
        borrowedFromProductId = ownerProxy.productId;
      } else if (prior?.expectedUnits != null) {
        override = { forecast30d: prior.expectedUnits, source: "owner_prior", label: priorLabel(prior) };
      } else {
        const proxy = selectProxy(target, candidates);
        if (proxy) {
          override = {
            forecast30d: borrowedForecast30d(proxy, target),
            source: "borrowed",
            label: `Borrowed from ${titleById.get(proxy.productId) ?? "a similar product"}`,
          };
          coldStart = "borrowed";
          borrowedFromProductId = proxy.productId;
        } else {
          coldStart = "too_new";
        }
      }
    } else if (prior && (prior.expectedUnits != null || prior.multiplier != null)) {
      // Established product with an owner expectation/multiplier.
      override = {
        forecast30d: applyOwnerPrior(first.finalForecast30d, prior),
        source: "owner_prior",
        label: priorLabel(prior),
      };
    }

    const fields =
      override == null
        ? first
        : forecastProduct({
            productId: product.id,
            product: {
              sku: product.sku,
              productType: product.productType,
              vendor: product.vendor,
              currentStock: product.currentStock,
              onOrder: inboundFor(product),
              leadTimeDays: product.leadTimeDays,
              priceKes: product.priceKes,
              costKes: product.costKes,
            },
            supplier: product.supplier,
            history,
            activePromos,
            monthlyExpectations,
            abcCategory,
            stockoutDates: stockoutsByProduct.get(product.id),
            snapshotsSince,
            excludedDates: excludedByProduct.get(product.id),
            policy: policyForClass(knobs.methods, abcCategory),
            demandMethod: championForClass(champions, abcCategory),
            serviceZ: knobs.serviceZ,
            capMultiple: knobs.capMultiple,
            runDateKey,
            demandOverride: override,
          });

    return {
      tenantId,
      productId: product.id,
      runDate,
      forecastRunId,
      layer1Forecast30d: fields.layer1Forecast30d,
      layer1Confidence: fields.layer1Confidence,
      layer2Adjustment: fields.layer2Adjustment,
      finalForecast30d: fields.finalForecast30d,
      daysUntilStockout: fields.daysUntilStockout,
      recommendedQty: fields.recommendedQty,
      safetyStock: fields.safetyStock,
      reorderPoint: fields.reorderPoint,
      confidence: fields.confidence,
      reasoning: fields.reasoning,
      urgency: fields.urgency,
      signals: JSON.stringify(fields.signals),
      regime: fields.regime,
      confidenceWord: fields.confidenceWord,
      coldStart,
      borrowedFromProductId,
      explainParts: fields.explainParts,
    };
  });

  // The durable half of the run. Keyed on the run DAY, so a manual "Re-run now"
  // on top of the nightly cron refines the live plan without rewriting what the
  // owner was already shown — the day's first ask stands, and an adherence figure
  // computed last week cannot change this week.
  const runDay = new Date(`${runDateKey}T00:00:00.000Z`);
  const onHandById = new Map(products.map((p) => [p.id, p.currentStock]));
  const historyRows = rows
    .filter((row) => row.recommendedQty > 0 || KEPT_ZERO_QTY_URGENCIES.has(row.urgency))
    .map((row) => ({
      tenantId,
      productId: row.productId,
      runDate: runDay,
      recommendedQty: row.recommendedQty,
      finalForecast30d: row.finalForecast30d,
      daysUntilStockout: row.daysUntilStockout,
      urgency: row.urgency,
      confidenceWord: row.confidenceWord,
      coldStart: row.coldStart,
      onHandAtRun: onHandById.get(row.productId) ?? 0,
      abcClass: abcByProduct[row.productId] ?? null,
    }));
  const retentionCutoff = new Date(runDay.getTime() - RECOMMENDATION_RETENTION_DAYS * DAY_MS);

  // Replace, atomically: this run is the tenant's current forecast.
  await prismaForTenantTx(tenantId, async (tx) => {
    await tx.prediction.deleteMany({});
    if (rows.length > 0) await tx.prediction.createMany({ data: rows });
    // History only ever grows forward: skipDuplicates makes a same-day re-run a
    // no-op instead of a unique-key error, and the only rows that ever leave are
    // the ones past the retention window.
    if (historyRows.length > 0) {
      await tx.forecastRecommendation.createMany({ data: historyRows, skipDuplicates: true });
    }
    await tx.forecastRecommendation.deleteMany({ where: { runDate: { lt: retentionCutoff } } });

    // Persist the class this run worked from.
    //
    // It was computed here, used here for service levels and ordering policy,
    // and then thrown away — so Product.abcCategory stayed null for every
    // product ever, and everything reading the stored column (the buy list's
    // ordering and its class badge) behaved as though nothing had a class.
    // Written per class rather than per product: three statements, not N.
    const byClass = new Map<string, string[]>();
    for (const product of products) {
      const cls = abcByProduct[product.id] ?? null;
      if (!cls) continue;
      const list = byClass.get(cls) ?? [];
      list.push(product.id);
      byClass.set(cls, list);
    }
    for (const [cls, ids] of byClass) {
      await tx.product.updateMany({ where: { id: { in: ids } }, data: { abcCategory: cls } });
    }
    // Anything the run could not rank loses a stale class rather than keeping
    // one it no longer earns — a product that stopped selling should not go on
    // leading the buy list.
    const ranked = new Set([...byClass.values()].flat());
    const unranked = products.filter((p) => !ranked.has(p.id)).map((p) => p.id);
    if (unranked.length > 0) {
      await tx.product.updateMany({
        where: { id: { in: unranked }, abcCategory: { not: null } },
        data: { abcCategory: null },
      });
    }
  });

  await publishForecastDone(tenantId, forecastRunId, rows.length);
  return { created: rows.length, forecastRunId };
}

/** Announce the run on the tenant's realtime channel. Best-effort: with no
 *  REDIS_URL (tests, minimal dev) or an unreachable broker this is a no-op —
 *  the run itself already succeeded. */
async function publishForecastDone(
  tenantId: string,
  forecastRunId: string,
  created: number
): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url) return;
  const redis = new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
  });
  try {
    await redis.connect();
    await publishEvent(redis, {
      type: "forecast.done",
      data: { tenantId, forecastRunId, created },
    });
  } catch {
    console.warn("forecast.done publish skipped (redis unavailable)");
  } finally {
    redis.disconnect();
  }
}
