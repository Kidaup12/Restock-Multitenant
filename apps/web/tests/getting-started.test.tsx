import { describe, expect, it } from "vitest";
import { STAGES, FORMULA, FORMULA_NOTES } from "@/app/(shell)/getting-started/content";
import { NAV_DESTINATIONS } from "@/components/shell/nav-config";

/**
 * The page that answers "how much of this is my job?".
 *
 * Every screen in the app explains itself, which left nobody a place to answer
 * the question an owner actually opens with. Without an answer the honest
 * assumption is "all of it", and a buy list from a system you believe you have
 * to hand-feed is not a buy list anyone follows.
 */

describe("how it works", () => {
  it("leads with what happens without them", () => {
    // Order carries the argument. Opening with the weekly habit makes the
    // product sound like work; opening with what is automatic is both true and
    // the reason to adopt it.
    expect(STAGES[0]!.key).toBe("automatic");
    expect(STAGES.map((s) => s.key)).toEqual(["automatic", "once", "ongoing"]);
  });

  it("numbers the stages in the order it shows them", () => {
    expect(STAGES.map((s) => s.step)).toEqual([1, 2, 3]);
  });

  it("says something concrete at every stage", () => {
    // A stage with no points is a heading pretending to be an explanation.
    for (const stage of STAGES) {
      expect(stage.points.length, `${stage.key} promises nothing`).toBeGreaterThan(2);
      expect(stage.intro.length).toBeGreaterThan(20);
    }
  });

  it("states the arithmetic in words, not symbols", () => {
    // The reader is a shop owner, not a statistician: the formula is here to be
    // checked by someone who will never open the code.
    expect(FORMULA).toContain("how fast it sells");
    expect(FORMULA).toContain("how long the supplier takes");
    for (const jargon of ["σ", "z-score", "serviceLevel", "MAPE", "quantile"]) {
      expect(FORMULA + FORMULA_NOTES.join(" "), `the page leaked "${jargon}"`).not.toContain(jargon);
    }
  });

  it("admits that stockout days are excluded from the rate", () => {
    // The single most surprising thing about the number, and the one a shop
    // notices first: a product that was unavailable did not "go quiet".
    expect(FORMULA_NOTES.join(" ")).toContain("out of stock");
  });

  it("is reachable from the nav", () => {
    // A page nobody can click to is not delivered.
    const entry = NAV_DESTINATIONS.find((d) => d.href === "/getting-started");
    expect(entry, "the page exists but nothing links to it").toBeDefined();
    expect(entry!.permission, "an explainer was put behind a permission").toBeUndefined();
  });
});
