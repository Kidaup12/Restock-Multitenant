import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CurrencyProvider } from "../components/currency-provider";
import { ExcludedSection } from "../app/(shell)/plan/buy-checklist";
import type { ExcludedReason, ExcludedRow } from "../lib/data/plan";

/**
 * "Why isn't this product on my plan?" is the question a buy list has to be able
 * to answer, and until now no screen did: a product the run sized to zero was
 * filtered out before the section was built and appeared nowhere. On the live
 * tenant that was 47 of 49 products.
 */

const row = (reason: ExcludedReason, over: Partial<ExcludedRow> = {}): ExcludedRow => ({
  predictionId: `p-${reason}-${over.sku ?? "1"}`,
  productId: `prod-${reason}`,
  sku: over.sku ?? "SKU-1",
  title: over.title ?? "Shea Butter 250ml",
  vendor: null,
  supplierName: "Nairobi Supplies",
  onHandUnits: 12,
  onOrderUnits: 0,
  daysUntilStockout: 40,
  daysLeftToOrder: 26,
  leadDays: 14,
  orderByDate: new Date("2026-08-31T00:00:00Z"),
  urgency: "low",
  tier: "can_wait",
  recommendedQty: 0,
  overriddenQty: null,
  runRatePerDay: 0.3,
  moq: 1,
  abc: "C",
  category: null,
  unitCostKes: 100,
  lineTotalKes: 0,
  priceKes: 200,
  reasoning: "covered for now",
  explain: null,
  qtySummary: "12 in stock + 0 incoming + 0 ordered = 12",
  plannable: "ok",
  atRiskKes: 0,
  revenue30dKes: 0,
  confidence: "guessing",
  coldStart: null,
  borrowedFromTitle: null,
  reason,
  ...over,
});

const render = (rows: ExcludedRow[]) =>
  renderToStaticMarkup(
    <CurrencyProvider currency="KES">
      <ExcludedSection excluded={rows} canViewCosts />
    </CurrencyProvider>
  );

describe("not on the buy list", () => {
  it("groups a zero-quantity product under a reason the owner can act on", () => {
    const html = render([
      row("covered"),
      row("too-new", { sku: "SKU-2", title: "New Curl Cream", coldStart: "too_new" }),
    ]);

    expect(html).toContain("Not on the buy list");
    expect(html).toContain("You already have enough");
    expect(html).toContain("Too new to forecast");
    expect(html).toContain("Shea Butter 250ml");
    expect(html).toContain("New Curl Cream");
    // The honesty word travels with the row into this section too.
    expect(html).toContain("Guessing");
    expect(html).toContain("Too new");
  });

  it("drops the quantity columns for products nothing is being ordered for", () => {
    const zeroSized = render([row("covered")]);
    expect(zeroSized).not.toContain("Suggested qty");
    expect(zeroSized).not.toContain("Line total");

    // A held-back row that DOES carry a quantity keeps them.
    const withQty = render([row("already-ordered", { recommendedQty: 8, lineTotalKes: 800 })]);
    expect(withQty).toContain("Suggested qty");
    expect(withQty).toContain("Line total");
  });
});
