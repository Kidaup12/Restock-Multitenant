import { describe, expect, it } from "vitest";
import {
  stockHealthByPeriod,
  type ProductMeta,
  type SaleRow,
  type SnapRow,
} from "../src/owner-report";

/**
 * The weekly owner email prints the bestseller stockout rate and the revenue
 * missed while out of stock side by side. They come out of one calculation:
 * the missed revenue is summed inside the branch that counts a stockout.
 *
 * So on a shop with no class-A or class-B products, or with no stock snapshots
 * yet, the rate honestly printed a dash while the money beside it printed a
 * confident zero — the same not-knowing, reported two different ways, on the
 * one line an owner reads as good news.
 *
 * The guard is the pairing, not either number on its own: money that was never
 * measured must not render as a figure, and a rate that was only inferred
 * cannot price what it never saw.
 */

const products = (entries: [string, ProductMeta][]) => new Map(entries);
const AB: ProductMeta = { abc: "A", costKes: 50, priceKes: 100 };
const C: ProductMeta = { abc: "C", costKes: 50, priceKes: 100 };

function health(input: {
  snaps: SnapRow[];
  sales: SaleRow[];
  products: Map<string, ProductMeta>;
  periods?: string[];
}) {
  return stockHealthByPeriod({
    periods: input.periods ?? ["2026-W36"],
    granularity: "week",
    snaps: input.snaps,
    sales: input.sales,
    products: input.products,
    deadStockWindowDays: 60,
  });
}

describe("owner report: a number never measured is never a zero", () => {
  it("prices the missed revenue when a bestseller was seen at zero", () => {
    // The measured case, so the assertions below are about absence of data and
    // not about the calculation having been broken.
    const [row] = health({
      snaps: [{ period: "2026-W36", pid: "p1", minOh: 0, endOh: 0, daysOut: 3 }],
      sales: [{ period: "2026-W36", pid: "p1", qty: 8 }],
      products: products([["p1", AB]]),
    });
    expect(row!.stockoutPct).toBe(100);
    expect(row!.missedRevenueKes).toBeGreaterThan(0);
  });

  it("reports no missed revenue figure for a shop with no bestsellers", () => {
    // Snapshots exist, so the week WAS observed — there was simply nothing in
    // the A/B class to observe. Both halves must say so.
    const [row] = health({
      snaps: [{ period: "2026-W36", pid: "p1", minOh: 0, endOh: 0, daysOut: 3 }],
      sales: [{ period: "2026-W36", pid: "p1", qty: 8 }],
      products: products([["p1", C]]),
    });
    expect(row!.stockoutPct).toBeNull();
    expect(row!.missedRevenueKes).toBeNull();
  });

  it("reports no missed revenue figure for a week with no stock snapshots", () => {
    const [row] = health({
      snaps: [],
      sales: [{ period: "2026-W36", pid: "p1", qty: 8 }],
      products: products([["p1", AB]]),
    });
    expect(row!.missedRevenueKes).toBeNull();
  });

  it("does not price an inferred stockout, which was never seen at zero", () => {
    // A proven seller went silent: enough to estimate a rate, never enough to
    // price the loss.
    const periods = ["2026-W34", "2026-W35", "2026-W36"];
    const rows = health({
      periods,
      snaps: [],
      sales: [
        { period: "2026-W34", pid: "p1", qty: 10 },
        { period: "2026-W35", pid: "p1", qty: 10 },
      ],
      products: products([["p1", AB]]),
    });
    const latest = rows[rows.length - 1]!;
    expect(latest.stockoutInferred).toBe(true);
    expect(latest.stockoutPct).not.toBeNull();
    expect(latest.missedRevenueKes).toBeNull();
  });

  it("pairs the two across every shape at once", () => {
    // The standing rule, asserted as a rule rather than case by case: a priced
    // loss requires a measured rate, and a measured (not inferred) rate always
    // carries its price.
    const cases = [
      health({
        snaps: [{ period: "2026-W36", pid: "p1", minOh: 0, endOh: 0, daysOut: 2 }],
        sales: [{ period: "2026-W36", pid: "p1", qty: 8 }],
        products: products([["p1", AB]]),
      }),
      health({
        snaps: [{ period: "2026-W36", pid: "p1", minOh: 4, endOh: 4, daysOut: 0 }],
        sales: [{ period: "2026-W36", pid: "p1", qty: 8 }],
        products: products([["p1", AB]]),
      }),
      health({
        snaps: [{ period: "2026-W36", pid: "p1", minOh: 0, endOh: 0, daysOut: 2 }],
        sales: [{ period: "2026-W36", pid: "p1", qty: 8 }],
        products: products([["p1", C]]),
      }),
      health({ snaps: [], sales: [], products: products([["p1", AB]]) }),
    ];

    for (const rows of cases) {
      for (const row of rows) {
        if (row.missedRevenueKes != null) expect(row!.stockoutPct).not.toBeNull();
        if (row.stockoutPct != null && !row.stockoutInferred) {
          expect(row!.missedRevenueKes).not.toBeNull();
        }
      }
    }
  });
});
