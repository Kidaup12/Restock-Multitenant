import { pickBestRun } from "@wezesha/forecast";
import { prismaService, roleOf, BUYABLE_PRODUCT_WHERE, OUTSTANDING_PO_STATUSES, effectiveOnOrder, outstandingByProduct } from "@wezesha/db";
import { sizeTransfers, destinationShares, type DestinationPosition } from "@wezesha/forecast";
import { reportOrderQuantity } from "./owner-report-planning";

/**
 * Owner report — a WEEK-BY-WEEK (or month-by-month) health TREND ("am I
 * improving?"). Rows = periods (last 6 weeks / 6 months), columns = the health
 * metrics; plus a short "needs attention" list (bestsellers currently stocked
 * out), a restock buy-list with budget, and warehouse→branch transfers.
 *
 * Ported from the reference app's lib/reports/weekly-report.ts. The reference
 * leaned on shared app-side helpers (stockHealthByPeriod, latestForecastRunId,
 * getDeadStockWindowDays). Those are apps/web-only, so the pure ones are inlined
 * here. The transfers section uses the shared pure sizing engine now extracted
 * into @wezesha/forecast (sizeTransfers/destinationShares), so it proposes the
 * same warehouse→branch moves the distribution page would.
 *
 * Queries run on prismaService WITH an explicit tenantId filter on every
 * where-clause and every raw query — the cron fires with no session and no
 * request, so there is no tenant context to scope a client with; that system
 * path is the documented use of the BYPASSRLS connection (same pattern as
 * weekly-summary.ts).
 */

export type ReportGranularity = "week" | "month";

/** One period's health row in the trend table. */
export type TrendRow = {
  label: string;          // "Aug 4" (week start) / "Jul 2026"
  salesKes: number;
  stockoutA: number;      // Class-A bestsellers that ran to zero
  stockoutB: number;      // Class-B
  stockoutPct: number | null; // A/B stockout rate overall
  overstockCount: number | null;
  deadCount: number;
  deadValueKes: number;   // capital frozen in dead stock
  /** null = never measured, which is not the same as nothing was lost. Paired
   *  with stockoutPct: the two come out of one calculation, so one of them
   *  printing a confident zero beside the other's dash is the report claiming
   *  to know something it does not. */
  missedRevenueKes: number | null;
  partial: boolean;
  inferred: boolean;
};

export type AttentionLine = {
  title: string; sku: string; abc: "A" | "B" | "C" | null; onHand: number; enRoute: number;
};

/** A line in "what to restock next period". */
export type RestockLine = {
  title: string; sku: string; abc: "A" | "B" | "C" | null;
  qty: number; costKes: number; daysLeft: number;
  runRate: number; onHand: number; enRoute: number;
};

/** A warehouse→branch transfer suggestion. */
export type TransferLine = {
  title: string; abc: "A" | "B" | "C" | null; qty: number; toBranch: string;
};

/** One of last period's best-selling products. */
export type TopSellerLine = {
  title: string; abc: "A" | "B" | "C" | null; qty: number; revenueKes: number;
};

/** A-class (bestseller) health snapshot for the report header section. */
export type BestsellerSummary = {
  total: number;    // active A-class products
  healthy: number;  // > lowDays of cover (incl. en route)
  low: number;      // 0 < cover <= lowDays
  out: number;      // effective stock <= 0
};


export type OwnerReport = {
  tenantName: string;
  currency: string;
  granularity: ReportGranularity;
  latestLabel: string;
  trend: TrendRow[];         // newest first
  needsAttention: AttentionLine[];
  restock: RestockLine[];    // top items to reorder next period
  bestsellers: BestsellerSummary;
  topSellers: TopSellerLine[];   // best sellers of the latest completed period
  oosCount: number;              // FULL bucket size (lists are capped at 12)
  criticalsCount: number;
  upcomingCount: number;
  upcomingBudgetKes: number;
  oosBudgetKes: number;          // full-bucket cost, not just the shown rows
  criticalsBudgetKes: number;
  othersBudgetKes: number;
  // Restock, planner-parity, split the way the owner reads it:
  criticals: RestockLine[];  // high run rate + running low (still has stock)
  upcoming: RestockLine[];   // fast movers with >7d cover: order soon, not urgent
  others: RestockLine[];     // TRUE slow/medium movers (rate < fast threshold)
  oos: RestockLine[];        // completely out of stock right now
  othersCount: number;       // total slow/medium lines (list is capped)
  restockBudgetKes: number;  // total cost of the full restock
  restockCount: number;      // total number of items to restock
  transfers: TransferLine[]; // top warehouse→branch moves
  transferCount: number;     // total transfer lines
  transferFrom: string;      // source warehouse name
  hasData: boolean;
};

// ── Period math (inlined from lib/metrics/stock-health, the pure bits) ─────────

const DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** ISO-8601 week key, identical to Postgres to_char(date, 'IYYY-"W"IW'). */
function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7; // Mon=1..Sun=7
  t.setUTCDate(t.getUTCDate() + 4 - day); // the Thursday decides the ISO year
  const isoYear = t.getUTCFullYear();
  const jan1 = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((t.getTime() - jan1.getTime()) / DAY + 1) / 7);
  return `${isoYear}-W${pad(week)}`;
}

const monthKey = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;

function daysInPeriod(period: string, granularity: ReportGranularity): number {
  if (granularity === "week") return 7;
  const parts = period.split("-").map(Number);
  const y = parts[0] ?? 0, m = parts[1] ?? 1;
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** UTC start of a period key. Week keys start on their ISO Monday. */
function periodStartDate(period: string, granularity: ReportGranularity): Date {
  if (granularity === "month") {
    const parts = period.split("-").map(Number);
    const y = parts[0] ?? 0, m = parts[1] ?? 1;
    return new Date(Date.UTC(y, m - 1, 1));
  }
  const parts = period.split("-W").map(Number);
  const isoYear = parts[0] ?? 0, wk = parts[1] ?? 1;
  // Jan 4 is always in ISO week 1; back up to that week's Monday, then step.
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() || 7) - 1));
  monday.setUTCDate(monday.getUTCDate() + (wk - 1) * 7);
  return monday;
}

/** The last `count` COMPLETED period keys, ascending (current period excluded). */
function completedPeriods(now: Date, granularity: ReportGranularity, count: number): string[] {
  const out: string[] = [];
  if (granularity === "month") {
    const y = now.getUTCFullYear(), m = now.getUTCMonth();
    for (let i = count; i >= 1; i--) out.push(monthKey(new Date(Date.UTC(y, m - i, 1))));
    return out;
  }
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() || 7) - 1));
  for (let i = count; i >= 1; i--) {
    const d = new Date(monday);
    d.setUTCDate(d.getUTCDate() - 7 * i);
    out.push(isoWeekKey(d));
  }
  return out;
}

/** The week keys covering the trailing `windowDays` ending at `period` — so the
 *  weekly dead-stock test uses the tenant's configurable dead-stock window. */
function trailingWeekKeys(period: string, windowDays: number): Set<string> {
  const start = periodStartDate(period, "week");
  const buckets = Math.max(1, Math.ceil(windowDays / 7));
  const keys = new Set<string>();
  for (let i = 0; i < buckets; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() - 7 * i);
    keys.add(isoWeekKey(d));
  }
  return keys;
}

function labelFor(period: string, periodStart: Date): string {
  if (period.includes("W")) return `${MONTHS[periodStart.getUTCMonth()]} ${periodStart.getUTCDate()}`;
  const parts = period.split("-").map(Number);
  const y = parts[0] ?? 0, m = parts[1] ?? 1;
  return `${MONTHS[m - 1]} ${y}`;
}

// ── Inlined helpers the worker cannot import from apps/web ─────────────────────

/** Code default dead-stock lookback — mirrors apps/web DEFAULT_DEAD_STOCK_DAYS
 *  so "dead" means the same everywhere. */
const DEFAULT_DEAD_STOCK_DAYS = 90;

/** Dead-stock lookback window (days), clamped 30–365. Reads
 *  TenantConfig.deadStockWindowDays (mirrors apps/web tenant config). */
async function getDeadStockWindowDays(tenantId: string): Promise<number> {
   
  const cfg = await prismaService.tenantConfig.findUnique({
    where: { tenantId },
    select: { deadStockWindowDays: true },
  });
  const v = cfg?.deadStockWindowDays ?? DEFAULT_DEAD_STOCK_DAYS;
  return Math.max(30, Math.min(365, v));
}

/** Regimes only the Python sidecar emits — their presence marks an AI run. */
const AI_REGIMES = ["sarima", "tsb", "cold_start"];

/** Choose the winning run id from same-day candidates: AI run → most complete →
 *  id (stable). Ported from apps/web latest-run resolution. */
/** The latest, most trustworthy forecast run for a tenant (same rule the app
 *  uses: latest runDate → AI engine → most complete → id). null when none. */
async function latestForecastRunId(tenantId: string): Promise<string | null> {
   
  const latest = await prismaService.prediction.findFirst({
    where: { tenantId },
    orderBy: { runDate: "desc" },
    select: { runDate: true },
  });
  if (!latest) return null;
   
  const runs = await prismaService.prediction.groupBy({
    by: ["forecastRunId"],
    where: { tenantId, runDate: latest.runDate },
    _count: { _all: true },
  });
  if (runs.length === 0) return null;
   
  const aiRuns = await prismaService.prediction.groupBy({
    by: ["forecastRunId"],
    where: { tenantId, runDate: latest.runDate, regime: { in: AI_REGIMES } },
  });
  const aiRunIds = new Set(aiRuns.map((r) => r.forecastRunId));
  return pickBestRun(
    runs.map((r) => ({ forecastRunId: r.forecastRunId, count: r._count._all })),
    aiRunIds
  );
}

// ── Trend engine (inlined + trimmed from stockHealthByPeriod) ─────────────────

export type SnapRow = { period: string; pid: string; minOh: number; endOh: number; daysOut: number };
export type SaleRow = { period: string; pid: string; qty: number };
export type ProductMeta = { abc: string | null; costKes: number; priceKes: number };

/** Per-period roll-up: A/B stockout split + rate, dead count/value, overstock
 *  count, missed revenue. Mirrors the reference stockHealthByPeriod, keeping the
 *  same stockout / dead-stock / inferred-pre-snapshot rules but only computing
 *  the numbers this report renders. Pure. */
export type PeriodHealth = {
  period: string;
  stockoutA: number;
  stockoutB: number;
  stockoutPct: number | null;
  overstockCount: number | null;
  deadStockCount: number;
  deadStockValueKes: number;
  missedRevenueKes: number | null;
  stockoutInferred: boolean;
};

const OVERSTOCK_THRESHOLD_DAYS = 90;

/** Exported for its own test: the pairing between the stockout rate and the
 *  missed revenue beside it is only checkable on the numbers themselves. */
export function stockHealthByPeriod(input: {
  periods: string[];
  granularity: ReportGranularity;
  snaps: SnapRow[];
  /** May include periods BEFORE periods[0] — needed for the weekly trailing window. */
  sales: SaleRow[];
  products: Map<string, ProductMeta>;
  deadStockWindowDays: number;
}): PeriodHealth[] {
  const { periods, granularity, snaps, sales, products, deadStockWindowDays } = input;

  const soldQty = new Map<string, number>(); // "period:pid" -> qty
  const soldPeriodsByPid = new Map<string, Set<string>>();
  for (const s of sales) {
    if (s.qty <= 0) continue;
    const k = `${s.period}:${s.pid}`;
    soldQty.set(k, (soldQty.get(k) ?? 0) + s.qty);
    let set = soldPeriodsByPid.get(s.pid);
    if (!set) soldPeriodsByPid.set(s.pid, (set = new Set()));
    set.add(s.period);
  }
  const snapsByPeriod = new Map<string, SnapRow[]>();
  for (const r of snaps) {
    const arr = snapsByPeriod.get(r.period);
    if (arr) arr.push(r);
    else snapsByPeriod.set(r.period, [r]);
  }
  // Period keys are zero-padded, so lexicographic <= is chronological.
  const soldEverBy = (pid: string, p: string) => {
    const set = soldPeriodsByPid.get(pid);
    if (!set) return false;
    for (const sp of set) if (sp <= p) return true;
    return false;
  };

  return periods.map((p) => {
    const days = daysInPeriod(p, granularity);
    const psnaps = snapsByPeriod.get(p);
    const deadTrailing = granularity === "week" ? trailingWeekKeys(p, deadStockWindowDays) : null;
    const trailing = granularity === "week" ? trailingWeekKeys(p, 21) : null;

    let stockoutA = 0, stockoutB = 0, abSkuCount = 0, stockoutCount = 0;
    let deadCount = 0, deadValue = 0, overstockCount = 0, missedRevenue = 0;

    for (const r of psnaps ?? []) {
      const meta = products.get(r.pid);
      if (!meta) continue;
      const sold = soldQty.get(`${p}:${r.pid}`) ?? 0;
      const isAB = meta.abc === "A" || meta.abc === "B";
      if (isAB) abSkuCount++;

      const stockedOut = isAB && r.minOh <= 0 && sold > 0;
      if (stockedOut) {
        stockoutCount++;
        if (meta.abc === "A") stockoutA++;
        else stockoutB++;
        // Missed revenue: run-rate over observed days × days at zero × price.
        const daysOut = Math.min(r.daysOut, days);
        const daysSelling = Math.max(1, days - daysOut);
        const runRate = sold / daysSelling;
        const missed = Math.round(runRate * daysOut * meta.priceKes);
        if (missed > 0) missedRevenue += missed;
      }

      if (r.endOh > 0 && soldEverBy(r.pid, p)) {
        const quiet = deadTrailing
          ? ![...deadTrailing].some((w) => (soldQty.get(`${w}:${r.pid}`) ?? 0) > 0)
          : sold === 0;
        if (quiet) {
          deadCount++;
          deadValue += r.endOh * meta.costKes;
        }
      }

      // Overstock: cover-days at period end beyond threshold, at the period's own
      // pace. Zero run-rate is dead stock, not overstock.
      const dailyRate = sold / days;
      if (dailyRate > 0) {
        const coverDays = r.endOh / dailyRate;
        if (coverDays > OVERSTOCK_THRESHOLD_DAYS) overstockCount++;
      }
    }

    // Inferred stockouts for periods with NO snapshot history: an A/B product that
    // sold in a trailing week but had ZERO sales this period is a proven seller
    // gone silent — the classic censoring signal for "went out of stock".
    let inferredStockoutA = 0, inferredStockoutB = 0, inferredAbBase = 0;
    if (!psnaps && trailing) {
      const seen = new Set<string>();
      for (const [pid] of soldPeriodsByPid) {
        const meta = products.get(pid);
        if (!meta || !(meta.abc === "A" || meta.abc === "B")) continue;
        if (soldEverBy(pid, p)) inferredAbBase++;
        if (seen.has(pid)) continue;
        const soldThis = (soldQty.get(`${p}:${pid}`) ?? 0) > 0;
        if (soldThis) continue;
        const wasSelling = [...trailing].some((w) => (soldQty.get(`${w}:${pid}`) ?? 0) > 0);
        if (wasSelling) {
          seen.add(pid);
          if (meta.abc === "A") inferredStockoutA++;
          else inferredStockoutB++;
        }
      }
    }

    const inferredTotal = inferredStockoutA + inferredStockoutB;
    const stockoutInferred = !psnaps && inferredTotal > 0;

    return {
      period: p,
      stockoutA: psnaps ? stockoutA : inferredStockoutA,
      stockoutB: psnaps ? stockoutB : inferredStockoutB,
      stockoutPct: psnaps
        ? (abSkuCount > 0 ? Math.round((stockoutCount / abSkuCount) * 1000) / 10 : null)
        : (stockoutInferred && inferredAbBase > 0 ? Math.round((inferredTotal / inferredAbBase) * 1000) / 10 : null),
      overstockCount: psnaps ? overstockCount : null,
      deadStockCount: deadCount,
      deadStockValueKes: Math.round(deadValue),
      // Missed revenue only exists where a stockout was OBSERVED: it is summed
      // inside the snapshot loop, so with no snapshots, or no A/B products to
      // look at, the accumulator stays at zero for want of anything to add
      // rather than because nothing was lost. An inferred rate is a censoring
      // signal, not a measurement, and cannot price what it did not see.
      missedRevenueKes: psnaps && abSkuCount > 0 ? missedRevenue : null,
      stockoutInferred,
    };
  });
}

const abcOf = (c: string | null): "A" | "B" | "C" | null => (c === "A" || c === "B" || c === "C" ? c : null);

/** Build the report: the last `periods` completed periods (trend) + current
 *  needs-attention/restock lists. null when the tenant is gone. */
export async function buildOwnerReport(
  tenantId: string,
  granularity: ReportGranularity,
  periods = 6,
): Promise<OwnerReport | null> {
  // eslint-disable-next-line tenant-safety/require-tenant-scope -- reads one tenant by the id the job already carries; the worker has no session, so there is no resolver to route through.
  const tenant = await prismaService.tenant.findUnique({
    where: { id: tenantId },
    select: { name: true, slug: true, currency: true },
  });
  if (!tenant) return null;

  // ── Trend: recompute the last `periods` completed periods ──
  const now = new Date(); now.setUTCHours(0, 0, 0, 0);
  const periodKeys = completedPeriods(now, granularity, periods);
  const trend: TrendRow[] = [];
  if (periodKeys.length > 0) {
    const firstKey = periodKeys[0] as string;
    const windowStart = periodStartDate(firstKey, granularity);
    const endBound = granularity === "month"
      ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
      : periodStartDate(isoWeekKey(now), "week");
    // Sales look back further than the snapshot window: the weekly dead-stock /
    // inferred-stockout tests read trailing weeks before periods[0].
    const salesSince = new Date(windowStart);
    if (granularity === "week") salesSince.setUTCDate(salesSince.getUTCDate() - 12 * 7);
    const fmt = granularity === "week" ? 'IYYY-"W"IW' : "YYYY-MM";
    const gran = granularity; // Postgres date_trunc unit: "week" | "month"

    const [salesRows, snapRows, prods, snapDayRows] = await Promise.all([
       
      prismaService.$queryRaw<{ period: string; pid: string; qty: number; rev: number }[]>`
        SELECT to_char(date_trunc(${gran}::text, date), ${fmt}) AS period, "productId" AS pid,
               SUM(quantity)::float8 AS qty, SUM("revenueKes")::float8 AS rev
        FROM "SalesHistory" WHERE "tenantId" = ${tenantId} AND date >= ${salesSince} AND date < ${endBound}
        GROUP BY period, pid`,
       
      prismaService.$queryRaw<{ period: string; pid: string; minoh: number; endoh: number; daysout: number }[]>`
        SELECT to_char(date_trunc(${gran}::text, s.date), ${fmt}) AS period, s."productId" AS pid,
               MIN(s."onHand")::float8 AS minoh,
               (ARRAY_AGG(s."onHand" ORDER BY s.date DESC))[1]::float8 AS endoh,
               COUNT(*) FILTER (WHERE s."onHand" <= 0)::float8 AS daysout
        FROM "InventorySnapshot" s
        WHERE s."tenantId" = ${tenantId} AND s.date >= ${windowStart} AND s.date < ${endBound}
        GROUP BY period, s."productId"`,
       
      prismaService.product.findMany({
        where: { tenantId },
        select: { id: true, abcCategory: true, costKes: true, priceKes: true },
      }),
       
      prismaService.$queryRaw<{ period: string; snapdays: number }[]>`
        SELECT to_char(date_trunc(${gran}::text, s.date), ${fmt}) AS period, COUNT(DISTINCT s.date::date)::int AS snapdays
        FROM "InventorySnapshot" s WHERE s."tenantId" = ${tenantId} AND s.date >= ${windowStart} AND s.date < ${endBound}
        GROUP BY period`,
    ]);

    const snapDays = new Map(snapDayRows.map((r) => [r.period, Number(r.snapdays)]));
    const salesRevByPeriod = new Map<string, number>();
    for (const r of salesRows) salesRevByPeriod.set(r.period, (salesRevByPeriod.get(r.period) ?? 0) + (Number(r.rev) || 0));
    const products = new Map<string, ProductMeta>(
      prods.map((p) => [p.id, { abc: p.abcCategory, costKes: p.costKes ?? 0, priceKes: p.priceKes ?? 0 }])
    );
    const deadStockWindowDays = await getDeadStockWindowDays(tenantId);
    const health = stockHealthByPeriod({
      periods: periodKeys,
      granularity,
      snaps: snapRows.map((r) => ({ period: r.period, pid: r.pid, minOh: Number(r.minoh), endOh: Number(r.endoh), daysOut: Number(r.daysout) || 0 })),
      sales: salesRows.map((r) => ({ period: r.period, pid: r.pid, qty: Number(r.qty) || 0 })),
      products,
      deadStockWindowDays,
    });
    // newest first
    for (const h of [...health].reverse()) {
      const d = snapDays.get(h.period) ?? 0;
      trend.push({
        label: labelFor(h.period, periodStartDate(h.period, granularity)),
        salesKes: Math.round(salesRevByPeriod.get(h.period) ?? 0),
        stockoutA: h.stockoutA,
        stockoutB: h.stockoutB,
        stockoutPct: h.stockoutPct,
        overstockCount: h.overstockCount,
        deadCount: h.deadStockCount,
        deadValueKes: h.deadStockValueKes,
        missedRevenueKes: h.missedRevenueKes,
        partial: d > 0 && d < (granularity === "week" ? 6 : 24),
        inferred: h.stockoutInferred,
      });
    }
  }

  // ── Needs attention + restock: from the latest forecast run's predictions ──
  const runId = await latestForecastRunId(tenantId);
  const storedPreds = runId
     
    ? await prismaService.prediction.findMany({
        where: { tenantId, forecastRunId: runId, product: { tenantId, ...BUYABLE_PRODUCT_WHERE } },
        select: {
          productId: true,
          finalForecast30d: true, daysUntilStockout: true, recommendedQty: true, urgency: true,
          product: { select: { title: true, sku: true, active: true, currentStock: true, onOrder: true, costKes: true, priceKes: true, abcCategory: true, supplier: { select: { moq: true } } } },
        },
      })
    : [];

  const productIds = storedPreds.map(p => p.productId);
  const [overrides, openOrders, sentLines] = productIds.length ? await Promise.all([
    prismaService.productPlanOverride.findMany({ where: { tenantId, productId: { in: productIds } }, select: { productId: true, qty: true } }),
    prismaService.order.findMany({
      where: { tenantId, productId: { in: productIds }, receivedAt: null, OR: [
        { status: "pending" },
        { status: "ordered", purchaseOrder: { tenantId, status: { in: [...OUTSTANDING_PO_STATUSES] }, deletedAt: null } },
      ] },
      select: { productId: true },
    }),
    prismaService.purchaseOrderLine.findMany({
      where: { tenantId, productId: { in: productIds }, purchaseOrder: { tenantId, status: { in: [...OUTSTANDING_PO_STATUSES] }, deletedAt: null } },
      select: { productId: true, quantity: true, receivedQty: true },
    }),
  ]) : [[], [], []];
  const overrideByProduct = new Map(overrides.map(o => [o.productId, o.qty]));
  const openProductIds = new Set(openOrders.map(o => o.productId));
  const outstanding = outstandingByProduct(sentLines);
  // Inventory alerts still see every buyable forecast. Only purchase quantities
  // honor the planner's holdbacks, owner decisions and supplier minimum.
  const preds = storedPreds.map(p => ({
    ...p,
    recommendedQty: reportOrderQuantity({ ...p, ...p.product, overrideQty: overrideByProduct.get(p.productId), moq: p.product.supplier?.moq, hasOpenOrder: openProductIds.has(p.productId) }),
    product: { ...p.product, onOrder: effectiveOnOrder(p.product.onOrder, outstanding.get(p.productId) ?? 0) },
  }));

  const classRank = (c: string | null) => (c === "A" ? 0 : c === "B" ? 1 : 2);
  const urgencyRank = (u: string) => (u === "critical" ? 0 : u === "high" ? 1 : u === "medium" ? 2 : 3);

  // Needs attention: A/B bestsellers currently at/near zero, still selling.
  const needsAttention: AttentionLine[] = preds
    .filter((p) => {
      if (!p.product.active) return false;
      const cls = p.product.abcCategory;
      if (cls !== "A" && cls !== "B") return false;
      const eff = p.product.currentStock + p.product.onOrder;
      const rate = p.finalForecast30d / 30;
      return rate > 0 && (eff <= 0 || eff / rate < 3);
    })
    .sort((a, b) => classRank(a.product.abcCategory) - classRank(b.product.abcCategory) || a.daysUntilStockout - b.daysUntilStockout)
    .slice(0, 8)
    .map((p) => ({
      title: p.product.title, sku: p.product.sku, abc: abcOf(p.product.abcCategory),
      onHand: Math.round(p.product.currentStock), enRoute: Math.round(p.product.onOrder),
    }));

  // Restock: plannable buy lines (valid cost/price), qty already nets on-hand +
  // en route. Ranked urgency → class → soonest out. Budget = full cost.
  const buy = preds
    .filter((p) => p.recommendedQty > 0)
    .sort((a, b) =>
      urgencyRank(a.urgency) - urgencyRank(b.urgency) ||
      classRank(a.product.abcCategory) - classRank(b.product.abcCategory) ||
      a.daysUntilStockout - b.daysUntilStockout);
  const restockBudgetKes = Math.round(buy.reduce((s, p) => s + Math.ceil(p.recommendedQty) * (p.product.costKes ?? 0), 0));
  // ── Segment the buy list the way the owner reads it (owner spec, Sep 2026):
  //    1. Completely OOS — nothing on the shelf right now (en route shown, not hidden)
  //    2. Criticals — HIGH run rate + running LOW (fast mover, short runway, has stock)
  //    3. Others — slow/medium movers that still earned a reorder line
  //    All three come from the SAME planner engine + ranking; only the grouping differs. ──
  const FAST_RATE = 0.4;   // units/day — matches the Class-A velocity floor
  const LOW_DAYS = 7;      // "running low" = a week or less of cover left
  const toLine = (p: (typeof buy)[number]): RestockLine => ({
    title: p.product.title, sku: p.product.sku, abc: abcOf(p.product.abcCategory),
    qty: Math.ceil(p.recommendedQty), costKes: Math.round(Math.ceil(p.recommendedQty) * (p.product.costKes ?? 0)),
    daysLeft: p.daysUntilStockout, runRate: Math.round((p.finalForecast30d / 30) * 100) / 100,
    onHand: Math.round(p.product.currentStock), enRoute: Math.round(p.product.onOrder),
  });
  const rateOf = (p: (typeof buy)[number]) => p.finalForecast30d / 30;
  const isOos = (p: (typeof buy)[number]) => p.product.currentStock <= 0;
  const isCritical = (p: (typeof buy)[number]) =>
    !isOos(p) && rateOf(p) >= FAST_RATE && p.daysUntilStockout <= LOW_DAYS;
  // Within each section, PLANNER-parity ordering (the planner's "priority"
  // comparator): Class A -> B -> C (class = earned revenue), then fastest run
  // rate first. Urgency lives in the SECTIONS (OOS -> critical -> other), so
  // rows read exactly like the Restock planner's buy list.
  const plannerOrder = (x: (typeof buy)[number], y: (typeof buy)[number]) =>
    classRank(x.product.abcCategory) - classRank(y.product.abcCategory) || rateOf(y) - rateOf(x);
  const lineCost = (p: (typeof buy)[number]) => Math.ceil(p.recommendedQty) * (p.product.costKes ?? 0);
  const oosAll = buy.filter(isOos).sort(plannerOrder);
  const criticalsAll = buy.filter(isCritical).sort(plannerOrder);
  // Fast movers NOT yet urgent (>7d cover) are their own tier: calling them
  // "slow" was false (a 4.7/day bestseller sat under that label). "Others" is
  // now genuinely slow/medium (rate below the fast threshold).
  const upcomingAll = buy.filter(p => !isOos(p) && !isCritical(p) && rateOf(p) >= FAST_RATE).sort(plannerOrder);
  const othersAll = buy.filter(p => !isOos(p) && !isCritical(p) && rateOf(p) < FAST_RATE).sort(plannerOrder);
  const oos = oosAll.slice(0, 12).map(toLine);
  const criticals = criticalsAll.slice(0, 12).map(toLine);
  const upcoming = upcomingAll.slice(0, 10).map(toLine);
  const others = othersAll.slice(0, 8).map(toLine);
  const oosBudgetKes = Math.round(oosAll.reduce((t, p) => t + lineCost(p), 0));
  const criticalsBudgetKes = Math.round(criticalsAll.reduce((t, p) => t + lineCost(p), 0));
  const upcomingBudgetKes = Math.round(upcomingAll.reduce((t, p) => t + lineCost(p), 0));
  const othersBudgetKes = Math.round(othersAll.reduce((t, p) => t + lineCost(p), 0));

  // ── Best sellers of the latest COMPLETED period (what actually sold). ──
  let topSellers: TopSellerLine[] = [];
  try {
    const lastKey = periodKeys[periodKeys.length - 1];
    if (lastKey) {
      const from = periodStartDate(lastKey, granularity);
      const until = new Date(from);
      if (granularity === "week") until.setUTCDate(until.getUTCDate() + 7);
      else until.setUTCMonth(until.getUTCMonth() + 1);
      const sold = await prismaService.salesHistory.groupBy({
        by: ["productId"],
        where: { tenantId, date: { gte: from, lt: until }, quantity: { gt: 0 } },
        _sum: { quantity: true, revenueKes: true },
        orderBy: { _sum: { revenueKes: "desc" } },
        take: 8,
      });
      const info = await prismaService.product.findMany({
        where: { tenantId, id: { in: sold.map(r => r.productId) } },
        select: { id: true, title: true, abcCategory: true },
      });
      const byId = new Map(info.map(i => [i.id, i]));
      topSellers = sold.map(r => ({
        title: byId.get(r.productId)?.title ?? "(deleted product)",
        abc: abcOf(byId.get(r.productId)?.abcCategory ?? null),
        qty: Math.round(r._sum.quantity ?? 0),
        revenueKes: Math.round(r._sum.revenueKes ?? 0),
      }));
    }
  } catch { /* best-effort */ }

  // ── Bestseller (A-class) health snapshot: the daily-watch list, summarised. ──
  const aPreds = preds.filter(p => p.product.active && p.product.abcCategory === "A");
  const bestsellers: BestsellerSummary = { total: aPreds.length, healthy: 0, low: 0, out: 0 };
  for (const p of aPreds) {
    const eff = p.product.currentStock + p.product.onOrder;
    const rate = p.finalForecast30d / 30;
    if (eff <= 0) bestsellers.out++;
    else if (rate > 0 && eff / rate <= LOW_DAYS) bestsellers.low++;
    else bestsellers.healthy++;
  }

  const restock = buy.slice(0, 12).map(toLine);

  // ── Transfers (warehouse→branch) ──
  // Equalise days-of-cover across selling branches by moving stock out of the
  // holding warehouse, using the SAME pure sizing engine the distribution page
  // runs (`sizeTransfers`/`destinationShares` from @wezesha/forecast) so the
  // email can't propose a move the app wouldn't. Best-effort: any failure here
  // leaves the transfers section empty rather than failing the whole report.
  let transfers: TransferLine[] = [];
  let transferCount = 0;
  let transferFrom = "";
  try {
    const built = await buildTransfers(tenantId);
    transfers = built.lines.slice(0, 12);
    transferCount = built.lines.length;
    transferFrom = built.fromName;
  } catch {
    // leave the section empty on any transfer-side failure
  }

  return {
    tenantName: tenant.name ?? tenant.slug,
    currency: tenant.currency ?? "KES",
    granularity,
    latestLabel: trend[0]?.label ?? (granularity === "week" ? "this week" : "this month"),
    trend,
    needsAttention,
    restock,
    bestsellers,
    topSellers,
    oosCount: oosAll.length,
    criticalsCount: criticalsAll.length,
    upcomingCount: upcomingAll.length,
    upcomingBudgetKes,
    upcoming,
    oosBudgetKes,
    criticalsBudgetKes,
    othersBudgetKes,
    criticals,
    others,
    oos,
    othersCount: othersAll.length,
    restockBudgetKes,
    restockCount: buy.length,
    transfers,
    transferCount,
    transferFrom,
    hasData: trend.length > 0,
  };
}

/** Trailing window for attributing branch demand — matches the distribution
 *  page's default. */
const TRANSFER_WINDOW_DAYS = 90;
/** Cover level the transfer plan equalises branches to. */
const TRANSFER_COVER_DAYS = 14;

/**
 * Build the top warehouse→branch moves for the report, using the shared pure
 * sizing engine. Picks the holding location with the most stock as the source,
 * splits each product's blended run rate across branches by their attributed
 * sales (falling back to stock share), and level-fills every branch to a common
 * days-of-cover. Returns lines already sorted by class then quantity.
 */
async function buildTransfers(
  tenantId: string
): Promise<{ lines: TransferLine[]; fromName: string }> {
  const since = new Date(Date.now() - TRANSFER_WINDOW_DAYS * 86_400_000);
   
  const locations = await prismaService.location.findMany({
    where: { tenantId },
    select: { id: true, name: true, locationType: true },
  });
  const sells = locations.filter((l) => roleOf(l) === "sells");
  const holds = locations.filter((l) => roleOf(l) === "holds");
  if (sells.length === 0 || holds.length === 0) return { lines: [], fromName: "" };

   
  const levels = await prismaService.inventoryLevel.findMany({
    where: { tenantId },
    select: { productId: true, locationId: true, onHand: true },
  });
   
  const attributed = await prismaService.salesHistory.groupBy({
    by: ["productId", "locationId"],
    where: { tenantId, date: { gte: since }, locationId: { not: null } },
    _sum: { quantity: true },
  });
   
  const products = await prismaService.product.findMany({
    where: { tenantId },
    select: { id: true, title: true, abcCategory: true },
  });

  // Source = the holding location carrying the most units.
  const onHandAt = new Map<string, Map<string, number>>(); // productId -> locationId -> onHand
  for (const lvl of levels) {
    let byLoc = onHandAt.get(lvl.productId);
    if (!byLoc) onHandAt.set(lvl.productId, (byLoc = new Map()));
    byLoc.set(lvl.locationId, lvl.onHand);
  }
  const heldTotal = (locId: string) =>
    levels.filter((l) => l.locationId === locId).reduce((s, l) => s + Math.max(0, l.onHand), 0);
  const source = [...holds].sort((a, b) => heldTotal(b.id) - heldTotal(a.id))[0]!;

  const attrAt = new Map<string, Map<string, number>>(); // productId -> locationId -> units
  for (const row of attributed) {
    if (!row.locationId) continue;
    let byLoc = attrAt.get(row.productId);
    if (!byLoc) attrAt.set(row.productId, (byLoc = new Map()));
    byLoc.set(row.locationId, row._sum.quantity ?? 0);
  }
  const metaById = new Map(products.map((p) => [p.id, p]));
  const classRank = (c: string | null) => (c === "A" ? 0 : c === "B" ? 1 : 2);

  const lines: TransferLine[] = [];
  for (const [productId, byLoc] of onHandAt) {
    const available = byLoc.get(source.id) ?? 0;
    if (available <= 0) continue;

    // The product's blended run rate over the window (all attributed branches).
    const attrByBranch = attrAt.get(productId) ?? new Map<string, number>();
    const blended =
      [...attrByBranch.values()].reduce((s, q) => s + Math.max(0, q), 0) / TRANSFER_WINDOW_DAYS;
    if (blended <= 0) continue; // nothing sells it — nothing to cover

    const destInputs = sells.map((b) => ({
      locationId: b.id,
      onHand: byLoc.get(b.id) ?? 0,
      attributedUnits: attrByBranch.get(b.id) ?? 0,
    }));
    const { shareByLocation } = destinationShares(destInputs);
    const positions: DestinationPosition[] = destInputs.map((d) => ({
      locationId: d.locationId,
      onHand: d.onHand,
      runRate: blended * (shareByLocation.get(d.locationId) ?? 0),
    }));

    const sized = sizeTransfers(available, positions, TRANSFER_COVER_DAYS);
    const meta = metaById.get(productId);
    const branchName = new Map(sells.map((b) => [b.id, b.name]));
    for (const move of sized) {
      lines.push({
        title: meta?.title ?? productId,
        abc: abcOf(meta?.abcCategory ?? null),
        qty: move.qty,
        toBranch: branchName.get(move.toLocationId) ?? "",
      });
    }
  }

  lines.sort((a, b) => classRank(a.abc) - classRank(b.abc) || b.qty - a.qty);
  return { lines, fromName: source.name };
}
