import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  products: [] as Record<string, unknown>[],
  recs: [] as Record<string, unknown>[],
  notifications: [] as Record<string, unknown>[],
  spentUsd: 0,
}));

vi.mock("../src/owner-report", () => ({ latestForecastRunId: async () => "run" }));
vi.mock("@wezesha/db", () => ({
  BUYABLE_PRODUCT_WHERE: {},
  CUSTOMER_TENANTS_WHERE: {},
  prismaService: {
    tenantConfig: { findFirst: async () => ({ deadStockWindowDays: 90 }) },
    product: { findMany: async () => db.products },
    salesHistory: { groupBy: async () => [{ productId: "dead", _max: { date: new Date("2026-06-01") } }] },
    inventorySnapshot: { groupBy: async () => [] },
    prediction: { findMany: async () => [{ productId: "dead", layer1Forecast30d: 0, recommendedQty: 4 }] },
    productPlanOverride: { findMany: async () => [] },
    stockRecommendation: {
      findMany: async () => db.recs.map((r) => ({ ...r })),
      create: async ({ data }: { data: Record<string, unknown> }) => { db.recs.push({ id: `r${db.recs.length}`, snoozedUntil: null, aiReason: null, ...data }); },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        for (const r of db.recs) {
          const ids = (where.id as { in?: string[] } | string | undefined);
          const match = typeof ids === "string" ? r.id === ids : ids?.in ? ids.in.includes(r.id as string)
            : (where.productId == null || r.productId === where.productId) && (where.action == null || r.action === where.action);
          if (match) Object.assign(r, data);
        }
      },
    },
    aiUsage: {
      findUnique: async () => (db.spentUsd ? { costUsd: db.spentUsd } : null),
      upsert: async ({ create }: { create: { costUsd: number } }) => { db.spentUsd += create.costUsd; },
    },
    notification: { create: async ({ data }: { data: Record<string, unknown> }) => { db.notifications.push(data); } },
  },
}));

const { runTenantRecommendations } = await import("../src/recommendations-cron");
const now = new Date("2026-11-05T06:30:00Z");
const noWording = async () => new Map();

beforeEach(() => {
  db.recs.length = 0;
  db.notifications.length = 0;
  db.spentUsd = 0;
  db.products = [{ id: "dead", title: "Old Lotion", abcCategory: "C", customCategory: "Body", currentStock: 10, costKes: 500, priceKes: 1000, shopifyCreatedAt: new Date("2025-01-01"), receivedAt: null }];
});

describe("nightly stock recommendations", () => {
  it("hands the wording step this month's remaining budget and records what it spent", async () => {
    db.spentUsd = 4.9;
    let seen = -1;
    await runTenantRecommendations("t", null, now, async (_items, opts) => {
      seen = opts?.remainingUsd ?? -1;
      await opts?.onUsage?.({ costUsd: 0.002, inputTokens: 1000, outputTokens: 500 });
      return new Map();
    });
    expect(seen).toBeCloseTo(0.1);
    expect(db.spentUsd).toBeCloseTo(4.902);
  });
  it("opens recommendations for dead stock and rings the bell once, with no cash in the title", async () => {
    const r = await runTenantRecommendations("t", null, now, noWording);
    expect(r.opened).toBe(2); // skip the planned reorder + discount
    expect(db.recs.map((x) => x.action).sort()).toEqual(["discount", "stop_reorder"]);
    expect(db.notifications).toHaveLength(1);
    expect(db.notifications[0]).toMatchObject({ kind: "stock_recommendations", title: "2 new stock recommendations", href: "/recommendations" });
    expect(String(db.notifications[0]!.title)).not.toMatch(/KES|\d{3,}/);
  });

  it("updates in place the next night without ringing again", async () => {
    await runTenantRecommendations("t", null, now, noWording);
    const r = await runTenantRecommendations("t", null, now, noWording);
    expect(r.opened).toBe(0);
    expect(db.recs).toHaveLength(2);
    expect(db.notifications).toHaveLength(1);
  });

  it("keeps a dismissed one quiet until its snooze ends, then reopens it", async () => {
    await runTenantRecommendations("t", null, now, noWording);
    for (const x of db.recs) Object.assign(x, { status: "dismissed", snoozedUntil: new Date("2026-12-01") });
    expect((await runTenantRecommendations("t", null, now, noWording)).opened).toBe(0);
    expect((await runTenantRecommendations("t", null, new Date("2026-12-02"), noWording)).opened).toBe(2);
  });

  it("resolves an open one that no longer applies", async () => {
    await runTenantRecommendations("t", null, now, noWording);
    db.products = [{ ...db.products[0]!, currentStock: 0 }];
    const r = await runTenantRecommendations("t", null, now, noWording);
    expect(r.resolved).toBe(2);
    expect(db.recs.every((x) => x.status === "resolved")).toBe(true);
  });

  it("stores AI wording only for what the wording step returned", async () => {
    await runTenantRecommendations("t", null, now, async () => new Map([["dead|discount", { reason: "Try 20% off.", idea: "Gift with a mist." }]]));
    expect(db.recs.find((x) => x.action === "discount")).toMatchObject({ aiReason: "Try 20% off.", aiIdea: "Gift with a mist." });
    expect(db.recs.find((x) => x.action === "stop_reorder")!.aiReason).toBeNull();
  });
});
