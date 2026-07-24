import { describe, expect, it } from "vitest";
import { resolvePosSkuMap, suggestProductForSku } from "../src/match";
import { detectSalesGaps } from "../src/gap";
import { parsePosDate, tenantDayKey } from "../src/time";
import type { MatchProduct } from "../src/types";

const products: MatchProduct[] = [
  { id: "p-cantu", sku: "CAN-SHE-340", title: "Cantu Shea Butter Leave-In 340g", priceKes: 1650 },
  { id: "p-gly", sku: "NL-GLY-750", title: "Nice & Lovely Pure Glycerine 750ml", priceKes: 450 },
];

describe("resolvePosSkuMap", () => {
  it("keys by normalized SKU", () => {
    const map = resolvePosSkuMap(products);
    expect(map.get("can-she-340")).toBe("p-cantu");
    expect(map.get("nl-gly-750")).toBe("p-gly");
  });

  it("drops a SKU shared by two products (ambiguous → unmatched, never guessed)", () => {
    const map = resolvePosSkuMap([
      { id: "a", sku: "DUP-1", title: "A" },
      { id: "b", sku: "dup-1", title: "B" },
      { id: "c", sku: "UNIQUE-9", title: "C" },
    ]);
    expect(map.has("dup-1")).toBe(false);
    expect(map.get("unique-9")).toBe("c");
  });
});

describe("suggestProductForSku (advisory only)", () => {
  it("suggests the closest catalogue product for a near-miss till code", () => {
    const s = suggestProductForSku("CANSHE340", "Cantu Shea Leave In", products);
    expect(s?.productId).toBe("p-cantu");
  });

  it("returns null when nothing is a plausible match", () => {
    expect(suggestProductForSku("XYZ-999", "Random Thing", products)).toBeNull();
  });
});

describe("detectSalesGaps", () => {
  const days = ["2026-07-13", "2026-07-14", "2026-07-15"];

  it("flags a branch that sold nothing on a day its sibling sold", () => {
    const gaps = detectSalesGaps({
      sellsLocationIds: ["kilimani", "westlands"],
      soldOn: [
        { locationId: "kilimani", dayKey: "2026-07-13" },
        { locationId: "westlands", dayKey: "2026-07-13" },
        { locationId: "kilimani", dayKey: "2026-07-15" },
        { locationId: "westlands", dayKey: "2026-07-15" },
        { locationId: "westlands", dayKey: "2026-07-14" }, // kilimani silent this day
      ],
      days,
    });
    expect(gaps).toEqual([{ locationId: "kilimani", dayKey: "2026-07-14" }]);
  });

  it("does not flag a day the whole shop was quiet", () => {
    const gaps = detectSalesGaps({
      sellsLocationIds: ["kilimani", "westlands"],
      soldOn: [
        { locationId: "kilimani", dayKey: "2026-07-13" },
        { locationId: "westlands", dayKey: "2026-07-13" },
      ],
      days,
    });
    // 07-14 and 07-15 had no sales anywhere → not one branch's problem.
    expect(gaps).toEqual([]);
  });

  it("does not flag a branch that never sold in the window (unmapped/inactive, not a gap)", () => {
    const gaps = detectSalesGaps({
      sellsLocationIds: ["kilimani", "dormant"],
      soldOn: [{ locationId: "kilimani", dayKey: "2026-07-14" }],
      days,
    });
    expect(gaps).toEqual([]); // dormant is never active → no per-day gap
  });

  it("suppresses a day already dismissed as a closure", () => {
    const gaps = detectSalesGaps({
      sellsLocationIds: ["kilimani", "westlands"],
      soldOn: [
        { locationId: "kilimani", dayKey: "2026-07-13" },
        { locationId: "westlands", dayKey: "2026-07-13" },
        { locationId: "kilimani", dayKey: "2026-07-14" },
        { locationId: "kilimani", dayKey: "2026-07-15" },
        { locationId: "westlands", dayKey: "2026-07-15" },
      ],
      days,
      closures: [{ locationId: "westlands", dayKey: "2026-07-14" }],
    });
    expect(gaps).toEqual([]); // westlands 07-14 was dismissed
  });
});

describe("tenant timezone", () => {
  it("keeps a late-evening Nairobi till sale on the same trading day", () => {
    // 23:30 Nairobi on the 15th is 20:30 UTC on the 15th; a UTC-naive read would
    // be fine here, but 01:00 Nairobi on the 16th is 22:00 UTC on the 15th.
    const late = parsePosDate("2026-07-15 23:30:00", "Africa/Nairobi");
    expect(tenantDayKey("Africa/Nairobi", late)).toBe("2026-07-15");

    const earlyNextDay = parsePosDate("2026-07-16 01:00:00", "Africa/Nairobi");
    expect(tenantDayKey("Africa/Nairobi", earlyNextDay)).toBe("2026-07-16");
    // The same instant is still the 15th in UTC — proof the tenant zone drove the day.
    expect(earlyNextDay.toISOString().slice(0, 10)).toBe("2026-07-15");
  });

  it("respects an explicit offset in the timestamp", () => {
    const d = parsePosDate("2026-07-15T23:30:00+03:00", "Africa/Nairobi");
    expect(tenantDayKey("Africa/Nairobi", d)).toBe("2026-07-15");
  });
});
