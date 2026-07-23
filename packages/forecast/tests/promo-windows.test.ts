import { describe, it, expect } from "vitest";
import { promoMatchesProduct, windowsForProduct, excludePromoDays, type PromoWindow } from "../src/promo-windows";

const prod = { sku: "SKU1", productType: "Makeup", vendor: "MIZANI" };

describe("promoMatchesProduct", () => {
  it("matches scope=all", () => {
    expect(promoMatchesProduct({ scope: "all", scopeValue: null }, prod)).toBe(true);
  });
  it("matches sku / category / brand by value (case-insensitive for cat/brand)", () => {
    expect(promoMatchesProduct({ scope: "sku", scopeValue: "SKU1" }, prod)).toBe(true);
    expect(promoMatchesProduct({ scope: "sku", scopeValue: "OTHER" }, prod)).toBe(false);
    expect(promoMatchesProduct({ scope: "category", scopeValue: "makeup" }, prod)).toBe(true);
    expect(promoMatchesProduct({ scope: "brand", scopeValue: "mizani" }, prod)).toBe(true);
    expect(promoMatchesProduct({ scope: "brand", scopeValue: "other" }, prod)).toBe(false);
  });
});

describe("excludePromoDays", () => {
  const hist = [
    { date: new Date("2026-05-01T00:00:00Z"), quantity: 2 },
    { date: new Date("2026-05-10T00:00:00Z"), quantity: 50 }, // inside promo
    { date: new Date("2026-05-12T00:00:00Z"), quantity: 40 }, // inside promo
    { date: new Date("2026-05-20T00:00:00Z"), quantity: 3 },
  ];
  const windows = [{ start: new Date("2026-05-09T00:00:00Z"), end: new Date("2026-05-13T00:00:00Z") }];

  it("drops days inside the window, keeps days outside", () => {
    const out = excludePromoDays(hist, windows);
    expect(out.map((h) => h.quantity)).toEqual([2, 3]);
  });

  it("is a no-op when there are no windows", () => {
    expect(excludePromoDays(hist, [])).toBe(hist);
  });
});

describe("windowsForProduct", () => {
  it("returns only windows whose promo matches the product", () => {
    const promos: PromoWindow[] = [
      { start: new Date("2026-01-01Z"), end: new Date("2026-01-02Z"), scope: "all", scopeValue: null },
      { start: new Date("2026-02-01Z"), end: new Date("2026-02-02Z"), scope: "brand", scopeValue: "OTHER" },
      { start: new Date("2026-03-01Z"), end: new Date("2026-03-02Z"), scope: "sku", scopeValue: "SKU1" },
    ];
    const w = windowsForProduct(promos, prod);
    expect(w).toHaveLength(2); // the "all" and the matching "sku"; brand=OTHER excluded
  });
});
