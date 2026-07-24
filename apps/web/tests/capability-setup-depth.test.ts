import { describe, expect, it } from "vitest";
import {
  computeSetupSignals,
  costCoverageRatio,
  decideSetupLevel,
  type SetupInput,
  type SetupSignals,
} from "../lib/capabilities/setup-depth";

/**
 * The setup-depth level logic, exercised as pure functions with injected counts
 * (no database). Covers the revenue-weighted cost threshold, the supplier share
 * threshold, and the contiguous-ladder rule (a skipped rung caps the level).
 */

const base: SetupInput = {
  shopifyConnected: true,
  activeProducts: 100,
  trustedCostProducts: 0,
  revenue30dTotal: 0,
  revenue30dTrustedCost: 0,
  suppliedProducts: 0,
  posFeedConfigured: false,
  sellableLocations: 1,
};

describe("computeSetupSignals", () => {
  it("Shopify connected with products, nothing else → only the shopify signal", () => {
    expect(computeSetupSignals(base)).toEqual({
      shopify: true,
      costs: false,
      suppliers: false,
      posOrMultiLocation: false,
    });
  });

  it("no connection → no shopify signal even with a catalogue", () => {
    expect(computeSetupSignals({ ...base, shopifyConnected: false }).shopify).toBe(false);
  });

  it("connected but empty catalogue → no shopify signal", () => {
    expect(computeSetupSignals({ ...base, activeProducts: 0 }).shopify).toBe(false);
  });

  it("costs are weighted by revenue, not product count", () => {
    // Trusted on only 40% of products, but those earn 60% of the revenue.
    const input = {
      ...base,
      trustedCostProducts: 40,
      revenue30dTotal: 1000,
      revenue30dTrustedCost: 600,
    };
    expect(costCoverageRatio(input)).toBeCloseTo(0.6);
    expect(computeSetupSignals(input).costs).toBe(true);
  });

  it("cost coverage at or below 50% of revenue does not trip the signal", () => {
    const input = { ...base, revenue30dTotal: 1000, revenue30dTrustedCost: 500 };
    expect(computeSetupSignals(input).costs).toBe(false);
  });

  it("falls back to product-count coverage when there are no sales yet", () => {
    const input = { ...base, trustedCostProducts: 60 }; // 60/100 > 0.5
    expect(costCoverageRatio(input)).toBeCloseTo(0.6);
    expect(computeSetupSignals(input).costs).toBe(true);
  });

  it("suppliers signal needs a majority of products assigned", () => {
    expect(computeSetupSignals({ ...base, suppliedProducts: 50 }).suppliers).toBe(false);
    expect(computeSetupSignals({ ...base, suppliedProducts: 51 }).suppliers).toBe(true);
  });

  it("all-channel signal trips on a POS feed or a second selling location", () => {
    expect(computeSetupSignals({ ...base, posFeedConfigured: true }).posOrMultiLocation).toBe(true);
    expect(computeSetupSignals({ ...base, sellableLocations: 2 }).posOrMultiLocation).toBe(true);
    expect(computeSetupSignals({ ...base, sellableLocations: 1 }).posOrMultiLocation).toBe(false);
  });
});

describe("decideSetupLevel", () => {
  const signals = (over: Partial<SetupSignals>): SetupSignals => ({
    shopify: false,
    costs: false,
    suppliers: false,
    posOrMultiLocation: false,
    ...over,
  });

  it("no shopify → level 0, nudging to connect", () => {
    const { level, nextUnlock } = decideSetupLevel(signals({}));
    expect(level).toBe(0);
    expect(nextUnlock?.signal).toBe("shopify");
  });

  it("shopify only → level 0, nudging to add costs", () => {
    const { level, nextUnlock } = decideSetupLevel(signals({ shopify: true }));
    expect(level).toBe(0);
    expect(nextUnlock?.signal).toBe("costs");
  });

  it("+ costs → level 1, nudging to add suppliers", () => {
    const { level, nextUnlock } = decideSetupLevel(signals({ shopify: true, costs: true }));
    expect(level).toBe(1);
    expect(nextUnlock?.signal).toBe("suppliers");
  });

  it("+ suppliers → level 2, nudging to add channels", () => {
    const { level, nextUnlock } = decideSetupLevel(
      signals({ shopify: true, costs: true, suppliers: true }),
    );
    expect(level).toBe(2);
    expect(nextUnlock?.signal).toBe("posOrMultiLocation");
  });

  it("everything on → level 3, no nudge", () => {
    const { level, nextUnlock } = decideSetupLevel(
      signals({ shopify: true, costs: true, suppliers: true, posOrMultiLocation: true }),
    );
    expect(level).toBe(3);
    expect(nextUnlock).toBeNull();
  });

  it("is a contiguous ladder — a skipped rung caps the level", () => {
    // Suppliers and channels are on, but costs are missing: still level 0.
    const { level, nextUnlock } = decideSetupLevel(
      signals({ shopify: true, costs: false, suppliers: true, posOrMultiLocation: true }),
    );
    expect(level).toBe(0);
    expect(nextUnlock?.signal).toBe("costs");
  });
});
