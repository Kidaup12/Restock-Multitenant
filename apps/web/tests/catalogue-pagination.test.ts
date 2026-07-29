import { beforeAll, describe, expect, it } from "vitest";
import { seedDev, type SeedResult } from "../../../packages/db/scripts/seed-dev";
import { getCatalogueScreen, getStockCatalogue } from "../lib/data/stock";
import {
  DEFAULT_QUERY,
  PAGE_SIZE,
  catalogueQueryToSearch,
  inScope,
  parseCatalogueQuery,
  selectRows,
  withQuery,
  type CatalogueQuery,
} from "../lib/catalogue";

/**
 * Paging the catalogue is only safe if it changes what is ON SCREEN and nothing
 * else. The counts, chips, facet options and money band all describe the whole
 * catalogue; the rows describe one page. These tests hold that line, because the
 * failure they guard against is silent — a chip that says 312 next to a table
 * that can only ever prove 50 looks perfectly fine.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

describe("catalogue query <-> URL", () => {
  it("round-trips every control", () => {
    const q: CatalogueQuery = {
      scope: "all",
      selection: { brand: ["Nice & Lovely", "Cantu"], health: ["missing_cost"] },
      healthFilter: "dup_sku",
      moneyFilter: "below_cost",
      sortKey: "runRate",
      desc: true,
      page: 3,
    };
    expect(parseCatalogueQuery(qs(catalogueQueryToSearch(q)))).toEqual(q);
  });

  it("keeps an untouched catalogue on a clean /stock URL", () => {
    expect(catalogueQueryToSearch(DEFAULT_QUERY)).toBe("");
    expect(parseCatalogueQuery({})).toEqual(DEFAULT_QUERY);
  });

  it("survives a hand-edited URL rather than throwing", () => {
    const q = parseCatalogueQuery({
      scope: "nonsense",
      sort: "; drop table",
      money: "free_money",
      page: "-4",
    });
    expect(q.scope).toBe(DEFAULT_QUERY.scope);
    expect(q.sortKey).toBe(DEFAULT_QUERY.sortKey);
    expect(q.moneyFilter).toBeNull();
    expect(q.page).toBe(0);
  });

  it("carries a facet value containing a comma intact", () => {
    // Vendor and category names contain commas, which is why facets repeat the
    // key instead of delimiting one.
    const q = withQuery(DEFAULT_QUERY, { selection: { brand: ["Lever, Bros", "Haco"] } });
    expect(parseCatalogueQuery(qs(catalogueQueryToSearch(q))).selection.brand).toEqual([
      "Lever, Bros",
      "Haco",
    ]);
  });

  it("sends every filter change back to page 1, and paging alone does not", () => {
    const onPage7 = { ...DEFAULT_QUERY, page: 7 };
    expect(withQuery(onPage7, { scope: "all" }).page).toBe(0);
    expect(withQuery(onPage7, { healthFilter: "dead" }).page).toBe(0);
    expect(withQuery(onPage7, { sortKey: "abc" }).page).toBe(0);
    expect(withQuery(onPage7, { page: 8 }).page).toBe(8);
  });

  /** `?a=1&b=2` as the shape Next hands a page. */
  function qs(search: string): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of new URLSearchParams(search)) {
      const cur = out[k];
      if (cur === undefined) out[k] = v;
      else if (Array.isArray(cur)) cur.push(v);
      else out[k] = [cur, v];
    }
    return out;
  }
});

describe.skipIf(!runnable)("paged catalogue screen (seeded local db)", () => {
  let seeded: SeedResult;

  beforeAll(async () => {
    seeded = await seedDev();
  }, 120_000);

  it("counts the whole catalogue while sending one page of rows", async () => {
    const all = await getStockCatalogue(seeded.tenantId, { canViewCosts: true });
    const screen = await getCatalogueScreen(seeded.tenantId, {
      canViewCosts: true,
      query: DEFAULT_QUERY,
    });

    const selling = all.filter((r) => inScope(r, "selling"));
    expect(screen.aggregates.scopedCount).toBe(selling.length);
    expect(screen.aggregates.matchedCount).toBe(selling.length);
    expect(screen.rows.length).toBe(Math.min(selling.length, PAGE_SIZE));

    // The facet counts still describe the catalogue, not the page — the metric
    // contract's "options sum to the catalogue" invariant, at the screen level.
    const brandTotal = screen.aggregates.facetOptions.brand.reduce((s, o) => s + o.count, 0);
    expect(brandTotal).toBe(selling.length);

    // Scope chips read across everything, so an archived SKU is never silently
    // absent from a screen scoped to what is selling.
    const scopeTotal = screen.aggregates.scopeChips.find((c) => c.key === "all")?.count;
    expect(scopeTotal).toBe(all.length);
  });

  it("gives every page a distinct slice, and no row twice", async () => {
    const query = { ...DEFAULT_QUERY, scope: "all" as const };
    const first = await getCatalogueScreen(seeded.tenantId, { canViewCosts: true, query });

    const seen: string[] = [];
    for (let page = 0; page < first.pageCount; page++) {
      const screen = await getCatalogueScreen(seeded.tenantId, {
        canViewCosts: true,
        query: { ...query, page },
      });
      seen.push(...screen.rows.map((r) => r.productId));
      // Counts do not move as the reader pages.
      expect(screen.aggregates.matchedCount).toBe(first.aggregates.matchedCount);
    }

    expect(seen).toHaveLength(first.aggregates.matchedCount);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("clamps a page past the end instead of showing an empty table", async () => {
    const screen = await getCatalogueScreen(seeded.tenantId, {
      canViewCosts: true,
      query: { ...DEFAULT_QUERY, page: 999 },
    });
    expect(screen.page).toBe(screen.pageCount - 1);
    expect(screen.rows.length).toBeGreaterThan(0);
  });

  it("pages the rows the filters matched, in the order the sort asked for", async () => {
    const query: CatalogueQuery = { ...DEFAULT_QUERY, sortKey: "onHandUnits", desc: true };
    const all = await getStockCatalogue(seeded.tenantId, { canViewCosts: true });
    const expected = selectRows(all, query).slice(0, PAGE_SIZE).map((r) => r.productId);

    const screen = await getCatalogueScreen(seeded.tenantId, { canViewCosts: true, query });
    expect(screen.rows.map((r) => r.productId)).toEqual(expected);
  });

  it("sends a money-blind member no money band and no stock-value total", async () => {
    // The band never renders for them, but the payload is the boundary that
    // matters: four cost sums must not travel to someone who cannot see costs.
    const member = await getCatalogueScreen(seeded.tenantId, {
      canViewCosts: false,
      query: DEFAULT_QUERY,
    });
    expect(member.aggregates.band).toBeNull();
    expect(member.aggregates.matchedStockValueKes).toBeNull();
    for (const row of member.rows) {
      expect(row.costKes).toBeNull();
      expect(row.stockValueKes).toBeNull();
      expect(row.moneyAtRestKes).toBeNull();
      expect(row.marginPct).toBeNull();
    }

    const owner = await getCatalogueScreen(seeded.tenantId, {
      canViewCosts: true,
      query: DEFAULT_QUERY,
    });
    expect(owner.aggregates.band).not.toBeNull();
    expect(owner.aggregates.matchedStockValueKes).toBeGreaterThan(0);
  });
});
