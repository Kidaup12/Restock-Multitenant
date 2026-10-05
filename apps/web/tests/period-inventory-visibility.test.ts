import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("@wezesha/db", () => ({ prismaForTenantTx: mocks.transaction }));
import { getPeriodInventory } from "../lib/data/period-inventory";
import { resolveReportRange } from "../lib/data/report-range";

describe("period inventory loader cost visibility", () => {
  it("redacts cost summaries and every drill row while preserving quantities", async () => {
    mocks.transaction.mockImplementation(async (_tenant: string, work: (tx: unknown) => Promise<unknown>) => work({
      tenant: { findUnique: async () => ({ timezone: "Africa/Nairobi" }) },
      tenantConfig: { findFirst: async () => ({ deadStockWindowDays: 30 }) },
      product: { findMany: async () => [
        { id: "moving", sku: "M", title: "Moving", abcCategory: "A", costKes: 10 },
        { id: "dead", sku: "D", title: "Dead", abcCategory: "B", costKes: 10 },
      ] },
      salesHistory: {
        findMany: async () => [{ productId: "moving", date: new Date("2026-10-01"), quantity: 7 }],
        groupBy: async () => ["moving", "dead"].map(productId => ({ productId, _min: { date: new Date("2026-01-01") } })),
      },
      inventorySnapshot: { findMany: async () => [
        { productId: "moving", date: new Date("2026-10-04"), onHand: 100 },
        { productId: "dead", date: new Date("2026-10-04"), onHand: 5 },
      ] },
      purchaseOrderLine: { findMany: async () => [{ productId: "moving", quantity: 12, recommendedQty: 8, unitCostKes: 7, lineTotalKes: 84,
        purchaseOrder: { sentAt: new Date("2026-10-01T10:00:00Z"), createdAt: new Date("2026-10-01T09:00:00Z") } }] },
    }));
    const period = resolveReportRange({ from: "2026-09-28", to: "2026-10-04" }, "Africa/Nairobi", new Date("2026-10-05"));
    const options = { weeks: 1, abc: "all" as const, period };
    const owner = await getPeriodInventory("tenant-proof", { ...options, canViewCosts: true });
    const blind = await getPeriodInventory("tenant-proof", { ...options, canViewCosts: false });
    expect(owner.rows[0]).toMatchObject({ orderedValueKes: 84, overorderValueKes: 28, deadValueKes: 50, overstockValueKes: 100 });
    expect(blind.rows[0]).toMatchObject({ orderedUnits: 12, overorderUnits: 4, deadCount: 1, overstockCount: 1 });
    expect(new Set(blind.rows[0]!.details.map(d => d.kind)).size).toBe(4);
    function assertRedacted(value: unknown): void {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (key.endsWith("Kes")) expect(child, key).toBeNull();
        else assertRedacted(child);
      }
    }
    assertRedacted(blind);
    expect(mocks.transaction).toHaveBeenCalledWith("tenant-proof", expect.any(Function), expect.any(Object));
  });
});
