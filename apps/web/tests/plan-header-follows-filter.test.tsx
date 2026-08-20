import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The decision header totals "the rows the checklist already has" — its own
 * stated contract. It did not.
 *
 * "Urgent only" was checklist state the header could not see, so turning it on
 * narrowed the list to eleven lines under a header still reading 22 items and
 * KES 1.21M, and a saved PDF of twelve products was headed "25 products". The
 * tick counter followed the filter, which made the header the one stale figure
 * on the screen.
 *
 * Both lenses are the parent's state now. These tests read the rendered HTML,
 * so they fail if either the header or the list stops reading the same list.
 */

let search = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
  usePathname: () => "/plan",
  useSearchParams: () => search,
}));

import { CurrencyProvider } from "../components/currency-provider";
import { PlanView } from "../app/(shell)/plan/plan-view";
import type { BuyList, BuyListRow } from "../lib/data/plan";
import { planFreshnessLabel } from "../lib/data/forecast-freshness";

let seq = 0;
function mkRow(over: Partial<BuyListRow>): BuyListRow {
  seq += 1;
  return {
    predictionId: `p-${seq}`,
    productId: `prod-${seq}`,
    sku: `SKU-${seq}`,
    title: `Product ${seq}`,
    vendor: null,
    supplierName: "Nairobi Supplies",
    onHandUnits: 4,
    onOrderUnits: 0,
    daysUntilStockout: 6,
    daysLeftToOrder: 1,
    leadDays: 5,
    orderByDate: new Date("2026-08-11T00:00:00Z"),
    urgency: "critical",
    tier: "order_today",
    recommendedQty: 20,
    orderQty: 20,
    overriddenQty: null,
    runRatePerDay: 0.8,
    moq: 1,
    leadFloored: false,
    abc: "A",
    category: null,
    unitCostKes: 100,
    lineTotalKes: 1000,
    priceKes: 200,
    reasoning: "runs out in 6 days",
    explain: null,
    qtySummary: "20 units brings the shelf to 24",
    confidence: null,
    coldStart: null,
    borrowedFromTitle: null,
    plannable: "ok",
    atRiskKes: 500,
    revenue30dKes: 4000,
    ...over,
  };
}

// Two urgent, three not. Every tier is represented so the header has all three
// roll-ups to get wrong.
const urgentRows = [
  mkRow({ urgency: "critical", tier: "order_today" }),
  mkRow({ urgency: "high", tier: "order_today" }),
];
const calmRows = [
  mkRow({ urgency: "medium", tier: "this_week" }),
  mkRow({ urgency: "low", tier: "can_wait" }),
  mkRow({ urgency: "low", tier: "can_wait" }),
];
const allRows = [...urgentRows, ...calmRows];

const buyList: BuyList = {
  forecastRunId: "run-1",
  runDate: new Date("2026-08-10T02:07:00Z"),
  rows: allRows,
  excluded: [],
  totalPredicted: 30,
  totalCostKes: allRows.reduce((s, r) => s + (r.lineTotalKes ?? 0), 0),
};

function render(params: string) {
  search = new URLSearchParams(params);
  return renderToStaticMarkup(
    <CurrencyProvider currency="KES">
      <PlanView
        buyList={buyList}
        canViewCosts
        canBudget
        canOverride
        freshness={planFreshnessLabel(buyList.runDate, Date.UTC(2026, 7, 10, 9, 0, 0))}
      />
    </CurrencyProvider>
  );
}

/** The header renders its tier roll-ups as "This week — <span>KES x</span> (n)",
 *  so the assertions below match the money and the count together — a count that
 *  drifts from its cash is exactly the failure being guarded. */
const tier = (label: string, cash: string, count: number) =>
  `${label} \u2014 <span class="tabular-nums">${cash}</span> (${count})`;

describe("the plan header and the list describe the same rows", () => {
  it("counts the whole plan when nothing is filtered", () => {
    const html = render("mode=list");
    expect(html).toContain(tier("This week", "KES 1,000", 1));
    expect(html).toContain(tier("Can wait", "KES 2,000", 2));
    // Revenue at risk across all five rows, 500 apiece.
    expect(html).toContain("KES 2,500");
    // ...and the checklist's own sentence agrees with the header above it.
    expect(html).toContain("5 products to order");
  });

  it("counts only the urgent rows when Urgent only is on", () => {
    const html = render("mode=list&urgent=1");
    // Both urgent rows are order_today, so the calmer tiers empty out. Before
    // the fix the header still read the whole plan here while the list showed
    // two lines.
    expect(html).toContain(tier("This week", "KES 0", 0));
    expect(html).toContain(tier("Can wait", "KES 0", 0));
    expect(html).toContain("2 items are past the last safe day");
    // Revenue at risk follows too — two rows, not five.
    expect(html).toContain("KES 1,000");
    expect(html).not.toContain("KES 2,500");
    // ...and the list says two.
    expect(html).toContain("2 products to order");
    expect(html).not.toContain("5 products to order");
  });

  it("keeps the urgency lens off the held-back rows", () => {
    // "Not on the list" rows are not being ordered, so "only the urgent ones"
    // has nothing to say about them — narrowing that section too would hide the
    // answer to "why isn't X here?" behind a filter about something else.
    const held = mkRow({ urgency: "low", tier: "can_wait" });
    const withHeld: BuyList = {
      ...buyList,
      excluded: [{ ...held, reason: "covered" as const }],
    };
    search = new URLSearchParams("mode=list&urgent=1");
    const html = renderToStaticMarkup(
      <CurrencyProvider currency="KES">
        <PlanView
          buyList={withHeld}
          canViewCosts
          canBudget
          canOverride
          freshness={planFreshnessLabel(buyList.runDate, Date.UTC(2026, 7, 10, 9, 0, 0))}
        />
      </CurrencyProvider>
    );
    expect(html).toContain(held.title);
  });
});
