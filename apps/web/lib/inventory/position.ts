import { effectiveWindowDays } from "@wezesha/forecast";

export const POSITION_WINDOWS = [30, 60, 90] as const;
export type PositionWindow = (typeof POSITION_WINDOWS)[number];
export function positionWindow(value: unknown): PositionWindow {
  const days = Number(Array.isArray(value) ? value[0] : value);
  return POSITION_WINDOWS.includes(days as PositionWindow) ? days as PositionWindow : 30;
}

export type PositionRow = {
  productId: string; title: string; sku: string; abc: string | null; supplier: string | null;
  opening: number; openingEstimated: boolean; openingDate: string | null;
  soldUnits: number; onHand: number; inbound: number;
  observedDays: number; inStockDays: number; stockoutDays: number;
  effectiveDays: number; salesPerDay: number; coverDays: number | null;
};

/** Original position report's average, distinct from weighted forecast demand.
 * Missing snapshot days stay in the denominator; only confirmed empty days leave.
 * The shared adaptive floor protects a short, thin sales signal.
 */
export function positionRow(input: {
  productId: string; title: string; sku: string; abc: string | null; supplier: string | null;
  onHand: number; inbound: number; windowDays: PositionWindow;
  soldUnits: number; saleDays: number; observedDays: number; inStockDays: number;
  stockoutDays: number; openingSnapshot: { onHand: number; date: string } | null;
}): PositionRow {
  const effectiveDays = effectiveWindowDays(input.windowDays, input.stockoutDays, {
    inStockDays: input.windowDays - input.stockoutDays, saleDays: input.saleDays,
  });
  const salesPerDay = Math.max(0, input.soldUnits) / effectiveDays;
  return {
    productId: input.productId, title: input.title, sku: input.sku, abc: input.abc,
    supplier: input.supplier, opening: input.openingSnapshot?.onHand ?? input.onHand + input.soldUnits,
    openingEstimated: input.openingSnapshot == null, openingDate: input.openingSnapshot?.date ?? null,
    soldUnits: input.soldUnits, onHand: input.onHand, inbound: input.inbound,
    observedDays: input.observedDays, inStockDays: input.inStockDays, stockoutDays: input.stockoutDays,
    effectiveDays, salesPerDay, coverDays: salesPerDay > 0 ? Math.max(0, input.onHand) / salesPerDay : null,
  };
}

export function selectPositionRows(rows: PositionRow[], search: string): PositionRow[] {
  const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const rank = (abc: string | null) => abc === "A" ? 0 : abc === "B" ? 1 : abc === "C" ? 2 : 3;
  return rows.filter(row => terms.every(term => `${row.title} ${row.sku} ${row.supplier ?? ""}`.toLowerCase().includes(term)))
    .sort((a, b) => rank(a.abc) - rank(b.abc) || b.salesPerDay - a.salesPerDay || a.title.localeCompare(b.title));
}
