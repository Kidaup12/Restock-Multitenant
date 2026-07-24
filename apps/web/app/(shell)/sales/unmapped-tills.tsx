import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { getUnmappedTills } from "@/lib/data/pos-queues";

/**
 * Unmapped tills: POS warehouses that sold but map to no Location, so their
 * sales count in channel totals but no branch's run rate (spec §3). One
 * attention row each, linking to Locations to map them.
 */
export async function UnmappedTills({ tenantId }: { tenantId: string }) {
  const tills = await getUnmappedTills(tenantId);
  if (tills.length === 0) return null;

  return (
    <Card>
      <CardHeader
        title="Unmapped tills"
        subtitle="These tills' sales aren't attributed to any branch's run rate. Map them under Locations."
        action={<Badge tone="warning">{tills.length}</Badge>}
      />
      <ul className="mt-3 pb-1">
        {tills.map((till) => (
          <li
            key={till.warehouse}
            className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-edge px-5 py-3"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm text-ink">
                <span className="font-medium">{till.warehouse}</span> isn&apos;t mapped to a branch
              </p>
              <p className="text-xs text-ink-muted">
                {till.salesCount} sale{till.salesCount === 1 ? "" : "s"} unattributed to run rate
              </p>
            </div>
            <Link
              href="/settings/locations"
              className="rounded-md border border-edge bg-surface px-3 py-1.5 text-xs font-medium text-ink-secondary transition-colors hover:bg-surface-2 hover:text-ink"
            >
              Map in Locations
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
