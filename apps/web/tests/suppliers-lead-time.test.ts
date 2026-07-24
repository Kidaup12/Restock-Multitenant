import { describe, expect, it } from "vitest";
import {
  leadTimeDrift,
  learnedLeadMedianDays,
  shortShipRatePct,
  speedBand,
} from "../lib/suppliers/lead-time";
import { suggestSupplierForVendor } from "../lib/suppliers/assign";

/**
 * Pure lead-time + assignment math — the trust logic behind the Suppliers page.
 * No database; every derived number the page shows is decided here.
 */

const DAY = 86_400_000;

/** A completed delivery `leadDays` door-to-door, received `receivedDaysAgo` ago. */
function delivery(leadDays: number, receivedDaysAgo: number) {
  const receivedAt = new Date(Date.now() - receivedDaysAgo * DAY);
  const sentAt = new Date(receivedAt.getTime() - leadDays * DAY);
  return { sentAt, receivedAt };
}

describe("learnedLeadMedianDays", () => {
  it("is null below the minimum delivery count", () => {
    expect(learnedLeadMedianDays([])).toBeNull();
    expect(learnedLeadMedianDays([delivery(20, 1), delivery(30, 2)])).toBeNull();
  });

  it("takes the median of the actual lead times", () => {
    expect(
      learnedLeadMedianDays([delivery(10, 1), delivery(20, 2), delivery(30, 3)]),
    ).toBe(20);
  });

  it("averages and rounds the two middle values for an even count", () => {
    expect(
      learnedLeadMedianDays([
        delivery(10, 1),
        delivery(20, 2),
        delivery(30, 3),
        delivery(40, 4),
      ]),
    ).toBe(25);
  });

  it("only considers the most recent N deliveries", () => {
    // Eight recent 20-day deliveries; two much older 100-day ones must drop out.
    const recent = Array.from({ length: 8 }, (_, i) => delivery(20, i + 1));
    const old = [delivery(100, 40), delivery(100, 41)];
    expect(learnedLeadMedianDays([...recent, ...old])).toBe(20);
  });
});

describe("speedBand", () => {
  it("maps lead time to a band", () => {
    expect(speedBand(1)).toBe("local");
    expect(speedBand(7)).toBe("local");
    expect(speedBand(8)).toBe("regional");
    expect(speedBand(20)).toBe("regional");
    expect(speedBand(21)).toBe("import");
    expect(speedBand(60)).toBe("import");
  });

  it("is null when no lead time is known", () => {
    expect(speedBand(null)).toBeNull();
  });
});

describe("leadTimeDrift", () => {
  it("is not drifting when either value is missing", () => {
    expect(leadTimeDrift(null, 30).drifting).toBe(false);
    expect(leadTimeDrift(28, null).drifting).toBe(false);
  });

  it("flags a divergence beyond the absolute-days threshold", () => {
    const d = leadTimeDrift(28, 34); // +6 days
    expect(d.drifting).toBe(true);
    expect(d.deltaDays).toBe(6);
    expect(d.direction).toBe("later");
  });

  it("flags a divergence beyond the relative threshold even under 5 days", () => {
    const d = leadTimeDrift(4, 6); // +2 days but +50%
    expect(d.drifting).toBe(true);
    expect(d.direction).toBe("later");
  });

  it("does not flag a small divergence within both thresholds", () => {
    // +5 days on a 28-day typed value: not >5 days and only ~18% — steady.
    expect(leadTimeDrift(28, 33).drifting).toBe(false);
  });

  it("reports the earlier direction when learned is faster", () => {
    const d = leadTimeDrift(40, 30); // -10 days
    expect(d.drifting).toBe(true);
    expect(d.direction).toBe("earlier");
  });
});

describe("shortShipRatePct", () => {
  it("is null with no deliveries", () => {
    expect(shortShipRatePct([])).toBeNull();
    // A never-received order is not a short-ship.
    expect(shortShipRatePct([{ lines: [{ quantity: 10, receivedQty: 0 }] }])).toBeNull();
  });

  it("is the share of delivered POs that arrived short", () => {
    const rate = shortShipRatePct([
      { lines: [{ quantity: 10, receivedQty: 10 }] }, // full
      { lines: [{ quantity: 10, receivedQty: 7 }] }, // short
      { lines: [{ quantity: 5, receivedQty: 0 }] }, // never delivered — ignored
    ]);
    expect(rate).toBe(50);
  });
});

describe("suggestSupplierForVendor", () => {
  const suppliers = [
    { id: "beauty", name: "Beauty Plus Distributors" },
    { id: "dubai", name: "Dubai Cosmetics" },
    { id: "garnier-ke", name: "Garnier Kenya" },
  ];

  it("prefers the supplier already carrying most of the brand", () => {
    const result = suggestSupplierForVendor("Garnier", suppliers, [
      { supplierId: "dubai", count: 8 },
      { supplierId: "beauty", count: 2 },
    ]);
    expect(result).toBe("dubai");
  });

  it("falls back to a supplier name overlap when nothing is assigned yet", () => {
    expect(suggestSupplierForVendor("Garnier", suppliers, [])).toBe("garnier-ke");
  });

  it("returns null when there is no signal at all", () => {
    expect(suggestSupplierForVendor("Nivea", suppliers, [])).toBeNull();
  });
});
