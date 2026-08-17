import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CurrencyProvider } from "../components/currency-provider";
import { ExcludedSection } from "../app/(shell)/plan/buy-checklist";
import type { ExcludedReason, ExcludedRow } from "../lib/data/plan";

/**
 * The held-back products carry the same stored reasoning as the ones being
 * ordered, and none of it reached the screen. The case that matters: an item
 * with nothing on the shelf, no days of cover and a quantity of zero, sitting
 * under a heading that says there is enough. The heading alone reads as a
 * contradiction; only the row's own arithmetic ("28 incoming") resolves it.
 */

const explain = (summary: string, over: Record<string, number> = {}) => ({
  method: "mean_cover" as const,
  dailyForecast: 0.8,
  windowDays: 30,
  coverDays: 30,
  demandOverCover: 25,
  safetyStock: 0,
  currentStock: 0,
  onOrder: 28,
  targetUnits: 25,
  recommendedQty: 0,
  summary,
  ...over,
});

const row = (reason: ExcludedReason, over: Partial<ExcludedRow> = {}): ExcludedRow => ({
  predictionId: `p-${reason}-${over.sku ?? "1"}`,
  productId: `prod-${reason}-${over.sku ?? "1"}`,
  sku: over.sku ?? "SKU-1",
  title: over.title ?? "Shea Butter 250ml",
  vendor: null,
  supplierName: "Nairobi Supplies",
  onHandUnits: 0,
  onOrderUnits: 28,
  daysUntilStockout: 0,
  daysLeftToOrder: 0,
  leadDays: 14,
  orderByDate: new Date("2026-08-31T00:00:00Z"),
  urgency: "critical",
  tier: "order_today",
  recommendedQty: 0,
  orderQty: 0,
  overriddenQty: null,
  runRatePerDay: 0.8,
  moq: 1,
  leadFloored: false,
  abc: "A",
  category: null,
  unitCostKes: 100,
  lineTotalKes: 0,
  priceKes: 200,
  reasoning: "covered for now",
  explain: null,
  qtySummary: "0 in stock + 28 incoming + 0 ordered = 28",
  plannable: "ok",
  atRiskKes: 0,
  revenue30dKes: 0,
  confidence: "sure",
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

/** The markup belonging to one product: from its title to the next one's. */
function slice(html: string, title: string, nextTitle?: string): string {
  const from = html.indexOf(title);
  expect(from, `${title} is not rendered at all`).toBeGreaterThan(-1);
  const to = nextTitle ? html.indexOf(nextTitle, from) : html.length;
  return html.slice(from, to > from ? to : html.length);
}

describe("why a product isn't on the buy list", () => {
  it("prints the stored reasoning behind a zero quantity", () => {
    const summary = "already covered — 25 target ≤ 0 on hand + 28 incoming = 0";
    const html = render([row("covered", { explain: explain(summary) })]);

    expect(html).toContain(summary);
  });

  it("gives each product its own reasoning, not a shared line", () => {
    const first = "already covered — 25 target ≤ 0 on hand + 28 incoming = 0";
    const second = "already covered — 6 target ≤ 4 on hand + 9 incoming = 0";
    const html = render([
      row("covered", { explain: explain(first) }),
      row("covered", {
        sku: "SKU-2",
        title: "Argan Oil 100ml",
        onHandUnits: 4,
        onOrderUnits: 9,
        explain: explain(second, { currentStock: 4, onOrder: 9, targetUnits: 6 }),
      }),
    ]);

    const shea = slice(html, "Shea Butter 250ml", "Argan Oil 100ml");
    const argan = slice(html, "Argan Oil 100ml");

    expect(shea).toContain(first);
    expect(shea).not.toContain(second);
    expect(argan).toContain(second);
    expect(argan).not.toContain(first);
  });

  it("does not just repeat the group heading at each row", () => {
    const html = render([row("covered", { explain: explain("0 target ≤ 3 on hand = 0") })]);
    const shea = slice(html, "Shea Butter 250ml");

    expect(shea).not.toContain("You already have enough");
  });

  it("says why a borrowed forecast still counts as enough", () => {
    // notPlannedReasonFor files a "borrowed" cold start under "covered", so the
    // heading claims certainty while the row wears a borrowed-forecast chip.
    const html = render([
      row("covered", {
        confidence: "guessing",
        coldStart: "borrowed",
        borrowedFromTitle: "Coconut Oil 100ml",
        explain: explain("already covered — 25 target ≤ 0 on hand + 28 incoming = 0"),
      }),
    ]);
    const shea = slice(html, "Shea Butter 250ml");

    expect(shea).toContain("Coconut Oil 100ml");
    expect(shea).toMatch(/estimate|borrowed/i);
  });
});
