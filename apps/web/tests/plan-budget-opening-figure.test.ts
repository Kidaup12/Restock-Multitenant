import { describe, expect, it } from "vitest";
import { openingBudget } from "../app/(shell)/plan/budget-planner";

/**
 * What the budget box opens on.
 *
 * It opened on a hardcoded 800,000 — a figure about nobody's shop, so the first
 * plan every owner saw was allocated against a number they had to notice and
 * correct. It now opens on the cash needed to clear the critical lines, the
 * same figure the decision header prints, from the same function.
 *
 * The rounding direction is the part worth guarding: rounding DOWN would open
 * the screen already short of the criticals it exists to cover, which is a
 * quietly wrong default rather than an obviously wrong one.
 */

describe("the budget box's opening figure", () => {
  it("covers the criticals rather than falling short of them", () => {
    // 743,219 must not open at 740,000 — that is 3,219 short of the lines the
    // figure is meant to clear.
    expect(openingBudget(743_219, null)).toBe(750_000);
    expect(openingBudget(743_219, null)).toBeGreaterThanOrEqual(743_219);
  });

  it("leaves an already-round figure alone", () => {
    expect(openingBudget(750_000, null)).toBe(750_000);
  });

  it("falls back when the sum is withheld from a money-blind member", () => {
    // Null is "unknown", never zero — opening at 0 would plan nothing at all
    // and read as a broken screen.
    expect(openingBudget(null, null)).toBe(800_000);
  });

  it("falls back when there is nothing critical to price", () => {
    expect(openingBudget(0, null)).toBe(800_000);
  });

  it("uses what is due today when nothing is flagged critical", () => {
    // The shop this was verified on read "cash for criticals KES 0" beside
    // "order today KES 733K". Keying on criticals alone put the box straight
    // back on the hardcoded figure, so the prefill did nothing on real data.
    expect(openingBudget(0, 733_000)).toBe(740_000);
    expect(openingBudget(null, 733_000)).toBe(740_000);
  });

  it("still prefers the criticals figure when there is one", () => {
    expect(openingBudget(120_000, 733_000)).toBe(120_000);
  });
});
