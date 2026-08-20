import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Every editable field in the product row editor has to announce itself.
 *
 * Cost, selling price and category were bare inputs with a placeholder and a
 * plain-text caption beside them — no label, no name, no aria-label — so a
 * screen-reader user tabbing the editor heard "edit text, blank" three times
 * and had to guess which box pays the supplier and which charges the customer.
 * The rest of the app is good about this (receiving announces "Units received
 * for <product>"), which made the editor an outlier rather than a pattern.
 *
 * The names carry the product too: several rows can be open at once, so
 * "Unit cost" alone would repeat across the page.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

import { CurrencyProvider } from "../components/currency-provider";
import { RowEditor } from "../app/(shell)/products/row-editor";
import type { CatalogueRow } from "../lib/data/stock";

const TITLE = "Cantu Shea Butter Leave-In 340g";

const row = {
  productId: "p-1",
  sku: "CAN-SHE-340",
  title: TITLE,
  variantTitle: null,
  shopifyProductId: null,
  vendor: "Cantu",
  onHandUnits: 20,
  warehouseUnits: 0,
  daysCover: 30,
  urgency: null,
  priceKes: 1500,
  runRate: 0.7,
  revenue30dKes: 5400,
  costKes: 1050,
  stockValueKes: 21_000,
  moneyAtRestKes: 21_000,
  abc: "A",
  customCategory: null,
  costSource: "shopify",
  notForSale: false,
  lifecycle: null,
  leadDays: 14,
  buyable: true,
  marginPct: 30,
  verdict: "healthy",
  expectedArrivalAt: null,
  onOrderUnits: 0,
} as unknown as CatalogueRow;

function labelsIn(html: string): string[] {
  return [...html.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]!);
}

function render(canViewCosts = true, canManage = true) {
  return renderToStaticMarkup(
    <CurrencyProvider currency="KES">
      <RowEditor
        row={row}
        categories={["Haircare"]}
        flags={{ active: true, activeOverride: false } as never}
        canViewCosts={canViewCosts}
        canManage={canManage}
      />
    </CurrencyProvider>
  );
}

describe("product row editor accessibility", () => {
  it("names the cost, price and category fields, and the product they belong to", () => {
    const labels = labelsIn(render());
    expect(labels.length).toBeGreaterThan(0); // vacuity guard
    for (const field of ["Unit cost", "Selling price", "Category"]) {
      const match = labels.find((l) => l.startsWith(field));
      expect(match, `no accessible name starting "${field}"`).toBeDefined();
      expect(match, match).toContain(TITLE);
    }
  });

  it("leaves no editable field in the editor unnamed", () => {
    const html = render();
    // Every <input> must carry an aria-label, or sit inside a <label> that names
    // it. The not-for-sale checkbox is the second kind and is already fine.
    const inputs = [...html.matchAll(/<input\b[^>]*>/g)].map((m) => m[0]!);
    expect(inputs.length).toBeGreaterThan(0);
    const unnamed = inputs.filter(
      (tag) => !/aria-label=/.test(tag) && !/type="checkbox"/.test(tag)
    );
    expect(unnamed, unnamed.join("\n")).toHaveLength(0);
  });
});
