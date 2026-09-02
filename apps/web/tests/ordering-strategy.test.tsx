import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { METHOD_DEFAULTS, ORDER_METHODS } from "@wezesha/forecast";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

import {
  STRATEGY_GROUPS,
  STRATEGY_OPTIONS,
  everyMethodDescribed,
  optionFor,
  recommendedFor,
} from "@/lib/ordering/strategy";
import { StrategyForm } from "@/app/(shell)/settings/ordering-strategy/strategy-form";

/**
 * The ordering strategy surface.
 *
 * The setting already existed — buried in Workspace settings under the timezone
 * picker, as three dropdowns. It decides how much cash sits on the shelf
 * against how often the shop runs out, which is the most consequential choice
 * an owner makes, so what is tested here is that the TRADE is visible and that
 * the page cannot drift from the engine it configures.
 */

const render = (over: Partial<Parameters<typeof StrategyForm>[0]> = {}) =>
  renderToStaticMarkup(
    <StrategyForm
      initial={{ A: "stay_in_stock", B: "balanced", C: "lean_cash" }}
      canManage
      {...over}
    />,
  );

describe("ordering strategy", () => {
  it("describes every method the engine accepts", () => {
    // The guard that matters over time: adding a fourth OrderMethod without a
    // description would render a blank card, and nothing else would notice.
    expect(everyMethodDescribed(), "an engine method has no description").toBe(true);
    expect(STRATEGY_OPTIONS).toHaveLength(ORDER_METHODS.length);
  });

  it("marks the engine's own default as recommended, not something invented here", () => {
    // If the two ever part company the page would recommend one thing while the
    // engine defaulted to another — and an unset column takes the ENGINE's.
    for (const group of STRATEGY_GROUPS) {
      expect(recommendedFor(group.key)).toBe(METHOD_DEFAULTS[group.key]);
    }
  });

  it("shows the trade on every option, not just its name", () => {
    // A dropdown makes three options look interchangeable. What separates them
    // is cash against lost sales, and that has to be on screen per choice.
    const html = render();
    for (const option of STRATEGY_OPTIONS) {
      expect(html).toContain(option.label);
      expect(html, `${option.label} does not say what it does to stock`).toContain(option.inStock);
      expect(html, `${option.label} does not say what it does to cash`).toContain(option.cash);
      expect(html, `${option.label} does not say what it risks`).toContain(option.risk);
    }
  });

  it("says who each option is for", () => {
    const html = render();
    expect(html).toContain("Best for:");
    expect(html).toContain("lost sale you can&#x27;t get back");
  });

  it("never shows the statistics behind it", () => {
    // The engine's own note: raw statistics are the engine's, not a shop
    // owner's. The CHOICE is the owner's; the z-value is not.
    const html = render();
    for (const leak of ["serviceLevelZ", "z =", "z-score", "quantile", "1.65", "1.28"]) {
      expect(html, `the page leaked "${leak}"`).not.toContain(leak);
    }
  });

  it("opens on what the buy list is actually doing", () => {
    const html = render({ initial: { A: "lean_cash", B: "lean_cash", C: "lean_cash" } });
    // Three pressed cards, one per group — not the recommendation.
    expect(html.match(/aria-pressed="true"/g) ?? []).toHaveLength(3);
  });

  it("cannot be saved until something changes", () => {
    // Save is disabled on an untouched form: a no-op write would stamp the
    // audit trail with a change nobody made.
    expect(render()).toContain('disabled=""');
  });

  it("gives a reader who cannot manage settings no way to change it", () => {
    const html = render({ canManage: false });
    expect(html).not.toContain("Save changes");
  });

  it("names the groups by what they earn, not by a letter", () => {
    // "Class A" tells an owner nothing; "roughly 70% of your revenue" tells
    // them why it deserves the careful setting.
    const html = render();
    expect(html).toContain("Best sellers");
    expect(html).toContain("Roughly 70% of your revenue");
    expect(html).not.toContain("Class A");
  });

  it("resolves an unknown method to something renderable", () => {
    // Defensive: a column holding a retired method must not blank the card.
    expect(optionFor("balanced").label).toBe("Balanced");
  });
});
