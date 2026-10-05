import { beforeEach, describe, expect, it, vi } from "vitest";
const { tx, tenantTx } = vi.hoisted(() => {
  const tx = {
    product: { findFirst: vi.fn(), findMany: vi.fn() },
    forecastRecommendation: { findMany: vi.fn() }, order: { findMany: vi.fn() },
    purchaseOrderLine: { findMany: vi.fn() }, salesHistory: { findMany: vi.fn() },
    inventorySnapshot: { findMany: vi.fn() },
  };
  return { tx, tenantTx: vi.fn(async (_tenantId: string, fn: (db: typeof tx) => unknown) => fn(tx)) };
});
vi.mock("@wezesha/db", () => ({ prismaForTenantTx: tenantTx }));
import { getProductTimeline, searchTimelineProducts } from "../lib/data/product-timeline";
const now = new Date("2026-10-05T12:00:00Z");
beforeEach(() => {
  vi.clearAllMocks();
  tx.product.findFirst.mockResolvedValue({ id: "sku", sku: "SKU", title: "Product" });
  for (const table of [tx.forecastRecommendation, tx.order, tx.purchaseOrderLine, tx.salesHistory, tx.inventorySnapshot]) table.findMany.mockResolvedValue([]);
});
describe("product report history", () => {
  it("does not query another product's history when tenant-scoped lookup finds nothing", async () => {
    tx.product.findFirst.mockResolvedValue(null);
    expect(await getProductTimeline("tenant-a","foreign","Africa/Nairobi",now)).toBeNull();
    expect(tenantTx).toHaveBeenCalledWith("tenant-a",expect.any(Function),expect.any(Object));
    expect(tx.salesHistory.findMany).not.toHaveBeenCalled();
  });
  it("shows original recommendations, daily channels and receipts in descending order without invented deliveries", async () => {
    tx.forecastRecommendation.findMany.mockResolvedValue([{id:"f",runDate:new Date("2026-10-01"),recommendedQty:7,finalForecast30d:20,onHandAtRun:1}]);
    tx.salesHistory.findMany.mockResolvedValue([{id:"s",date:new Date("2026-10-02"),quantity:2,channel:"pos"}]);
    tx.purchaseOrderLine.findMany.mockResolvedValue([{id:"p",quantity:20,receivedQty:12,receivedAt:new Date("2026-10-03"),purchaseOrder:{poNumber:"PO-1",createdAt:new Date("2025-01-01"),sentAt:null,status:"partially_received",createdByName:"Owner"}}]);
    const result=await getProductTimeline("tenant-a","sku","Africa/Nairobi",now);
    expect(result!.events.map(e=>e.id)).toEqual(["received-p","sale-s","forecast-f"]);
    expect(result!.events[0]).toMatchObject({qty:12,detail:"Cumulative units received on this line"});
    expect(result!.events[2]).toMatchObject({qty:7});
    expect(JSON.stringify(result)).not.toContain("costKes");
    expect(tx.salesHistory.findMany).toHaveBeenCalledWith(expect.objectContaining({where:{productId:"sku",date:{gte:new Date("2025-10-06T00:00:00Z"),lt:new Date("2026-10-06T00:00:00Z")}}}));
    expect(tx.purchaseOrderLine.findMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({OR:expect.arrayContaining([{purchaseOrder:{sentAt:{gte:new Date("2025-10-05T12:00:00Z"),lte:now}}}])})}));
  });
  it("bounds the rendered/exported event set and reports truncation", async () => {
    tx.salesHistory.findMany.mockResolvedValue(Array.from({length:1001},(_,i)=>({id:String(i),date:new Date("2026-10-01"),quantity:1,channel:"pos"})));
    const result=await getProductTimeline("tenant-a","sku","Africa/Nairobi",now);
    expect(result!.events).toHaveLength(1000);
    expect(result!.truncated).toBe(true);
  });
  it("includes today's local sales/snapshot markers before Nairobi midnight reaches UTC", async () => {
    const early = new Date("2026-10-04T22:00:00Z");
    tx.salesHistory.findMany.mockResolvedValue([{id:"today",date:new Date("2026-10-05"),quantity:2,channel:"pos"}]);
    tx.inventorySnapshot.findMany.mockResolvedValue([{id:"empty",date:new Date("2026-10-05"),onHand:0}]);
    tx.forecastRecommendation.findMany.mockResolvedValue([{id:"future",runDate:new Date("2026-10-05T01:00:00Z"),recommendedQty:7,finalForecast30d:20,onHandAtRun:1}]);
    const result=await getProductTimeline("tenant-a","sku","Africa/Nairobi",early);
    expect(result!.events.map(e=>e.id).sort()).toEqual(["empty-empty","sale-today"]);
  });
  it("searches title and SKU only within the supplied tenant and skips blank searches", async () => {
    expect(await searchTimelineProducts("tenant-a","  ")).toEqual([]);
    expect(tenantTx).not.toHaveBeenCalled();
    tx.product.findMany.mockResolvedValue([]);
    await searchTimelineProducts("tenant-a","  SKU  ");
    expect(tenantTx).toHaveBeenCalledWith("tenant-a",expect.any(Function));
    expect(tx.product.findMany).toHaveBeenCalledWith(expect.objectContaining({take:10,where:{OR:[{title:{contains:"SKU",mode:"insensitive"}},{sku:{contains:"SKU",mode:"insensitive"}}]}}));
  });
});
