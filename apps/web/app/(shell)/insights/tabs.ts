/**
 * The three faces of the Reports screen.
 *
 * Reports used to be two `?view=` tabs — "now" and "proof" — and the IA has
 * moved to the inspiration app's three: Overview (the snapshot), Performance
 * (the trend) and History (one product's story). The tab travels in the URL as
 * `?tab=`, so a face is shareable, survives a reload and works with Back, the
 * same way the range and class lenses already do.
 *
 * `?view=proof` is kept alive on purpose. Old links, bookmarks and the tour
 * still point at it, and the honest mapping is to "performance" — the trend
 * that "is it working?" always was. Everything else, including a mistyped or
 * absent parameter, lands on Overview rather than throwing: this reads a query
 * string any visitor can type, and a report that 500s on a bad tab is worse
 * than one that shows its front page.
 */

export type ReportTab = "overview" | "performance" | "history";

export const REPORT_TABS: ReportTab[] = ["overview", "performance", "history"];

/** What the screen shows when nothing is asked for. */
const DEFAULT_TAB: ReportTab = "overview";

const LABELS: Record<ReportTab, string> = {
  overview: "Overview",
  performance: "Performance",
  history: "History",
};

/**
 * The tab a URL is asking for.
 *
 * `?tab=` wins when it names a real tab. Absent that, legacy `?view=proof`
 * still resolves to "performance" so old links do not break. Anything
 * unrecognised falls back to the default rather than throwing.
 */
export function parseReportTab(params: { tab?: string; view?: string }): ReportTab {
  if ((REPORT_TABS as readonly string[]).includes(params.tab ?? "")) {
    return params.tab as ReportTab;
  }
  if (params.view === "proof") return "performance";
  return DEFAULT_TAB;
}

export function reportTabLabel(t: ReportTab): string {
  return LABELS[t];
}

/**
 * The link to a tab, carrying the range and class lenses when they are set.
 *
 * Overview is the default face, so it omits `?tab=` — an unparameterised
 * `/insights` reads as the front page, and the switcher and legacy links land
 * there without a redundant query. The other two name themselves. The lenses
 * ride along so switching face does not silently reset the period or the ABC
 * filter the reader had chosen.
 */
export function reportTabHref(t: ReportTab, opts?: { range?: string; class?: string }): string {
  const query = new URLSearchParams();
  if (t !== DEFAULT_TAB) query.set("tab", t);
  if (opts?.range) query.set("range", opts.range);
  if (opts?.class) query.set("class", opts.class);
  const suffix = query.toString();
  return suffix ? `/insights?${suffix}` : "/insights";
}
