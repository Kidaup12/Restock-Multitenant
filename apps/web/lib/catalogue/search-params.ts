import { FACET_KEYS, type FacetKey, type FacetSelection } from "@/lib/facets";
import {
  DEFAULT_QUERY,
  SCOPES,
  SORT_KEYS,
  type CatalogueQuery,
  type MoneyBandFilter,
  type Scope,
  type SortKey,
} from "./view-model";

/**
 * The catalogue screen's state, as the URL.
 *
 * It lives in the address bar rather than component state because the server now
 * decides which rows to send: it has to read the same filters the reader chose.
 * Putting them here also means a filtered view can be linked and bookmarked, the
 * back button walks the reader's own steps, and an edit that revalidates the
 * page returns them to what they were looking at instead of resetting to page 1
 * of everything.
 *
 * Facet params carry an `f.` prefix so a facet named `health` cannot collide
 * with the health-chip filter, nor a future facet with `scope`, `sort` or `page`.
 * Multi-valued facets repeat the key (`?f.brand=A&f.brand=B`) rather than
 * delimiting, because vendor and category names contain commas.
 *
 * Unknown or malformed values fall back to the default rather than throwing — a
 * hand-edited URL should show the catalogue, not an error.
 */

const FACET_PREFIX = "f.";

/** `page` is 1-based in the URL (humans read pages from 1) and 0-based inside. */
const PAGE_PARAM = "page";
const SCOPE_PARAM = "scope";
const SORT_PARAM = "sort";
const DIR_PARAM = "dir";
const ISSUE_PARAM = "issue";
const MONEY_PARAM = "money";
const SEARCH_PARAM = "q";

/** Long enough for any product name a shop types, short enough that a pasted
 *  essay cannot make every row run a scan over it. */
const SEARCH_MAX = 120;

const MONEY_FILTERS = ["dead_overstock", "revenue_at_risk", "below_cost"] as const;

/** What Next hands a page: a value may be absent, single, or repeated. */
export type RawSearchParams = Record<string, string | string[] | undefined>;

function all(params: RawSearchParams, key: string): string[] {
  const v = params[key];
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function one(params: RawSearchParams, key: string): string | undefined {
  return all(params, key)[0];
}

export function parseCatalogueQuery(params: RawSearchParams): CatalogueQuery {
  const scope = one(params, SCOPE_PARAM);
  const sort = one(params, SORT_PARAM);
  const money = one(params, MONEY_PARAM);
  const issue = one(params, ISSUE_PARAM);
  const page = Number(one(params, PAGE_PARAM) ?? "1");

  const selection: FacetSelection = {};
  for (const key of FACET_KEYS) {
    const values = all(params, `${FACET_PREFIX}${key}`).filter((v) => v.length > 0);
    if (values.length) selection[key] = values;
  }

  return {
    scope: SCOPES.includes(scope as Scope) ? (scope as Scope) : DEFAULT_QUERY.scope,
    selection,
    healthFilter: issue && issue.length > 0 ? issue : null,
    search: (one(params, SEARCH_PARAM) ?? "").trim().slice(0, SEARCH_MAX),
    moneyFilter: MONEY_FILTERS.includes(money as Exclude<MoneyBandFilter, null>)
      ? (money as MoneyBandFilter)
      : null,
    sortKey: SORT_KEYS.includes(sort as SortKey) ? (sort as SortKey) : DEFAULT_QUERY.sortKey,
    desc: one(params, DIR_PARAM) === "desc",
    page: Number.isFinite(page) && page >= 1 ? Math.floor(page) - 1 : 0,
  };
}

/**
 * The query as a querystring, defaults omitted so an untouched catalogue has a
 * clean `/stock` URL and every param present means the reader chose it.
 * `view` is passed through because the Stock page's tab lives there too.
 */
export function catalogueQueryToSearch(q: CatalogueQuery, extra?: { view?: string }): string {
  const out = new URLSearchParams();
  if (extra?.view) out.set("view", extra.view);
  if (q.scope !== DEFAULT_QUERY.scope) out.set(SCOPE_PARAM, q.scope);
  for (const key of FACET_KEYS) {
    for (const value of q.selection[key as FacetKey] ?? []) out.append(`${FACET_PREFIX}${key}`, value);
  }
  if (q.search) out.set(SEARCH_PARAM, q.search);
  if (q.healthFilter) out.set(ISSUE_PARAM, q.healthFilter);
  if (q.moneyFilter) out.set(MONEY_PARAM, q.moneyFilter);
  if (q.sortKey !== DEFAULT_QUERY.sortKey) out.set(SORT_PARAM, q.sortKey);
  if (q.desc) out.set(DIR_PARAM, "desc");
  if (q.page > 0) out.set(PAGE_PARAM, String(q.page + 1));
  const s = out.toString();
  return s ? `?${s}` : "";
}

/** The query as hidden form fields, minus `q` and `page`. A GET form submits
 *  only its own inputs, so a search box that did not carry the rest would
 *  silently drop the reader's scope, facets, chip and sort the moment they
 *  typed. Built from the same serializer the links use, so the two can't drift. */
export function catalogueQueryFields(
  q: CatalogueQuery,
  extra?: { view?: string },
): { name: string; value: string }[] {
  const search = catalogueQueryToSearch({ ...q, search: "", page: 0 }, extra);
  return [...new URLSearchParams(search.replace(/^\?/, ""))].map(([name, value]) => ({ name, value }));
}

/** A changed query, back on page 1. Every control that changes WHICH rows match
 *  goes through here: filtering down to eight rows while sitting on page 7 would
 *  otherwise show an empty table. Paging itself passes `page` and keeps it. */
export function withQuery(q: CatalogueQuery, patch: Partial<CatalogueQuery>): CatalogueQuery {
  return { ...q, ...patch, page: patch.page ?? 0 };
}
