import { describe, expect, it } from "vitest";
import { assessTenantIngest } from "../src/run";

/**
 * Who the staleness gate is allowed to skip.
 *
 * One rule used to answer two questions. A shop with fewer than fourteen selling
 * days was recorded as "not stale" — rather than "not enough history to say" —
 * so the shops with the least data were the only ones never judged. On
 * production that read exactly backwards: two shops with a single selling day
 * forecast every half hour off sales 38 and 45 days old, with no notice to
 * anyone, while shops 24 days stale were correctly held and told.
 *
 * The split: a short history cannot say whether a day came in below normal,
 * because there is no normal. It says nothing about how old the newest sale is,
 * and that is measurable from one row.
 *
 * The reference build reaches the same place from the other side — its
 * staleness check is unconditional and its only small-shop leniency sits on the
 * gap branch (`minNorm`). We differ from it in one place on purpose: a shop that
 * has never sold at all keeps forecasting rather than being stopped, because
 * blocking a new shop's first forecast is the harm the old exemption existed to
 * prevent.
 */

const DAY = 86_400_000;
const NOW = new Date("2026-09-12T09:00:00Z");
const marker = (d: Date) => {
  const m = new Date(d);
  m.setUTCHours(0, 0, 0, 0);
  return m;
};
const daysAgo = (n: number) => marker(new Date(+NOW - n * DAY));

/** A shop that traded on `days` separate days, the newest `endingDaysAgo` ago. */
const trading = (days: number, endingDaysAgo = 0, quantity = 20) =>
  Array.from({ length: days }, (_, i) => ({
    date: daysAgo(i + endingDaysAgo),
    quantity,
  }));

describe("the staleness gate and shops with barely any history", () => {
  it("holds a one-selling-day shop whose only sale is six weeks old", () => {
    // The production case. It forecast every thirty minutes and said nothing.
    const v = assessTenantIngest(trading(1, 45), NOW);

    expect(v.stale).toBe(true);
    expect(v.stop).toBe(true);
    expect(v.ok).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/newest sale/i);
    // Named in the unit a person would use, not "1080h".
    expect(v.reasons.join(" ")).toMatch(/weeks|month/i);
  });

  it("lets a one-selling-day shop through when that sale was yesterday", () => {
    // The case the old exemption was protecting: a shop that just started. It
    // is protected by the data being fresh, not by the history being short.
    const v = assessTenantIngest(trading(1, 1), NOW);

    expect(v.stale).toBe(false);
    expect(v.stop).toBe(false);
    expect(v.ok).toBe(true);
  });

  it("lets a shop that has never sold anything forecast, and says so", () => {
    // Our one deliberate divergence from the reference, which stops this case.
    // Nothing can be stale when nothing has arrived — but the verdict must not
    // answer with silence either.
    const v = assessTenantIngest([], NOW);

    expect(v.stop).toBe(false);
    expect(v.ok).toBe(true);
    expect(v.stale).toBe(false);
    expect(v.latestSaleAt).toBeNull();
    expect(v.reasons.join(" ")).toMatch(/no sales/i);
  });

  it("treats a sparse shop and an established one alike on staleness", () => {
    // The defect in one assertion: the same six-week-old feed, judged the same
    // way whether the shop sold on one day or on ninety.
    const sparse = assessTenantIngest(trading(1, 45), NOW);
    const established = assessTenantIngest(trading(90, 45), NOW);

    expect(sparse.stale).toBe(established.stale);
    expect(sparse.stop).toBe(established.stop);
  });

  it("still spares a sparse shop the gap check, which needs a normal day", () => {
    // Below-normal days are meaningless without a normal. Three of the last
    // seven days at a twentieth of the rest would stop an established shop;
    // on a shop with too little history it must not, because the "norm" here
    // is one or two days of its own noise.
    const sparse = [
      { date: daysAgo(1), quantity: 1 },
      { date: daysAgo(2), quantity: 1 },
      { date: daysAgo(3), quantity: 1 },
      ...Array.from({ length: 5 }, (_, i) => ({ date: daysAgo(i + 4), quantity: 60 })),
    ];
    const v = assessTenantIngest(sparse, NOW);

    expect(v.stale).toBe(false);
    expect(v.stop).toBe(false);
    expect(v.gapDayKeys).toEqual([]);
  });

  it("still applies the gap check once the shop has a real trading history", () => {
    // The other side of the same line: with enough selling days the gap check
    // keeps working exactly as it did.
    const established = [
      { date: daysAgo(1), quantity: 1 },
      { date: daysAgo(2), quantity: 1 },
      { date: daysAgo(3), quantity: 1 },
      ...Array.from({ length: 25 }, (_, i) => ({ date: daysAgo(i + 4), quantity: 60 })),
    ];
    const v = assessTenantIngest(established, NOW);

    expect(v.stale).toBe(false);
    expect(v.stop).toBe(true);
    expect(v.gapDayKeys.length).toBeGreaterThan(2);
  });
});
