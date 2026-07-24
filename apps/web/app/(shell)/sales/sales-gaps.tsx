import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { getSalesGaps } from "@/lib/data/pos-queues";
import { GapRow } from "./gap-row";

/**
 * The sales-gap list: branches silent on a day their siblings sold (spec §3).
 * Hidden when there are none. The daily cron raises the bell; this is where the
 * owner resolves each — closed, or a feed problem.
 */
export async function SalesGaps({ tenantId, canFix }: { tenantId: string; canFix: boolean }) {
  const gaps = await getSalesGaps(tenantId);
  if (gaps.length === 0) return null;

  return (
    <Card>
      <CardHeader
        title="Sales gaps"
        subtitle="A branch recorded no sales while others sold. Confirm it was closed, or re-pull the feed."
        action={<Badge tone="warning">{gaps.length}</Badge>}
      />
      <ul className="mt-3 pb-1">
        {gaps.map((gap) => (
          <GapRow key={`${gap.locationId}:${gap.dayKey}`} gap={gap} canFix={canFix} />
        ))}
      </ul>
    </Card>
  );
}
