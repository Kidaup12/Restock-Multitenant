import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CurrencyProvider } from "../components/currency-provider";
import { buildAggregates, DEFAULT_QUERY, selectRows } from "../lib/catalogue";
import type { CatalogueRow, CatalogueScreen } from "../lib/data/stock";
import type { BuyListRow } from "../lib/data/plan";

/**
 * The shape of a table must not depend on what happens to be in it. A shop
 * comparing two workspaces — or the same workspace before and after a sync —
 * saw a different set of columns each time, which reads as an unreliable screen
 * and hides a whole concept whenever it is empty. Columns that carry data are
 * always there; an empty one says "—".
 *
 * Permission-gated columns are the exception and stay gated: the tick column
 * holds controls, and cost VALUES are masked rather than dropped.
 */

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

const { CatalogueView, RowGroup } = await import("../app/(shell)/stock/catalogue-view");
const { BudgetTable } = await import("../app/(shell)/plan/budget-planner");

const headerCells = (html: string) => html.match(/<th\b/g) ?? [];

/** Every colSpan the markup carries. Case-insensitive: the attribute reaches the
 *  markup as written, and HTML attribute names are not case-sensitive. */
const colSpans = (html: string) =>
  [...html.matchAll(/colspan="(\d+)"/gi)].map((m) => Number(m[1]));

/* ── catalogue ─────────────────────────────────────────────────────────── */

const catalogueRow = (over: Partial<CatalogueRow> = {}): CatalogueRow => ({
  productId: over.sku ?? "p1",
  sku: "CAT-1",
  title: "Shea Butter 250ml",
  variantTitle: null,
  shopifyProductId: null,
  vendor: "Fixture Co",
  onHandUnits: 5,
  warehouseUnits: 0,
  daysCover: 12,
  urgency: null,
  priceKes: 800,
  runRate: 0.4,
  revenue30dKes: 3200,
  costKes: 400,
  stockValueKes: 2000,
  moneyAtRestKes: 2000,
  abc: "B",
  customCategory: "Skin",
  costSource: "manual",
  notForSale: false,
  lifecycle: "active",
  lifecycleLabel: "Active",
  buyable: true,
  lifecycleReason: null,
  onOrderUnits: 0,
  expectedArrivalAt: null,
  syncError: null,
  syncErrorAt: null,
  leadDays: 14,
  verdict: "healthy",
  marginPct: 50,
  missingCost: false,
  suspectCost: false,
  heldOffBuyList: false,
  costMovedPct: null,
  costMovedAt: null,
  facet: {
    productId: over.sku ?? "p1",
    brand: "Fixture Co",
    productType: null,
    category: "Skin",
    supplier: null,
    supplierGroup: null,
    speedBand: null,
    abc: "B",
    health: [],
  },
  ...over,
});

/** A screen built the way the server builds one, so the aggregates the view
 *  reads are the real derivation rather than a hand-written guess. */
function screenFor(rows: CatalogueRow[]): CatalogueScreen {
  const matched = selectRows(rows, DEFAULT_QUERY);
  return {
    rows: matched,
    aggregates: buildAggregates(rows, DEFAULT_QUERY, matched, { canViewCosts: true }),
    pageCount: 1,
    page: 0,
    from: 1,
    empty: rows.length === 0,
  };
}

const renderCatalogue = (rows: CatalogueRow[], canManage = false) =>
  renderToStaticMarkup(
    <CurrencyProvider currency="KES">
      <CatalogueView
        screen={screenFor(rows)}
        query={DEFAULT_QUERY}
        categories={[]}
        ownerFlags={{}}
        canViewCosts
        canManage={canManage}
      />
    </CurrencyProvider>
  );

const EMPTY_WAREHOUSE = [catalogueRow()];
const WITH_WAREHOUSE = [catalogueRow({ sku: "CAT-2", warehouseUnits: 37 })];

describe("catalogue columns do not come and go with the data", () => {
  it("keeps the warehouse column on a shop holding no warehouse stock", () => {
    const html = renderCatalogue(EMPTY_WAREHOUSE);
    expect(html).toContain("In warehouse");
    // Nothing to show, so the cell says so in the table's own empty form.
    expect(html).toContain("—");
  });

  it("still carries the figure when there IS warehouse stock", () => {
    const html = renderCatalogue(WITH_WAREHOUSE);
    expect(html).toContain("In warehouse");
    expect(html).toContain("37");
  });

  it("shows the same columns either way", () => {
    expect(headerCells(renderCatalogue(EMPTY_WAREHOUSE))).toHaveLength(
      headerCells(renderCatalogue(WITH_WAREHOUSE)).length
    );
  });

  it("an expanded row spans every column", () => {
    for (const canManage of [false, true]) {
      const html = renderCatalogue(EMPTY_WAREHOUSE, canManage);
      const columns = headerCells(html).length;
      const expanded = renderToStaticMarkup(
        <CurrencyProvider currency="KES">
          <table>
            <tbody>
              <RowGroup
                row={EMPTY_WAREHOUSE[0]!}
                open
                onToggle={() => {}}
                canViewCosts
                canManage={canManage}
                categoryNames={[]}
                flags={{ active: true, activeOverride: false }}
                picked={false}
                onPick={canManage ? () => {} : undefined}
              />
            </tbody>
          </table>
        </CurrencyProvider>
      );
      expect(colSpans(expanded)).toEqual([columns]);
    }
  });

  // "On order" read as a purchase order the shop had raised. The number is the
  // en-route figure — stock at an en-route location plus Shopify's incoming
  // count, MAXed against outstanding PO units — so it is stock on its way,
  // however it was set in motion.
  it("names the inbound column for what it counts", () => {
    const html = renderCatalogue(EMPTY_WAREHOUSE);
    expect(html).toContain("En route");
    expect(html).not.toContain("On order");
  });

  // The tick column holds a checkbox, not a reading — it stays permission-gated.
  it("leaves the editor's tick column to the permission", () => {
    expect(headerCells(renderCatalogue(EMPTY_WAREHOUSE, true)).length).toBe(
      headerCells(renderCatalogue(EMPTY_WAREHOUSE, false)).length + 1
    );
  });
});

/* ── budget planner ────────────────────────────────────────────────────── */

const buyRow = (over: Partial<BuyListRow> = {}): BuyListRow => ({
  predictionId: "pred-1",
  productId: "prod-1",
  sku: "BUY-1",
  title: "Curl Cream 200ml",
  vendor: null,
  supplierName: "Nairobi Supplies",
  onHandUnits: 12,
  onOrderUnits: 0,
  daysUntilStockout: 18,
  daysLeftToOrder: 4,
  leadDays: 14,
  orderByDate: new Date("2026-08-31T00:00:00Z"),
  urgency: "high",
  tier: "order_today",
  recommendedQty: 24,
  overriddenQty: null,
  runRatePerDay: 0.6,
  moq: 1,
  leadFloored: false,
  orderQty: 24,
  abc: "A",
  category: null,
  unitCostKes: 100,
  lineTotalKes: 2400,
  priceKes: 200,
  reasoning: "cover runs out inside the lead time",
  explain: null,
  qtySummary: "12 in stock + 0 incoming + 24 ordered = 36",
  confidence: "sure",
  coldStart: null,
  borrowedFromTitle: null,
  plannable: "ok",
  atRiskKes: 0,
  revenue30dKes: 5400,
  ...over,
});

const renderBudget = (rows: BuyListRow[]) =>
  renderToStaticMarkup(
    <CurrencyProvider currency="KES">
      <BudgetTable rows={rows} canViewCosts />
    </CurrencyProvider>
  );

describe("budget planner columns do not come and go with the data", () => {
  it("keeps the at-risk column on a list with nothing at risk", () => {
    const html = renderBudget([buyRow()]);
    expect(html).toContain("At risk (30d)");
    expect(html).toContain("—");
  });

  it("still carries the figure when something IS at risk", () => {
    const html = renderBudget([buyRow({ atRiskKes: 9100 })]);
    expect(html).toContain("At risk (30d)");
    expect(html).toContain("9,100");
  });

  it("shows the same columns either way", () => {
    expect(headerCells(renderBudget([buyRow()]))).toHaveLength(
      headerCells(renderBudget([buyRow({ atRiskKes: 9100 })])).length
    );
  });
});
