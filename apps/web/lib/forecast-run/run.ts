import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { prismaForTenant, prismaForTenantTx } from "@wezesha/db";
import {
  assignAbc,
  dailySalesValue,
  forecastProduct,
  policyForClass,
  resolveForecastKnobs,
  type ActivePromo,
  type SalesPoint,
} from "@wezesha/forecast";
import { publishEvent } from "@wezesha/realtime";

/**
 * One forecast run for one tenant: load facts + history, run the pure engine
 * per product, replace the tenant's Prediction rows under a shared
 * forecastRunId, then announce forecast.done over realtime.
 *
 * Everything — reads AND writes — goes through the RLS-enforced tenant client:
 * the run is a user-facing request path with a single tenant context, so the
 * service client has no business here. The delete-then-create replacement runs
 * inside one tenant transaction; RLS scopes the unfiltered deleteMany to this
 * tenant's rows, and the WITH CHECK policies reject any row a bug tried to
 * write for another tenant.
 */

const DAY_MS = 86_400_000;
/** History window fed to the engine — matches its 30/90/365-day rate windows. */
const HISTORY_DAYS = 365;

export type ForecastRunResult = { created: number; forecastRunId: string };

export async function runForecast(tenantId: string): Promise<ForecastRunResult> {
  const db = prismaForTenant(tenantId);
  const now = new Date();
  const historySince = new Date(now.getTime() - HISTORY_DAYS * DAY_MS);

  const [products, config, promos, sales] = await Promise.all([
    db.product.findMany({
      where: { active: true },
      select: {
        id: true,
        sku: true,
        productType: true,
        vendor: true,
        priceKes: true,
        costKes: true,
        currentStock: true,
        onOrder: true,
        leadTimeDays: true,
        supplier: { select: { leadTimeAvgDays: true, leadTimeStdDays: true } },
      },
    }),
    db.tenantConfig.findFirst(),
    db.promo.findMany({
      where: { deletedAt: null, startDate: { lte: now }, endDate: { gte: now } },
      select: { discountPct: true, promoType: true, channel: true, scope: true, scopeValue: true },
    }),
    db.salesHistory.findMany({
      where: { date: { gte: historySince } },
      select: { productId: true, date: true, quantity: true, revenueKes: true, channel: true },
    }),
  ]);

  const historyByProduct = new Map<string, SalesPoint[]>();
  for (const row of sales) {
    let list = historyByProduct.get(row.productId);
    if (!list) historyByProduct.set(row.productId, (list = []));
    list.push(row);
  }

  // Cross-product steps the pure pipeline leaves to the caller: ABC over the
  // whole catalogue, tenant knobs, active promo set (the engine scope-matches
  // promos per product itself).
  const knobs = resolveForecastKnobs(config);
  const abcByProduct = assignAbc(
    products.map((p) => ({
      id: p.id,
      revenue: dailySalesValue(historyByProduct.get(p.id) ?? [], p.priceKes),
    }))
  );
  const activePromos: ActivePromo[] = promos;
  const runDateKey = now.toISOString().slice(0, 10);

  const forecastRunId = randomUUID();
  const runDate = now;
  const rows = products.map((product) => {
    const abcCategory = abcByProduct[product.id] ?? null;
    const fields = forecastProduct({
      productId: product.id,
      product: {
        sku: product.sku,
        productType: product.productType,
        vendor: product.vendor,
        currentStock: product.currentStock,
        onOrder: product.onOrder,
        leadTimeDays: product.leadTimeDays,
        priceKes: product.priceKes,
        costKes: product.costKes,
      },
      supplier: product.supplier,
      history: historyByProduct.get(product.id) ?? [],
      activePromos,
      abcCategory,
      policy: policyForClass(knobs.methods, abcCategory),
      serviceZ: knobs.serviceZ,
      capMultiple: knobs.capMultiple,
      runDateKey,
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
    };
  });

  // Replace, atomically: this run is the tenant's current forecast.
  await prismaForTenantTx(tenantId, async (tx) => {
    await tx.prediction.deleteMany({});
    if (rows.length > 0) await tx.prediction.createMany({ data: rows });
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
