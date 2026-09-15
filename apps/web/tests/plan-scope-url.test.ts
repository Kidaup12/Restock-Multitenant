import { describe, expect, it } from "vitest";

/**
 * URL <-> scope codec for the planner scope bar. The scope also lives in the
 * address bar, so a refreshed or shared link reproduces the filter (and Back
 * moves between scopes). These are pure functions — no database, no React — so
 * they load without a SERVICE_DATABASE_URL, unlike the saved-scope actions.
 *
 * Proved: the round trip, the param names/shape the deep link uses, and
 * defensive parsing (junk lead bands and empty comma fragments dropped, like
 * parseAbcKey / parseRangeKey), plus that the NONE_VALUE gap sentinel survives.
 */

import {
  EMPTY_SCOPE,
  parseScopeFromParams,
  scopeToParams,
  type ScopeSelection,
} from "../app/(shell)/plan/scope-bar";

describe("planner scope URL codec", () => {
  it("round-trips a full selection through URLSearchParams", () => {
    const scope: ScopeSelection = {
      abc: ["A", "B"],
      category: ["Serums"],
      supplier: ["Orbit Imports"],
      leadBand: ["fast", "medium"],
    };
    const params = new URLSearchParams(scopeToParams(scope));
    expect(parseScopeFromParams(params)).toEqual(scope);
  });

  it("uses class/category/supplier/lead as the param names, comma-joined", () => {
    const params = new URLSearchParams(
      scopeToParams({
        abc: ["A", "B"],
        category: ["Serums"],
        supplier: ["Orbit Imports"],
        leadBand: ["fast", "medium"],
      })
    );
    expect(params.get("class")).toBe("A,B");
    expect(params.get("category")).toBe("Serums");
    // Value encoding is URLSearchParams' job — the space survives the round trip.
    expect(params.get("supplier")).toBe("Orbit Imports");
    expect(params.get("lead")).toBe("fast,medium");
  });

  it("omits empty dimensions from the URL", () => {
    expect(scopeToParams({ abc: ["A"], category: [], supplier: [], leadBand: [] })).toEqual({
      class: "A",
    });
  });

  it("reads an empty scope from no params", () => {
    expect(parseScopeFromParams(new URLSearchParams(""))).toEqual(EMPTY_SCOPE);
  });

  it("drops unknown lead bands and empty comma fragments (defensive parse)", () => {
    const params = new URLSearchParams("class=A,,B&lead=fast,teleport,slow&category=,");
    expect(parseScopeFromParams(params)).toEqual({
      abc: ["A", "B"],
      category: [],
      supplier: [],
      leadBand: ["fast", "slow"],
    });
  });

  it("preserves the NONE_VALUE sentinel so a scope can target a gap", () => {
    const scope: ScopeSelection = {
      abc: [],
      category: ["__none__"],
      supplier: ["__none__"],
      leadBand: [],
    };
    const params = new URLSearchParams(scopeToParams(scope));
    expect(parseScopeFromParams(params)).toEqual(scope);
  });
});
