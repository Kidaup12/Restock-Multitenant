import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ tenant: vi.fn(), sales: vi.fn() }));
vi.mock("@wezesha/db", () => ({ BUYABLE_PRODUCT_WHERE: { active: true }, isSellable: vi.fn(),
  prismaForTenant: () => ({ tenant: { findUnique: mocks.tenant }, salesHistory: { findMany: mocks.sales },
    promo: { findMany: async () => [] }, ignoreRule: { findMany: async () => [] },
    product: { findMany: async () => [{ id: "p1", sku: "SER", title: "Serum", vendor: null, productType: null }] },
  }),
}));
vi.mock("@wezesha/pos", async () => await import("../../../packages/pos/src/time"));
import { getSpikeSuggestions } from "../lib/data/signals";

beforeEach(() => vi.clearAllMocks());

describe("sales review uses the tenant's trading day", () => {
  it.each([
    ["Africa/Nairobi", "2026-10-04T21:30:00Z", "2026-10-05"],
    ["America/New_York", "2026-10-05T01:30:00Z", "2026-10-04"],
  ])("flags today's accumulated sale in %s", async (timezone, instant, todayKey) => {
    mocks.tenant.mockResolvedValue({ timezone });
    const today = new Date(`${todayKey}T00:00:00Z`);
    const rows = [
      ...Array.from({ length: 20 }, (_, i) => ({ productId: "p1", date: new Date(+today - (i + 1) * 86_400_000), quantity: 1, revenueKes: 100 })),
      { productId: "p1", date: today, quantity: 7, revenueKes: 700 },
      { productId: "p1", date: new Date(+today + 86_400_000), quantity: 100, revenueKes: 10_000 },
    ];
    mocks.sales.mockImplementation(async ({ where }: { where: { date: { gte: Date; lte: Date } } }) =>
      rows.filter(row => row.date >= where.date.gte && row.date <= where.date.lte));
    const now = new Date(instant);
    const result = await getSpikeSuggestions("t1", now);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ dayKey: todayKey, quantity: 7, kind: "possible_bulk", inProgress: true });
    expect(mocks.sales).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ date: { gte: new Date(+today - 365 * 86_400_000), lte: today } }) }));
    expect(mocks.tenant).toHaveBeenCalledWith({ where: { id: "t1" }, select: { timezone: true } });
    expect(now.toISOString()).toBe(new Date(instant).toISOString());
  });
});
