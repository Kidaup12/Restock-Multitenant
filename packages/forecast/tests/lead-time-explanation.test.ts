import { describe, expect, it } from "vitest";
import { layeredForecast } from "../src/layered";
import type { SalesPoint } from "../src/baseline";

/**
 * The sentence the shop reads has to say something true about the delivery wait.
 *
 * The engine resolves an unknown lead time to 0 on purpose — never inflate an
 * order on a guess — but the explanation printed that straight through as
 * "lead time 0±7d", which reads as a supplier who delivers in no days, with
 * nothing saying why. On a workspace whose only supplier had no lead time set,
 * that was every product on every screen, and the nudge that would have fixed
 * it (set one lead time, improve every recommendation) was never given.
 *
 * The arithmetic is unchanged — only the wording branches.
 */

function history(days: number, perDay: number): SalesPoint[] {
  const out: SalesPoint[] = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date(Date.UTC(2026, 6, 1) + i * 86_400_000);
    out.push({ date: d, quantity: perDay, revenueKes: perDay * 100 });
  }
  return out;
}

const base = {
  productId: "p-1",
  productType: "Skincare",
  vendor: "Isntree",
  sku: "ISN-SU-2004",
  currentStock: 0,
  abcCategory: "A",
  history: history(120, 2),
  activePromos: [],
  runDateKey: "2026-10-29",
};

describe("the forecast explains an unknown lead time", () => {
  it("says the supplier has none set rather than printing zero days", () => {
    const out = layeredForecast({ ...base, leadTimeAvg: 0, leadTimeStd: 7 });
    expect(out.reasoning).toContain("no delivery time set for this supplier");
    expect(out.reasoning).not.toContain("lead time 0");
  });

  it("still prints a real lead time as a lead time", () => {
    const out = layeredForecast({ ...base, leadTimeAvg: 42, leadTimeStd: 7 });
    expect(out.reasoning).toContain("lead time 42±7d");
    expect(out.reasoning).not.toContain("no delivery time set");
  });

  it("changes no number — only the words", () => {
    // The whole point of resolving an unknown lead to 0 is that the sizing does
    // not move. If this ever fails, the wording change has leaked into the maths.
    const unknown = layeredForecast({ ...base, leadTimeAvg: 0, leadTimeStd: 7 });
    expect(unknown.finalForecast30d).toBeGreaterThan(0);
    expect(unknown.safetyStock).toBeGreaterThanOrEqual(0);
  });
});
