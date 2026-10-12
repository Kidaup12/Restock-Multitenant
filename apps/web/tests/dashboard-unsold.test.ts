import { afterEach, describe, expect, it, vi } from "vitest";
const mock=vi.hoisted(()=>({catalogue:vi.fn(),ages:vi.fn(),lastSales:vi.fn(),observed:vi.fn()}));
vi.mock("@wezesha/db",()=>({BUYABLE_PRODUCT_WHERE:{active:true},prismaForTenant:()=>({salesHistory:{groupBy:mock.lastSales},tenantConfig:{findFirst:async()=>({deadStockWindowDays:60})},product:{findMany:mock.ages}})}));
vi.mock("../lib/data/stock",()=>({getStockCatalogue:mock.catalogue}));
vi.mock("../lib/data/plan",()=>({getBuyList:async()=>null,byBuyListPriority:()=>0}));
vi.mock("../lib/data/stock-observation",()=>({observedInStockDays:mock.observed}));
vi.mock("../lib/metrics",()=>({moneyAtRest:(cost:number,stock:number)=>cost*Math.max(0,stock)}));
import {getDashboardTable} from "../lib/data/today";
afterEach(()=>vi.useRealTimers());
function setup(){
  vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
  const ids=["new","old","unknown","restocked","selling","empty","archived",...Array.from({length:30},(_,i)=>`new-${i}`)];
  mock.catalogue.mockImplementation(async(_tenant:string,{canViewCosts}:{canViewCosts:boolean})=>ids.map(id=>({productId:id,title:id,sku:id,vendor:null,buyable:id!=="archived",onHandUnits:id==="empty"?0:10,onOrderUnits:0,revenue30dKes:0,priceKes:200,costKes:canViewCosts?100:null,moneyAtRestKes:canViewCosts?1000:null})));
  mock.ages.mockResolvedValue(ids.map(id=>({id,shopifyCreatedAt:id==="unknown"?null:new Date(id==="old"||id==="restocked"?"2026-01-01":"2026-09-01"),receivedAt:null})));
  mock.lastSales.mockResolvedValue([{productId:"selling",_max:{date:new Date("2026-10-01")}}]);
  mock.observed.mockResolvedValue(new Map(ids.map(id=>[id,id==="restocked"?2:20])));
}
describe("held never-sold dashboard visibility",()=>{
  it("shows every never-sold held SKU with its reason without inflating confirmed dead stock",async()=>{
    setup();const result=await getDashboardTable("tenant",{canViewCosts:true,limit:2});
    expect(result.counts.unsold).toBe(34);expect(result.rows.unsold).toHaveLength(34);expect(result.capped.unsold).toBe(false);
    expect(result.unsoldSummary).toEqual({skus:34,costKes:34000});
    expect(result.unsoldReasons).toMatchObject({new:"new_product",old:"dead",unknown:"unknown_age",restocked:"insufficient_stock_history"});
    expect(Object.keys(result.unsoldReasons)).toHaveLength(34);
    for (const id of ["selling", "empty", "archived"]) expect(result.rows.unsold.map(r=>r.productId)).not.toContain(id);
    expect(result.counts.dead).toBe(1);expect(result.deadCostKes).toBe(1000);
  });
  it("redacts the new total and every unsold row cost for members",async()=>{
    setup();const result=await getDashboardTable("tenant",{canViewCosts:false,limit:2});
    expect(result.unsoldSummary).toEqual({skus:34,costKes:null});
    expect(result.rows.unsold).toHaveLength(34);
    for(const row of result.rows.unsold){expect(row.costKes).toBeNull();expect(row.moneyAtRestKes).toBeNull();}
  });
});
