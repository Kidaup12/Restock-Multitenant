import { describe, expect, it, vi } from "vitest";

const rows = [
  { id: "a", productId: "p1", action: "discount", reason: "rule a", aiReason: "AI a", aiIdea: "idea", cashKes: 5000, idleUnits: 10, payload: { pct: 20 }, firstSeenAt: new Date(),
    product: { title: "Lotion", sku: "L1", abcCategory: "C", customCategory: "Body", currentStock: 10, supplier: { name: "BBW" } } },
  { id: "b", productId: "p1", action: "stop_reorder", reason: "rule b", aiReason: null, aiIdea: null, cashKes: 3000, idleUnits: 10, payload: { plannedQty: 6 }, firstSeenAt: new Date(),
    product: { title: "Lotion", sku: "", abcCategory: "C", customCategory: "Body", currentStock: 10, supplier: null } },
];
vi.mock("@wezesha/db", () => ({
  prismaForTenant: () => ({
    stockRecommendation: { findMany: async () => rows, findFirst: async () => ({ updatedAt: new Date("2026-11-05") }) },
  }),
}));
const { getRecommendations } = await import("../lib/data/recommendations");

describe("recommendations data", () => {
  it("uses AI wording when present, the rule's otherwise", async () => {
    const list = await getRecommendations("t", { canViewCosts: true });
    expect(list.rows.map((r) => r.reason)).toEqual(["AI a", "rule b"]);
    expect(list.rows[0]!.aiWorded).toBe(true);
    expect(list.rows[1]!.sku).toBeNull();
  });
  it("counts skipped reorders apart from cash tied up", async () => {
    const list = await getRecommendations("t", { canViewCosts: true });
    expect(list.totalCashKes).toBe(5000);
    expect(list.counts).toMatchObject({ discount: 1, stop_reorder: 1 });
  });
  it("hides every cost figure from a member who can't see costs", async () => {
    const list = await getRecommendations("t", { canViewCosts: false });
    expect(list.totalCashKes).toBeNull();
    expect(list.rows.every((r) => r.cashKes === null)).toBe(true);
  });
});
