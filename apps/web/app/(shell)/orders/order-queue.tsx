import Link from "next/link";
import { ClipboardIcon } from "@/components/icons";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Pager } from "@/components/ui/pager";
import {
  getOrderQueuePage,
  ordersQueryToSearch,
  withOrdersQuery,
  type OrdersQuery,
} from "@/lib/data/orders";
import { QueueGroup } from "./queue-group";

/** The "what to buy" queue, one card per supplier with its scorecard. Pages by
 *  whole cards — see getOrderQueuePage for why a card is never split. */
export async function OrderQueue({
  tenantId,
  query,
  canViewCosts = true,
}: {
  tenantId: string;
  query: OrdersQuery;
  canViewCosts?: boolean;
}) {
  const { groups, total, page, pageCount, from } = await getOrderQueuePage(tenantId, {
    canViewCosts,
    page: query.queuePage,
  });

  if (total === 0) {
    return (
      <Card>
        <CardHeader title="Order queue" subtitle="Queued buys, grouped by supplier" />
        <CardContent>
          <EmptyState
            icon={<ClipboardIcon />}
            title="Nothing queued to order"
            description="Products you queue from the plan — and urgent forecast picks — collect here, ready to turn into purchase orders."
            action={
              <Link
                href="/plan"
                className="flex h-10 items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-on-accent transition-colors hover:bg-accent-strong"
              >
                Go to the buy list
              </Link>
            }
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
      {/* Bare rather than in a card of its own: the queue is a stack of cards,
          so the pager reads as the rule under the last one. */}
      {pageCount > 1 && (
        <Pager
          page={page}
          pageCount={pageCount}
          from={from}
          to={from + groups.length - 1}
          total={total}
          pageHref={(next) =>
            `/orders${ordersQueryToSearch(withOrdersQuery(query, { queuePage: next }))}`
          }
          label="Order queue pages"
          unit="suppliers"
        />
      )}
    </section>
  );
}
