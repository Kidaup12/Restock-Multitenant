import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PosSaleInput } from "../src/types";

const memory = vi.hoisted(() => ({ sales: [] as any[], lines: [] as any[], history: [] as any[], products: [] as any[], ignores: [] as any[], fail: false, locks: 0 }));
vi.mock("@wezesha/db", () => {
  const scoped = (row: any, where: any) => row.tenantId === where.tenantId;
  const db: any = {
    tenant: { findUnique: async () => ({ timezone: "Africa/Nairobi" }) },
    product: { findMany: async ({ where }: any) => memory.products.filter(p => scoped(p, where)) },
    ignoreRule: { findMany: async () => memory.ignores },
    warehouseLocationMap: { findMany: async () => [{ warehouseName: "A", locationId: "loc-a" }, { warehouseName: "B", locationId: "loc-b" }] },
    $executeRaw: async () => { memory.locks++; },
    posSale: {
      findMany: async ({where}: any) => memory.sales.filter(s => scoped(s,where) && where.externalId.in.includes(s.externalId)),
      deleteMany: async ({where}: any) => { const ids = memory.sales.filter(s => scoped(s,where) && where.externalId.in.includes(s.externalId)).map(s => s.id); memory.sales = memory.sales.filter(s => !ids.includes(s.id)); memory.lines = memory.lines.filter(l => !ids.includes(l.posSaleId)); },
      createMany: async ({data}: any) => { memory.sales.push(...data); },
    },
    posSaleLine: {
      findMany: async ({where}: any) => memory.lines.filter(l => {
        if (!scoped(l,where)) return false;
        if (!where.posSale) return l.productId !== null;
        const s = memory.sales.find(s => s.id === l.posSaleId);
        return s && scoped(s,where.posSale) && s.channel === where.posSale.channel && s.date >= where.posSale.date.gte && s.date < where.posSale.date.lt;
      }).map(l => ({...l, posSale: memory.sales.find(s => s.id === l.posSaleId)})),
      createMany: async ({data}: any) => { memory.lines.push(...data); },
    },
    salesHistory: {
      deleteMany: async ({where}: any) => { memory.history = memory.history.filter(h => !(scoped(h,where) && h.channel === where.channel && where.date.in.some((d: Date) => +d === +h.date))); },
      createMany: async ({data}: any) => { if (memory.fail) throw new Error("derived insert failed"); memory.history.push(...data); },
    },
  };
  db.$transaction = async (fn: any) => {
    const before = structuredClone({sales: memory.sales, lines: memory.lines, history: memory.history});
    try { return await fn(db); } catch (error) { Object.assign(memory,before); throw error; }
  };
  return { prismaService: db };
});
import { healPosRollup, ingestPosSales } from "../src/ingest";

const sale = (id: string, qty = 1, extra: Partial<PosSaleInput> = {}): PosSaleInput => ({ externalId: id, date: "2026-10-04 23:30:00", warehouse: "A", lines: [{sku:"SKU",qty}], ...extra });
const ingest = (...sales: PosSaleInput[]) => ingestPosSales({tenantId:"tenant",sales});
beforeEach(() => { Object.assign(memory,{sales:[],lines:[],history:[],products:[{tenantId:"tenant",id:"product",sku:"SKU",priceKes:100}],ignores:[],fail:false,locks:0}); });

describe("complete POS ledger rollups", () => {
  it("retains unresent receipts in partial batches, deduplicates resends and preserves mixed branch attribution", async () => {
    await ingest(sale("one",2),sale("two",3,{warehouse:"B"}));
    await ingest(sale("one",1),sale("one",4));
    expect(memory.history).toMatchObject([{quantity:7,revenueKes:700,locationId:null}]);
    expect(memory.sales).toHaveLength(2);
  });
  it("clears old days and removed product lines when receipt dates or SKUs change", async () => {
    await ingest(sale("one",2));
    await ingest(sale("one",3,{date:"2026-10-05 00:10:00"}));
    expect(memory.history).toHaveLength(1);
    expect(memory.history[0].date.toISOString()).toBe("2026-10-05T00:00:00.000Z");
    await ingest(sale("one",1,{date:"2026-10-05 00:10:00",lines:[{sku:"UNKNOWN",qty:1}]}));
    expect(memory.history).toEqual([]);
  });
  it("removes a physical receipt corrected to online without changing Shopify history", async () => {
    await ingest(sale("one",2));
    memory.history.push({tenantId:"tenant",channel:"shopify",date:new Date("2026-10-04"),quantity:9});
    await ingest(sale("one",2,{channel:"online"}));
    expect(memory.sales).toEqual([]);
    expect(memory.history).toMatchObject([{channel:"shopify",quantity:9}]);
  });
  it("heals historical shortages and newly matchable SKUs; honors ignores and other tenants", async () => {
    await ingest(sale("one",2,{lines:[{sku:"LATER",qty:2}]}));
    memory.products.push({tenantId:"tenant",id:"later",sku:"LATER",priceKes:50});
    memory.history.push({tenantId:"other",channel:"pos",date:new Date("2026-10-04"),quantity:99});
    await healPosRollup("tenant",3,new Date("2026-10-05T12:00:00Z"));
    expect(memory.history.find(h=>h.tenantId==='tenant')).toMatchObject({quantity:2,revenueKes:100});
    memory.ignores.push({value:"LATER"});
    await healPosRollup("tenant",3,new Date("2026-10-05T12:00:00Z"));
    expect(memory.history).toMatchObject([{tenantId:"other",quantity:99}]);
  });
  it("keeps learned human aliases and revenue fallback", async () => {
    await ingest(sale("one",1,{lines:[{sku:"ALIAS",qty:2,price:80}]}));
    memory.lines[0].productId="product";
    await ingest(sale("one",1,{lines:[{sku:"ALIAS",qty:3,price:80}]}));
    expect(memory.history).toMatchObject([{productId:"product",quantity:3,revenueKes:240,locationId:"loc-a"}]);
  });
  it("rolls raw and derived writes back together when rebuilding fails", async () => {
    await ingest(sale("one",2));
    const before=structuredClone({sales:memory.sales,lines:memory.lines,history:memory.history});
    memory.fail=true;
    await expect(ingest(sale("one",9))).rejects.toThrow("derived insert failed");
    expect({sales:memory.sales,lines:memory.lines,history:memory.history}).toEqual(before);
    expect(memory.locks).toBe(2);
  });
});
