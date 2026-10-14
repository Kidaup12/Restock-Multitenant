import type { SalesDrift } from "@wezesha/shopify";

/** What the daily check corrected for one shop, and how it reads in an alert.
 *  Kept apart from the sender so it can be tested without a database. */

export type DriftReport = {
  /** Null when this run did not reconcile sales. */
  salesDrift: SalesDrift | null;
  costsCorrected: number;
};

export type ReportDrift = (tenantId: string, report: DriftReport) => Promise<void>;

export function describeDrift(tenantName: string, report: DriftReport): { subject: string; text: string } {
  const lines: string[] = [];
  const d = report.salesDrift;
  if (d && d.days > 0) {
    lines.push(
      `Sales: ${d.days} settled day${d.days === 1 ? "" : "s"} corrected — ${d.unitsBefore} units before, ${d.unitsAfter} after the rebuild from Shopify.`
    );
  }
  if (report.costsCorrected > 0) {
    lines.push(
      `Costs: ${report.costsCorrected} product cost${report.costsCorrected === 1 ? "" : "s"} corrected by the nightly full pull.`
    );
  }
  return {
    subject: `Sync drift: ${tenantName}`,
    text:
      `The daily check found ${tenantName}'s data had drifted from Shopify, and corrected it.\n\n` +
      `${lines.join("\n")}\n\n` +
      `The data is right now, but the hourly sync missed these, so something in it is ` +
      `losing changes. Check the shop's sync runs on the admin page.`,
  };
}
