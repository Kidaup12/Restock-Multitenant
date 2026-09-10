import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ABC_WINDOW_CHOICES, DEFAULT_ABC_WINDOW_DAYS, METHOD_DEFAULTS, ORDER_METHODS } from "@wezesha/forecast";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

import {
  RECOMMENDED_WINDOW_DAYS,
  STRATEGY_GROUPS,
  STRATEGY_OPTIONS,
  WINDOW_OPTIONS,
  everyMethodDescribed,
  everyWindowDescribed,
  optionFor,
  recommendedFor,
  strategyChanged,
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
      initialWindowDays={90}
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
    const html = render({
      initial: { A: "lean_cash", B: "lean_cash", C: "lean_cash" },
      initialWindowDays: 30,
    });
    // One pressed card per group plus the window — not the recommendation.
    expect(html.match(/aria-pressed="true"/g) ?? []).toHaveLength(
      STRATEGY_GROUPS.length + 1,
    );
    expect(html).toContain("Last 30 days");
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

  it("offers every earnings period the engine accepts, and no other", () => {
    // The same guard as the methods: a window the engine grew and nobody
    // described would simply be missing from the page, with nothing to notice it.
    expect(everyWindowDescribed(), "an engine window has no description").toBe(true);
    expect(WINDOW_OPTIONS).toHaveLength(ABC_WINDOW_CHOICES.length);
  });

  it("recommends the window the engine falls back to, not one invented here", () => {
    // An unset column takes the ENGINE's window; recommending a different one
    // would tell an owner their groups are ranked over a period they are not.
    expect(RECOMMENDED_WINDOW_DAYS).toBe(DEFAULT_ABC_WINDOW_DAYS);
  });

  it("says what the earnings period does to the shop, not how it is measured", () => {
    const html = render();
    expect(html).toContain("Which products count as your best sellers");
    for (const leak of ["Pareto", "window", "lookback", "run rate", "trailing"]) {
      expect(html, `the page leaked "${leak}"`).not.toContain(leak);
    }
  });

  it("counts a changed earnings period as a change worth saving", () => {
    // Save is gated on this. The window sits outside the three per-group values
    // the check began as, so forgetting it leaves Save disabled after a choice
    // — the page looking like it ignored the owner.
    const stored = {
      methods: { A: "stay_in_stock", B: "balanced", C: "lean_cash" },
      windowDays: 90,
    } as const;
    expect(strategyChanged(stored, stored)).toBe(false);
    expect(strategyChanged(stored, { ...stored, windowDays: 30 })).toBe(true);
    expect(
      strategyChanged(stored, {
        ...stored,
        methods: { ...stored.methods, C: "balanced" },
      }),
    ).toBe(true);
  });
});
