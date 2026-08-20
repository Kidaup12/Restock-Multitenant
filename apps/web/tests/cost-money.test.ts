import { describe, expect, it } from "vitest";
import {
  cashTiedUp,
  computeMoneyBand,
  coverVerdict,
  marginPct,
  type MoneyRow,
} from "@/lib/cost";

/** The money lens — margin %, cash tied up, cover verdict, and the four band
 *  tiles. Pure; consumes the metric numbers the engine already produced. */

describe("marginPct", () => {
  it("computes margin on the selling price", () => {
    expect(marginPct(60, 100)).toBe(40);
  });
  it("is negative when selling below cost", () => {
    expect(marginPct(120, 100)).toBeCloseTo(-20);
  });
  it("is null with no price", () => {
    expect(marginPct(60, 0)).toBeNull();
  });
});

describe("cashTiedUp", () => {
  it("is cost × sellable, clamped at zero for oversold", () => {
    expect(cashTiedUp(50, 10)).toBe(500);
    expect(cashTiedUp(50, -3)).toBe(0);
  });
});

describe("coverVerdict", () => {
  it("oversold before stockout", () => {
    expect(coverVerdict(-2, null, 10)).toBe("oversold");
  });
  it("stockout at zero on-hand", () => {
    expect(coverVerdict(0, null, 10)).toBe("stockout");
  });
  it("stock but no velocity → overstock (idle capital)", () => {
    expect(coverVerdict(20, null, 10)).toBe("overstock");
  });
  it("cover below lead → order now", () => {
    expect(coverVerdict(20, 8, 14)).toBe("order_now");
  });
  it("cover past 90d → overstock", () => {
    expect(coverVerdict(20, 120, 14)).toBe("overstock");
  });
  it("in-band cover → healthy", () => {
    expect(coverVerdict(20, 30, 14)).toBe("healthy");
  });
});

describe("computeMoneyBand", () => {
  const row = (over: Partial<MoneyRow>): MoneyRow => ({
    costKes: 50,
    priceKes: 100,
    sellableOnHand: 10,
    coverDays: 30,
    leadDays: 14,
    runRatePerDay: 2,
    revenue30dKes: 1000,
    moneyAtRestKes: 500,
    notForSale: false,
    ...over,
  });

  it("sums cash tied up across the sellable catalogue", () => {
    const band = computeMoneyBand([row({}), row({ moneyAtRestKes: 300 })]);
    expect(band.cashTiedUpKes).toBe(800);
  });

  it("counts overstock (cover>90 or no velocity) as dead capital", () => {
    const band = computeMoneyBand([
      row({ coverDays: 200, moneyAtRestKes: 700 }),
      row({ coverDays: null, sellableOnHand: 5, moneyAtRestKes: 200 }),
      row({ coverDays: 30 }),
    ]);
    expect(band.deadOverstockCount).toBe(2);
    expect(band.deadOverstockKes).toBe(900);
  });

  it("sizes revenue at risk from expected sales over the days the shelf is short", () => {
    const band = computeMoneyBand([
      // Out of stock: all 30 days missed — 2/day x KES 100 x 30.
      row({ sellableOnHand: 0, coverDays: 0 }),
      // Below lead: runs out on day 8, so 22 days missed.
      row({ coverDays: 8, leadDays: 14 }),
      row({ coverDays: 40 }), // safe
    ]);
    expect(band.revenueAtRiskCount).toBe(2);
    expect(band.revenueAtRiskKes).toBe(6000 + 4400);
  });

  /**
   * The defect this replaced. The tile summed each row's TRAILING 30-day
   * revenue, and a product out of stock for the whole month sold nothing — so
   * the figure fell towards zero exactly as the stockout got worse and read
   * KES 0 on a shop losing real money. Reports, sizing the same loss from the
   * run rate, said KES 338 a day on that same data.
   */
  it("still reports a loss when the shelf has been empty long enough to earn nothing", () => {
    const band = computeMoneyBand([row({ sellableOnHand: 0, coverDays: 0, revenue30dKes: 0 })]);
    expect(band.revenueAtRiskKes).toBeGreaterThan(0);
    expect(band.revenueAtRiskKes).toBe(6000);
  });

  it("holds an at-risk row that never sells at zero", () => {
    // No velocity, nothing to miss — the count still flags it, the money does not.
    const band = computeMoneyBand([row({ sellableOnHand: 0, coverDays: 0, runRatePerDay: 0 })]);
    expect(band.revenueAtRiskCount).toBe(1);
    expect(band.revenueAtRiskKes).toBe(0);
  });

  it("counts rows selling below cost", () => {
    const band = computeMoneyBand([
      row({ costKes: 120, priceKes: 100, revenue30dKes: 800 }),
      row({ costKes: 50, priceKes: 100 }),
    ]);
    expect(band.belowCostCount).toBe(1);
    expect(band.belowCostRevenueKes).toBe(800);
  });

  it("excludes not-for-sale rows from every tile", () => {
    const band = computeMoneyBand([
      row({ notForSale: true, moneyAtRestKes: 999, coverDays: 200, sellableOnHand: 0 }),
    ]);
    expect(band.cashTiedUpKes).toBe(0);
    expect(band.deadOverstockCount).toBe(0);
    expect(band.revenueAtRiskCount).toBe(0);
  });
});
