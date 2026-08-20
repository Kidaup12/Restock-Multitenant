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
});
