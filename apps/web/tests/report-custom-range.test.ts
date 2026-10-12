import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveReportRange } from "../lib/data/report-range";
import { reportTabHref } from "../app/(shell)/insights/tabs";

const mock = vi.hoisted(() => ({
  sales: { groupBy: vi.fn(), findMany: vi.fn(), aggregate: vi.fn() },
  snapshots: { findMany: vi.fn(), findFirst: vi.fn() },
  products: { findMany: vi.fn() },
  config: { findFirst: vi.fn() },
  asks: { findMany: vi.fn() }, orders: { findMany: vi.fn() }, po: { findMany: vi.fn() },
  metrics: vi.fn(), today: vi.fn(),
}));
vi.mock("@wezesha/db", () => ({ BUYABLE_PRODUCT_WHERE: { active: true }, prismaForTenant: () => ({
  salesHistory: mock.sales, inventorySnapshot: mock.snapshots, product: mock.products,
  tenantConfig: mock.config, forecastRecommendation: mock.asks, order: mock.orders, purchaseOrderLine: mock.po,
}) }));
vi.mock("@wezesha/forecast-run", () => ({ AS_SHOWN_TAG: "as-shown" }));
vi.mock("@/lib/metrics", () => ({ getCatalogueMetrics: mock.metrics, runRate: () => 1 }));
vi.mock("../lib/data/today", () => ({ DEFAULT_DEAD_STOCK_DAYS: 60, getTodayMetrics: mock.today, pileFor: vi.fn() }));
vi.mock("../lib/data/stock", () => ({ getStockCatalogue: vi.fn() }));

import { getPeriodMetrics, getPlanAdherence, getRevenueBreakdown, getStockoutTrend } from "../lib/data/insights";
import { getOverviewKpis } from "../lib/data/overview-kpis";
import { getTopProducts } from "../lib/data/sales";

const now = new Date("2026-10-04T22:00:00Z");
const period = resolveReportRange({ from: "2026-09-14", to: "2026-09-20" }, "Africa/Nairobi", now);

describe("report dates in the shop's timezone", () => {
  it("separates day markers from timestamps and includes both selected date labels", () => {
    expect(period.days).toBe(7);
    expect(period.start.toISOString()).toBe("2026-09-14T00:00:00.000Z");
    expect(period.endExclusive.toISOString()).toBe("2026-09-21T00:00:00.000Z");
    expect(period.startInstant.toISOString()).toBe("2026-09-13T21:00:00.000Z");
    expect(period.endInstant.toISOString()).toBe("2026-09-20T21:00:00.000Z");
    expect(resolveReportRange({ range: "7d" }, "Africa/Nairobi", now).to).toBe("2026-10-05");
  });

  it("does not assume DST trading days are 24 hours long", () => {
    const spring = resolveReportRange({ from: "2026-03-08", to: "2026-03-08" }, "America/New_York", now);
    expect(spring.days).toBe(1);
    expect((+spring.endInstant - +spring.startInstant) / 3600000).toBe(23);
    const fall = resolveReportRange({ from: "2025-11-02", to: "2025-11-02" }, "America/New_York", now);
    expect((+fall.endInstant - +fall.startInstant) / 3600000).toBe(25);
  });

  it("reports invalid, reversed, excessive and future spans instead of silently applying them", () => {
    for (const input of [
      { from: "2026-02-30", to: "2026-03-01" }, { from: "2026-09-20", to: "2026-09-14" },
      { from: "2024-01-01", to: "2026-01-01" }, { from: "2026-10-05", to: "2026-10-06" },
      { from: "2026-09-01" },
    ]) {
      const resolved = resolveReportRange(input, "Africa/Nairobi", now);
      expect(resolved.error).toBeTruthy();
      expect(resolved.custom).toBe(false);
      expect(resolved.days).toBe(30);
    }
  });

  it("keeps dates and class when switching report tabs", () => {
    expect(reportTabHref("performance", { from: period.from, to: period.to, class: "A" }))
      .toBe("/insights?tab=performance&class=A&from=2026-09-14&to=2026-09-20");
  });
});

describe("selected report range reaches database queries", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mock.products.findMany.mockResolvedValue([{ id: "sku", sku: "SKU", title: "Product", priceKes: 100, vendor: "Brand", customCategory: "Category", abcCategory: "A", currentStock: 5 }]);
    mock.metrics.mockResolvedValue(new Map());
    mock.config.findFirst.mockResolvedValue(null);
    mock.snapshots.findFirst.mockResolvedValue({ date: period.start });
    mock.sales.findMany.mockResolvedValue([]);
    mock.sales.groupBy.mockResolvedValue([{ productId: "sku", _sum: { revenueKes: 100, quantity: 1 } }]);
    mock.sales.aggregate.mockResolvedValue({ _sum: { revenueKes: 100 } });
    mock.asks.findMany.mockResolvedValue([]); mock.orders.findMany.mockResolvedValue([]); mock.po.findMany.mockResolvedValue([]);
    mock.snapshots.findMany.mockResolvedValue(Array.from({ length: 5 }, (_, i) => ({ date: new Date(+period.start + i * 86400000), onHand: 0, productId: "sku" })));
  });

  it("bounds top earners and category revenue on both ends", async () => {
    await getTopProducts("tenant", { period });
    await getRevenueBreakdown("tenant", { period });
    for (const [query] of mock.sales.groupBy.mock.calls) expect(query.where.date).toEqual({ gte: period.start, lt: period.endExclusive });
    const historyQuery = mock.sales.findMany.mock.calls[0]![0];
    expect(historyQuery.where.date.lt).toBeInstanceOf(Date); // current rate is explicitly current
  });

  it("compares selected revenue against the immediately preceding equal-length period", async () => {
    const result = await getOverviewKpis("tenant", { canViewCosts: false, period });
    expect(result.lastMonthRevenueKes).toBe(100);
    expect(mock.today).not.toHaveBeenCalled();
    expect(mock.sales.aggregate.mock.calls[0]![0].where.date).toEqual({ gte: period.start, lt: period.endExclusive });
    expect(mock.sales.aggregate.mock.calls[1]![0].where.date).toEqual({ gte: new Date("2026-09-07T00:00:00Z"), lt: period.start });
    expect(result.capitalAtCostKes).toBeNull();
  });

  it("bounds weekly snapshots and historical weekly sales rather than including later weeks", async () => {
    await getStockoutTrend("tenant", { period });
    await getPeriodMetrics("tenant", { period });
    for (const [query] of mock.snapshots.findMany.mock.calls) expect(query.where.date).toEqual({ gte: period.start, lt: period.endExclusive });
    expect(mock.sales.findMany.mock.calls[0]![0].where.date).toEqual({ gte: period.start, lt: period.endExclusive });
  });

  it("uses actual local-midnight UTC instants for order/adherence records", async () => {
    const result = await getPlanAdherence("tenant", { period });
    expect(result.windowDays).toBe(7);
    const boundary = { gte: period.startInstant, lt: period.endInstant };
    expect(mock.asks.findMany.mock.calls[0]![0].where.runDate).toEqual(boundary);
    expect(mock.orders.findMany.mock.calls[0]![0].where.createdAt).toEqual(boundary);
    expect(mock.po.findMany.mock.calls[0]![0].where.purchaseOrder.createdAt).toEqual(boundary);
  });

  it("does not widen a midweek selection back to Monday when loading weekly detail", async () => {
    const partial = resolveReportRange({ from: "2026-09-16", to: "2026-09-22" }, "Africa/Nairobi", now);
    mock.snapshots.findMany.mockResolvedValue(Array.from({ length: 5 }, (_, i) => ({ date: new Date(+partial.start + i * 86400000), onHand: 0, productId: "sku" })));
    await getPeriodMetrics("tenant", { period: partial });
    for (const [query] of mock.snapshots.findMany.mock.calls) expect(query.where.date).toEqual({ gte: partial.start, lt: partial.endExclusive });
    expect(mock.sales.findMany.mock.calls[0]![0].where.date).toEqual({ gte: partial.start, lt: partial.endExclusive });
  });
});
