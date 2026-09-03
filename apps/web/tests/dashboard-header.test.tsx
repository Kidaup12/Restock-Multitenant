import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { planFreshnessLabel, PLAN_STALE_AFTER_MS } from "@/lib/data/forecast-freshness";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

const { AdvancedMenu } = await import("../app/(shell)/today/advanced-menu");

/**
 * The dashboard header: how old the numbers are, and where the engine chores went.
 *
 * The screen showed a stockout count with no indication of its age, so a figure
 * from a run three days ago read exactly like one from this morning. And Run
 * forecast was the most prominent control on the page — a job nobody does daily,
 * sitting above the numbers it exists to produce.
 */

const HOUR = 3_600_000;

describe("buy-list freshness", () => {
  it("says how long ago in words a shop uses", () => {
    const now = Date.now();
    expect(planFreshnessLabel(new Date(now - 2 * HOUR), now).relative).toBe("2h ago");
    expect(planFreshnessLabel(new Date(now - 3 * 24 * HOUR), now).relative).toBe("3d ago");
  });

  it("turns to a warning once the run is overdue, not before", () => {
    // The dashboard prints a different second half on each tone, so the
    // threshold decides which sentence a shop reads.
    const now = Date.now();
    const fresh = planFreshnessLabel(new Date(now - PLAN_STALE_AFTER_MS + HOUR), now);
    const stale = planFreshnessLabel(new Date(now - PLAN_STALE_AFTER_MS - HOUR), now);
    expect(fresh.tone).toBe("neutral");
    expect(stale.tone, "an overdue run still reads as healthy").toBe("warning");
  });
});

describe("advanced menu", () => {
  it("holds both engine chores rather than the header", () => {
    const html = renderToStaticMarkup(<AdvancedMenu />);
    expect(html).toContain("Advanced");
    expect(html).toContain("Sync now");
    expect(html).toContain("Run forecast");
  });

  it("keeps them behind a closed disclosure", () => {
    // The point of the change: neither is a daily job, so neither competes with
    // the numbers. A menu rendered open is the button again with extra steps.
    const html = renderToStaticMarkup(<AdvancedMenu />);
    expect(html).toContain("<details");
    expect(html, "the menu renders already open").not.toMatch(/<details[^>]*\sopen/);
  });
});
