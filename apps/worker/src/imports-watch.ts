import { BUYABLE_PRODUCT_WHERE, effectiveOnOrder, outstandingByProduct, OUTSTANDING_PO_STATUSES, prismaService, roleOf } from "@wezesha/db";
import { leadDaysFor } from "@wezesha/forecast";
import { dashboardRunRates } from "./live-rates";
import { latestForecastRunId } from "./owner-report";

/**
 * Imports Watch (ported from the original app, #94/#95) — a short, frequent
 * email about the products where a late reorder costs the most: the ones that
 * take weeks to arrive.
 *
 * The original called these "imports" and picked them by two hardcoded brand
 * tags for one shop. Here they are every buyable product with a measured lead
 * time of LONG_LEAD_DAYS or more (product override, else the supplier's
 * average) — the property that made imports risky in the first place, and one
 * any shop already has.
 *
 * Sections (top CAP each; Class A → B → C, then fastest first):
 *   1. Bestsellers          — fastest movers, where their stock sits today
 *   2. Critical reorders    — fast (≥ FAST_RATE/day) and ≤ LOW_DAYS of cover
 *   3. Out of stock, fast   — nothing on the shelf, still selling fast
 *   4. Out of stock, slow   — nothing on the shelf, slow movers
 *   5. Other reorders       — the rest the planner still wants
 * Rates are the dashboard's (dashboardRunRates); order quantities and runway
 * are the planner's.
 */

export const LONG_LEAD_DAYS = 14;
const CAP = 20;
const FAST_RATE = 0.4;
const LOW_DAYS = 7;

export type WatchLine = {
  title: string;
  sku: string;
  abc: "A" | "B" | "C";
  runRate: number;
  orderQty: number | null;
  orderCostKes: number;
  shops: number;
  warehouse: number;
  enRoute: number;
  total: number;
  daysLeft: number;
};

export type ImportsWatch = {
  tenantName: string;
  currency: string;
  dateLabel: string;
  leadDays: number;
  watchedCount: number;
  urgentCount: number;
  attentionCount: number;
  bestsellers: WatchLine[];
  criticals: WatchLine[];
  criticalsCount: number;
  criticalsBudgetKes: number;
  oosHigh: WatchLine[];
  oosHighCount: number;
  oosHighBudgetKes: number;
  oosLow: WatchLine[];
  oosLowCount: number;
  oosLowBudgetKes: number;
  others: WatchLine[];
  othersCount: number;
  othersBudgetKes: number;
  totalBudgetKes: number;
  totalOrderLines: number;
};

export async function buildImportsWatch(tenantId: string, now: Date = new Date()): Promise<ImportsWatch | null> {
  // eslint-disable-next-line tenant-safety/require-tenant-scope -- reads the one tenant this job is for, by id.
  const tenant = await prismaService.tenant.findUnique({ where: { id: tenantId }, select: { name: true, currency: true, timezone: true } });
  if (!tenant) return null;
  const runId = await latestForecastRunId(tenantId);
  if (!runId) return null;

  const products = await prismaService.product.findMany({
    where: { tenantId, ...BUYABLE_PRODUCT_WHERE },
    select: {
      id: true, sku: true, title: true, currentStock: true, onOrder: true, costKes: true, priceKes: true, abcCategory: true,
      leadTimeDays: true, supplier: { select: { leadTimeAvgDays: true } },
    },
  });
  const watched = products.filter((p) => (leadDaysFor(p, p.supplier) ?? 0) >= LONG_LEAD_DAYS);
  if (watched.length === 0) return null; // no slow-to-arrive products — nothing to watch
  const ids = watched.map((p) => p.id);

  const [preds, overrides, levels, locations, sentLines, rates] = await Promise.all([
    prismaService.prediction.findMany({
      where: { tenantId, forecastRunId: runId, productId: { in: ids } },
      select: { productId: true, recommendedQty: true, daysUntilStockout: true },
    }),
    prismaService.productPlanOverride.findMany({ where: { tenantId, productId: { in: ids } }, select: { productId: true, qty: true } }),
    prismaService.inventoryLevel.findMany({ where: { tenantId, productId: { in: ids } }, select: { productId: true, locationId: true, onHand: true } }),
    prismaService.location.findMany({ where: { tenantId }, select: { id: true, locationType: true } }),
    prismaService.purchaseOrderLine.findMany({
      where: { tenantId, productId: { in: ids }, purchaseOrder: { tenantId, status: { in: [...OUTSTANDING_PO_STATUSES] }, deletedAt: null } },
      select: { productId: true, quantity: true, receivedQty: true },
    }),
    dashboardRunRates(tenantId, ids, now),
  ]);

  const role = new Map(locations.map((l) => [l.id, roleOf(l)]));
  const split = new Map<string, { shops: number; warehouse: number }>();
  for (const lv of levels) {
    const r = role.get(lv.locationId);
    if (r !== "sells" && r !== "holds") continue;
    const s = split.get(lv.productId) ?? { shops: 0, warehouse: 0 };
    if (r === "sells") s.shops += lv.onHand;
    else s.warehouse += lv.onHand;
    split.set(lv.productId, s);
  }
  const pred = new Map(preds.map((p) => [p.productId, p]));
  const override = new Map(overrides.map((o) => [o.productId, o.qty]));
  const outstanding = outstandingByProduct(sentLines);

  type P = (typeof watched)[number];
  const rate = (p: P) => rates.get(p.id) ?? 0;
  const qty = (p: P) => Math.max(0, Math.ceil(override.get(p.id) ?? pred.get(p.id)?.recommendedQty ?? 0));
  const daysLeft = (p: P) => pred.get(p.id)?.daysUntilStockout ?? 999;
  const plannable = (p: P) => p.costKes > 0 && p.priceKes > 0 && p.costKes <= p.priceKes;
  const lineCost = (p: P) => qty(p) * p.costKes;
  const rank = (c: string | null) => (c === "A" ? 0 : c === "B" ? 1 : 2);
  const order = (a: P, b: P) => rank(a.abcCategory) - rank(b.abcCategory) || rate(b) - rate(a);

  const buy = watched.filter((p) => qty(p) > 0 && plannable(p));
  const isCritical = (p: P) => p.currentStock > 0 && rate(p) >= FAST_RATE && daysLeft(p) <= LOW_DAYS;
  const criticals = buy.filter(isCritical).sort(order);
  const oosHigh = buy.filter((p) => p.currentStock <= 0 && rate(p) >= FAST_RATE).sort(order);
  const oosLow = buy.filter((p) => p.currentStock <= 0 && rate(p) < FAST_RATE).sort(order);
  const others = buy.filter((p) => p.currentStock > 0 && !isCritical(p)).sort(order);
  const bestsellers = [...watched].filter((p) => rate(p) > 0).sort((a, b) => rate(b) - rate(a)).slice(0, CAP);

  const line = (p: P, withOrder: boolean): WatchLine => {
    const s = split.get(p.id) ?? { shops: 0, warehouse: 0 };
    const enRoute = Math.round(effectiveOnOrder(p.onOrder, outstanding.get(p.id) ?? 0));
    return {
      title: p.title,
      sku: p.sku,
      abc: (p.abcCategory as "A" | "B" | "C" | null) ?? "C",
      runRate: Math.round(rate(p) * 100) / 100,
      orderQty: withOrder ? qty(p) : null,
      orderCostKes: withOrder ? Math.round(lineCost(p)) : 0,
      shops: Math.round(s.shops),
      warehouse: Math.round(s.warehouse),
      enRoute,
      total: Math.round(s.shops + s.warehouse) + enRoute,
      daysLeft: Math.round(daysLeft(p)),
    };
  };
  const sum = (xs: P[]) => Math.round(xs.reduce((t, p) => t + lineCost(p), 0));

  return {
    tenantName: tenant.name,
    currency: tenant.currency ?? "KES",
    dateLabel: now.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: tenant.timezone ?? "Africa/Nairobi" }),
    leadDays: LONG_LEAD_DAYS,
    watchedCount: watched.length,
    urgentCount: criticals.length + oosHigh.length,
    attentionCount: criticals.length + oosHigh.length + oosLow.length,
    bestsellers: bestsellers.map((p) => line(p, false)),
    criticals: criticals.slice(0, CAP).map((p) => line(p, true)),
    criticalsCount: criticals.length,
    criticalsBudgetKes: sum(criticals),
    oosHigh: oosHigh.slice(0, CAP).map((p) => line(p, true)),
    oosHighCount: oosHigh.length,
    oosHighBudgetKes: sum(oosHigh),
    oosLow: oosLow.slice(0, CAP).map((p) => line(p, true)),
    oosLowCount: oosLow.length,
    oosLowBudgetKes: sum(oosLow),
    others: others.slice(0, CAP).map((p) => line(p, true)),
    othersCount: others.length,
    othersBudgetKes: sum(others),
    totalBudgetKes: sum(buy),
    totalOrderLines: buy.length,
  };
}

/** Every-other-day cadence on the shop's own calendar (even day of year), as
 *  the original sends it. */
export function isImportsWatchDay(now: Date, timezone: string): boolean {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const [y, m, d] = parts.split("-").map(Number) as [number, number, number];
  const dayOfYear = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 0)) / 86_400_000);
  return dayOfYear % 2 === 0;
}
