import { describe, expect, it } from "vitest";
import { ACCURACY_MIN_HISTORY_DAYS } from "../lib/data/insights";
import { noGradeYet } from "../app/(shell)/insights/forecast-scorecard";

/**
 * The accuracy card's empty state.
 *
 * It used to promise a date computed as "first sale + the history bar" without
 * checking whether that date had already gone — so a shop with a year of history
 * was told its first check was due last month.
 *
 * Then it measured from the first sale to TODAY, which is the wrong span
 * entirely. Seen live on a store with 54 days of sales that had stopped selling
 * two weeks earlier: 68 days had passed since its first sale, so the card said
 * "you have enough sales history for the check now" — and the check, which needs
 * 59 days between the first sale and the LAST, declined on the same card a line
 * above. Waiting would never have fixed it; only selling again would.
 */

const DAY = 86_400_000;
const NOW = new Date("2026-07-27T00:00:00.000Z");

/** A shop still trading: last sale is today. */
const trading = (spanDays: number) => ({
  first: new Date(NOW.getTime() - spanDays * DAY),
  last: NOW,
});

describe("noGradeYet", () => {
  it("names a date when the history is still building and sales are coming in", () => {
    const { first, last } = trading(10);
    const copy = noGradeYet(first, last, NOW);
    expect(copy).toContain(String(ACCURACY_MIN_HISTORY_DAYS));
    // How far along the shop actually is, and what is still missing — expressed
    // in days of SELLING, never a calendar date that assumes it continues.
    expect(copy).toContain("covers 10");
    expect(copy).toContain(`${ACCURACY_MIN_HISTORY_DAYS - 10} days of selling short`);
  });

  it("never promises a date that has already passed", () => {
    const { first, last } = trading(365);
    const copy = noGradeYet(first, last, NOW);
    expect(copy).toContain("enough sales history");
  });

  it("holds at the exact boundary — the bar met is not still pending", () => {
    const { first, last } = trading(ACCURACY_MIN_HISTORY_DAYS);
    expect(noGradeYet(first, last, NOW)).toContain("enough sales history");
  });

  it("is one day short at the boundary minus one", () => {
    const { first, last } = trading(ACCURACY_MIN_HISTORY_DAYS - 1);
    expect(noGradeYet(first, last, NOW)).not.toContain("enough sales history");
  });

  /**
   * The defect this replaced, with the live numbers: first sale 13 Jun, last
   * sale 6 Aug (54 days apart), read on 20 Aug — 68 days after the first sale.
   */
  it("does not claim enough history for a shop whose sales stopped short", () => {
    const first = new Date("2026-06-13T00:00:00.000Z");
    const last = new Date("2026-08-06T00:00:00.000Z");
    const now = new Date("2026-08-20T00:00:00.000Z");

    const copy = noGradeYet(first, last, now);
    expect(copy).not.toContain("enough sales history");
    // ...and it says what would actually fix it, rather than implying time will.
    expect(copy).toContain("54");
    expect(copy.toLowerCase()).toContain("selling resumes");
  });

  it("does not blame a stall when the shop is still trading", () => {
    const { first, last } = trading(20);
    expect(noGradeYet(first, last, NOW).toLowerCase()).not.toContain("selling resumes");
  });

  it("says what is needed when there are no sales at all", () => {
    for (const [first, last] of [
      [null, null],
      [new Date(NOW.getTime() - 100 * DAY), null],
      [null, NOW],
    ] as [Date | null, Date | null][]) {
      const copy = noGradeYet(first, last, NOW);
      expect(copy).toContain(String(ACCURACY_MIN_HISTORY_DAYS));
    }
  });

  it("matches the threshold the check actually enforces", () => {
    // 30 days of training + a 30-day horizon, less the inclusive final day
    // (walkForwardCutoffs). If the engine's rule moves, this must move with it —
    // the whole defect was these two disagreeing.
    expect(ACCURACY_MIN_HISTORY_DAYS).toBe(30 + 30 - 1);
  });
});
