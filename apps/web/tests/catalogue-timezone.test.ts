import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ tenant: vi.fn(), sales: vi.fn(), snapshot: vi.fn() }));
vi.mock("@wezesha/db", () => ({ prismaForTenant: () => ({
  product: { findMany: async () => [{ id: "p1", currentStock: 20, costKes: 10, abcCategory: "A" }] },
  salesHistory: { findMany: mocks.sales },
  inventorySnapshot: { findMany: async () => [], findFirst: mocks.snapshot },
  tenantConfig: { findFirst: async () => ({ baselineMethod: "mean", bigBuyerDamping: false }) },
  tenant: { findUnique: mocks.tenant },
}) }));
vi.mock("@wezesha/pos", async () => await import("../../../packages/pos/src/time"));
import { getCatalogueMetrics } from "../lib/metrics/catalogue";
import { revenueByWindow, runRate } from "../lib/metrics/calc";

beforeEach(() => vi.clearAllMocks());

describe("catalogue rates follow completed tenant trading days", () => {
  it.each([
    ["Africa/Nairobi", "2026-10-04T21:30:00Z", "2026-10-05"],
    ["America/New_York", "2026-10-05T01:30:00Z", "2026-10-04"],
  ])("keeps fitting and revenue boundaries distinct in %s", async (timezone, instant, key) => {
    const asOf = new Date(instant);
    const day = new Date(`${key}T00:00:00Z`);
    const completed = Array.from({ length: 365 }, (_, i) => ({
      productId: "p1", date: new Date(+day - (i + 1) * 86400000), quantity: i === 0 ? 20 : 1,
      revenueKes: 100, channel: "pos",
    }));
    const rows = [...completed, { productId: "p1", date: day, quantity: 1000, revenueKes: 100000, channel: "pos" }];
    mocks.tenant.mockResolvedValue({ timezone });
    mocks.snapshot.mockResolvedValue({ date: completed[364]!.date });
    mocks.sales.mockImplementation(async ({ where }: { where: { date: { gte: Date } } }) =>
      rows.filter(row => row.date >= where.date.gte));
    const metrics = (await getCatalogueMetrics("t1", { asOf })).get("p1")!;
    expect(metrics.runRate).toBe(runRate(completed, day, [], completed[364]!.date));
    expect(metrics.runRate).not.toBe(runRate(rows, asOf, [], completed[364]!.date));
    expect(metrics.revenueKes).toEqual(revenueByWindow(rows, asOf));
    expect(asOf.toISOString()).toBe(new Date(instant).toISOString());
    expect(mocks.tenant).toHaveBeenCalledWith({ where: { id: "t1" }, select: { timezone: true } });
  });
});
