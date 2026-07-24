import { describe, expect, it } from "vitest";
import {
  guessRoleFromName,
  isEnroute,
  isHolds,
  isIgnore,
  isSellable,
  roleOf,
  roleOfType,
  type LocationRole,
} from "../src/roles";

/** Pure mapping/guessing logic — no database. A wrong role silently corrupts
 *  the inventory math (spec §1), so the mapping is pinned by these tests. */

describe("roleOfType — locationType → calculation role", () => {
  it("maps each DB enum value to its role", () => {
    expect(roleOfType("branch")).toBe("sells");
    expect(roleOfType("warehouse")).toBe("holds");
    expect(roleOfType("enroute")).toBe("enroute");
    expect(roleOfType("virtual")).toBe("ignore");
  });

  it("null / unclassified / unknown falls back to sells (treated as a branch)", () => {
    expect(roleOfType(null)).toBe("sells");
    expect(roleOfType(undefined)).toBe("sells");
    expect(roleOfType("something-else")).toBe("sells");
  });
});

describe("roleOf + is* predicates", () => {
  const cases: Array<[string | null, LocationRole]> = [
    ["branch", "sells"],
    ["warehouse", "holds"],
    ["enroute", "enroute"],
    ["virtual", "ignore"],
    [null, "sells"],
  ];
  it.each(cases)("%s → %s", (locationType, role) => {
    expect(roleOf({ locationType })).toBe(role);
  });

  it("predicates agree with roleOf", () => {
    expect(isSellable({ locationType: "branch" })).toBe(true);
    expect(isSellable({ locationType: "warehouse" })).toBe(false);
    expect(isHolds({ locationType: "warehouse" })).toBe(true);
    expect(isEnroute({ locationType: "enroute" })).toBe(true);
    expect(isIgnore({ locationType: "virtual" })).toBe(true);
    expect(isSellable({ locationType: null })).toBe(true);
  });
});

describe("guessRoleFromName — the assumed default", () => {
  it("warehouse / storage words → holds", () => {
    expect(guessRoleFromName("Industrial Area Warehouse")).toBe("holds");
    expect(guessRoleFromName("Main Godown")).toBe("holds");
    expect(guessRoleFromName("Central Depot")).toBe("holds");
    expect(guessRoleFromName("Back Storeroom")).toBe("holds");
    expect(guessRoleFromName("Cold Storage")).toBe("holds");
  });

  it("incoming / en-route / transit words → enroute", () => {
    expect(guessRoleFromName("INCOMING (QB) ENROUTE ORDERS")).toBe("enroute");
    expect(guessRoleFromName("En Route")).toBe("enroute");
    expect(guessRoleFromName("en-route")).toBe("enroute");
    expect(guessRoleFromName("In Transit")).toBe("enroute");
  });

  it("returns / damaged / virtual words → ignore", () => {
    expect(guessRoleFromName("Returns Bin")).toBe("ignore");
    expect(guessRoleFromName("Damaged Stock")).toBe("ignore");
    expect(guessRoleFromName("Virtual Location")).toBe("ignore");
    expect(guessRoleFromName("Legacy 2019")).toBe("ignore");
  });

  it("a real distributing warehouse named '(Virtual)' stays Holds, not Ignore", () => {
    // Holds tokens are checked before the ignore tokens on purpose.
    expect(guessRoleFromName("Main Warehouse- Nairobi (Virtual)")).toBe("holds");
  });

  it("retail branches — including 'Store'/'Shop' — default to sells", () => {
    expect(guessRoleFromName("Kilimani Shop")).toBe("sells");
    expect(guessRoleFromName("Main Store")).toBe("sells");
    expect(guessRoleFromName("Karen branch")).toBe("sells");
    expect(guessRoleFromName("New Stanley Building, CBD")).toBe("sells");
    expect(guessRoleFromName("Online")).toBe("sells");
  });

  it("blank / null → sells", () => {
    expect(guessRoleFromName("")).toBe("sells");
    expect(guessRoleFromName("   ")).toBe("sells");
    expect(guessRoleFromName(null)).toBe("sells");
  });
});
