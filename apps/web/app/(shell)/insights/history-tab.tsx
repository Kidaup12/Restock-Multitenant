import { CalendarIcon } from "@/components/icons";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * The History tab — a placeholder for now.
 *
 * The real thing is a per-product timeline: search a SKU and see what sold,
 * when it stocked out and when stock arrived, all on one line. That is a
 * documented follow-up with its own loader; until it lands, this says what is
 * coming in plain terms rather than showing an empty tab that reads as broken.
 *
 * No data fetching, on purpose — there is nothing to fetch yet, and a loader
 * that returns nothing would only add latency to a promise.
 */
export function HistoryTab({
  // Part of the tab's contract from day one: the follow-up timeline fetches by
  // tenant, and callers already pass it. Unused only until that loader lands.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  tenantId,
}: {
  tenantId: string;
}) {
  return (
    <Card>
      <CardHeader title="Order & SKU history" />
      <CardContent>
        <EmptyState
          icon={<CalendarIcon />}
          title="Per-product timeline coming soon"
          description="Search a product to see its full timeline — what sold, when it stocked out, when stock arrived. Coming soon."
        />
      </CardContent>
    </Card>
  );
}
