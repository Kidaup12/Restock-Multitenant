import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactNode, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DashboardTable } from "../lib/data/today";
import type { CatalogueRow } from "../lib/data/stock";

/**
 * The Reorder tab never holds a product back for lacking a supplier — only for
 * unit economics it can't reason about (missing/broken cost). That exclusion
 * used to be silent: a stockout with no cost simply never appeared, with
 * nothing on screen to say why. This proves the notice names them instead.
 */

const hooks = vi.hoisted(() => ({ states: [] as unknown[], cursor: 0 }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.states)) hooks.states[index] = initial;
    return [hooks.states[index], (next: unknown) => { hooks.states[index] = next; }];
  },
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
import { ProductTabs } from "../app/(shell)/today/product-tabs";

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}

const reorderRow: CatalogueRow = {
  productId: "ok-1", sku: "OK-1", title: "Priced Product", variantTitle: null, shopifyProductId: null,
  vendor: "House", onHandUnits: 2, warehouseUnits: 0, daysCover: 3, urgency: "critical", priceKes: 500,
  runRate: 0.7, revenue30dKes: 2100, costKes: 300, stockValueKes: 600, moneyAtRestKes: 600, abc: "A",
  customCategory: null, costSource: "manual", notForSale: false, lifecycle: "active", lifecycleLabel: "Active",
  buyable: true, lifecycleReason: null, onOrderUnits: 0, expectedArrivalAt: null, syncError: null,
  syncErrorAt: null, leadDays: 14, leadSource: "assumed", supplierName: null, verdict: "order_now", marginPct: 40,
  missingCost: false, suspectCost: false, heldOffBuyList: false, costMovedPct: null, costMovedAt: null,
  facet: {
    productId: "ok-1", brand: "House", productType: null, category: null, supplier: null,
    supplierGroup: null, speedBand: null, abc: "A", health: [],
  },
};

const missingCostRow = (id: string, title: string): CatalogueRow & { plannable: "missing-cost" } => ({
  ...reorderRow, productId: id, sku: id.toUpperCase(), title, costKes: null, stockValueKes: null, moneyAtRestKes: null,
  plannable: "missing-cost",
});

const data: DashboardTable = {
  unsoldSummary: { skus: 0, costKes: null }, unsoldReasons: {},
  counts: { unsold: 0, stockout: 0, reorder: 1, onway: 0, dead: 0, all: 1 },
  healthy: 0,
  rows: { unsold: [], stockout: [], reorder: [reorderRow], onway: [], dead: [], all: [reorderRow] },
  deadWindowDays: 90, deadCostKes: 0, criticalCount: 1, criticalCostKes: 600,
  capped: { unsold: false, stockout: false, reorder: false, onway: false, dead: false, all: false },
  deadStockExport: [],
  // Zero suppliers on the tenant, nothing here depends on one — only cost does.
  missingCostCount: 8,
  missingCostRows: Array.from({ length: 8 }, (_, i) => missingCostRow(`mc-${i}`, `Uncosted Product ${i}`)),
};

const tree = (canOverride = false) => { hooks.cursor = 0; return ProductTabs({ data, canViewCosts: true, canOverride, trend: null }); };
const selectReorder = (canOverride = false) => {
  const button = elements(tree(canOverride)).find(
    (el) => el.type === "button" && elements(el).some((child) => child.props?.children === "Reorder")
  );
  // The health-pill and the tab-strip both route to the same tab key.
  const target = button ?? elements(tree(canOverride)).find((el) => el.type === "button" && String(el.props.children).includes("Reorder"));
  (target!.props.onClick as () => void)();
};

beforeEach(() => { hooks.states = []; hooks.cursor = 0; });

describe("Reorder tab: missing-cost notice", () => {
  it("says nothing on a tenant with nothing held back for cost", () => {
    const quiet: DashboardTable = { ...data, missingCostCount: 0, missingCostRows: [] };
    const html = renderToStaticMarkup(ProductTabs({ data: quiet, canViewCosts: true, trend: null }));
    expect(html).not.toContain("need a cost before they can be forecasted");
    expect(html).not.toContain("needs a cost before it can be forecasted");
  });

  it("names the held-back count and products — the reason is cost, not a supplier", () => {
    selectReorder();
    const html = renderToStaticMarkup(tree());
    expect(html).toContain("8 more products need a cost before they can be forecasted");
    expect(html).toContain("Uncosted Product 0");
    // The point: a missing supplier never excludes a row. Only a missing/broken
    // cost does, and the copy says so explicitly rather than staying silent.
    expect(html).toContain("whether or not a supplier is set");
  });

  it("caps the named list and says how many more", () => {
    selectReorder();
    const html = renderToStaticMarkup(tree());
    expect(html).toContain("Uncosted Product 5");
    expect(html).not.toContain("Uncosted Product 6");
    expect(html).toContain("+2 more");
  });

  it("links each named product to its page to fix the cost", () => {
    selectReorder();
    const html = renderToStaticMarkup(tree());
    expect(html).toContain('href="/products/mc-0"');
  });

  it("offers the inline cost fixer instead of a link when the caller can act on cost", () => {
    selectReorder(true);
    const html = renderToStaticMarkup(tree(true));
    // CostFixer's closed state is a "Fix (...)" button, replacing the old
    // "Fix cost →" link that non-override callers still get (asserted below).
    expect(html).toContain("Fix (no cost on file)");
    expect(html).not.toContain("Fix cost →");
  });

  it("falls back to a link-only fix when the caller cannot act on cost, even with view access", () => {
    selectReorder(false);
    const html = renderToStaticMarkup(tree(false));
    expect(html).toContain("Fix cost →");
    expect(html).not.toContain("Fix (no cost on file)");
  });
});
