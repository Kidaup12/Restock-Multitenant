import type { Metadata } from "next";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { getWeeklySpotChecks } from "@/lib/data/spot-check";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { CountRow } from "./count-row";

export const metadata: Metadata = {
  title: "Weekly count",
};

const DESCRIPTION =
  "A handful of high-value SKUs to physically count this week, so shelf-vs-app drift is caught before it costs you";

/**
 * Weekly spot-check screen. Each Monday the worker cron picks the few SKUs where
 * a miscount costs the most and writes them here (apps/worker spot-check-cron.ts);
 * this lists them, takes the physical count, and shows the drift against what the
 * app believed on hand.
 *
 * Reading is open to any member. Recording a count needs manage_settings (the
 * same gate the API route enforces), so a money-blind MEMBER sees the list but
 * not the inputs — the write is re-checked server-side either way.
 */
export default async function SpotCheckPage() {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);

  if (!membership) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Stock" title="Weekly count" description={DESCRIPTION} />
        <EmptyState
          title="No workspace yet"
          description="Create your shop's workspace to start, or ask an admin to invite you to theirs."
        />
      </div>
    );
  }

  const canCount = hasPermission(membership, "manage_settings");
  const { rows, remaining } = await getWeeklySpotChecks(membership.tenantId);

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Stock" title="Weekly count" description={DESCRIPTION} />

      {rows.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState
              title="Nothing to count this week"
              description="This week's SKUs to count are chosen automatically every Monday from your latest forecast. Once you've been selling and forecasting for a bit, they'll appear here."
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader
            title="Count these SKUs"
            subtitle={
              remaining > 0
                ? `${remaining} of ${rows.length} still to count`
                : "All counted for this week"
            }
          />
          <CardContent className="pt-2">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs font-medium uppercase tracking-wide text-ink-muted">
                    <th className="pb-2 pr-3 font-medium">Product</th>
                    <th className="pb-2 pr-3 text-right font-medium">App says</th>
                    <th className="pb-2 pr-3 text-right font-medium">Counted</th>
                    <th className="pb-2 text-right font-medium">Drift</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <CountRow key={row.id} row={row} canCount={canCount} />
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-4 text-xs text-ink-muted">
              Drift is what you counted minus what the app believed. A negative
              number is stock that has gone missing — theft, breakage, or sales
              that were never scanned.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
