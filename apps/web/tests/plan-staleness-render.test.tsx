import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// RunForecastButton is a client component using next/navigation; the router
// context a bare renderToStaticMarkup provides is not one. The button's identity
// is what this asserts, not its behaviour.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

import { PlanFreshness } from "../app/(shell)/plan/plan-freshness";
import { planFreshnessLabel } from "@/lib/data/forecast-freshness";

/**
 * A stale plan has to look different from a fresh one, and has to carry the way
 * out with it. The August outage rendered "run 3 Aug" in grey and read as normal.
 */

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 5, 8, 0, 0);

describe("plan freshness banner", () => {
  it("states the date quietly when the plan is current", () => {
    const html = renderToStaticMarkup(
      <PlanFreshness freshness={planFreshnessLabel(new Date(NOW - 30 * HOUR), NOW)} />
    );
    expect(html).toContain("Plan computed");
    expect(html).not.toContain("out of date");
    expect(html).not.toContain("Run forecast");
  });

  it("warns and offers a rerun when a night has been missed", () => {
    const html = renderToStaticMarkup(
      <PlanFreshness freshness={planFreshnessLabel(new Date(Date.UTC(2026, 7, 3, 2, 0, 0)), NOW)} />
    );
    expect(html).toContain("2 nights ago");
    expect(html).toContain("behind your stock");
    // A warning the owner cannot act on is just a worry.
    expect(html).toContain("Run forecast");
    expect(html).toContain("bg-warning-soft");
  });
});
