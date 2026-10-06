import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactNode, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DashboardTable } from "../lib/data/today";
import type { CatalogueRow } from "../lib/data/stock";

// Exercise the actual handlers and rerender without requiring a browser DOM.
const hooks = vi.hoisted(() => ({ states: [] as unknown[], cursor: 0 }));
vi.mock("react", async importOriginal => ({ ...(await importOriginal<typeof import("react")>()), useState: (initial: unknown) => {
  const index = hooks.cursor++;
  if (!(index in hooks.states)) hooks.states[index] = initial;
  return [hooks.states[index], (next: unknown) => { hooks.states[index] = next; }];
} }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a> }));
import { ProductTabs } from "../app/(shell)/today/product-tabs";

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
const rows = Array.from({ length: 238 }, (_, index) => ({ productId: `p${index}`, title: `Never-sold product ${index}`, sku: `SKU-${index}`, vendor: "Example", abc: null, onHandUnits: 10, costKes: 123456789, moneyAtRestKes: 1234567890, urgency: "low" }) as CatalogueRow);
const reasons = ["new_product", "insufficient_stock_history", "unknown_age", "dead"] as const;
const data: DashboardTable = {
  counts: { all: 238, stockout: 0, reorder: 0, onway: 0, dead: 1, unsold: 238 },
  rows: { all: rows.slice(0, 25), stockout: [], reorder: [], onway: [], dead: [], unsold: rows },
  capped: { all: true, stockout: false, reorder: false, onway: false, dead: false, unsold: false },
  healthy: 237, deadCostKes: 156000, deadWindowDays: 90, criticalCount: 0, criticalCostKes: 0, deadStockExport: [],
  unsoldSummary: { skus: 238, costKes: 1980000 }, unsoldReasons: Object.fromEntries(rows.map((row, index) => [row.productId, reasons[index % 4]!])),
};
const tree = (canViewCosts = true) => { hooks.cursor = 0; return ProductTabs({ data, canViewCosts, trend: null }); };
const selectUnsold = () => {
  const button = elements(tree()).find(element => element.type === "button" && String(element.props.className).includes("w-full min-w-0"))!;
  (button.props.onClick as () => void)();
};
beforeEach(() => { hooks.states = []; hooks.cursor = 0; });
describe("Never sold dashboard interaction", () => {
  it("selects the full238-item view from its summary and explains all eligibility reasons", () => {
    expect(renderToStaticMarkup(tree())).not.toContain("Never-sold product 237");
    selectUnsold();
    const html = renderToStaticMarkup(tree());
    expect(html).toContain("Never-sold product 237");
    expect(html.match(/href="\/products\/p\d+"/g)).toHaveLength(238);
    expect(html).toContain("under 60 days");
    expect(html).toContain("Fewer than 14 observed in-stock days");
    expect(html).toContain("Product age unknown");
    expect(html).toContain("Also counted as dead stock");
    expect(html).toContain("the two values should not be added together");
  });
  it("searches across the full list, including products beyond row25", () => {
    selectUnsold();
    const input = elements(tree()).find(element => element.props["aria-label"] === "Search unsold products")!;
    (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "SKU-237" } });
    const html = renderToStaticMarkup(tree());
    expect(html).toContain("Never-sold product 237");
    expect(html.match(/href="\/products\/p\d+"/g)).toHaveLength(1);
  });
  it("hides summary and row costs for a member even if passed an unredacted fixture", () => {
    selectUnsold();
    const html = renderToStaticMarkup(tree(false));
    expect(html).toContain("238 stocked products");
    expect(html).not.toContain("stock value at cost");
    expect(html).not.toContain("123,456,789");
    expect(html).not.toContain("1,234,567,890");
  });
});
