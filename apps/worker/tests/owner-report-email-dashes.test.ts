import { describe, expect, it } from "vitest";
import { renderReportEmail } from "../src/owner-report-email";
import type { OwnerReport, TrendRow } from "../src/owner-report";

/**
 * What the owner actually reads. The email's first line is the bestseller
 * stockout rate, and with nothing to measure it rendered "-%", a dash wearing
 * a percent sign, which reads as a number too small to print rather than as no
 * number at all. The missed revenue in the same table rendered "KES 0".
 */

const row = (over: Partial<TrendRow> = {}): TrendRow => ({
  label: "Sep 7",
  salesKes: 120_000,
  stockoutA: 0,
  stockoutB: 0,
  stockoutPct: null,
  overstockCount: null,
  deadCount: 2,
  deadValueKes: 9_000,
  missedRevenueKes: null,
  partial: false,
  inferred: false,
  ...over,
});

const report = (trend: TrendRow[]): OwnerReport => ({
  tenantName: "A Shop",
  currency: "KES",
  granularity: "week",
  latestLabel: "Sep 7",
  trend,
  needsAttention: [],
  restock: [],
  bestsellers: { total: 0, healthy: 0, low: 0, out: 0 },
  topSellers: [],
  oos: [], criticals: [], upcoming: [], others: [],
  oosCount: 0, criticalsCount: 0, upcomingCount: 0, othersCount: 0,
  oosBudgetKes: 0, criticalsBudgetKes: 0, upcomingBudgetKes: 0, othersBudgetKes: 0,
  restockBudgetKes: 7_000,
  restockCount: 0,
  transfers: [],
  transferCount: 0,
  transferFrom: "",
  hasData: true,
});

describe("the weekly email, when there was nothing to measure", () => {
  it("does not print a percent sign on a dash", () => {
    const { html } = renderReportEmail(report([row()]));
    expect(html).not.toContain("-%");
    expect(html).toContain("Bestseller stockout rate this week: -.");
  });

  it("prints a dash for missed revenue, not a currency and a zero", () => {
    // Empty restock buckets legitimately show zero; the trend's unmeasured
    // missed-revenue cell must still be a dash in both formats.
    const { html, text } = renderReportEmail(report([row()]));
    expect(html).toMatch(/<td[^>]*>-<\/td>/);
    expect(text.split("\n").find(line => line.startsWith("Sep 7"))?.trimEnd()).toMatch(/-$/);
  });

  it("still prints real figures when there were real figures", () => {
    const { html } = renderReportEmail(
      report([row({ stockoutPct: 12.5, missedRevenueKes: 4_200, stockoutA: 2 })]),
    );
    expect(html).toContain("12.5%");
    expect(html).toContain("KES 4k");
  });

  it("keeps the two-period headline intact", () => {
    const { html } = renderReportEmail(
      report([
        row({ stockoutPct: 9, missedRevenueKes: 1_000 }),
        row({ label: "Aug 31", stockoutPct: 14, missedRevenueKes: 2_000 }),
      ]),
    );
    expect(html).toContain("9%");
    expect(html).toContain("last week: 14%");
  });
});
