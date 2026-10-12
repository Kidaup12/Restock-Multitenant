import { GuideBox } from "@/components/ui/guide-box";
import type { ReportTab } from "./tabs";

/**
 * The one-sentence explainer for each Reports tab, in the shop's own language.
 *
 * Copy is lifted verbatim from the inspiration app so the three faces read the
 * same across both. Each is a GuideBox — shown once, dismissable, remembered
 * per workspace — keyed to a stable id so a tab's explainer quiets on its own.
 *
 * One component switching on the tab rather than three call sites: the page
 * renders exactly one guide, whichever face is active, and cannot drift into
 * showing two or none.
 */
export function ReportGuide({ tab, scope }: { tab: ReportTab; scope: string }) {
  if (tab === "overview") {
    return (
      <GuideBox
        id="reports-overview"
        scope={scope}
        title="Overview — your shop's health right now"
      >
        The tiles up top are the headline: revenue, capital tied up in stock, revenue at risk if a
        bestseller runs out, and your ABC mix. Below, four lists — Top movers (what earns), Dead
        stock (cash frozen in items that stopped selling), On order (what&rsquo;s coming), and
        Overstock (over-bought). Use the class filter to see any list for just A, B or C. Watch
        first: dead A/B and revenue at risk — that&rsquo;s where money leaks.
      </GuideBox>
    );
  }

  if (tab === "performance") {
    return (
      <GuideBox
        id="reports-performance"
        scope={scope}
        title="Performance — are we improving, week by week?"
      >
        This is the trend, not a snapshot. It tracks stockouts (bestsellers that ran to zero) and
        dead stock over time — lower is better. Class A is the one that matters: a bestseller
        stocking out is lost revenue.
      </GuideBox>
    );
  }

  return (
    <GuideBox id="reports-history" scope={scope} title="History — the story of one product">
      Search a product to see its timeline: what sold, when it stocked out, when stock arrived, and
      how its numbers moved. Coming soon.
    </GuideBox>
  );
}
