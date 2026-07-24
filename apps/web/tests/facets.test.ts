import { describe, expect, it } from "vitest";
import {
  buildFacetItems,
  deriveFacetOptions,
  duplicateSkus,
  filterByFacets,
  healthFlagsFor,
  matchesFacets,
  speedBandFromLeadDays,
  type FacetSourceRow,
} from "@/lib/facets";

/**
 * Pure facet-derivation tests — no database. Facet options come from what the
 * catalogue actually contains (never a hard-coded list); the predicate is AND
 * across facets, OR within.
 */

const ASOF = new Date("2026-07-24T00:00:00.000Z");
const DAY_MS = 86_400_000;

describe("speed band from lead time", () => {
  it("buckets lead days into Local / Regional / Import", () => {
    expect(speedBandFromLeadDays(5)).toBe("local");
    expect(speedBandFromLeadDays(7)).toBe("local");
    expect(speedBandFromLeadDays(8)).toBe("regional");
    expect(speedBandFromLeadDays(20)).toBe("regional");
    expect(speedBandFromLeadDays(21)).toBe("import");
    expect(speedBandFromLeadDays(42)).toBe("import");
  });

  it("has no band without lead data (never guesses)", () => {
    expect(speedBandFromLeadDays(null)).toBeNull();
    expect(speedBandFromLeadDays(undefined)).toBeNull();
  });
});

describe("duplicate SKUs", () => {
  it("returns only SKUs appearing more than once, trimmed, ignoring blanks", () => {
    const dups = duplicateSkus(["A", "B", " A ", null, "", "B", "C"]);
    expect([...dups].sort()).toEqual(["A", "B"]);
  });
});

describe("health flags", () => {
  const base = {
    sku: "SKU1",
    costKes: 100,
    supplierId: "sup1",
    sellableOnHand: 10,
    runRate: 1,
    createdAt: new Date(ASOF.getTime() - 300 * DAY_MS),
    isDuplicateSku: false,
  };

  it("is clean when everything is present and moving", () => {
    expect(healthFlagsFor(base, ASOF)).toEqual([]);
  });

  it("flags missing cost, no supplier, no sku, negative stock", () => {
    const flags = healthFlagsFor(
      { ...base, costKes: 0, supplierId: null, sku: "", sellableOnHand: -2 },
      ASOF
    );
    expect(flags).toContain("missing_cost");
    expect(flags).toContain("no_supplier");
    expect(flags).toContain("no_sku");
    expect(flags).toContain("negative");
    // A blank SKU is "no_sku", never also "dup_sku".
    expect(flags).not.toContain("dup_sku");
  });

  it("flags dup_sku only for a non-blank duplicated SKU", () => {
    expect(healthFlagsFor({ ...base, isDuplicateSku: true }, ASOF)).toContain("dup_sku");
  });

  it("flags new (inside the window) and never also dead", () => {
    const flags = healthFlagsFor(
      { ...base, createdAt: new Date(ASOF.getTime() - 10 * DAY_MS), runRate: 0 },
      ASOF
    );
    expect(flags).toContain("new");
    expect(flags).not.toContain("dead");
  });

  it("flags dead when it has stock but no run rate and is not new", () => {
    const flags = healthFlagsFor({ ...base, runRate: 0 }, ASOF);
    expect(flags).toContain("dead");
  });

  it("does not flag dead when out of stock", () => {
    expect(healthFlagsFor({ ...base, runRate: 0, sellableOnHand: 0 }, ASOF)).not.toContain("dead");
  });
});

describe("facet derivation + filtering over a small catalogue", () => {
  const rows: FacetSourceRow[] = [
    {
      productId: "a",
      vendor: "Cantu",
      productType: "Hair Care",
      customCategory: "Hair",
      sku: "A1",
      costKes: 100,
      supplierId: "s1",
      supplierName: "Beauty Plus",
      leadDays: 10, // regional
      sellableOnHand: 5,
      runRate: 2,
      abc: "A",
      createdAt: new Date(ASOF.getTime() - 300 * DAY_MS),
    },
    {
      productId: "b",
      vendor: "Cantu",
      productType: "Skin Care",
      customCategory: "Skin",
      sku: "B1",
      costKes: 0, // missing cost
      supplierId: null, // no supplier → no lead → no band
      supplierName: null,
      leadDays: null,
      sellableOnHand: 3,
      runRate: 0, // dead (has stock, no rate, old)
      abc: "C",
      createdAt: new Date(ASOF.getTime() - 300 * DAY_MS),
    },
    {
      productId: "c",
      vendor: "Nivea",
      productType: "Skin Care",
      customCategory: null, // uncategorised
      sku: "C1",
      costKes: 200,
      supplierId: "s2",
      supplierName: "Orbit Imports",
      leadDays: 42, // import
      sellableOnHand: 8,
      runRate: 1,
      abc: null,
      createdAt: new Date(ASOF.getTime() - 300 * DAY_MS),
    },
  ];

  const items = buildFacetItems(rows, ASOF);
  const options = deriveFacetOptions(items);

  it("derives brand options with counts from the catalogue", () => {
    expect(options.brand.map((o) => o.value)).toEqual(["Cantu", "Nivea"]);
    expect(options.brand.find((o) => o.value === "Cantu")!.count).toBe(2);
  });

  it("derives category options and surfaces uncategorised", () => {
    const values = options.category.map((o) => o.value);
    expect(values).toContain("Hair");
    expect(values).toContain("Skin");
    // The null-category product shows under the 'none' sentinel, listed last.
    expect(values[values.length - 1]).toBe("__none__");
  });

  it("derives speed bands only for products with lead data", () => {
    const bands = options.speedBand.map((o) => o.value);
    expect(bands).toContain("regional");
    expect(bands).toContain("import");
    expect(bands).not.toContain("local"); // nothing ≤7d in this catalogue
  });

  it("leaves supplierGroup empty (column not owned yet)", () => {
    expect(options.supplierGroup).toEqual([]);
  });

  it("derives health flags present in the catalogue", () => {
    const flags = options.health.map((o) => o.value);
    expect(flags).toContain("missing_cost");
    expect(flags).toContain("no_supplier");
    expect(flags).toContain("dead");
  });

  it("filters AND across facets, OR within a facet", () => {
    // Brand Cantu → a, b.
    expect(filterByFacets(items, { brand: ["Cantu"] }).map((i) => i.productId).sort()).toEqual([
      "a",
      "b",
    ]);
    // Brand Cantu AND productType Skin Care → b only.
    expect(
      filterByFacets(items, { brand: ["Cantu"], productType: ["Skin Care"] }).map((i) => i.productId)
    ).toEqual(["b"]);
    // OR within a facet: Cantu OR Nivea → all three.
    expect(filterByFacets(items, { brand: ["Cantu", "Nivea"] })).toHaveLength(3);
  });

  it("matches the 'none' sentinel for products missing a facet value", () => {
    expect(matchesFacets(items.find((i) => i.productId === "c")!, { category: ["__none__"] })).toBe(
      true
    );
    expect(matchesFacets(items.find((i) => i.productId === "a")!, { category: ["__none__"] })).toBe(
      false
    );
  });

  it("matches a health facet when ANY selected flag is present", () => {
    expect(filterByFacets(items, { health: ["dead", "no_supplier"] }).map((i) => i.productId)).toEqual([
      "b",
    ]);
  });
});
