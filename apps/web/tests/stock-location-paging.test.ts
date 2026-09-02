import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { prismaService } from "@wezesha/db";
import { PAGE_SIZE } from "../lib/catalogue";
import { LocationView } from "../app/(shell)/inventory/location-view";
import {
  getLocationsScreen,
  locationsQueryFields,
  locationsQueryToSearch,
  matchesLocationLine,
  parseLocationsQuery,
  type LocationLine,
} from "../lib/data/stock";

/**
 * Paging and search on the By-location table.
 *
 * The screen is a list of locations, each with its own lines, and one location
 * holds most of them — a shop floor with 131 lines beside a back store with 12.
 * So the page window walks the lines in location order and a location's lines
 * can straddle a page break: the reader gets a bounded table without the list
 * being re-sorted into something that is no longer grouped by location.
 *
 * What must not move as they page or search: the card's own totals (SKUs, units,
 * value) describe the whole location, and the two shop-wide columns describe the
 * whole shop. A narrowed list must never make either read as a per-branch count.
 *
 * Fixtures build their own tenant so the shared seed is untouched.
 * Skips when no local database is configured.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const SLUG = "stock-location-paging";
const SHOP = "Kilimani Counter";
const STORE = "Kilimani Back Store";

/** More lines at one location than a page holds, so the shop's table is cut in
 *  two and the back store lands on the second page beside its tail. */
const SHOP_LINES = PAGE_SIZE + 12;
const STORE_LINES = 3;
const TOTAL_LINES = SHOP_LINES + STORE_LINES;

/** A word on three shop lines and nothing else, so a search has a known answer. */
const TERM = "kokoa";
const TERM_LINES = 3;

/** Each location stocks its own products, so a SKU in the markup names exactly
 *  one line and "no line twice" is a claim the rendered page can answer. */
const sku = (n: number) => `LP-${String(n).padStart(3, "0")}`;
const storeSku = (n: number) => `SP-${String(n).padStart(3, "0")}`;
const titleFor = (n: number) => (n < TERM_LINES ? `Kokoa Butter ${n}` : `Paging Item ${n}`);

/** The SKUs the rendered page actually lists. */
const skusIn = (html: string): string[] => html.match(/[LS]P-\d{3}/g) ?? [];

describe("line search predicate", () => {
  const line = (over: Partial<LocationLine>) =>
    ({ title: "Kokoa Butter Rich", sku: "LP-007", ...over }) as LocationLine;

  it("finds a line by product name or SKU — the two things the table prints", () => {
    expect(matchesLocationLine(line({}), "kokoa")).toBe(true);
    expect(matchesLocationLine(line({}), "BUTTER")).toBe(true);
    expect(matchesLocationLine(line({}), "lp-007")).toBe(true);
    // Run-together SKUs need a substring match, not a word start.
    expect(matchesLocationLine(line({}), "007")).toBe(true);
    expect(matchesLocationLine(line({}), "nivea")).toBe(false);
  });

  it("ANDs the terms and lets empty text through", () => {
    expect(matchesLocationLine(line({}), "kokoa rich")).toBe(true);
    expect(matchesLocationLine(line({}), "kokoa nivea")).toBe(false);
    expect(matchesLocationLine(line({}), "")).toBe(true);
    expect(matchesLocationLine(line({ sku: "" }), "kokoa")).toBe(true);
  });
});

describe("By-location query <-> URL", () => {
  it("reads the text and the page a reader arrived on", () => {
    expect(parseLocationsQuery({ q: "  kokoa  ", page: "3" })).toEqual({
      search: "kokoa",
      page: 2,
      sortKey: "onHand",
      pageSize: 50,
      hidden: [],
      desc: true,
    });
    expect(parseLocationsQuery({})).toEqual({
      search: "",
      page: 0,
      sortKey: "onHand",
      pageSize: 50,
      hidden: [],
      desc: true,
    });
    expect(parseLocationsQuery({ page: "-4" }).page).toBe(0);
  });

  it("carries nothing the search box supplies itself", () => {
    // Inventory is its own route now, so there is no tab to preserve — and the
    // box posts the text itself, so a new search cannot land on page 7 of a
    // list that is now three lines long.
    const fields = locationsQueryFields();
    expect(fields.map((f) => f.name)).not.toContain("q");
    expect(fields.map((f) => f.name)).not.toContain("page");
  });

  it("spells its own URL without borrowing the catalogue's params", () => {
    const base = { sortKey: "onHand" as const, desc: true, pageSize: 50 as const, hidden: [] };
    expect(locationsQueryToSearch({ ...base, search: "kokoa", page: 0 })).toBe("?q=kokoa");
    expect(locationsQueryToSearch({ ...base, search: "", page: 2 })).toBe("?page=3");
    expect(locationsQueryToSearch({ ...base, search: "", page: 0 })).toBe("");
    // The default order stays out of the URL, so the common link is short and a
    // shared one does not pin the reader to an order they never chose.
    expect(locationsQueryToSearch({ ...base, search: "", page: 0, sortKey: "daysCover" })).toBe(
      "?lsort=daysCover",
    );
    expect(locationsQueryToSearch({ ...base, search: "", page: 0, desc: false })).toBe("?ldir=asc");
  });
});

describe.skipIf(!runnable)("paged By-location table (local db)", () => {
  let tenantId: string;

  beforeAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    const tenant = await prismaService.tenant.create({
      data: { name: "Kilimani", slug: SLUG, currency: "KES" },
    });
    tenantId = tenant.id;

    const base = { tenantId, vendor: "House", priceKes: 1000, costKes: 400, currentStock: 5 };
    const products = await Promise.all(
      Array.from({ length: SHOP_LINES }, (_, n) =>
        prismaService.product.create({ data: { ...base, sku: sku(n), title: titleFor(n) } })
      )
    );
    const storeProducts = await Promise.all(
      Array.from({ length: STORE_LINES }, (_, n) =>
        prismaService.product.create({
          data: { ...base, sku: storeSku(n), title: `Back Stock ${n}` },
        })
      )
    );

    const shop = await prismaService.location.create({
      data: { tenantId, name: SHOP, locationType: "branch", roleStatus: "confirmed", isPrimary: true },
    });
    const store = await prismaService.location.create({
      data: { tenantId, name: STORE, locationType: "warehouse", roleStatus: "confirmed" },
    });

    await prismaService.inventoryLevel.createMany({
      data: [
        // Descending units, so the sort the screen already applies gives the
        // lines a stable, predictable order to page through.
        ...products.map((p, n) => ({
          tenantId,
          locationId: shop.id,
          productId: p.id,
          onHand: SHOP_LINES - n,
          available: SHOP_LINES - n,
        })),
        ...storeProducts.map((p) => ({
          tenantId,
          locationId: store.id,
          productId: p.id,
          onHand: 4,
          available: 4,
        })),
      ],
    });
  }, 120_000);

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    await prismaService.$disconnect();
  });

  it("pages the lines and says how many there are in total", async () => {
    const screen = await getLocationsScreen(tenantId, {
      canViewCosts: true,
      query: { search: "", page: 0, sortKey: "onHand", desc: true, pageSize: 50, hidden: [] },
    });
    expect(screen.total).toBe(TOTAL_LINES);
    expect(screen.matched).toBe(TOTAL_LINES);
    expect(screen.pageCount).toBe(2);
    expect(screen.locations.flatMap((l) => l.lines)).toHaveLength(PAGE_SIZE);

    const html = renderToStaticMarkup(await LocationView({ tenantId, canViewCosts: true }));
    expect(html).toContain(`Showing 1–${PAGE_SIZE} of ${TOTAL_LINES}`);
    expect(skusIn(html)).toHaveLength(PAGE_SIZE);
  });

  it("gives page 2 different lines, and no line twice across the pages", async () => {
    const first = renderToStaticMarkup(await LocationView({ tenantId, canViewCosts: true }));
    const second = renderToStaticMarkup(
      await LocationView({ tenantId, canViewCosts: true, params: { page: "2" } })
    );

    const one = skusIn(first);
    const two = skusIn(second);
    expect(two).not.toEqual(one);
    expect(two.some((s) => one.includes(s))).toBe(false);
    expect(new Set([...one, ...two]).size).toBe(TOTAL_LINES);
    expect(second).toContain(`Showing ${PAGE_SIZE + 1}–${TOTAL_LINES} of ${TOTAL_LINES}`);
  });

  it("keeps the grouping when a location's lines straddle the break", async () => {
    const first = renderToStaticMarkup(await LocationView({ tenantId, canViewCosts: true }));
    const second = renderToStaticMarkup(
      await LocationView({ tenantId, canViewCosts: true, params: { page: "2" } })
    );
    // The shop fills page 1 alone; page 2 carries its tail AND the back store,
    // each still under its own heading.
    expect(first).toContain(SHOP);
    expect(first).not.toContain(STORE);
    expect(second).toContain(SHOP);
    expect(second).toContain(STORE);
    // The card's own totals describe the location, never the page.
    expect(second).toContain(`${SHOP_LINES} SKUs`);
    expect(second).toContain(`${STORE_LINES} SKUs`);
  });

  it("narrows to the lines the text matches, back on page 1", async () => {
    const screen = await getLocationsScreen(tenantId, {
      canViewCosts: true,
      // Page 7 of a three-line answer: the screen clamps rather than showing an
      // empty table. The search box itself drops the page (see the URL suite).
      query: { search: TERM, page: 6, sortKey: "onHand", desc: true, pageSize: 50, hidden: [] },
    });
    expect(screen.matched).toBe(TERM_LINES);
    expect(screen.pageCount).toBe(1);
    expect(screen.page).toBe(0);

    const html = renderToStaticMarkup(
      await LocationView({ tenantId, canViewCosts: true, params: { q: TERM } })
    );
    expect(skusIn(html)).toHaveLength(TERM_LINES);
    // A location with no match drops out rather than sitting there empty.
    expect(html).not.toContain(STORE);
    // A narrowed table must not restate the location's totals as if they were
    // the match: the card says how many of its lines matched.
    expect(html).toContain(`${SHOP_LINES} SKUs`);
    expect(html).toContain(`${TERM_LINES} of ${SHOP_LINES} lines match`);
    // Both shop-wide columns stay labelled whatever is filtered out.
    expect(html).toContain("Cover (shop)");
    expect(html).toContain("En route (shop)");
  });

  it("says so plainly when nothing matches, instead of an empty list", async () => {
    const html = renderToStaticMarkup(
      await LocationView({ tenantId, canViewCosts: true, params: { q: "zzzz-no-such-product" } })
    );
    expect(skusIn(html)).toHaveLength(0);
    expect(html).toContain("No product matches");
    // The box keeps the text so it can be cleared from where they are.
    expect(html).toContain("zzzz-no-such-product");
  });
});
