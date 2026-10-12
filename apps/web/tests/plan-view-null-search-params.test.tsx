import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * /plan must survive `useSearchParams()` being null.
 *
 * Next returns null from `useSearchParams()` during the server prerender, before
 * hydration. PlanView reads it on every render (mode, scope, urgent), and the
 * URL-persisted scope work started calling `.get()` on the result unconditionally
 * — so a null took the whole page down with the "Something went wrong" boundary
 * (the production crash, quote ref 4085124725). Rendering to static markup
 * reproduces exactly that server pass: it calls the hook with null and would
 * throw before painting a single row. `parseScopeFromParams(null)` is the same
 * hazard one layer down, so it is asserted directly too.
 */

// Reads happen at module import; a null searchParams is the case under test.
let searchParams: URLSearchParams | null = null;
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
  usePathname: () => "/plan",
  useSearchParams: () => searchParams,
}));

// PlanView pulls the tenant db in via lib/data/plan's type imports only, but the
// client bundle it lives in shouldn't reach the db at all; stub it defensively.
vi.mock("@wezesha/db", () => ({
  prismaForTenant: () => ({}),
  prismaService: {},
  prismaAuth: {},
  Prisma: {},
  OUTSTANDING_PO_STATUSES: ["sent", "partially_received"],
  effectiveOnOrder: (a: number, b: number) => Math.max(a, b),
  outstandingByProduct: () => new Map(),
}));

import type { BuyList, BuyListRow } from "../lib/data/plan";

const { CurrencyProvider } = await import("../components/currency-provider");
const { PlanView } = await import("../app/(shell)/plan/plan-view");
const { parseScopeFromParams, EMPTY_SCOPE } = await import("../app/(shell)/plan/scope-bar");
const { planFreshnessLabel } = await import("../lib/data/forecast-freshness");

const row: BuyListRow = {
  predictionId: "p1", productId: "prod-1", sku: "SKU1", title: "Curl Cream 200ml", vendor: null,
  supplierName: "Nairobi Supplies", onHandUnits: 4, onOrderUnits: 0, daysUntilStockout: 6,
  daysLeftToOrder: 1, leadDays: 5, orderByDate: new Date("2026-08-11T00:00:00Z"), urgency: "critical",
  tier: "order_today", recommendedQty: 20, orderQty: 20, overriddenQty: null, runRatePerDay: 0.8,
  moq: 1, leadFloored: false, abc: "A", category: null, unitCostKes: 100, lineTotalKes: 1000,
  priceKes: 200, reasoning: "cover runs out inside the lead time", explain: null, qtySummary: "x",
  confidence: null, coldStart: null, borrowedFromTitle: null, plannable: "ok", atRiskKes: 500,
  revenue30dKes: 4000,
};
const buyList: BuyList = {
  forecastRunId: "r1", runDate: new Date("2026-08-10T02:07:00Z"), rows: [row], excluded: [],
  totalPredicted: 30, totalCostKes: 1000,
};

const render = () =>
  renderToStaticMarkup(
    <CurrencyProvider currency="KES">
      <PlanView
        buyList={buyList}
        canViewCosts
        canBudget
        canOverride
        freshness={planFreshnessLabel(buyList.runDate, Date.UTC(2026, 7, 10, 9, 0, 0))}
      />
    </CurrencyProvider>,
  );

describe("/plan survives a null useSearchParams (server prerender)", () => {
  it("renders (the mode chooser) when searchParams is null instead of throwing", () => {
    searchParams = null;
    // No `mode` param -> PlanView shows the chooser, not a table. The point is it
    // PAINTS rather than throwing: the crash was a null-deref before any markup.
    const html = render();
    expect(html).toContain("See recommended purchase");
    expect(html.length).toBeGreaterThan(0);
  });

  it("renders the buy list once mode=list is present", () => {
    searchParams = new URLSearchParams("mode=list&class=A&lead=fast");
    expect(render()).toContain("Curl Cream 200ml");
  });

  it("parseScopeFromParams treats null as no scope, not a crash", () => {
    expect(parseScopeFromParams(null)).toEqual(EMPTY_SCOPE);
    expect(parseScopeFromParams(new URLSearchParams("class=A,B&lead=fast,bogus&category=Serums"))).toEqual({
      abc: ["A", "B"],
      category: ["Serums"],
      supplier: [],
      leadBand: ["fast"], // "bogus" dropped
    });
  });
});
