import { normalizeSku } from "./normalize";
import type { MatchProduct } from "./types";

/**
 * POS till code → catalogue productId.
 *
 * Match is EXACT normalized SKU only. The reference design also recovered codes
 * by embedded Shopify variant id and by unambiguous product name; that is
 * deliberately NOT ported for the ingest path. Two reasons:
 *   1. The spec is explicit that POS matching is by SKU ("matched by SKU →
 *      channel pos"), and physical till codes are set up to mirror the SKU.
 *   2. Auto-recovering by a lookalike name silently writes revenue against a
 *      guessed product — the exact failure the "unmatched, never invented" rule
 *      exists to prevent. A near-miss belongs in the fix queue as a *suggestion*
 *      the owner confirms (see suggestProductForSku), not an automatic match.
 *
 * Returns a normalized-sku → productId map. A catalogue SKU that repeats across
 * products is ambiguous and is dropped from the map, so it surfaces as unmatched
 * rather than attaching revenue to an arbitrary one.
 */
export function resolvePosSkuMap(products: MatchProduct[]): Map<string, string> {
  const byKey = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const p of products) {
    const key = normalizeSku(p.sku);
    if (!key) continue;
    if (byKey.has(key)) ambiguous.add(key);
    else byKey.set(key, p.id);
  }
  for (const key of ambiguous) byKey.delete(key);
  return byKey;
}

export type ProductSuggestion = {
  productId: string;
  sku: string;
  title: string;
  /** 0..1 — higher is a closer lexical match. */
  score: number;
};

const tokens = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length > 0);

/**
 * Best-guess catalogue product for an unmatched till line, for the fix queue's
 * "suggested match" column. Advisory only — never used to write revenue.
 *
 * Ranks by shared normalized tokens between the till code + line name and each
 * product's SKU + title (Jaccard-ish overlap), with a bump when the till code is
 * a substring of the product SKU (a padded/truncated code). Returns null when
 * nothing clears a low confidence floor — a bad suggestion is worse than none.
 */
export function suggestProductForSku(
  sku: string,
  name: string | null | undefined,
  products: MatchProduct[]
): ProductSuggestion | null {
  const needle = new Set([...tokens(sku), ...tokens(name ?? "")]);
  if (needle.size === 0) return null;
  const normSku = normalizeSku(sku);

  let best: ProductSuggestion | null = null;
  for (const p of products) {
    const hay = new Set([...tokens(p.sku ?? ""), ...tokens(p.title ?? "")]);
    if (hay.size === 0) continue;
    let shared = 0;
    for (const t of needle) if (hay.has(t)) shared++;
    const union = new Set([...needle, ...hay]).size;
    let score = union > 0 ? shared / union : 0;
    const pSku = normalizeSku(p.sku);
    if (normSku && pSku && (pSku.includes(normSku) || normSku.includes(pSku))) {
      score = Math.max(score, 0.5) + 0.25;
    }
    if (score > (best?.score ?? 0)) {
      best = { productId: p.id, sku: p.sku ?? "", title: p.title ?? "", score: Math.min(score, 1) };
    }
  }
  return best && best.score >= 0.34 ? best : null;
}
