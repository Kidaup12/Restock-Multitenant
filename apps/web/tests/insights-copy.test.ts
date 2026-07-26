import { describe, expect, it } from "vitest";
import { ACCURACY_MIN_HISTORY_DAYS } from "../lib/data/insights";
import { noGradeYet } from "../app/(shell)/insights/forecast-scorecard";

/**
 * The accuracy card's empty state. It used to promise a date computed as
 * "first sale + the history bar" without checking whether that date had already
 * gone — so a shop with a year of history was told its first check was due last
 * month. Once the history bar is met the wait is the monthly check, and the copy
 * has to say so.
 */

const DAY = 86_400_000;
const NOW = new Date("2026-07-27T00:00:00.000Z");

describe("noGradeYet", () => {
  it("names the date when the history bar is still ahead", () => {
    const firstSale = new Date(NOW.getTime() - 10 * DAY);
    const copy = noGradeYet(firstSale, NOW);
    expect(copy).toContain("due around");
    expect(copy).toContain(String(ACCURACY_MIN_HISTORY_DAYS));
  });

  it("never promises a date that has already passed", () => {
    const firstSale = new Date(NOW.getTime() - 365 * DAY);
    const copy = noGradeYet(firstSale, NOW);
    expect(copy).not.toContain("due around");
    expect(copy).toContain("enough sales history");
  });

  it("holds at the exact boundary — the bar met is not still pending", () => {
    const firstSale = new Date(NOW.getTime() - ACCURACY_MIN_HISTORY_DAYS * DAY);
    expect(noGradeYet(firstSale, NOW)).not.toContain("due around");
  });

  it("says what is needed when there are no sales at all", () => {
    const copy = noGradeYet(null, NOW);
    expect(copy).not.toContain("due around");
    expect(copy).toContain(String(ACCURACY_MIN_HISTORY_DAYS));
  });
});
