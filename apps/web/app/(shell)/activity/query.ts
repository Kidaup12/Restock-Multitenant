import { ACTIVITY_PAGE_SIZE } from "@/lib/data/activity";

/**
 * The activity screen's state, as the URL: which page, and what was searched.
 *
 * It lives in the address bar for the same reason the catalogue's does — the
 * server decides which entries to send, so it has to read what the reader
 * chose — and it means a searched view can be linked and the back button walks
 * the reader's own steps.
 *
 * A hand-edited or stale value falls back to the default rather than throwing:
 * a bad `page` should show the log, not an error.
 */

/** `page` is 1-based in the URL (people read pages from 1), 0-based inside. */
const PAGE_PARAM = "page";
const SEARCH_PARAM = "q";

/** Long enough for anything a shop types, short enough that a pasted essay
 *  cannot turn one request into a scan for fifty terms. */
const SEARCH_MAX = 120;

export type ActivityQuery = {
  /** Free text, already trimmed. Empty means no filter. */
  search: string;
  /** 0-based. */
  page: number;
};

export const DEFAULT_ACTIVITY_QUERY: ActivityQuery = { search: "", page: 0 };

/** What Next hands a page: a value may be absent, single, or repeated. */
export type RawSearchParams = Record<string, string | string[] | undefined>;

function one(params: RawSearchParams, key: string): string | undefined {
  const v = params[key];
  return Array.isArray(v) ? v[0] : v;
}

export function parseActivityQuery(params: RawSearchParams): ActivityQuery {
  const page = Number(one(params, PAGE_PARAM) ?? "1");
  return {
    search: (one(params, SEARCH_PARAM) ?? "").trim().slice(0, SEARCH_MAX),
    page: Number.isFinite(page) && page >= 1 ? Math.floor(page) - 1 : 0,
  };
}

/** The query as a querystring, defaults omitted so an untouched log has a clean
 *  `/activity` URL and every param present means the reader chose it. */
export function activityQueryToSearch(q: ActivityQuery): string {
  const out = new URLSearchParams();
  if (q.search) out.set(SEARCH_PARAM, q.search);
  if (q.page > 0) out.set(PAGE_PARAM, String(q.page + 1));
  const s = out.toString();
  return s ? `?${s}` : "";
}

/** A changed query, back on page 1. Searching narrows WHICH entries match, so a
 *  reader sitting on page 3 would otherwise land on an empty page of a one-page
 *  result. Paging itself passes `page` and keeps it. */
export function withActivityQuery(q: ActivityQuery, patch: Partial<ActivityQuery>): ActivityQuery {
  return { ...q, ...patch, page: patch.page ?? 0 };
}

/** Clamp to a real page. What survives a reader coming back to a bookmarked
 *  page 4 of a log that has since been narrowed by a search. */
export function activityPageBounds(
  total: number,
  page: number
): { pageCount: number; current: number; start: number } {
  const pageCount = Math.max(1, Math.ceil(total / ACTIVITY_PAGE_SIZE));
  const current = Math.min(Math.max(0, page), pageCount - 1);
  return { pageCount, current, start: current * ACTIVITY_PAGE_SIZE };
}
