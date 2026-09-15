import { SegmentedNav } from "@/components/ui/segmented-nav";
import { REPORT_TABS, reportTabHref, reportTabLabel, type ReportTab } from "./tabs";

/**
 * The Reports tab switcher — Overview, Performance, History, in that order.
 *
 * A row of server-rendered links rather than client state, mirroring the old
 * ViewTabs: the tab lives in the URL, so it is shareable and survives a reload.
 * The range and class lenses ride along in each href so switching face keeps
 * the period and ABC filter the reader had chosen.
 */
export function ReportTabNav({
  tab,
  range,
  abc,
}: {
  tab: ReportTab;
  range?: string;
  abc?: string;
}) {
  return (
    <SegmentedNav
      label="Report views"
      data-tour="insights-tabs"
      items={REPORT_TABS.map((t) => ({
        href: reportTabHref(t, { range, class: abc }),
        label: reportTabLabel(t),
        active: t === tab,
      }))}
    />
  );
}
