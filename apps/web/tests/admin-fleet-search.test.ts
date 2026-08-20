import { describe, expect, it } from "vitest";
import { filterFleet, sortFleet, type FleetRow } from "../lib/admin/fleet";

/**
 * The fleet list is every workspace we have and grows with the business. With
 * no way to search it, finding one shop meant reading the whole table — and the
 * operator console is where someone lands when a customer writes in about a
 * specific store.
 *
 * Matched against what an operator actually knows: the workspace name, its slug,
 * and the store domain the customer quotes.
 */

let seq = 0;
function row(over: Partial<FleetRow> = {}): FleetRow {
  seq += 1;
  return {
    tenantId: `t-${seq}`,
    name: `Shop ${seq}`,
    slug: `shop-${seq}`,
    createdAt: new Date(2026, 0, seq),
    memberCount: 1,
    productCount: 10,
    connection: { state: "live", shopDomain: `shop-${seq}.myshopify.com` },
    lastSync: { products: null, inventory: null, orders: null },
    lastData: { products: null, inventory: null, orders: null },
    stalenessMs: null,
    openNotifications: 0,
    lastForecastRunAt: null,
    recentFailures: 0,
    strandedRuns: 0,
    lastError: null,
    ...over,
  } as FleetRow;
}

const westlands = row({ name: "Westlands Shop", slug: "westlands-shop" });
const westlands2 = row({ name: "Westlands shop", slug: "westlands-shop-2" });
const garnier = row({
  name: "Garnier Products",
  slug: "garnier-products",
  connection: { state: "live", shopDomain: "garnier-ke.myshopify.com" },
});
const fleet = [westlands, westlands2, garnier];

describe("searching the fleet", () => {
  it("returns everything for an empty search", () => {
    expect(filterFleet(fleet, "")).toHaveLength(3);
    expect(filterFleet(fleet, "   ")).toHaveLength(3);
  });

  it("matches the workspace name, case-insensitively", () => {
    // Two workspaces differ only by capitalisation and slug — both must come back.
    expect(filterFleet(fleet, "westlands")).toHaveLength(2);
    expect(filterFleet(fleet, "WESTLANDS")).toHaveLength(2);
  });

  it("matches the slug, which is how the two Westlands are told apart", () => {
    const found = filterFleet(fleet, "westlands-shop-2");
    expect(found).toHaveLength(1);
    expect(found[0]!.slug).toBe("westlands-shop-2");
  });

  it("matches the store domain a customer would quote", () => {
    const found = filterFleet(fleet, "garnier-ke.myshopify.com");
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe("Garnier Products");
  });

  it("ANDs the terms", () => {
    expect(filterFleet(fleet, "westlands garnier")).toHaveLength(0);
    expect(filterFleet(fleet, "garnier products")).toHaveLength(1);
  });

  it("survives a workspace with no connection at all", () => {
    const orphan = row({ name: "No Store", connection: { state: "none", shopDomain: null } });
    expect(filterFleet([orphan], "no store")).toHaveLength(1);
    expect(filterFleet([orphan], "myshopify")).toHaveLength(0);
  });

  it("keeps the chosen order — searching narrows, it does not re-rank", () => {
    const sorted = sortFleet(fleet, "name");
    const names = filterFleet(sorted, "westlands").map((r) => r.name);
    expect(names).toEqual(sorted.filter((r) => /westlands/i.test(r.name)).map((r) => r.name));
  });

  /**
   * #41 was never a sorting bug. `sortFleet` is correct for all three keys —
   * verified on production, where ?sort=name reorders the fleet alphabetically.
   * The tabs sat in the page header with the whole console-access card between
   * them and the first row, so pressing one changed nothing inside the viewport
   * except the address bar. These hold the sort honest; the control moved down
   * beside the table so the change is visible.
   */
  describe("the sorts themselves", () => {
    const fleetOf = (names: string[]) => names.map((name) => row({ name, slug: name.toLowerCase() }));

    it("orders by name alphabetically", () => {
      const sorted = sortFleet(fleetOf(["Westlands", "Garnier", "Karen"]), "name");
      expect(sorted.map((r) => r.name)).toEqual(["Garnier", "Karen", "Westlands"]);
    });

    it("orders by creation, newest first", () => {
      const a = row({ name: "old", createdAt: new Date(2026, 0, 1) });
      const b = row({ name: "new", createdAt: new Date(2026, 5, 1) });
      expect(sortFleet([a, b], "created").map((r) => r.name)).toEqual(["new", "old"]);
    });

    it("puts a failing store above a merely stale one", () => {
      const failing = row({ name: "failing", recentFailures: 3, stalenessMs: 1000 });
      const stale = row({ name: "stale", recentFailures: 0, stalenessMs: 999_999 });
      expect(sortFleet([stale, failing], "staleness").map((r) => r.name)).toEqual([
        "failing",
        "stale",
      ]);
    });

    it("gives the keys genuinely different orders", () => {
      // If two sorts can never disagree on any input, a tab that does nothing is
      // indistinguishable from a tab that is broken. Alpha is first by name and
      // last by both of the others.
      const fleet = [
        row({ name: "Alpha", createdAt: new Date(2026, 0, 1), stalenessMs: 5 }),
        row({ name: "Zulu", createdAt: new Date(2026, 6, 1), stalenessMs: 999 }),
      ];
      expect(sortFleet(fleet, "name").map((r) => r.name)).toEqual(["Alpha", "Zulu"]);
      expect(sortFleet(fleet, "created").map((r) => r.name)).toEqual(["Zulu", "Alpha"]);
      expect(sortFleet(fleet, "staleness").map((r) => r.name)).toEqual(["Zulu", "Alpha"]);

      // ...and they sort rather than merely preserving insertion order.
      const reversed = [...fleet].reverse();
      expect(sortFleet(reversed, "name").map((r) => r.name)).toEqual(["Alpha", "Zulu"]);
      expect(sortFleet(reversed, "created").map((r) => r.name)).toEqual(["Zulu", "Alpha"]);
    });
  });
});
