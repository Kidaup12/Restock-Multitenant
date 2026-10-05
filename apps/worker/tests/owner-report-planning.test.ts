import { describe, expect, it } from "vitest";
import { reportOrderQuantity } from "../src/owner-report-planning";
const base = { recommendedQty: 3, finalForecast30d: 60, urgency: "high", costKes: 100, priceKes: 200, hasOpenOrder: false };
describe("owner report actionable quantities", () => {
  it("costs the supplier minimum, including owner overrides", () => {
    expect(reportOrderQuantity({...base,moq:12})).toBe(12);
    expect(reportOrderQuantity({...base,moq:12,overrideQty:20})).toBe(20);
    expect(reportOrderQuantity({...base,moq:12,overrideQty:0})).toBe(0);
  });
  it("honors an owner's positive decision even when the engine recommended zero", () => {
    expect(reportOrderQuantity({...base,recommendedQty:0,overrideQty:7,urgency:"low",finalForecast30d:3})).toBe(7);
  });
  it("never reorders committed lines or buys against invalid costs", () => {
    expect(reportOrderQuantity({...base,overrideQty:9,hasOpenOrder:true})).toBe(0);
    expect(reportOrderQuantity({...base,overrideQty:9,costKes:300})).toBe(0);
  });
  it("matches the planner's low urgency slow-mover holdback", () => {
    expect(reportOrderQuantity({...base,urgency:"low",finalForecast30d:29})).toBe(0);
    expect(reportOrderQuantity({...base,urgency:"low",finalForecast30d:30})).toBe(3);
  });
});
