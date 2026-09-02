import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProductTabs } from "../app/(shell)/today/product-tabs";
import { CurrencyProvider } from "../components/currency-provider";
import type { DashboardTable } from "../lib/data/today";

/**
 * Two figures on Today measure different things and must not claim to measure
 * the same one.
 *
 * The banner counts buy-list rows at urgency "critical" — under seven days of
 * cover, velocity-gated. The Stockouts tile counts products whose shelf is
 * actually empty. Both were correct, and both said "at or near zero stock", so
 * a shop read 4 above 3 as a contradiction and had no way to tell them apart.
 */

const table: DashboardTable = {
  counts: { stockout: 3, reorder: 9, onway: 2, dead: 1, all: 47 },
  healthy: 40,
  rows: { stockout: [], reorder: [], onway: [], dead: [], all: [] },
  deadWindowDays: 60,
  deadCostKes: 1000,
  criticalCount: 4,
  criticalCostKes: 0,
  capped: { stockout: false, reorder: false, onway: false, dead: false, all: false },
  deadStockExport: [],
};

const html = () =>
  renderToStaticMarkup(
    <CurrencyProvider currency="KES">
      <ProductTabs data={table} canViewCosts trend={null} />
    </CurrencyProvider>
  );

describe("Today's two shortage figures read differently", () => {
  it("describes the Stockouts tile by the empty shelf", () => {
    expect(html()).toContain("the shelf is empty");
  });

  it("never reuses the phrase that made the two look like one number", () => {
    // The banner lives in the server component above; what matters here is that
    // the phrase it used to share with this tile is gone from the tile.
    expect(html()).not.toContain("at or near zero stock");
  });
});
