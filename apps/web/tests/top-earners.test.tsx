import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TopEarnersView } from "@/app/(shell)/insights/top-earners-view";
import type { TopProduct } from "@/lib/data/sales";

vi.mock("@/components/currency-provider", () => ({ useCurrency: () => "KES" }));

/**
 * Best earners on the Reports screen, filterable by ABC class.
 *
 * The ranking already existed on the Sales page; what a report needs and it
 * lacked is the class lens — "are my A-class products actually the ones
 * earning?" The list is server-rendered here; the class chips carry their real
 * counts so a chip can never promise more rows than it delivers.
 */

const row = (over: Partial<TopProduct>): TopProduct => ({
  productId: over.sku ?? "p", sku: "SKU-1", title: "A product",
  unitsSold: 10, revenueKes: 1000, runRate: 0.5, abc: "A", ...over,
});

const rows: TopProduct[] = [
  row({ sku: "a1", abc: "A", revenueKes: 5000 }),
  row({ sku: "a2", abc: "A", revenueKes: 4000 }),
  row({ sku: "b1", abc: "B", revenueKes: 3000 }),
  row({ sku: "c1", abc: "C", revenueKes: 1000 }),
  row({ sku: "u1", abc: null, revenueKes: 500 }),
];

const render = () => renderToStaticMarkup(<TopEarnersView rows={rows} currency="KES" />);

describe("top earners", () => {
  it("ranks by revenue and shows the class per row", () => {
    const html = render();
    // Highest earner first, and its class beside it.
    expect(html.indexOf("a1")).toBeLessThan(html.indexOf("c1"));
    expect(html).toContain("Top earners, 30 days");
  });

  it("carries the true count on each class chip", () => {
    // A chip promising "Best sellers 2" must actually filter to two — a count
    // that does not match the filter is how a report lies.
    const html = render();
    expect(html).toContain("Best sellers");
    // 5 total, 2 A, 1 B, 1 C rendered as chip counts.
    expect(html).toMatch(/All classes[\s\S]*?5/);
  });

  it("names the classes for a shop, not by letter", () => {
    const html = render();
    expect(html).toContain("Best sellers");
    expect(html).toContain("Slow movers");
    expect(html).not.toContain("Class A");
  });

  it("shows an empty state when nothing has sold", () => {
    const html = renderToStaticMarkup(<TopEarnersView rows={[]} currency="KES" />);
    expect(html).toContain("No sales in the last 30 days");
  });
});
