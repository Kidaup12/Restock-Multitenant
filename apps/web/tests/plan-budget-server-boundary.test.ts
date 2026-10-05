import { describe, expect, it, vi } from "vitest";

// Model the RSC boundary: the action must never execute exports of this component.
vi.mock("../app/(shell)/plan/scope-bar", () => { throw new Error("Client module imported on server"); });
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@wezesha/db", () => ({ Prisma: {}, prismaForTenant: vi.fn(), prismaService: {} }));
vi.mock("@/lib/auth", () => ({
  requireSession: async () => ({ user: { id: "user" } }),
  activeMembership: async () => ({ tenantId: "shop", tenant: { currency: "KES" } }),
}));
vi.mock("@/lib/auth/permissions", () => ({ hasPermission: () => true }));
vi.mock("@/lib/capabilities", () => ({
  getTenantFeatureOverrides: async () => ({}), getTenantPlan: async () => "starter",
  planAllows: () => true, planFeatureTier: () => "starter", PLAN_TIER_LABEL: { starter: "Starter" },
}));
const { allocate } = vi.hoisted(() => ({ allocate: vi.fn<(rows: unknown[], budget: number, options: unknown) => { funded: unknown[] }>(() => ({ funded: [] })) }));
vi.mock("@/lib/data/plan", () => ({
  getBuyList: async () => ({ rows: [
    { predictionId: "a", abc: "A", leadDays: 3 },
    { predictionId: "b", abc: "B", leadDays: 30 },
  ], excluded: [] }),
  splitByBudget: allocate, redactBudgetSplit: (x: unknown) => x,
}));
import { planBudget } from "../app/(shell)/plan/actions";

describe("budget action server boundary", () => {
  it("allocates only the requested class and lead band without importing client code", async () => {
    const result = await planBudget({ budgetKes: 500, scope: { abc: ["A"], category: [], supplier: [], leadBand: ["fast"] } });
    expect(result.ok).toBe(true);
    expect(allocate).toHaveBeenLastCalledWith([{ predictionId: "a", abc: "A", leadDays: 3 }], 500, { strict: true, heldBackCount: 0 });
  });
  it("accepts an empty scope and allocates across the whole shop", async () => {
    await planBudget({ budgetKes: 500 });
    expect(allocate.mock.calls.at(-1)?.[0]).toHaveLength(2);
  });
});
