import { beforeEach, describe, expect, it, vi } from "vitest";
const { prediction, productQuery, overrides, orders, sent } = vi.hoisted(() => {
  const row = (title: string, currentStock: number, rate: number, daysUntilStockout: number, qty = 3) => ({
    productId: title, finalForecast30d: rate * 30, daysUntilStockout, recommendedQty: qty, urgency: "high",
    product: { title, sku: title, active: true, currentStock, onOrder: 7, costKes: 10, priceKes: 20, abcCategory: "A", supplier: { moq: 1 } },
  });
  return { prediction: vi.fn(async () => [row("Out", 0, 3, 0), row("Critical", 1, 0.4, 7), row("Upcoming", 20, 2, 10), ...Array.from({ length: 10 }, (_, i) => row(`Slow ${i}`, 2, 0.1, 20))]), productQuery: vi.fn(), overrides: vi.fn(), orders: vi.fn(), sent: vi.fn() };
});
vi.mock("@wezesha/db", async () => ({
  ...await import("../../../packages/db/src/inbound"),
  BUYABLE_PRODUCT_WHERE: { active: true, notForSale: false, missingFromShopifyAt: null, shopifyStatus: { notIn: ["draft", "archived"] } },
  roleOf: () => "sells",
  prismaService: {
    tenant: { findUnique: async () => ({ name: "Shop", slug: "shop", currency: "USD" }) },
    prediction: {
      findFirst: async () => ({ runDate: new Date("2026-10-01") }),
      groupBy: async () => [{ forecastRunId: "run", _count: { _all: 13 } }],
      findMany: prediction,
    },
    location: { findMany: async () => [] },
    productPlanOverride: { findMany: overrides },
    order: { findMany: orders },
    purchaseOrderLine: { findMany: sent },
    product: { findMany: productQuery },
  },
}));
import { buildOwnerReport } from "../src/owner-report";
import { renderReportEmail } from "../src/owner-report-email";
beforeEach(() => { overrides.mockResolvedValue([]); orders.mockResolvedValue([]); sent.mockResolvedValue([]); });

describe("upstream owner-report sections", () => {
  it("partitions each buy line once and totals the full buckets before truncating", async () => {
    const report = await buildOwnerReport("tenant-a", "week", 0);
    expect(report).not.toBeNull();
    expect(report!.oos.map(r => r.title)).toEqual(["Out"]);
    expect(report!.criticals.map(r => r.title)).toEqual(["Critical"]);
    expect(report!.upcoming.map(r => r.title)).toEqual(["Upcoming"]);
    expect(report!.others).toHaveLength(8);
    expect(report!.othersCount).toBe(10);
    expect(report!.othersBudgetKes).toBe(300);
    expect(report!.restockBudgetKes).toBe(390);
    expect(prediction).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenantId: "tenant-a", forecastRunId: "run", product: expect.objectContaining({ active: true, notForSale: false }) }) }));
    const { html, text, subject } = renderReportEmail(report!);
    for (const label of ["Completely out of stock", "Critical reorders", "Fast movers, order soon", "Slow and medium movers"]) expect(html).toContain(label);
    expect(html).toContain("USD 390");
    expect(html).not.toContain("KES");
    expect(text).toContain("7 en route");
    expect(subject).toContain("Wezesha Restock Weekly Report");
  });
  it("uses owner quantities, MOQ and committed orders in every count and budget", async () => {
    const rows = await prediction();
    prediction.mockResolvedValueOnce(rows.map(p => p.productId === "Critical" ? {...p,product:{...p.product,supplier:{moq:12}}} : p));
    overrides.mockResolvedValue([{productId:"Out",qty:0},{productId:"Critical",qty:2}]);
    orders.mockResolvedValue([{productId:"Upcoming"}]);
    sent.mockResolvedValue([{productId:"Critical",quantity:20,receivedQty:2}]);
    const report = await buildOwnerReport("tenant-a","week",0);
    expect(report!.oosCount).toBe(0);
    expect(report!.upcomingCount).toBe(0);
    expect(report!.criticals[0]).toMatchObject({qty:12,costKes:120,enRoute:18});
    expect(report!.criticalsBudgetKes).toBe(120);
    expect(report!.restockBudgetKes).toBe(420);
    expect(report!.restockCount).toBe(11);
  });
});
