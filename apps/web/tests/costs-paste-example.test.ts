import { describe, expect, it } from "vitest";
import { placeholderFor } from "../app/(shell)/costs/cost-import";

/**
 * The paste box's worked example hardcoded two SKUs from the seeded demo shop,
 * so a brand-new workspace — and every real customer — was shown another shop's
 * product codes on the screen where they hand us their cost data. It read as
 * leftover seed data, and the codes meant nothing to the shop being asked to
 * paste against them.
 */

const DEMO_SKUS = ["CAN-SHE-340", "NL-GLY-750"];

describe("the costs paste example", () => {
  it("uses the shop's own SKUs when it has a catalogue", () => {
    const example = placeholderFor(["ISN-SU-2004", "MAY-SM-2030", "NIV-DE-150"]);
    expect(example).toContain("ISN-SU-2004,1200");
    expect(example).toContain("MAY-SM-2030,450");
    // Two rows is a worked example; the whole catalogue is a wall of text.
    expect(example.split("\n")).toHaveLength(3); // header + 2
    expect(example).not.toContain("NIV-DE-150");
  });

  it("falls back to neutral codes for an empty catalogue", () => {
    const example = placeholderFor([]);
    expect(example).toContain("SKU-001,1200");
    expect(example.startsWith("sku,cost")).toBe(true);
  });

  it("never shows the demo shop's SKUs to anyone", () => {
    for (const skus of [[], ["OWN-1"], ["OWN-1", "OWN-2"]]) {
      const example = placeholderFor(skus);
      for (const demo of DEMO_SKUS) {
        expect(example, demo).not.toContain(demo);
      }
    }
  });

  it("still names the columns, whatever the rows are", () => {
    expect(placeholderFor(["ONE"]).split("\n")[0]).toBe("sku,cost");
  });
});
