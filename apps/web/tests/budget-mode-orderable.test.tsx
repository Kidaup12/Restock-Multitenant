import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

import { CurrencyProvider } from "@/components/currency-provider";

const { BudgetTable } = await import("../app/(shell)/plan/budget-planner");

/**
 * Ordering from budget mode.
 *
 * The screen that decides what to buy was the one screen that could not buy it:
 * the tick boxes lived only in list mode, so an owner who planned against a
 * budget had to rebuild the same decision elsewhere to act on it.
 *
 * The structural case is the one that matters most. There must be exactly ONE
 * answer to "what does ticking rows and pressing the button do". Two screens
 * with their own copy of that is this codebase's signature defect — the sort
 * headings, the three footers, the two producers of ABC — so a test fails if
 * budget mode ever grows its own call to the order action.
 */

const row = (id: string, title: string) =>
  ({
    predictionId: id,
    productId: `p-${id}`,
    sku: `SKU-${id}`,
    title,
    vendor: null,
    supplierName: null,
    onHandUnits: 4,
    onOrderUnits: 0,
    daysLeftToOrder: 2,
    runRatePerDay: 1,
    recommendedQty: 10,
    unitCostKes: 100,
    lineTotalKes: 1000,
    priceKes: 200,
    revenue30dKes: 5000,
    atRiskKes: 900,
    abc: "A",
    plannable: "ok",
    tier: "order_today",
    urgency: "critical",
  }) as never;

const render = (props: Record<string, unknown>) =>
  renderToStaticMarkup(
    <CurrencyProvider currency="KES">
      <BudgetTable rows={[row("1", "Shea Butter")]} canViewCosts {...props} />
    </CurrencyProvider>
  );

describe("ordering from the budget plan", () => {
  it("offers a tick box per row when a selection is on offer", () => {
    const html = render({ picked: new Set<string>(), onToggle: () => {} });
    expect(html).toContain('type="checkbox"');
    expect(html, "the box is not tied to its product").toContain('aria-label="Order Shea Butter"');
  });

  it("grows no dead column where nothing can be ordered", () => {
    // Without a handler the table is read-only, and a checkbox nobody can act
    // on is worse than none. The column-stability guard renders it this way.
    const html = render({});
    expect(html).not.toContain('type="checkbox"');
  });

  it("shows a ticked row as ticked", () => {
    const html = render({ picked: new Set(["1"]), onToggle: () => {} });
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*checked/);
  });

  it("keeps ONE way to turn a selection into an order", () => {
    // Budget mode must go through the shared picker, never its own call.
    const source = readFileSync(
      new URL("../app/(shell)/plan/budget-planner.tsx", import.meta.url),
      "utf8"
    );
    expect(source, "budget mode is not using the shared picker").toContain("useOrderPicker");
    expect(
      /\baddToOrder\b/.test(source),
      "budget mode grew its own order call — there are now two answers to what ticking a row does"
    ).toBe(false);
  });
});
