/**
 * Cold start — borrow-from-similar for a product with no history of its own.
 *
 * A new product's run rate is 0, which would silently read as "not selling"
 * and keep it off every buy list (spec §6). Instead it borrows the shape of an
 * ESTABLISHED similar product (same brand, else same category) scaled to its
 * own price, flagged as borrowed and never presented as certainty. The iron
 * rule: a proxy must be established — a new product can NEVER borrow from
 * another new product (spec §6, "cold-start proxies must be established
 * products only"). When nothing qualifies the honest answer is "too new to
 * forecast", not a fabricated number.
 *
 * Pure: the caller assembles the candidate list (the established products in
 * the catalogue) and the target, and this module picks and scales.
 */

import { NEW_PRODUCT_DAYS } from "./layered";

/** A product that could serve as a proxy for a cold-start item. */
export type ProxyCandidate = {
  productId: string;
  vendor: string | null;
  customCategory: string | null;
  /** Days of sales history available. */
  historyDays: number;
  /** Established daily run rate (units/day) from its own sales. */
  dailyRate: number;
  priceKes?: number | null;
};

/** The cold-start product looking for a shape to borrow. */
export type ProxyTarget = {
  productId: string;
  vendor: string | null;
  customCategory: string | null;
  priceKes?: number | null;
};

/** Minimum history for a product to be an eligible proxy — the same threshold
 *  the engine uses to stop treating a product as "new". */
export const PROXY_MIN_HISTORY_DAYS = NEW_PRODUCT_DAYS;

/** Price-scaling clamp: a proxy's rate may be scaled by at most this factor up
 *  or down for a price gap, so a cheap-vs-expensive mismatch can't run away. */
export const BORROW_SCALE_MIN = 0.5;
export const BORROW_SCALE_MAX = 2;

const norm = (v: string | null | undefined): string => (v ?? "").trim().toLowerCase();
const sameBrand = (a: string | null, b: string | null): boolean => norm(a) !== "" && norm(a) === norm(b);
const sameCategory = (a: string | null, b: string | null): boolean => norm(a) !== "" && norm(a) === norm(b);

/** An eligible proxy has a full baseline of history AND a real, non-zero rate.
 *  This is what forbids borrowing from another new (or dead) product. */
export function isEstablishedProxy(c: { historyDays: number; dailyRate: number }): boolean {
  return c.historyDays >= PROXY_MIN_HISTORY_DAYS && c.dailyRate > 0;
}

/**
 * Pick the best established proxy for a cold-start target: same brand wins over
 * same category, and within a tier the product with the most history (steadiest
 * signal) is chosen. Returns null when nothing qualifies — the caller then shows
 * "too new to forecast" rather than inventing a number.
 */
export function selectProxy(target: ProxyTarget, candidates: ProxyCandidate[]): ProxyCandidate | null {
  const eligible = candidates.filter(
    (c) => c.productId !== target.productId && isEstablishedProxy(c)
  );
  const brandMatches = eligible.filter((c) => sameBrand(c.vendor, target.vendor));
  const categoryMatches = eligible.filter((c) => sameCategory(c.customCategory, target.customCategory));
  const pool = brandMatches.length > 0 ? brandMatches : categoryMatches;
  if (pool.length === 0) return null;
  return pool.reduce((best, c) => (c.historyDays > best.historyDays ? c : best));
}

/**
 * Scale the proxy's daily rate to the target by relative price: a cheaper item
 * than its proxy tends to sell more units, and vice versa. Clamped both ways so
 * a large price gap can't produce a wild borrow. With no usable price on either
 * side the proxy's rate is borrowed as-is.
 */
export function borrowedDailyRate(
  proxyRate: number,
  target: { priceKes?: number | null },
  proxy: { priceKes?: number | null }
): number {
  const tp = target.priceKes ?? 0;
  const pp = proxy.priceKes ?? 0;
  if (tp > 0 && pp > 0) {
    const ratio = Math.min(BORROW_SCALE_MAX, Math.max(BORROW_SCALE_MIN, pp / tp));
    return proxyRate * ratio;
  }
  return proxyRate;
}

/** Convenience: the borrowed 30-day forecast for a target from a chosen proxy. */
export function borrowedForecast30d(proxy: ProxyCandidate, target: ProxyTarget): number {
  return borrowedDailyRate(proxy.dailyRate, target, proxy) * 30;
}
