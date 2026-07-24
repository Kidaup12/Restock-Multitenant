import { ClipboardIcon } from "@/components/icons";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { getOrderQueue } from "@/lib/data/orders";
import { QueueGroup } from "./queue-group";

/** The "what to buy" queue, one card per supplier with its scorecard. */
export async function OrderQueue({
  tenantId,
  canViewCosts = true,
}: {
  tenantId: string;
  canViewCosts?: boolean;
}) {
  const groups = await getOrderQueue(tenantId, { canViewCosts });

  if (groups.length === 0) {
    return (
      <Card>
        <CardHeader title="Order queue" subtitle="Queued buys, grouped by supplier" />
        <CardContent>
          <EmptyState
            icon={<ClipboardIcon />}
            title="Nothing queued to order"
            description="Products you queue from the plan — and urgent forecast picks — collect here, ready to turn into purchase orders."
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <section className="space-y-4">
      {groups.map((group) => (
        <QueueGroup
          key={group.supplierId ?? "unassigned"}
          group={group}
          canViewCosts={canViewCosts}
        />
      ))}
    </section>
  );
}
