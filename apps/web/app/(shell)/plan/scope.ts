import type { BuyListRow } from "@/lib/data/plan";
import { NONE_VALUE } from "@/lib/facets/types";

/**
 * Lead-band buckets, keyed off the row's resolved lead days:
 * fast ≤7d · medium 8–28d · slow >28d. These are the plan's own restock-speed
 * bands, distinct from the catalogue's speed facet (which splits at 20d).
 */
export type LeadBand = "fast" | "medium" | "slow";

export const LEAD_BANDS: readonly LeadBand[] = ["fast", "medium", "slow"];

export const LEAD_BAND_LABELS: Record<LeadBand, string> = {
  fast: "Fast (≤7d)",
  medium: "Medium (8–28d)",
  slow: "Slow (>28d)",
};

export function leadBandFor(leadDays: number): LeadBand {
  if (leadDays <= 7) return "fast";
  if (leadDays <= 28) return "medium";
  return "slow";
}

/** Active scope: for each dimension, the chosen values (OR within). An empty
 *  array imposes no constraint on that dimension. */
export type ScopeSelection = {
  abc: string[];
  category: string[];
  supplier: string[];
  leadBand: LeadBand[];
};

export const EMPTY_SCOPE: ScopeSelection = {
  abc: [],
  category: [],
  supplier: [],
  leadBand: [],
};

/** The scope's four dimensions, in a fixed order — drives both the URL codec
 *  and the derived facets, so the two never fall out of step. */
type ScopeDimensionKey = keyof ScopeSelection;
const SCOPE_DIMENSIONS: readonly ScopeDimensionKey[] = ["abc", "category", "supplier", "leadBand"];

export function isScopeActive(sel: ScopeSelection): boolean {
  return sel.abc.length + sel.category.length + sel.supplier.length + sel.leadBand.length > 0;
}

/**
 * URL <-> scope, one param per dimension with comma-joined values:
 *   ?class=A,B&category=Serums&supplier=Orbit%20Imports&lead=fast,medium
 *
 * `class` names the abc dimension (consistent with the insights page's ?class);
 * `lead` names leadBand. This keeps the scope in the address bar, so a filtered
 * plan survives refresh, is deep-linkable, and Back/forward move between scopes.
 *
 * The same values the saved-scope encoding holds (see scope-actions'
 * parseSelection) travel here — abc/category/supplier verbatim (including the
 * NONE_VALUE sentinel), leadBand validated against LEAD_BANDS — so a URL scope
 * and a saved scope reconstruct the same ScopeSelection.
 */

/** Minimal reader the parser needs — satisfied by both URLSearchParams and
 *  Next's ReadonlyURLSearchParams (from useSearchParams). */
type ParamReader = { get(name: string): string | null };

const SCOPE_PARAMS = {
  abc: "class",
  category: "category",
  supplier: "supplier",
  leadBand: "lead",
} as const satisfies Record<ScopeDimensionKey, string>;

/** Split one comma-joined param into clean values: trimmed, empties dropped,
 *  order and duplicates preserved as typed. */
function splitParam(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/**
 * Rebuild a ScopeSelection from the URL. Defensive like parseAbcKey /
 * parseRangeKey: a missing param is an empty dimension, and an unknown LeadBand
 * is dropped so the applied selection is always one the scope bar can render.
 * abc/category/supplier are free-form (category and supplier names, or the
 * NONE_VALUE sentinel) so they pass through as given.
 */
export function parseScopeFromParams(params: ParamReader | null | undefined): ScopeSelection {
  // `useSearchParams()` is null during server prerender, so a caller can hand us
  // one; a null reader is simply no params, the same as every dimension empty.
  if (!params) return EMPTY_SCOPE;
  const leadBand = splitParam(params.get(SCOPE_PARAMS.leadBand)).filter((v): v is LeadBand =>
    (LEAD_BANDS as readonly string[]).includes(v)
  );
  return {
    abc: splitParam(params.get(SCOPE_PARAMS.abc)),
    category: splitParam(params.get(SCOPE_PARAMS.category)),
    supplier: splitParam(params.get(SCOPE_PARAMS.supplier)),
    leadBand,
  };
}

/**
 * The scope's params as name -> comma-joined value, empty dimensions omitted.
 * The caller merges these onto the existing query (deleting the four names it
 * doesn't set), so ?mode / ?urgent and anything else are preserved.
 */
export function scopeToParams(scope: ScopeSelection): Record<string, string> {
  const out: Record<string, string> = {};
  for (const dim of SCOPE_DIMENSIONS) {
    const values = scope[dim];
    if (values.length > 0) out[SCOPE_PARAMS[dim]] = values.join(",");
  }
  return out;
}

/** The URL param names this module owns — the writer deletes these before
 *  re-setting the active ones, so a cleared dimension leaves the URL. */
export const SCOPE_PARAM_NAMES: readonly string[] = Object.values(SCOPE_PARAMS);

/**
 * Does a row satisfy the selection? AND across the four dimensions, OR within
 * each. A dimension with no selection imposes nothing. Null abc/category/
 * supplier match the "none" sentinel, so an owner can scope TO the gaps.
 */
export function matchesScope(row: BuyListRow, sel: ScopeSelection): boolean {
  if (sel.abc.length > 0 && !sel.abc.includes(row.abc ?? NONE_VALUE)) return false;
  if (sel.category.length > 0 && !sel.category.includes(row.category ?? NONE_VALUE)) return false;
  if (sel.supplier.length > 0 && !sel.supplier.includes(row.supplierName ?? NONE_VALUE)) return false;
  if (sel.leadBand.length > 0 && !sel.leadBand.includes(leadBandFor(row.leadDays))) return false;
  return true;
}

/**
 * What the planner's "Urgent only" lens keeps.
 *
 * One predicate, so the checklist, the decision header above it and anything
 * exported from the screen cannot disagree about which rows are urgent.
 *
 * It lives here rather than in `lib/data/plan` because the planner is a client
 * component: importing a VALUE from that module pulls `prismaForTenant` — and
 * with it the Prisma clients, which throw on a missing SERVICE_DATABASE_URL —
 * into the browser bundle, and the page dies before it hydrates. Types are
 * erased and stay fine; values do not.
 */
export function isUrgentRow(row: Pick<BuyListRow, "urgency">): boolean {
  return row.urgency === "critical" || row.urgency === "high";
}

/** Pure row filter — the checklist renders the result. Extracted so the AND/OR
 *  logic is unit-tested without React. No selection short-circuits to the input
 *  list (same reference), so an unfiltered plan is untouched. */
export function filterBuyListRows(rows: BuyListRow[], sel: ScopeSelection): BuyListRow[] {
  if (!isScopeActive(sel)) return rows;
  return rows.filter((row) => matchesScope(row, sel));
}
