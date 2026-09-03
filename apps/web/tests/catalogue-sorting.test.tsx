import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_QUERY, SORT_KEYS, compare, selectRows, type SortKey } from "@/lib/catalogue";
import type { CatalogueRow } from "@/lib/data/stock";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

const { RowGroup } = await import("../app/(shell)/products/catalogue-view");

/**
 * Sorting the catalogue, and the two columns a buyer orders from.
 *
 * The screen used to sort through a dropdown and a separate Asc/Desc link, and
 * reversed the sorted list to get descending. Reversing is what this file
 * mostly guards: a row with no value for a column is not that column's extreme,
 * and flipping the list put every unknown at the top — sorting by cover,
 * descending, led with every product that has never sold.
 */

const row = (over: Partial<CatalogueRow> = {}): CatalogueRow => ({
  productId: over.productId ?? "p1",
  sku: "CAT-1",
  title: "Shea Butter 250ml",
  variantTitle: null,
  shopifyProductId: null,
  vendor: "Fixture Co",
  onHandUnits: 5,
  warehouseUnits: 0,
  daysCover: 12,
  urgency: null,
  priceKes: 800,
  runRate: 0.4,
  revenue30dKes: 3200,
  costKes: 400,
  stockValueKes: 2000,
  moneyAtRestKes: 2000,
  abc: "B",
  customCategory: "Skin",
  costSource: "manual",
  notForSale: false,
  lifecycle: "active",
  lifecycleLabel: "Active",
  buyable: true,
  lifecycleReason: null,
  onOrderUnits: 0,
  expectedArrivalAt: null,
  syncError: null,
  syncErrorAt: null,
  leadDays: 14,
  leadSource: "supplier",
  supplierName: "Nairobi Beauty",
  verdict: "healthy",
  marginPct: 50,
  missingCost: false,
  suspectCost: false,
  heldOffBuyList: false,
  costMovedPct: null,
  costMovedAt: null,
  facet: {
    productId: over.productId ?? "p1",
    brand: "Fixture Co",
    productType: null,
    category: "Skin",
    supplier: null,
    supplierGroup: null,
    speedBand: null,
    abc: "B",
    health: [],
  },
  ...over,
});

const titles = (rows: CatalogueRow[], sortKey: SortKey, desc: boolean) =>
  selectRows(rows, { ...DEFAULT_QUERY, sortKey, desc }).map((r) => r.title);

describe("catalogue sorting", () => {
  it("sinks rows with no value to the bottom in BOTH directions", () => {
    const rows = [
      row({ productId: "a", title: "Alpha", daysCover: 40 }),
      row({ productId: "b", title: "Bravo", daysCover: null }),
      row({ productId: "c", title: "Charlie", daysCover: 3 }),
    ];
    expect(titles(rows, "daysCover", false)).toEqual(["Charlie", "Alpha", "Bravo"]);
    // The one that mattered: descending used to lead with Bravo, which has no
    // cover figure at all, rather than with the deepest-covered product.
    expect(titles(rows, "daysCover", true), "a row with no cover sorted as the highest cover").toEqual([
      "Alpha",
      "Charlie",
      "Bravo",
    ]);
  });

  it("sorts by supplier name alphabetically, unassigned last", () => {
    const rows = [
      row({ productId: "a", title: "Alpha", supplierName: "Zanzibar Supplies" }),
      row({ productId: "b", title: "Bravo", supplierName: null }),
      row({ productId: "c", title: "Charlie", supplierName: "Athi Distributors" }),
    ];
    expect(titles(rows, "supplierName", false)).toEqual(["Charlie", "Alpha", "Bravo"]);
    expect(titles(rows, "supplierName", true)).toEqual(["Alpha", "Charlie", "Bravo"]);
  });

  it("breaks ties by title so paging cannot reshuffle equal rows", () => {
    // Two pages of a column where every value is identical must not swap rows
    // between renders — the second page would repeat what the first showed.
    const rows = [
      row({ productId: "c", title: "Charlie", onHandUnits: 5 }),
      row({ productId: "a", title: "Alpha", onHandUnits: 5 }),
      row({ productId: "b", title: "Bravo", onHandUnits: 5 }),
    ];
    expect(titles(rows, "onHandUnits", false)).toEqual(["Alpha", "Bravo", "Charlie"]);
    expect(titles(rows, "onHandUnits", true)).toEqual(["Alpha", "Bravo", "Charlie"]);
  });

  it("ranks ABC by class, not by letter, with unclassed rows last", () => {
    const rows = [
      row({ productId: "a", title: "Alpha", abc: "C" }),
      row({ productId: "b", title: "Bravo", abc: null }),
      row({ productId: "c", title: "Charlie", abc: "A" }),
    ];
    expect(titles(rows, "abc", false)).toEqual(["Charlie", "Alpha", "Bravo"]);
  });

  it("orders every sort key the URL accepts", () => {
    // The old assertion — isFinite(compare(...)) — was a tautology: compare
    // returns a number on every path, INCLUDING the unhandled-key fall-through
    // that hands back load order. Two rows that differ on EVERY sortable column
    // let us assert what actually matters: the column separates them, and
    // ascending is the exact opposite of descending. A key that falls through
    // to "return 0" (the load-order bug) makes both fail.
    const low = row({
      productId: "low", title: "Alpha", supplierName: "Athi", leadDays: 1,
      onHandUnits: 1, warehouseUnits: 1, onOrderUnits: 1, runRate: 0.1,
      daysCover: 1, revenue30dKes: 1, abc: "A", costKes: 1, moneyAtRestKes: 1,
      marginPct: 1,
    });
    const high = row({
      productId: "high", title: "Bravo", supplierName: "Zanzibar", leadDays: 9,
      onHandUnits: 9, warehouseUnits: 9, onOrderUnits: 9, runRate: 0.9,
      daysCover: 9, revenue30dKes: 9, abc: "C", costKes: 9, moneyAtRestKes: 9,
      marginPct: 9,
    });
    for (const key of SORT_KEYS) {
      expect(compare(low, high, key), `${key} does not order two different rows`).not.toBe(0);
      // Antisymmetry: swapping the arguments flips the sign. A constant/zero
      // fall-through cannot satisfy this for rows that genuinely differ.
      expect(
        Math.sign(compare(low, high, key)),
        `${key} is not antisymmetric`,
      ).toBe(-Math.sign(compare(high, low, key)));
    }
  });
});

/* ── the two new columns ──────────────────────────────────────────────────── */

const renderRow = (over: Partial<CatalogueRow>, canManage = true) =>
  renderToStaticMarkup(
    <table>
      <tbody>
        <RowGroup
          row={row(over)}
          open={false}
          onToggle={() => {}}
          canViewCosts
          canManage={canManage}
          categoryNames={[]}
          flags={{ active: true, activeOverride: false }}
          picked={false}
        />
      </tbody>
    </table>,
  );

describe("supplier and lead columns", () => {
  it("names the supplier a buyer would order from", () => {
    expect(renderRow({ supplierName: "Athi Distributors" })).toContain("Athi Distributors");
  });

  it("says where a lead time came from, not just what it is", () => {
    // Every row resolves to some number of days. An assumed 14 and a measured
    // 14 render identically unless the origin travels with it — and only one of
    // them is a job for the shop.
    const assumed = renderRow({ leadDays: 14, leadSource: "assumed" });
    expect(assumed, "an assumed lead time reads as a set one").toContain("Assumed");

    const set = renderRow({ leadDays: 9, leadSource: "product" });
    expect(set).toContain("Set on this product");
    expect(set).not.toContain("Assumed");

    const inherited = renderRow({ leadDays: 21, leadSource: "supplier", supplierName: "Athi" });
    expect(inherited).toContain("From Athi");
  });

  it("offers no lead-time edit to a reader who cannot manage the catalogue", () => {
    const html = renderRow({ leadDays: 9, leadSource: "product" }, false);
    expect(html).toContain("9d");
    expect(html, "a read-only reader was given an edit control").not.toContain("click to change");
  });
});
