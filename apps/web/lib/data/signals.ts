import { BUYABLE_PRODUCT_WHERE, isSellable, prismaForTenant } from "@wezesha/db";
import { detectSpikes, expandPromoWindowsToDays } from "@wezesha/forecast";
import { SPIKE_IGNORE_KIND, spikeKey } from "@/lib/signals/spikes";

/**
 * Reads for the declared-signals screen: the promos and closed days an owner has
 * told us about, plus what the forecast actually does with them.
 *
 * Server-only; explicit tenantId; every query runs on the RLS-enforced tenant
 * client. Nothing here carries a KES cost, so no money-blind gating applies.
 *
 * The forecast looks back one year (HISTORY_DAYS in packages/forecast-run), so
 * that is the window the counts are quoted over — days outside it change nothing.
 */

/** Matches the engine's look-back so "days left out" means what it says. */
const HISTORY_DAYS = 365;
const DAY_MS = 86_400_000;

const dayFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export type PromoStatus = "upcoming" | "running" | "past";

export type DeclaredPromo = {
  id: string;
  startKey: string;
  endKey: string;
  rangeLabel: string;
  scope: string;
  scopeValue: string | null;
  scopeLabel: string;
  promoType: string;
  discountPct: number;
  notes: string | null;
  status: PromoStatus;
  /** Days inside the forecast's look-back this promo takes out of the run rate. */
  daysExcluded: number;
};

export type DeclaredClosure = {
  locationId: string;
  locationName: string;
  dayKey: string;
  dayLabel: string;
  reason: string;
  note: string | null;
  /** The forecast only drops a day when every selling location was shut — a
   *  single branch closing while another traded still counts as a trading day. */
  countsAsClosed: boolean;
};

export type SignalsCatalogue = {
  brands: string[];
  categories: string[];
  products: { sku: string; title: string }[];
};

export type SignalsData = {
  promos: DeclaredPromo[];
  closures: DeclaredClosure[];
  locations: { id: string; name: string; sells: boolean }[];
  catalogue: SignalsCatalogue;
  promoDaysExcluded: number;
  closedDaysExcluded: number;
  historyDays: number;
  /** Months the shop has stated run above or below a normal one. */
  months: { month: string; multiplier: number }[];
};

function dayKeyOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function statusOf(start: Date, end: Date, now: Date): PromoStatus {
  if (start.getTime() > now.getTime()) return "upcoming";
  // endDate is a day marker, so the promo runs to the end of that day.
  if (end.getTime() + DAY_MS <= now.getTime()) return "past";
  return "running";
}

export async function getDeclaredSignals(
  tenantId: string,
  now: Date = new Date()
): Promise<SignalsData> {
  const db = prismaForTenant(tenantId);
  const since = new Date(now.getTime() - HISTORY_DAYS * DAY_MS);

  const [promoRows, closureRows, locationRows, productRows, monthRows] = await Promise.all([
    db.promo.findMany({
      where: { deletedAt: null },
      orderBy: { startDate: "desc" },
      select: {
        id: true,
        startDate: true,
        endDate: true,
        scope: true,
        scopeValue: true,
        promoType: true,
        discountPct: true,
        notes: true,
      },
    }),
    db.locationClosure.findMany({
      where: { date: { gte: since } },
      orderBy: { date: "desc" },
      select: { locationId: true, date: true, reason: true, note: true },
    }),
    db.location.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, locationType: true },
    }),
    db.product.findMany({
      where: { ...BUYABLE_PRODUCT_WHERE },
      orderBy: { title: "asc" },
      select: { sku: true, title: true, vendor: true, productType: true },
    }),
    // Months the shop has said run above or below normal. Only rows carrying a
    // multiplier — the rest of MonthlyContext is free-text notes.
    db.monthlyContext.findMany({
      where: { expectedMultiplier: { not: null } },
      orderBy: { month: "asc" },
      select: { month: true, expectedMultiplier: true },
    }),
  ]);

  const titleBySku = new Map(productRows.map((p) => [p.sku, p.title]));
  const locationById = new Map(locationRows.map((l) => [l.id, l.name]));
  const sellsIds = new Set(locationRows.filter(isSellable).map((l) => l.id));

  // Same rule as the engine (packages/forecast-run/src/run.ts): a day only
  // leaves the run rate when every Sells location was closed on it.
  const closedSellsByDay = new Map<string, Set<string>>();
  for (const row of closureRows) {
    if (!sellsIds.has(row.locationId)) continue;
    const key = dayKeyOf(row.date);
    let set = closedSellsByDay.get(key);
    if (!set) closedSellsByDay.set(key, (set = new Set()));
    set.add(row.locationId);
  }
  const fullClosureDays = new Set(
    [...closedSellsByDay.entries()]
      .filter(([, closed]) => sellsIds.size > 0 && closed.size >= sellsIds.size)
      .map(([key]) => key)
  );

  const promos: DeclaredPromo[] = promoRows.map((p) => ({
    id: p.id,
    startKey: dayKeyOf(p.startDate),
    endKey: dayKeyOf(p.endDate),
    rangeLabel:
      dayKeyOf(p.startDate) === dayKeyOf(p.endDate)
        ? dayFormat.format(p.startDate)
        : `${dayFormat.format(p.startDate)} – ${dayFormat.format(p.endDate)}`,
    scope: p.scope,
    scopeValue: p.scopeValue,
    scopeLabel: scopeLabelOf(p.scope, p.scopeValue, titleBySku),
    promoType: p.promoType,
    discountPct: p.discountPct,
    notes: p.notes,
    status: statusOf(p.startDate, p.endDate, now),
    daysExcluded: expandPromoWindowsToDays([{ start: p.startDate, end: p.endDate }], since, now)
      .length,
  }));

  const closures: DeclaredClosure[] = closureRows.map((row) => {
    const dayKey = dayKeyOf(row.date);
    return {
      locationId: row.locationId,
      locationName: locationById.get(row.locationId) ?? "Unknown location",
      dayKey,
      dayLabel: dayFormat.format(row.date),
      reason: row.reason,
      note: row.note,
      countsAsClosed: fullClosureDays.has(dayKey),
    };
  });

  const promoDaysExcluded = expandPromoWindowsToDays(
    promoRows.map((p) => ({ start: p.startDate, end: p.endDate })),
    since,
    now
  ).length;

  return {
    promos,
    closures,
    locations: locationRows.map((l) => ({ id: l.id, name: l.name, sells: sellsIds.has(l.id) })),
    catalogue: {
      brands: distinct(productRows.map((p) => p.vendor)),
      categories: distinct(productRows.map((p) => p.productType)),
      products: productRows.map((p) => ({ sku: p.sku, title: p.title })),
    },
    promoDaysExcluded,
    closedDaysExcluded: fullClosureDays.size,
    historyDays: HISTORY_DAYS,
    months: monthRows.map((m) => ({ month: m.month, multiplier: m.expectedMultiplier as number })),
  };
}

function distinct(values: (string | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => !!v && v.trim().length > 0))].sort((a, b) =>
    a.localeCompare(b)
  );
}

function scopeLabelOf(
  scope: string,
  scopeValue: string | null,
  titleBySku: Map<string, string>
): string {
  if (scope === "sku" && scopeValue) return titleBySku.get(scopeValue) ?? scopeValue;
  if (scope === "brand" && scopeValue) return `${scopeValue} (brand)`;
  if (scope === "category" && scopeValue) return `${scopeValue} (category)`;
  return "Everything in the shop";
}

/** A day the shop sold far above its own normal, with no promo logged to explain
 *  it. Surfaced as a question, never applied on its own — only the owner knows
 *  whether it was a promotion or a one-off. */
export type SpikeSuggestion = {
  productId: string;
  sku: string;
  title: string;
  dayKey: string;
  dayLabel: string;
  quantity: number;
  /** The product's own normal units/day, for the comparison sentence. */
  baseline: number;
  multiple: number;
};

/** How many to put in front of the owner at once — this is a nudge, not a queue. */
const MAX_SPIKE_SUGGESTIONS = 5;
/** Enough history for the detector's 60-day baseline plus its 14-day lookback. */
const SPIKE_HISTORY_DAYS = 90;

/**
 * Unexplained demand spikes, as questions for the owner.
 *
 * An un-logged spike — an influencer post, a bulk buyer, a flash sale nobody
 * recorded — bleeds into the baseline and quietly inflates every future order
 * for that product. The engine's guardrail caps the worst of it; labelling the
 * day as a promotion is the actual fix, because promo days are then left out of
 * the run rate.
 *
 * The detector already knew how to find these (`detectSpikes`); nothing called
 * it, so the shop was still relying on the owner remembering. Days already
 * inside a declared promo are skipped by the detector, and days the owner has
 * answered "one-off" are skipped here.
 */
export async function getSpikeSuggestions(
  tenantId: string,
  now: Date = new Date()
): Promise<SpikeSuggestion[]> {
  const db = prismaForTenant(tenantId);
  const since = new Date(now.getTime() - SPIKE_HISTORY_DAYS * DAY_MS);

  const [salesRows, promoRows, dismissedRows, productRows] = await Promise.all([
    db.salesHistory.findMany({
      where: { date: { gte: since, lte: now } },
      select: { productId: true, date: true, quantity: true, revenueKes: true },
    }),
    db.promo.findMany({
      where: { deletedAt: null },
      select: { startDate: true, endDate: true },
    }),
    db.ignoreRule.findMany({ where: { kind: SPIKE_IGNORE_KIND }, select: { value: true } }),
    db.product.findMany({
      where: BUYABLE_PRODUCT_WHERE,
      select: { id: true, sku: true, title: true },
    }),
  ]);

  const dismissed = new Set(dismissedRows.map((r) => r.value));
  const promoWindows = promoRows.map((p) => ({ start: p.startDate, end: p.endDate }));
  const productById = new Map(productRows.map((p) => [p.id, p]));

  const historyByProduct = new Map<string, { date: Date; quantity: number; revenueKes: number }[]>();
  for (const row of salesRows) {
    if (!productById.has(row.productId)) continue; // not a product we'd buy again
    let list = historyByProduct.get(row.productId);
    if (!list) historyByProduct.set(row.productId, (list = []));
    list.push(row);
  }

  const out: SpikeSuggestion[] = [];
  for (const [productId, history] of historyByProduct) {
    const product = productById.get(productId)!;
    for (const spike of detectSpikes(history, promoWindows, now)) {
      const dayKey = dayKeyOf(spike.date);
      if (dismissed.has(spikeKey(productId, dayKey))) continue;
      out.push({
        productId,
        sku: product.sku,
        title: product.title,
        dayKey,
        dayLabel: dayFormat.format(spike.date),
        quantity: Math.round(spike.quantity),
        baseline: Math.round(spike.baseline * 10) / 10,
        multiple: spike.multiple,
      });
    }
  }

  // Biggest surprise first, then most recent — the ones worth a moment's thought.
  out.sort((a, b) => b.multiple - a.multiple || b.dayKey.localeCompare(a.dayKey));
  return out.slice(0, MAX_SPIKE_SUGGESTIONS);
}
