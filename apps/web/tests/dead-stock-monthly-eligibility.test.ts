import { afterEach, describe, expect, it, vi } from "vitest";
const data = vi.hoisted(() => ({ snapshots: vi.fn(), products: vi.fn(), sales: vi.fn(), firstSales: vi.fn() }));
vi.mock("@wezesha/db", () => ({ BUYABLE_PRODUCT_WHERE: {}, prismaForTenant: () => ({
  tenantConfig: { findFirst: async () => ({deadStockWindowDays:90}) },
  inventorySnapshot: { findMany: data.snapshots, findFirst: async () => ({date:new Date("2026-07-01")}) },
  product:{findMany:data.products}, salesHistory:{findMany:data.sales,groupBy:data.firstSales},
}) }));
vi.mock("@wezesha/forecast-run",()=>({AS_SHOWN_TAG:"shown"}));
vi.mock("../lib/metrics",()=>({getCatalogueMetrics:vi.fn()}));
vi.mock("../lib/data/today",()=>({DEFAULT_DEAD_STOCK_DAYS:90,getTodayMetrics:vi.fn(),pileFor:vi.fn()}));
vi.mock("../lib/data/stock",()=>({getStockCatalogue:vi.fn()}));
import { getDeadStockByMonth } from "../lib/data/insights";
afterEach(()=>vi.useRealTimers());
describe("monthly eligibility loader",()=>{
  it("keeps full-window observations but reports only requested months and excludes new/just-restocked stock",async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
    const endpoint=new Date("2026-10-05");
    const products=[{id:"quiet",costKes:100,abcCategory:"A",shopifyCreatedAt:new Date("2025-01-01"),receivedAt:null},{id:"new",costKes:500,abcCategory:"B",shopifyCreatedAt:new Date("2026-09-20"),receivedAt:null},{id:"restocked",costKes:1000,abcCategory:"C",shopifyCreatedAt:new Date("2025-01-01"),receivedAt:null}];
    data.products.mockResolvedValue(products);data.sales.mockResolvedValue([]);
    data.firstSales.mockResolvedValue([{productId:"quiet",_min:{date:new Date("2025-06-01")}},{productId:"restocked",_min:{date:new Date("2025-06-01")}}]);
    data.snapshots.mockResolvedValue(products.flatMap(p=>Array.from({length:14},(_,d)=>({productId:p.id,date:new Date(+endpoint-d*86400000),onHand:p.id==="restocked"&&d>1?0:10}))));
    const result=await getDeadStockByMonth("tenant",{months:1,canViewCosts:true});
    expect(result.months).toHaveLength(1);expect(result.months[0]).toMatchObject({skus:1,costKes:1000,byClass:{a:1,b:0,c:0,unrated:0}});
    expect(data.snapshots.mock.calls[0][0].where.date.gte).toEqual(new Date("2026-07-03"));
    const member=await getDeadStockByMonth("tenant",{months:1,canViewCosts:false});expect(member.months[0].costKes).toBeNull();
  });
});
