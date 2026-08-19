import { describe, expect, it } from "vitest";
import { resolveCost } from "../lib/cost/resolve";
import { healthFlagsFor } from "../lib/facets/health";

/**
 * Today's "N products need a cost" bar counts with `resolveCost` (via
 * getCostCoverage's source split) and links to `/stock?issue=missing_cost`,
 * which filters on the `missing_cost` health flag. Two predicates, one number
 * on screen — so they have to be the same predicate, or the bar sends the shop
 * to a list that does not match the count it just read.
 *
 * Pure, and deliberately not seeded: this pins the rule, not one dataset.
 */

const COSTS = [-100, -1, 0, 0.0001, 1, 99.5, 100_000];
const LABELS = [null, "manual", "qb", "shopify"];

function flagsMissing(costKes: number): boolean {
  return healthFlagsFor({
    sku: "SKU-1",
    costKes,
    supplierId: "s1",
    sellableOnHand: 5,
    runRate: 1,
    createdAt: new Date("2020-01-01"),
    isDuplicateSku: false,
  }).includes("missing_cost");
}

describe("the cost-gap count and the catalogue filter", () => {
  it("agree on every cost, whatever the stored source label says", () => {
    for (const costKes of COSTS) {
      for (const costSource of LABELS) {
        const countedMissing = resolveCost({ costKes, costSource, priceKes: 500 }).source === "missing";
        expect(
          countedMissing,
          `costKes=${costKes} costSource=${costSource ?? "null"}`
        ).toBe(flagsMissing(costKes));
      }
    }
  });

  it("treats a zero or negative cost as missing even when it is labelled", () => {
    // The trap this guards: a product carrying costSource "shopify" with a zero
    // cost. Counting it as priced would understate the bar while the catalogue
    // still listed it.
    expect(resolveCost({ costKes: 0, costSource: "shopify", priceKes: 500 }).source).toBe("missing");
    expect(flagsMissing(0)).toBe(true);
  });

  it("counts a real cost as present on both sides", () => {
    expect(resolveCost({ costKes: 250, costSource: "manual", priceKes: 500 }).source).not.toBe("missing");
    expect(flagsMissing(250)).toBe(false);
  });
});
