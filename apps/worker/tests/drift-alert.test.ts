import { describe, expect, it } from "vitest";
import { describeDrift } from "../src/drift-report";

describe("sync drift alert wording", () => {
  it("names the shop and both corrections", () => {
    const { subject, text } = describeDrift("Treasured Scents Edit", {
      salesDrift: { days: 3, unitsBefore: 10, unitsAfter: 14 },
      costsCorrected: 151,
    });
    expect(subject).toBe("Sync drift: Treasured Scents Edit");
    expect(text).toContain("3 settled days corrected — 10 units before, 14 after");
    expect(text).toContain("151 product costs corrected by the nightly full pull");
  });

  it("leaves out the half that found nothing", () => {
    const { text } = describeDrift("Shop", { salesDrift: null, costsCorrected: 1 });
    expect(text).toContain("1 product cost corrected");
    expect(text).not.toContain("Sales:");
  });
});
