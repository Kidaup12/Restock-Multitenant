import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The report period must reach the panels it claims to drive.
 *
 * A rail that renders, highlights the chosen chip and changes no number is the
 * failure this codebase has produced three times — a control sitting far from
 * its effect, looking like it works. The period is only real if it arrives as a
 * prop on the panels that read a window.
 *
 * Asserted against the source because both panels are async server components
 * that query the database; rendering them here would test the loader, not the
 * wiring. The regexes require the range EXPRESSION, not a literal, so hardcoding
 * `days={30}` back in fails.
 */

const page = readFileSync(new URL("../app/(shell)/insights/page.tsx", import.meta.url), "utf8");

describe("the report period reaches the panels", () => {
  it("drives the top-earners window", () => {
    expect(
      /<TopEarners[\s\S]{0,200}days=\{rangeDays\(range\)\}/.test(page),
      "top earners is not reading the period — the rail cannot change it"
    ).toBe(true);
  });

  it("drives the trend window", () => {
    expect(
      /<StockoutTrend[\s\S]{0,200}weeks=\{rangeWeeks\(range\)\}/.test(page),
      "the trend chart is not reading the period"
    ).toBe(true);
  });

  it("reads the period from the URL rather than component state", () => {
    // Server-routed, so a period is shareable and survives a reload.
    expect(page).toContain("parseRangeKey(");
    expect(page).toMatch(/params\.range/);
  });

  it("says which panels the period does not drive", () => {
    // Shelf health and the impact card are snapshots. A period control silently
    // sitting above them reads as changing numbers it cannot change.
    expect(page).toMatch(/right now|since your first order/);
  });
});
