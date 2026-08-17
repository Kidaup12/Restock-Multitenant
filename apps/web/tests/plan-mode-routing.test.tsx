import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The planner's three ways in were client state with no URL of their own, so
 * the browser Back button left /plan entirely instead of returning to the
 * cards, a mode could be neither linked nor reloaded into, and the only way
 * back was the tail of a grey summary sentence reading "Start over".
 *
 * The mode now lives in ?mode=, and every mode carries a way out at the top.
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

const row: BuyListRow = {
  predictionId: "pred-1",
  productId: "prod-1",
  sku: "SKU-1",
  title: "Shea Butter 250ml",
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
  lineTotalKes: 2000,
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
};

const buyList: BuyList = {
  forecastRunId: "run-1",
  runDate: new Date("2026-08-10T02:07:00Z"),
  rows: [row],
  excluded: [],
  totalPredicted: 30,
  totalCostKes: 2000,
};

function render(params: string, canBudget = true) {
  search = new URLSearchParams(params);
  return renderToStaticMarkup(
    <CurrencyProvider currency="KES">
      <PlanView
        buyList={buyList}
        canViewCosts
        canBudget={canBudget}
        canOverride
        freshness={planFreshnessLabel(buyList.runDate, Date.UTC(2026, 7, 10, 9, 0, 0))}
      />
    </CurrencyProvider>
  );
}

describe("plan modes live in the URL", () => {
  it("shows the three ways in when no mode is asked for", () => {
    const html = render("");
    expect(html).toContain("Show me what to order");
    expect(html).toContain("See my ordering calendar");
    expect(html).not.toContain("All plan options");
  });

  it("opens the checklist straight from ?mode=list, with a way back", () => {
    const html = render("mode=list");
    expect(html).not.toContain("Show me what to order, and why");
    expect(html).toContain("All plan options");
  });

  it("opens the calendar from ?mode=calendar", () => {
    const html = render("mode=calendar");
    expect(html).toContain("All plan options");
    expect(html).not.toContain("See my ordering calendar");
  });

  it("ignores a mode the workspace's plan does not include", () => {
    // The budget allocator is a Growth feature. Typing the URL must not be a
    // way past the gate — the server action re-checks too, but the screen
    // should never have rendered it in the first place.
    const html = render("mode=budget", false);
    expect(html).toContain("Show me what to order");
    expect(html).not.toContain("All plan options");
  });

  it("falls back to the cards for a mode that does not exist", () => {
    const html = render("mode=nonsense");
    expect(html).toContain("Show me what to order");
  });
});
