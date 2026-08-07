import { beforeAll, describe, expect, it } from "vitest";
import { seedDev, type SeedResult } from "../../../packages/db/scripts/seed-dev";
import { getCatalogueScreen, getStockCatalogue, type CatalogueRow } from "../lib/data/stock";
import {
  DEFAULT_QUERY,
  PAGE_SIZE,
  catalogueQueryFields,
  catalogueQueryToSearch,
  inScope,
  matchesSearch,
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
      search: "nivea 250",
      sortKey: "runRate",
      desc: true,
      page: 3,
    };
    expect(parseCatalogueQuery(qs(catalogueQueryToSearch(q)))).toEqual(q);
  });

  it("carries the reader's other filters through the search form", () => {
    // The search box is a GET form, which submits only its own inputs: without
    // these hidden fields, typing a product name would silently drop the scope,
    // facets, chip and sort the reader had chosen.
    const q = withQuery(DEFAULT_QUERY, {
      scope: "all",
      selection: { brand: ["Cantu"] },
      healthFilter: "dup_sku",
      sortKey: "runRate",
      desc: true,
      search: "shea",
      page: 6,
    });
    const fields = catalogueQueryFields(q);
    const names = fields.map((f) => f.name);
    expect(names).toContain("scope");
    expect(names).toContain("f.brand");
    expect(names).toContain("issue");
    expect(names).toContain("sort");
    expect(names).toContain("dir");
    // The text is what the input posts, and a new search starts at page 1.
    expect(names).not.toContain("q");
    expect(names).not.toContain("page");

    // Submitting the form reproduces the same view with the new text.
    const posted = qs(new URLSearchParams([...fields.map((f) => [f.name, f.value] as [string, string]), ["q", "shea"]]).toString());
    expect(parseCatalogueQuery(posted)).toEqual({ ...q, page: 0 });
  });

  it("trims, caps and tolerates whatever is typed into the box", () => {
    expect(parseCatalogueQuery({ q: "  shea butter  " }).search).toBe("shea butter");
    expect(parseCatalogueQuery({ q: "   " }).search).toBe("");
    expect(parseCatalogueQuery({ q: "x".repeat(500) }).search).toHaveLength(120);
    expect(parseCatalogueQuery({}).search).toBe("");
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
    expect(withQuery(onPage7, { search: "shea" }).page).toBe(0);
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

describe("catalogue search predicate", () => {
  const row = (over: Partial<CatalogueRow>) =>
    ({
      title: "Nivea Body Lotion 250ml",
      sku: "NIV-250ML",
      variantTitle: "Cocoa",
      vendor: "Beiersdorf",
      customCategory: "Skincare",
      ...over,
    }) as CatalogueRow;

  it("finds a product by name, SKU, variant, brand or category", () => {
    expect(matchesSearch(row({}), "nivea")).toBe(true);
    expect(matchesSearch(row({}), "250ml")).toBe(true);
    expect(matchesSearch(row({}), "cocoa")).toBe(true);
    expect(matchesSearch(row({}), "beiersdorf")).toBe(true);
    expect(matchesSearch(row({}), "skincare")).toBe(true);
    expect(matchesSearch(row({}), "cantu")).toBe(false);
  });

  it("ignores case and matches terms in any order", () => {
    expect(matchesSearch(row({}), "NIVEA")).toBe(true);
    expect(matchesSearch(row({}), "250 nivea")).toBe(true);
    // ANDed: every term must land somewhere on the row.
    expect(matchesSearch(row({}), "nivea cantu")).toBe(false);
  });

  it("matches inside a run-together SKU, not just at a word start", () => {
    // `NIV-250ML` has no space before the size, so a word-prefix match would
    // miss the one thing an owner is most likely to type.
    expect(matchesSearch(row({}), "250")).toBe(true);
  });

  it("survives the fields a real catalogue leaves empty", () => {
    const bare = row({ sku: "", variantTitle: null, vendor: null, customCategory: null });
    expect(matchesSearch(bare, "nivea")).toBe(true);
    expect(matchesSearch(bare, "cocoa")).toBe(false);
    // No text means no filter — every row survives.
    expect(matchesSearch(bare, "")).toBe(true);
    expect(matchesSearch(bare, "   ")).toBe(true);
  });
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

  it("narrows the screen to the products the text matches, chips unchanged", async () => {
    const all = await getStockCatalogue(seeded.tenantId, { canViewCosts: true });
    const selling = all.filter((r) => inScope(r, "selling"));
    // Take a word from a real seeded title rather than a guess, so this test
    // cannot pass by matching nothing.
    const term = selling[0]!.title.split(/\s+/)[0]!.toLowerCase();
    const expected = selling.filter((r) => matchesSearch(r, term));
    expect(expected.length).toBeGreaterThan(0);

    const screen = await getCatalogueScreen(seeded.tenantId, {
      canViewCosts: true,
      query: { ...DEFAULT_QUERY, search: term },
    });

    expect(screen.aggregates.matchedCount).toBe(expected.length);
    expect(screen.rows.every((r) => matchesSearch(r, term))).toBe(true);
    // Searching filters the list; it does not redefine which catalogue the
    // chips are counting — same rule paging and the money band already follow.
    expect(screen.aggregates.scopedCount).toBe(selling.length);
  });

  it("finds nothing rather than everything when the text matches no product", async () => {
    const screen = await getCatalogueScreen(seeded.tenantId, {
      canViewCosts: true,
      query: { ...DEFAULT_QUERY, search: "zzzz-no-such-product" },
    });
    expect(screen.aggregates.matchedCount).toBe(0);
    expect(screen.rows).toHaveLength(0);
    // Still a real page, so the pager cannot land the reader out of bounds.
    expect(screen.page).toBe(0);
    expect(screen.pageCount).toBe(1);
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
