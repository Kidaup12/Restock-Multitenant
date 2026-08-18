import { describe, it, expect } from "vitest";
import { validateOwnerPriorInput } from "../src/owner-priors";
import { OWNER_PRIOR_MAX_MULTIPLIER } from "@wezesha/forecast";

/** A valid product-scope expectation, as the base each case tweaks. */
const base = { scope: "product" as const, scopeValue: "prod-1", weeks: 6 };

describe("validateOwnerPriorInput", () => {
  it("accepts a plain expectation", () => {
    expect(validateOwnerPriorInput({ ...base, expectedUnits: 40 })).toBeNull();
  });

  it("accepts a multiplier up to the cap", () => {
    expect(
      validateOwnerPriorInput({ ...base, multiplier: OWNER_PRIOR_MAX_MULTIPLIER })
    ).toBeNull();
  });

  it("rejects a multiplier past the cap, and points to expected amount instead", () => {
    const msg = validateOwnerPriorInput({ ...base, multiplier: OWNER_PRIOR_MAX_MULTIPLIER + 1 });
    expect(msg).not.toBeNull();
    expect(msg).toMatch(/expected amount/);
  });

  it("still rejects a zero or negative multiplier", () => {
    expect(validateOwnerPriorInput({ ...base, multiplier: 0 })).toMatch(/greater than zero/);
  });

  it("rejects negative expected units but not a large positive one", () => {
    expect(validateOwnerPriorInput({ ...base, expectedUnits: -1 })).toMatch(/negative/);
    // A high expected level is the owner's deliberate figure, not an error.
    expect(validateOwnerPriorInput({ ...base, expectedUnits: 500 })).toBeNull();
  });

  it("requires the owner to supply something", () => {
    expect(validateOwnerPriorInput({ ...base })).toMatch(/give the forecast something/);
  });
});
