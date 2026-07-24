import { describe, expect, it } from "vitest";
import {
  FEATURE_DEFAULTS,
  FEATURE_KEYS,
  featureEnabled,
  resolveFeatureFlags,
} from "../lib/capabilities/feature-flags";

/** Gate 4 — tenant feature switches: documented defaults, stored overrides, and
 *  robustness against a malformed featureFlags blob. */

describe("feature defaults", () => {
  it("covers exactly the spec's switch set", () => {
    expect([...FEATURE_KEYS]).toEqual([
      "transfers",
      "pos_feed",
      "quickbooks",
      "supplier_email",
      "weekly_digest",
    ]);
  });

  it("defaults most surfaces on, and the emailed digest off", () => {
    expect(FEATURE_DEFAULTS).toEqual({
      transfers: true,
      pos_feed: true,
      quickbooks: true,
      supplier_email: true,
      weekly_digest: false,
    });
  });

  it("a null config yields every documented default", () => {
    for (const key of FEATURE_KEYS) {
      expect(featureEnabled(null, key)).toBe(FEATURE_DEFAULTS[key]);
    }
    expect(resolveFeatureFlags(null)).toEqual(FEATURE_DEFAULTS);
  });
});

describe("stored overrides", () => {
  it("a stored boolean wins over the default, both ways", () => {
    expect(featureEnabled({ featureFlags: { transfers: false } }, "transfers")).toBe(false);
    expect(featureEnabled({ featureFlags: { weekly_digest: true } }, "weekly_digest")).toBe(true);
  });

  it("merges overrides onto the defaults", () => {
    expect(resolveFeatureFlags({ featureFlags: { quickbooks: false } })).toEqual({
      ...FEATURE_DEFAULTS,
      quickbooks: false,
    });
  });

  it("ignores non-boolean and malformed values, keeping the default", () => {
    expect(featureEnabled({ featureFlags: { transfers: "no" } }, "transfers")).toBe(true);
    for (const flags of ["on", 42, [], null]) {
      expect(featureEnabled({ featureFlags: flags }, "supplier_email")).toBe(true);
    }
  });
});
