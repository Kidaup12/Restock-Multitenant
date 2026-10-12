import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("@/lib/data/product-timeline", () => ({
  searchTimelineProducts: vi.fn(async () => [{ id: "p/one", title: "Soap", sku: "S" }]),
  getProductTimeline: vi.fn(),
}));
import { HistoryTab } from "../app/(shell)/insights/history-tab";
describe("History report navigation", () => {
  it("preserves the report lens through search and product selection", async () => {
    const html = renderToStaticMarkup(await HistoryTab({ tenantId: "tenant", timezone: "Africa/Nairobi", query: "Soap & oil", lenses: {range:"90d",class:"A",from:"2026-09-01",to:"2026-09-20"} }));
    for (const [name, value] of Object.entries({range:"90d",class:"A",from:"2026-09-01",to:"2026-09-20"})) {
      expect(html).toContain(`name="${name}" value="${value}"`);
    }
    const href = html.match(/href="([^"]*product=[^"]*)"/)?.[1].replaceAll("&amp;", "&");
    const params = new URL(href!, "https://example.test").searchParams;
    expect(Object.fromEntries(params)).toEqual({tab:"history",range:"90d",class:"A",from:"2026-09-01",to:"2026-09-20",q:"Soap & oil",product:"p/one"});
  });
});
