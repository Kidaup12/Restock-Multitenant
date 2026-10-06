import { describe, expect, it } from "vitest";
import { historicalDeadStock } from "../lib/inventory/historical-dead-stock";
const asOf = new Date("2026-10-01T00:00:00Z");
const ago = (days: number) => new Date(+asOf - days * 86400000);
const base = { onHand: 10, asOf, windowDays: 90, firstSeenAt: ago(200), firstSaleAt: ago(150), sales: [] as Date[], observations: Array.from({ length: 14 }, (_, d) => ({date: ago(d), onHand: 10})) };
describe("historical dead stock eligibility", () => {
  it("excludes new, never-sold products even when held", () => {
    expect(historicalDeadStock({...base, firstSeenAt:ago(30), firstSaleAt:null})).toBe(false);
  });
  it("does not call a recently restocked item dead after a long stockout", () => {
    expect(historicalDeadStock({...base, observations: Array.from({length:90}, (_,d)=>({date:ago(d),onHand:d<3?10:0}))})).toBe(false);
  });
  it("keeps prior sale evidence outside the loaded recent sales window", () => {
    expect(historicalDeadStock({...base, firstSeenAt:null})).toBe(true);
  });
  it("excludes any sale in the lookback, including endpoint day", () => {
    expect(historicalDeadStock({...base,sales:[asOf]})).toBe(false);
  });
  it("does not borrow future sales or observations to classify past inventory", () => {
    expect(historicalDeadStock({...base,firstSeenAt:null,firstSaleAt:ago(-1),observations:[{date:asOf,onHand:10},...Array.from({length:20},(_,d)=>({date:ago(-d-1),onHand:10}))]})).toBe(false);
  });
  it("values eligibility only after fourteen distinct in-stock days", () => {
    expect(historicalDeadStock({...base,observations:Array.from({length:20},()=>({date:asOf,onHand:10}))})).toBe(false);
    expect(historicalDeadStock(base)).toBe(true);
  });
});
