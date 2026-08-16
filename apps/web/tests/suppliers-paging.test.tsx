import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import {
  DEFAULT_SUPPLIER_QUERY,
  SUPPLIERS_PAGE_SIZE,
  getSuppliersScreen,
  matchesSupplierSearch,
  parseSupplierQuery,
  type SupplierQuery,
  type SupplierRow,
} from "../lib/data/suppliers";
import { supplierQueryToSearch, withSupplierQuery } from "../app/(shell)/suppliers/suppliers-view";

/**
 * The suppliers list searches, sorts and pages on the server: the URL carries
 * the state and the server answers with one page plus the totals. These tests
 * hold the line that makes that safe — every page a distinct slice, the counts
 * describing the whole list rather than the page, and a search that narrows the
 * list and starts it over at the first page.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);
const SLUG = "suppliers-paging-probe";

describe("supplier search predicate", () => {
  const row = (over: Partial<SupplierRow>) =>
    ({
      name: "Beauty Plus Distributors",
      group: "Local pickup",
      country: "Kenya",
      currency: "KES",
      email: "orders@beautyplus.co.ke",
      ...over,
    }) as SupplierRow;

  it("finds a supplier by name, group, country, currency or email", () => {
    expect(matchesSupplierSearch(row({}), "beauty")).toBe(true);
    expect(matchesSupplierSearch(row({}), "local")).toBe(true);
    expect(matchesSupplierSearch(row({}), "kenya")).toBe(true);
    expect(matchesSupplierSearch(row({}), "kes")).toBe(true);
    expect(matchesSupplierSearch(row({}), "beautyplus.co.ke")).toBe(true);
    expect(matchesSupplierSearch(row({}), "haria")).toBe(false);
  });

  it("ignores case and ANDs the terms in any order", () => {
    expect(matchesSupplierSearch(row({}), "BEAUTY")).toBe(true);
    expect(matchesSupplierSearch(row({}), "kenya beauty")).toBe(true);
    expect(matchesSupplierSearch(row({}), "beauty haria")).toBe(false);
  });

  it("survives the fields a real supplier leaves empty", () => {
    const bare = row({ group: null, country: null, email: null });
    expect(matchesSupplierSearch(bare, "beauty")).toBe(true);
    expect(matchesSupplierSearch(bare, "kenya")).toBe(false);
    // No text means no filter — every supplier survives.
    expect(matchesSupplierSearch(bare, "")).toBe(true);
    expect(matchesSupplierSearch(bare, "   ")).toBe(true);
  });
});

describe("suppliers query <-> URL", () => {
  it("round-trips every control", () => {
    const q: SupplierQuery = { search: "haria kenya", sortKey: "moq", desc: true, page: 3 };
    expect(parseSupplierQuery(qs(supplierQueryToSearch(q)))).toEqual(q);
  });

  it("keeps an untouched list on a clean /suppliers URL", () => {
    expect(supplierQueryToSearch(DEFAULT_SUPPLIER_QUERY)).toBe("");
    expect(parseSupplierQuery({})).toEqual(DEFAULT_SUPPLIER_QUERY);
  });

  it("trims, caps and tolerates whatever is typed or hand-edited", () => {
    expect(parseSupplierQuery({ q: "  haria  " }).search).toBe("haria");
    expect(parseSupplierQuery({ q: "   " }).search).toBe("");
    expect(parseSupplierQuery({ q: "x".repeat(500) }).search).toHaveLength(120);
    expect(parseSupplierQuery({ sort: "; drop table", page: "-4" })).toEqual(
      DEFAULT_SUPPLIER_QUERY,
    );
  });

  it("sends a new search or sort back to page 1, and paging alone does not", () => {
    const onPage7 = { ...DEFAULT_SUPPLIER_QUERY, page: 7 };
    expect(withSupplierQuery(onPage7, { search: "haria" }).page).toBe(0);
    expect(withSupplierQuery(onPage7, { sortKey: "moq" }).page).toBe(0);
    expect(withSupplierQuery(onPage7, { desc: true }).page).toBe(0);
    expect(withSupplierQuery(onPage7, { page: 8 }).page).toBe(8);
  });

  /** `?a=1&b=2` as the shape Next hands a page. */
  function qs(search: string): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of new URLSearchParams(search)) out[k] = v;
    return out;
  }
});

describe.skipIf(!runnable)("paged suppliers screen (local db)", () => {
  const COUNT = SUPPLIERS_PAGE_SIZE + 3;
  let tenantId: string;

  beforeAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    const tenant = await prismaService.tenant.create({
      data: { name: "Suppliers Paging Probe", slug: SLUG },
    });
    tenantId = tenant.id;
    // Two digits so the seeded names sort the same way a person reads them.
    for (let i = 1; i <= COUNT; i++) {
      const n = String(i).padStart(2, "0");
      await prismaService.supplier.create({
        data: {
          tenantId,
          name: `Probe Supplier ${n}`,
          email: `probe${n}@example.com`,
          country: "Kenya",
          currency: "KES",
          supplierGroup: i % 7 === 0 ? "Overseas" : "Local pickup",
          moq: i,
        },
      });
    }
  }, 120_000);

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    await prismaService.$disconnect();
  });

  it("counts the whole list while sending one page of rows", async () => {
    const screen = await getSuppliersScreen(tenantId, DEFAULT_SUPPLIER_QUERY);
    expect(screen.total).toBe(COUNT);
    expect(screen.matched).toBe(COUNT);
    expect(screen.rows).toHaveLength(SUPPLIERS_PAGE_SIZE);
    expect(screen.page).toBe(0);
    expect(screen.pageCount).toBe(2);
    expect(screen.from).toBe(1);
    expect(screen.rows[0]!.name).toBe("Probe Supplier 01");
  });

  it("gives every page a distinct slice, and no supplier twice", async () => {
    const seen: string[] = [];
    const first = await getSuppliersScreen(tenantId, DEFAULT_SUPPLIER_QUERY);
    for (let page = 0; page < first.pageCount; page++) {
      const screen = await getSuppliersScreen(tenantId, { ...DEFAULT_SUPPLIER_QUERY, page });
      expect(screen.page).toBe(page);
      expect(screen.from).toBe(page * SUPPLIERS_PAGE_SIZE + 1);
      // The counts do not move as the reader pages.
      expect(screen.matched).toBe(first.matched);
      seen.push(...screen.rows.map((r) => r.id));
    }
    expect(seen).toHaveLength(COUNT);
    expect(new Set(seen).size).toBe(COUNT);
  });

  it("sorts across the whole list, not inside the page", async () => {
    const screen = await getSuppliersScreen(tenantId, {
      ...DEFAULT_SUPPLIER_QUERY,
      sortKey: "moq",
      desc: true,
    });
    // The largest MOQ belongs to the last supplier seeded; a sort applied after
    // the slice would put the first page's own biggest row here instead.
    expect(screen.rows[0]!.moq).toBe(COUNT);
    expect(screen.rows.map((r) => r.moq)).toEqual(
      [...screen.rows.map((r) => r.moq)].sort((a, b) => b - a),
    );
  });

  it("narrows to what the text matches and reports the count", async () => {
    const overseas = await getSuppliersScreen(tenantId, {
      ...DEFAULT_SUPPLIER_QUERY,
      search: "overseas",
    });
    expect(overseas.matched).toBe(Math.floor(COUNT / 7));
    expect(overseas.matched).toBeGreaterThan(0);
    expect(overseas.rows.every((r) => r.group === "Overseas")).toBe(true);
    // Searching filters the list; it does not change how many suppliers exist.
    expect(overseas.total).toBe(COUNT);
    expect(overseas.pageCount).toBe(1);
  });

  it("finds nothing rather than everything when the text matches no supplier", async () => {
    const screen = await getSuppliersScreen(tenantId, {
      ...DEFAULT_SUPPLIER_QUERY,
      search: "zzzz-no-such-supplier",
    });
    expect(screen.matched).toBe(0);
    expect(screen.rows).toHaveLength(0);
    // Still a real page, so the pager cannot land the reader out of bounds.
    expect(screen.page).toBe(0);
    expect(screen.pageCount).toBe(1);
  });

  it("clamps a page past the end instead of showing an empty table", async () => {
    const screen = await getSuppliersScreen(tenantId, { ...DEFAULT_SUPPLIER_QUERY, page: 999 });
    expect(screen.page).toBe(screen.pageCount - 1);
    expect(screen.rows.length).toBeGreaterThan(0);
  });

  it("puts no cost figure on the screen, searched or not", async () => {
    // The suppliers screen carries none by design (MOQ is units, currency is a
    // code, lead times are days). A search or a count must never be the thing
    // that introduces one for a member who cannot see costs.
    const screen = await getSuppliersScreen(tenantId, { ...DEFAULT_SUPPLIER_QUERY, search: "kes" });
    expect(screen.rows.length).toBeGreaterThan(0);
    for (const row of screen.rows) {
      expect(Object.keys(row).filter((k) => /kes$/i.test(k))).toEqual([]);
    }
  });

  it("is tenant-scoped: another tenant's screen is empty", async () => {
    const other = await prismaService.tenant.create({
      data: { name: "Other Shop", slug: `${SLUG}-other` },
    });
    try {
      const screen = await getSuppliersScreen(other.id, DEFAULT_SUPPLIER_QUERY);
      expect(screen.total).toBe(0);
      expect(screen.rows).toEqual([]);
    } finally {
      await prismaService.tenant.delete({ where: { id: other.id } });
    }
  });
});
