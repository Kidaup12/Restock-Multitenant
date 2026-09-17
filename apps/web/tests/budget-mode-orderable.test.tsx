import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

import { CurrencyProvider } from "@/components/currency-provider";
import type { BuyListRow } from "@/lib/data/plan";

const { BuyTable } = await import("../app/(shell)/plan/buy-table");

/**
 * Ordering from budget mode.
 *
 * The screen that decides what to buy was the one screen that could not buy it:
 * the tick boxes lived only in list mode, so an owner who planned against a
 * budget had to rebuild the same decision elsewhere to act on it.
 *
 * Budget mode now renders the SAME BuyTable list mode does (not a copy), so
 * this is no longer just "budget mode uses the shared picker" — there is
 * exactly one table component, and this test proves it stays orderable there.
 */

const row = (id: string, title: string): BuyListRow => ({
  predictionId: id,
  productId: `p-${id}`,
  sku: `SKU-${id}`,
  title,
  vendor: null,
  supplierName: null,
  onHandUnits: 4,
  onOrderUnits: 0,
  daysUntilStockout: 6,
  daysLeftToOrder: 2,
  leadDays: 5,
  orderByDate: new Date("2026-08-11T00:00:00Z"),
  urgency: "critical",
  tier: "order_today",
  recommendedQty: 10,
  orderQty: 10,
  overriddenQty: null,
  runRatePerDay: 1,
  moq: 1,
  leadFloored: false,
  abc: "A",
  category: null,
  unitCostKes: 100,
  lineTotalKes: 1000,
  priceKes: 200,
  reasoning: "cover runs out inside the lead time",
  explain: null,
  qtySummary: "x",
  confidence: null,
  coldStart: null,
  borrowedFromTitle: null,
  plannable: "ok",
  atRiskKes: 900,
  revenue30dKes: 5000,
});

const render = (props: { picked: Set<string>; onToggle: (id: string) => void }) =>
  renderToStaticMarkup(
    <CurrencyProvider currency="KES">
      <BuyTable
        rows={[row("1", "Shea Butter")]}
        canViewCosts
        canOverride={false}
        sort="plan"
        onSortChange={() => {}}
        footerTotalKes={1000}
        {...props}
      />
    </CurrencyProvider>
  );

describe("ordering from the budget plan", () => {
  it("offers a tick box per row", () => {
    const html = render({ picked: new Set<string>(), onToggle: () => {} });
    expect(html).toContain('type="checkbox"');
    expect(html, "the box is not tied to its product").toContain('aria-label="Order Shea Butter"');
  });

  it("shows a ticked row as ticked", () => {
    const html = render({ picked: new Set(["1"]), onToggle: () => {} });
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*checked/);
  });

  it("keeps ONE way to turn a selection into an order", () => {
    // Budget mode must go through the shared picker and the shared table,
    // never its own call or its own copy of the table.
    const source = readFileSync(
      new URL("../app/(shell)/plan/budget-planner.tsx", import.meta.url),
      "utf8"
    );
    expect(source, "budget mode is not using the shared picker").toContain("useOrderPicker");
    expect(source, "budget mode is not using the shared table").toContain("BuyTable");
    expect(
      /\baddToOrder\b/.test(source),
      "budget mode grew its own order call — there are now two answers to what ticking a row does"
    ).toBe(false);
  });
});
