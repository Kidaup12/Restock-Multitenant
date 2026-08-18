/**
 * Owner priors — "tell the forecast something" (spec §6).
 *
 * The owner supplies an expectation ("I expect about 40 a month", "run this
 * brand at 1.5x for the next 6 weeks") or, for a cold start, a "sell like X"
 * proxy pointer. It is knowledge, not a guess, so it moves the number — but it
 * is still not history, so it can never make a number read as "sure", and it
 * expires after its stated weeks unless renewed. Priors are listed and
 * revocable; the forecast shows it listened.
 *
 * Pure: matching, activeness, and application. Storage + the write path live in
 * the forecast-run package (a real OwnerPrior table).
 */

export type PriorScope = "product" | "brand";

/**
 * The most a multiplier prior may scale the engine's own number.
 *
 * A multiplier is a relative nudge — "run this brand hotter for a while". A real
 * campaign is 2–3×; past that it is almost always a slip (a `9` meant for `0.9`,
 * or a stray digit), and because a prior bypasses the reality guardrail it would
 * otherwise fund a buy list off a typo. An expectation in absolute units is a
 * different thing — the owner naming a number they mean — and is left alone.
 */
export const OWNER_PRIOR_MAX_MULTIPLIER = 4;

/** The shape the engine needs to reason about a prior. Storage carries more
 *  (author, note, id); only these fields drive the math. */
export type OwnerPriorFacts = {
  scope: PriorScope;
  /** productId (scope "product") or brand/vendor name (scope "brand"). */
  scopeValue: string;
  /** "I expect about X units / 30 days". Null when the prior is a multiplier or a proxy. */
  expectedUnits?: number | null;
  /** Scale the current forecast by this factor. Null when it is an expectation or a proxy. */
  multiplier?: number | null;
  /** Cold-start "sell like": the established product to borrow from. */
  proxyProductId?: string | null;
  /** How many weeks the prior stays in force from createdAt. */
  weeks: number;
  createdAt: Date;
  /** Soft-delete: a revoked prior is still listed but no longer applied. */
  revokedAt?: Date | null;
};

/** A product the engine is deciding a prior against. */
export type PriorProduct = { id: string; vendor: string | null };

const norm = (v: string | null | undefined): string => (v ?? "").trim().toLowerCase();

/** In force as of `asOf`: not revoked and within its weeks window from creation. */
export function priorActive(
  p: Pick<OwnerPriorFacts, "createdAt" | "weeks" | "revokedAt">,
  asOf: Date
): boolean {
  if (p.revokedAt) return false;
  const end = new Date(p.createdAt);
  end.setUTCDate(end.getUTCDate() + Math.max(0, Math.round(p.weeks)) * 7);
  return asOf.getTime() <= end.getTime();
}

/** Does this prior target this product? Product scope matches by id; brand scope
 *  by case-insensitive vendor. */
export function priorMatchesProduct(
  p: Pick<OwnerPriorFacts, "scope" | "scopeValue">,
  product: PriorProduct
): boolean {
  if (p.scope === "product") return p.scopeValue === product.id;
  return norm(product.vendor) !== "" && norm(p.scopeValue) === norm(product.vendor);
}

/**
 * The prior that should apply to a product: the most specific active match.
 * A product-scope prior beats a brand-scope one (owner was more precise); among
 * equals the most recently created wins. Null = no prior speaks to this product.
 */
export function selectPriorForProduct(
  priors: OwnerPriorFacts[],
  product: PriorProduct,
  asOf: Date
): OwnerPriorFacts | null {
  const matches = priors.filter((p) => priorActive(p, asOf) && priorMatchesProduct(p, product));
  if (matches.length === 0) return null;
  return matches.reduce((best, p) => {
    const moreSpecific = p.scope === "product" && best.scope !== "product";
    const sameSpecificityNewer =
      p.scope === best.scope && p.createdAt.getTime() > best.createdAt.getTime();
    return moreSpecific || sameSpecificityNewer ? p : best;
  });
}

/**
 * Apply an expectation/multiplier prior to a base 30-day forecast. expectedUnits
 * sets the level outright; multiplier scales it (applied after expectedUnits when
 * both are present). A proxy-only prior leaves the base untouched here — the
 * borrow is resolved by the cold-start path, not this function.
 */
export function applyOwnerPrior(
  base30d: number,
  p: Pick<OwnerPriorFacts, "expectedUnits" | "multiplier">
): number {
  let v = base30d;
  if (p.expectedUnits != null) v = p.expectedUnits;
  if (p.multiplier != null) v = v * Math.min(p.multiplier, OWNER_PRIOR_MAX_MULTIPLIER);
  return Math.max(0, v);
}
