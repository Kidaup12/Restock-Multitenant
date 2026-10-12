/** Characterization tests: these assert the observed bugs, not desired behaviour. */
import { beforeEach, describe, expect, it, vi } from "vitest";
const { state } = vi.hoisted(() => ({ state: { raw: [] as Record<string, any>[], lines: [] as Record<string, any>[], daily: [] as Record<string, any>[] } }));
vi.mock("@wezesha/db", () => ({ prismaService: {
  tenant: { findUnique: async () => ({ timezone: "Africa/Nairobi" }) },
  product: { findMany: async () => [{ id: "product", sku: "sku", priceKes: 100 }] },
  ignoreRule: { findMany: async () => [] },
  warehouseLocationMap: { findMany: async () => [] },
  posSale: {
    deleteMany: async ({ where }: any) => {
      const removed = new Set(state.raw.filter(r => where.externalId.in.includes(r.externalId)).map(r => r.id));
      state.raw = state.raw.filter(r => !removed.has(r.id));
      state.lines = state.lines.filter(r => !removed.has(r.posSaleId));
    },
    createMany: async ({ data }: any) => { state.raw.push(...data); },
  },
  posSaleLine: {
    findMany: async () => state.lines,
    createMany: async ({ data }: any) => { state.lines.push(...data); },
  },
  salesHistory: {
    deleteMany: async ({ where }: any) => {
      state.daily = state.daily.filter(r => !where.OR.some((k: any) => k.productId === r.productId && +k.date === +r.date));
    },
    createMany: async ({ data }: any) => { state.daily.push(...data); },
  },
} }));
import { ingestPosSales } from "../../packages/pos/src/ingest";
import { bucketSalesByProductDay } from "../../packages/shopify/src/sales";

beforeEach(() => { state.raw = []; state.lines = []; state.daily = []; });
const receipt = (externalId: string, qty: number, date = "2026-10-01 12:00:00") => ({ externalId, date, lines: [{ sku: "sku", qty }] });

describe("input audit: observed writer behaviour with in-memory persistence", () => {
  it("partial POS replay reduces a full day from 12 to 2 despite 12 raw units remaining", async () => {
    const a = receipt("a", 10), b = receipt("b", 2);
    await ingestPosSales({ tenantId: "tenant", sales: [a, b] });
    expect(state.daily[0].quantity).toBe(12);
    await ingestPosSales({ tenantId: "tenant", sales: [b] });
    expect(state.lines.reduce((sum, r) => sum + r.qty, 0)).toBe(12);
    expect(state.daily[0].quantity).toBe(2);
    console.log("POS partial replay: raw units=12, derived units=2 (83.33% undercount)");
  });
  it("moving a receipt to a corrected day leaves the previous day's derived sale behind", async () => {
    await ingestPosSales({ tenantId: "tenant", sales: [receipt("a", 10)] });
    await ingestPosSales({ tenantId: "tenant", sales: [receipt("a", 10, "2026-10-02 12:00:00")] });
    expect(state.lines.reduce((sum, r) => sum + r.qty, 0)).toBe(10);
    expect(state.daily.reduce((sum, r) => sum + r.quantity, 0)).toBe(20);
    console.log("POS corrected date: raw units=10, derived units=20 (100% overcount)");
  });
  it("changing a physical receipt to online leaves the old physical receipt and derived sale", async () => {
    await ingestPosSales({ tenantId: "tenant", sales: [receipt("a", 10)] });
    await ingestPosSales({ tenantId: "tenant", sales: [{ ...receipt("a", 10), channel: "shopify" }] });
    expect(state.raw).toHaveLength(1);
    expect(state.daily[0].quantity).toBe(10);
    console.log("POS physical-to-online correction: old 10-unit physical sale remains");
  });
  it("a fully refunded Shopify line yields no bucket to clear a previously stored day", () => {
    const order = { id: "order", createdAt: "2026-10-01T10:00:00Z", lineItems: [{ id: "line", product: { id: "1" }, quantity: 3, originalUnitPriceSet: { shopMoney: { amount: "100" } } }] };
    const map = new Map([["1", "product"]]);
    const day = (d: Date) => d.toISOString().slice(0, 10);
    expect([...bucketSalesByProductDay([order], map, day).values()][0].quantity).toBe(3);
    expect(bucketSalesByProductDay([{ ...order, refunds: [{ refundLineItems: [{ quantity: 3, lineItem: { id: "line" } }] }] }], map, day).size).toBe(0);
    // syncOrders returns early for this empty result (apps/worker/src/shopify-sync.ts).
    console.log("Shopify full refund: initial bucket=3; correction emits zero buckets; writer has an empty-bucket early return");
  });
  it("an updated-order subset cannot reconstruct a full historical Shopify sales day", () => {
    const order = (id: string, quantity: number) => ({ id, createdAt: "2026-10-01T10:00:00Z", lineItems: [{ product: { id: "1" }, quantity, originalUnitPriceSet: { shopMoney: { amount: "100" } } }] });
    const map = new Map([["1", "product"]]);
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const full = [...bucketSalesByProductDay([order("unchanged", 10), order("changed", 2)], map, day).values()];
    const delta = [...bucketSalesByProductDay([order("changed", 1)], map, day).values()];
    expect(full[0].quantity).toBe(12);
    expect(delta[0].quantity).toBe(1);
    // fetchOrdersSince selects updated_at >= cursor, while syncOrders replaces
    // the complete product/day. Correct full-day quantity would be 10 + 1 = 11.
    console.log("Shopify updated-order subset: writer input=1 unit; full corrected day=11 units");
  });
});
