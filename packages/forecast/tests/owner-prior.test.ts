import { describe, it, expect } from "vitest";
import {
  priorActive,
  priorMatchesProduct,
  selectPriorForProduct,
  applyOwnerPrior,
  type OwnerPriorFacts,
} from "../src/owner-prior";

const now = new Date("2026-07-24T00:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

const prior = (over: Partial<OwnerPriorFacts>): OwnerPriorFacts => ({
  scope: "product",
  scopeValue: "p1",
  expectedUnits: null,
  multiplier: null,
  proxyProductId: null,
  weeks: 4,
  createdAt: daysAgo(1),
  revokedAt: null,
  ...over,
});

describe("priorActive", () => {
  it("is active inside its weeks window", () => {
    expect(priorActive(prior({ createdAt: daysAgo(10), weeks: 4 }), now)).toBe(true);
  });

  it("expires after its weeks window", () => {
    expect(priorActive(prior({ createdAt: daysAgo(40), weeks: 4 }), now)).toBe(false); // 4w = 28d
  });

  it("a revoked prior is never active", () => {
    expect(priorActive(prior({ createdAt: daysAgo(1), revokedAt: daysAgo(0) }), now)).toBe(false);
  });
});

describe("priorMatchesProduct", () => {
  it("product scope matches by id", () => {
    expect(priorMatchesProduct(prior({ scope: "product", scopeValue: "p1" }), { id: "p1", vendor: "Cantu" })).toBe(true);
    expect(priorMatchesProduct(prior({ scope: "product", scopeValue: "p1" }), { id: "p2", vendor: "Cantu" })).toBe(false);
  });

  it("brand scope matches by case-insensitive vendor", () => {
    expect(priorMatchesProduct(prior({ scope: "brand", scopeValue: "cantu" }), { id: "x", vendor: "Cantu" })).toBe(true);
    expect(priorMatchesProduct(prior({ scope: "brand", scopeValue: "Nivea" }), { id: "x", vendor: "Cantu" })).toBe(false);
  });
});

describe("selectPriorForProduct", () => {
  it("a product-scope prior beats a brand-scope one", () => {
    const priors = [
      prior({ scope: "brand", scopeValue: "Cantu", multiplier: 1.2 }),
      prior({ scope: "product", scopeValue: "p1", expectedUnits: 50 }),
    ];
    const chosen = selectPriorForProduct(priors, { id: "p1", vendor: "Cantu" }, now);
    expect(chosen?.scope).toBe("product");
    expect(chosen?.expectedUnits).toBe(50);
  });

  it("ignores expired and revoked priors", () => {
    const priors = [
      prior({ scope: "product", scopeValue: "p1", createdAt: daysAgo(60), weeks: 4 }), // expired
      prior({ scope: "product", scopeValue: "p1", revokedAt: daysAgo(0) }), // revoked
    ];
    expect(selectPriorForProduct(priors, { id: "p1", vendor: "Cantu" }, now)).toBeNull();
  });

  it("among same-scope priors, the newest wins", () => {
    const priors = [
      prior({ scope: "brand", scopeValue: "Cantu", multiplier: 1.1, createdAt: daysAgo(5) }),
      prior({ scope: "brand", scopeValue: "Cantu", multiplier: 1.5, createdAt: daysAgo(1) }),
    ];
    expect(selectPriorForProduct(priors, { id: "x", vendor: "Cantu" }, now)?.multiplier).toBe(1.5);
  });
});

describe("applyOwnerPrior", () => {
  it("expectedUnits sets the level outright", () => {
    expect(applyOwnerPrior(10, { expectedUnits: 40, multiplier: null })).toBe(40);
  });

  it("multiplier scales the base", () => {
    expect(applyOwnerPrior(10, { expectedUnits: null, multiplier: 1.5 })).toBe(15);
  });

  it("multiplier applies after expectedUnits when both are set", () => {
    expect(applyOwnerPrior(10, { expectedUnits: 40, multiplier: 0.5 })).toBe(20);
  });

  it("never returns a negative forecast", () => {
    expect(applyOwnerPrior(10, { expectedUnits: -5, multiplier: null })).toBe(0);
  });
});
