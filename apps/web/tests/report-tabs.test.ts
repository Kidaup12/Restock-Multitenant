import { describe, expect, it } from "vitest";
import {
  REPORT_TABS,
  parseReportTab,
  reportTabHref,
  reportTabLabel,
  type ReportTab,
} from "../app/(shell)/insights/tabs";

/**
 * The Reports tab router.
 *
 * The IA moved from two `?view=` tabs to three `?tab=` ones, and two things had
 * to hold through the move: legacy `?view=proof` links must still land on the
 * trend (now "performance"), and a mistyped or absent tab must show a page
 * rather than throw — this parses a query string any visitor can type.
 */

describe("parseReportTab", () => {
  it("reads a real tab off ?tab=", () => {
    for (const tab of REPORT_TABS) {
      expect(parseReportTab({ tab })).toBe(tab);
    }
  });

  it("maps legacy ?view=proof to performance so old links do not break", () => {
    expect(parseReportTab({ view: "proof" })).toBe("performance");
  });

  it("lets ?tab= win over a legacy ?view=", () => {
    // A modern link that also carries the old parameter is still a modern link.
    expect(parseReportTab({ tab: "overview", view: "proof" })).toBe("overview");
  });

  it("falls back to overview for anything unknown or absent", () => {
    expect(parseReportTab({})).toBe("overview");
    expect(parseReportTab({ tab: "" })).toBe("overview");
    expect(parseReportTab({ tab: "proof" })).toBe("overview");
    expect(parseReportTab({ tab: "nonsense" })).toBe("overview");
    expect(parseReportTab({ view: "now" })).toBe("overview");
    expect(parseReportTab({ view: "nonsense" })).toBe("overview");
  });
});

describe("reportTabLabel", () => {
  it("names each tab", () => {
    expect(reportTabLabel("overview")).toBe("Overview");
    expect(reportTabLabel("performance")).toBe("Performance");
    expect(reportTabLabel("history")).toBe("History");
  });
});

describe("reportTabHref", () => {
  it("omits ?tab= for the default overview face", () => {
    expect(reportTabHref("overview")).toBe("/insights");
  });

  it("names the non-default tabs", () => {
    expect(reportTabHref("performance")).toBe("/insights?tab=performance");
    expect(reportTabHref("history")).toBe("/insights?tab=history");
  });

  it("carries the range and class lenses when set", () => {
    expect(reportTabHref("performance", { range: "90d", class: "A" })).toBe(
      "/insights?tab=performance&range=90d&class=A",
    );
    // Overview keeps the lenses even while dropping its redundant tab param.
    expect(reportTabHref("overview", { range: "7d" })).toBe("/insights?range=7d");
  });

  it("round-trips: every href parses back to the tab that built it", () => {
    for (const tab of REPORT_TABS) {
      const url = new URL(reportTabHref(tab), "https://example.test");
      const parsed = parseReportTab({
        tab: url.searchParams.get("tab") ?? undefined,
      });
      expect(parsed).toBe<ReportTab>(tab);
    }
  });
});
